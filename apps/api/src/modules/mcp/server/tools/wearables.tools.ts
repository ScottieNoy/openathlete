import { z } from 'zod';

import { SportType } from '@openathlete/database';

import { saveImportedWorkout } from '../../../providers-sync/base/workout-deduplication';
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
        const {
          sourceId: _sourceId,
          name,
          sport,
          start: _start,
          end: _end,
          laps,
          ...summary
        } = workout;
        const saved = await saveImportedWorkout(deps.prisma, {
          athleteId: scope.athleteId,
          provider: 'APPLE_HEALTH',
          externalId: workout.sourceId.toLowerCase(),
          legacyExternalId: externalId,
          startDate,
          endDate,
          sport,
          distance: workout.distance,
          create: {
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
        });
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
          alreadyImported: !saved.created,
          protected: saved.protected,
          processingQueued,
        };
      }),
  );
};
