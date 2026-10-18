import { ConnectorProvider, Prisma, SportType } from '@openathlete/database';

import { PrismaService } from '../../prisma/services/prisma.service';

type Recording = {
  startDate: Date;
  endDate: Date;
  sport: SportType;
  distance?: number | null;
};

const running: SportType[] = ['RUNNING', 'TRAIL_RUNNING'];
const cycling: SportType[] = ['CYCLING', 'GRAVEL_RIDE', 'MOUNTAIN_BIKE_RIDE'];

function compatibleSport(a: SportType, b: SportType) {
  return (
    a === b ||
    [running, cycling].some(
      (family) => family.includes(a) && family.includes(b),
    )
  );
}

/** Conservative match: elapsed time includes pauses; moving time does not. */
export function sameWorkout(a: Recording, b: Recording): boolean {
  const durationA = (a.endDate.getTime() - a.startDate.getTime()) / 1000;
  const durationB = (b.endDate.getTime() - b.startDate.getTime()) / 1000;
  if (
    !Number.isFinite(durationA) ||
    !Number.isFinite(durationB) ||
    durationA <= 0 ||
    durationB <= 0 ||
    [a.distance, b.distance].some(
      (distance) =>
        distance != null && (!Number.isFinite(distance) || distance < 0),
    ) ||
    !compatibleSport(a.sport, b.sport) ||
    Math.abs(a.startDate.getTime() - b.startDate.getTime()) > 30000 ||
    Math.abs(durationA - durationB) >
      Math.min(120, Math.max(30, Math.min(durationA, durationB) * 0.02))
  )
    return false;
  // Zero/missing distance is common for strength, yoga and indoor recordings.
  if (a.distance && b.distance) {
    return (
      Math.abs(a.distance - b.distance) <=
      Math.max(100, Math.min(a.distance, b.distance) * 0.03)
    );
  }
  return true;
}

type Import = Recording & {
  athleteId: number;
  provider: 'APPLE_HEALTH' | 'STRAVA';
  externalId: string;
  legacyExternalId: string;
  create: Prisma.EventUncheckedCreateInput;
};

/** Both import paths take the same per-athlete lock before checking or writing.
 * No network requests belong inside this transaction. READ COMMITTED ensures
 * the reader sees the previous lock holder's commit, including new aliases.
 */
export async function saveImportedWorkout(
  prisma: PrismaService,
  input: Import,
) {
  return prisma.$transaction(
    async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(1935764836, ${input.athleteId}::integer)::text`;
      const identity = {
        athleteId: input.athleteId,
        provider: input.provider as ConnectorProvider,
        externalId: input.externalId,
      };
      const existing = await tx.eventActivity.findFirst({
        where: {
          event: { athleteId: input.athleteId },
          OR: [
            { provider: input.provider, externalId: input.legacyExternalId },
            { sources: { some: identity } },
          ],
        },
      });
      const link = async (eventActivityId: number) => {
        await tx.activityImportSource.upsert({
          where: { athleteId_provider_externalId: identity },
          create: { ...identity, eventActivityId },
          update: {},
        });
      };
      if (existing) {
        await link(existing.eventActivityId);
        return {
          activity: existing,
          created: false,
          protected: existing.provider !== input.provider,
        };
      }
      const candidates = await tx.event.findMany({
        where: {
          athleteId: input.athleteId,
          type: 'ACTIVITY',
          startDate: {
            gte: new Date(input.startDate.getTime() - 30000),
            lte: new Date(input.startDate.getTime() + 30000),
          },
          activity: {
            provider:
              input.provider === 'STRAVA' ? 'APPLE_HEALTH' : { not: null },
            // Health may itself contain copies from multiple recording apps.
            // A second Strava ID must not reuse a recording already linked to
            // a different Strava activity.
            ...(input.provider === 'STRAVA' && {
              sources: { none: { provider: input.provider } },
            }),
          },
        },
        include: { activity: true },
      });
      const matches = candidates.filter(
        (event) =>
          event.activity &&
          sameWorkout(input, {
            ...event,
            sport: event.activity.sport,
            distance: event.activity.distance,
          }),
      );
      // Never guess between multiple plausible recordings or modify user data.
      if (matches.length === 1) {
        const activity = matches[0].activity!;
        await link(activity.eventActivityId);
        return { activity, created: false, protected: true };
      }
      const event = await tx.event.create({
        data: input.create,
        include: { activity: true },
      });
      const activity = event.activity!;
      await link(activity.eventActivityId);
      return { activity, created: true, protected: false };
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      timeout: 15000,
    },
  );
}
