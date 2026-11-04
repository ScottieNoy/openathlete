import { TrainingLoadService } from 'src/modules/core/services/training-load.service';
import { PrismaService } from 'src/modules/prisma/services/prisma.service';

/**
 * Repair missing historical TRIMP entries without touching any existing load,
 * activity, stream or training plan.
 *
 * This command is intentionally a dry run unless --yes is passed.
 * CTL/ATL/TSB are calculated from load entries when queried, so no separate
 * fitness cache needs to be modified.
 */
export async function backfillMissingTrimp(
  args: string[],
  deps: { prisma: PrismaService; trainingLoad: TrainingLoadService },
  out: (line: string) => void,
): Promise<number> {
  const [emailArg, ...flags] = args;
  const usage =
    'Usage: openathlete backfill-trimp <email> [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--yes]';

  if (!emailArg || emailArg.startsWith('--')) {
    out(usage);
    return 1;
  }

  let from: string | undefined;
  let to: string | undefined;
  let apply = false;
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i];
    if (flag === '--yes') {
      if (apply) {
        out(usage);
        return 1;
      }
      apply = true;
    } else if (flag === '--from' || flag === '--to') {
      const date = flags[++i];
      const parsed = date ? new Date(`${date}T00:00:00.000Z`) : null;
      if (
        !date ||
        !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
        !parsed ||
        Number.isNaN(parsed.getTime()) ||
        parsed.toISOString().slice(0, 10) !== date ||
        (flag === '--from' ? from !== undefined : to !== undefined)
      ) {
        out(usage);
        return 1;
      }
      if (flag === '--from') from = date;
      else to = date;
    } else {
      out(usage);
      return 1;
    }
  }
  if (from && to && from > to) {
    out('The start date must not be after the end date.');
    return 1;
  }

  const email = emailArg.toLowerCase();
  const user = await deps.prisma.user.findFirst({
    where: { email: { equals: email, mode: 'insensitive' } },
    select: { userId: true, email: true },
  });
  if (!user) {
    out(`No account with the email ${email}`);
    return 1;
  }
  const athlete = await deps.prisma.athlete.findUnique({
    where: { userId: user.userId },
    select: { athleteId: true },
  });
  if (!athlete) {
    out(`No athlete profile for ${user.email}`);
    return 1;
  }

  const [hrMax, hrRest, calculation] = await Promise.all([
    deps.prisma.athleteMetric.findFirst({
      where: { athleteId: athlete.athleteId, type: 'HR_MAX' },
      orderBy: { date: 'desc' },
      select: { value: true },
    }),
    deps.prisma.athleteMetric.findFirst({
      where: { athleteId: athlete.athleteId, type: 'HR_REST' },
      orderBy: { date: 'desc' },
      select: { value: true },
    }),
    deps.prisma.trainingLoadCalculation.findUnique({
      where: {
        athleteId_type: { athleteId: athlete.athleteId, type: 'TRIMP' },
      },
      select: { trainingLoadCalculationId: true },
    }),
  ]);
  if (
    !hrMax ||
    !hrRest ||
    hrRest.value <= 0 ||
    hrMax.value <= hrRest.value
  ) {
    out('Valid HR_MAX and HR_REST metrics are required; no changes made.');
    return 1;
  }

  const startDate: { gte?: Date; lt?: Date } = {};
  if (from) startDate.gte = new Date(`${from}T00:00:00.000Z`);
  if (to) {
    const exclusiveEnd = new Date(`${to}T00:00:00.000Z`);
    exclusiveEnd.setUTCDate(exclusiveEnd.getUTCDate() + 1);
    startDate.lt = exclusiveEnd;
  }

  const [events, existingEntries] = await Promise.all([
    deps.prisma.event.findMany({
      where: {
        athleteId: athlete.athleteId,
        type: 'ACTIVITY',
        ...(Object.keys(startDate).length ? { startDate } : {}),
      },
      orderBy: { startDate: 'asc' },
      select: {
        eventId: true,
        startDate: true,
        activity: {
          select: {
            eventActivityId: true,
            averageHeartrate: true,
            movingTime: true,
          },
        },
      },
    }),
    calculation
      ? deps.prisma.trainingLoadEntry.findMany({
          where: { calculationId: calculation.trainingLoadCalculationId },
          select: { activityId: true },
        })
      : Promise.resolve([]),
  ]);
  const existingIds = new Set(existingEntries.map((entry) => entry.activityId));
  const pending = events.filter(
    (event) => event.activity && !existingIds.has(event.activity.eventActivityId),
  );
  const candidates: number[] = [];
  let skippedNoHr = 0;

  for (const event of pending) {
    const activity = event.activity;
    if (!activity) continue;
    if (
      activity.averageHeartrate !== null &&
      activity.averageHeartrate > 0 &&
      activity.movingTime > 0
    ) {
      candidates.push(event.eventId);
      continue;
    }
    // Some imports have a stream without a populated HR summary. The existing
    // service is responsible for checking whether that stream contains HR.
    const stream = await deps.prisma.eventActivity.findUnique({
      where: { eventActivityId: activity.eventActivityId },
      select: { stream: true },
    });
    if (stream?.stream) candidates.push(event.eventId);
    else skippedNoHr++;
  }

  out(
    `TRIMP backfill for ${user.email} (athlete ${athlete.athleteId}): ` +
      `${events.length} activities, ${events.length - pending.length} with existing TRIMP, ` +
      `${candidates.length} missing candidates, ${skippedNoHr} without HR data.`,
  );
  out(
    `Using current HR_MAX ${hrMax.value}, HR_REST ${hrRest.value} (existing formula).`,
  );

  if (!apply) {
    out('Dry run only. Add --yes to calculate missing entries.');
    return 0;
  }

  const authUser = {
    userId: user.userId,
    email: user.email,
    athlete: { athleteId: athlete.athleteId },
    coachAthletes: [],
  };
  let completed = 0;
  let failed = 0;
  for (const eventId of candidates) {
    try {
      await deps.trainingLoad.calculateActivityLoad(authUser, eventId, 'TRIMP');
      completed++;
    } catch (error) {
      failed++;
      const reason = error instanceof Error ? error.message : String(error);
      out(`Failed event ${eventId}: ${reason}`);
    }
  }

  // Verify persistence using the same unique calculation type used by the
  // application, rather than trusting the method's return values.
  const savedCalculation = await deps.prisma.trainingLoadCalculation.findUnique({
    where: {
      athleteId_type: { athleteId: athlete.athleteId, type: 'TRIMP' },
    },
    select: { trainingLoadCalculationId: true },
  });
  const savedEntries = savedCalculation
    ? await deps.prisma.trainingLoadEntry.findMany({
        where: { calculationId: savedCalculation.trainingLoadCalculationId },
        select: { activityId: true },
      })
    : [];
  const expected = existingIds.size + completed;
  out(
    `Attempted ${candidates.length}; calculated ${completed}; failed ${failed}. ` +
      `Verified ${savedEntries.length} stored TRIMP entries (expected at least ${expected}).`,
  );
  out('CTL/ATL/TSB will update automatically on the next training-load query.');
  return failed || savedEntries.length < expected ? 1 : 0;
}
