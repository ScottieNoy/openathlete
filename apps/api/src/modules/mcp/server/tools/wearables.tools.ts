import { z } from 'zod';

import { Prisma, SportType } from '@openathlete/database';

import { ToolError, run } from '../context';
import { ToolRegistrar, registerTool } from './deps';

// No athleteId input. These imported activities always belong to the token owner.
export const importedWorkout = z.object({
  sourceId: z.string().uuid(),
  name: z.string().trim().min(1).max(200),
  sport: z.nativeEnum(SportType),
  start: z.string().datetime({ offset: true }),
  end: z.string().datetime({ offset: true }),
  movingTime: z.number().int().positive().max(172800),
  distance: z.number().finite().nonnegative().max(2000000),
  elevationGain: z.number().finite().nonnegative().max(50000),
  averageSpeed: z.number().finite().nonnegative().max(150),
  maxSpeed: z.number().finite().nonnegative().max(150),
  averageHeartrate: z.number().finite().positive().max(300).optional(),
  maxHeartrate: z.number().finite().positive().max(300).optional(),
  averageWatts: z.number().finite().nonnegative().max(10000).optional(),
  maxWatts: z.number().finite().nonnegative().max(10000).optional(),
  averageCadence: z.number().finite().nonnegative().max(500).optional(),
  kilojoules: z.number().finite().nonnegative().max(200000).optional(),
  // Summary-only SDK workouts have no invented GPS or sensor streams.
  laps: z
    .array(
      z.object({
        start: z.number().int().nonnegative(),
        end: z.number().int().positive(),
        distance: z.number().finite().nonnegative().optional(),
      }),
    )
    .max(1000)
    .default([]),
});

const output = z.object({
  eventId: z.number(),
  alreadyImported: z.boolean(),
  protected: z.boolean(),
  processingQueued: z.boolean(),
});

export const registerWearablesTools: ToolRegistrar = (server, ctx, deps) => {
  registerTool(
    server,
    'import_wearable_workout',
    {
      title: 'Import an Apple Health workout',
      description:
        'Imports an original Apple Health workout through Open Wearables for your own account. Idempotent by source UUID. Existing activities and edits are protected. Summary-only imports do not contain GPS or sensor streams.',
      inputSchema: { workout: importedWorkout },
      outputSchema: output,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    ({ workout }) =>
      run(output, async () => {
        const scope = await ctx.athlete();
        if (!ctx.can('write') || !scope.isSelf)
          throw new ToolError('Own athlete write access required');
        if (!deps.queue)
          throw new ToolError('Activity processing is unavailable');
        const startDate = new Date(workout.start),
          endDate = new Date(workout.end);
        const elapsed = (endDate.getTime() - startDate.getTime()) / 1000;
        if (
          elapsed <= 0 ||
          elapsed > 172800 ||
          workout.movingTime > Math.ceil(elapsed) ||
          endDate.getTime() > Date.now() + 300000
        )
          throw new ToolError('Invalid workout dates or moving time');
        if (
          workout.laps.some(
            (l) => l.end <= l.start || l.end > Math.ceil(elapsed),
          )
        )
          throw new ToolError('Invalid workout lap');
        const externalId = `openwearables:${scope.athleteId}:${workout.sourceId.toLowerCase()}`;
        const save = () =>
          deps.prisma.$transaction(
            async (tx) => {
              const own = await tx.eventActivity.findUnique({
                where: { externalId },
                include: { event: true },
              });
              if (own) {
                if (own.event.athleteId !== scope.athleteId)
                  throw new ToolError('Workout owner mismatch');
                return {
                  activity: own,
                  alreadyImported: true,
                  protected: false,
                };
              }
              // Nearby recordings from Strava/Garmin/Health are one workout. Prefer
              // the existing activity (which may have richer streams) to a duplicate.
              const existing = await tx.event.findFirst({
                where: {
                  athleteId: scope.athleteId,
                  type: 'ACTIVITY',
                  startDate: {
                    gte: new Date(startDate.getTime() - 30000),
                    lte: new Date(startDate.getTime() + 30000),
                  },
                  activity: { sport: workout.sport },
                },
                include: { activity: true },
              });
              if (existing?.activity)
                return {
                  activity: existing.activity,
                  alreadyImported: true,
                  protected: true,
                };
              const {
                sourceId: _sourceId,
                name,
                sport,
                start: _start,
                end: _end,
                laps,
                ...summary
              } = workout;
              const created = await tx.event.create({
                data: {
                  athleteId: scope.athleteId,
                  type: 'ACTIVITY',
                  name,
                  startDate,
                  endDate,
                  activity: {
                    create: {
                      ...summary,
                      sport,
                      externalId,
                      provider: 'APPLE_HEALTH',
                      description:
                        'Imported from Apple Health through Open Wearables. GPS and sensor streams are not provided by this SDK version.',
                      segments: {
                        create: laps.map((lap, index) => ({
                          segmentType: 'LAP',
                          name: `Lap ${index + 1}`,
                          orderIndex: index,
                          startTimeSeconds: lap.start,
                          endTimeSeconds: lap.end,
                          movingTime: lap.end - lap.start,
                          ...(lap.distance !== undefined && {
                            distance: lap.distance,
                          }),
                        })),
                      },
                    },
                  },
                },
                include: { activity: true },
              });
              return {
                activity: created.activity!,
                alreadyImported: false,
                protected: false,
              };
            },
            {
              isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
              timeout: 15000,
            },
          );
        let saved: Awaited<ReturnType<typeof save>> | undefined;
        for (let attempt = 0; !saved; attempt++) {
          try {
            saved = await save();
          } catch (error) {
            if (
              !(error instanceof Prisma.PrismaClientKnownRequestError) ||
              !['P2002', 'P2034'].includes(error.code) ||
              attempt >= 2
            )
              throw error;
          }
        }
        let processingQueued = true;
        if (!saved.protected) {
          try {
            await deps.queue.addActivityProcessingJob(
              saved.activity.eventActivityId,
              saved.activity.eventId,
              true,
            );
          } catch {
            processingQueued = false;
          }
        }
        return {
          eventId: saved.activity.eventId,
          alreadyImported: saved.alreadyImported,
          protected: saved.protected,
          processingQueued,
        };
      }),
  );
};
