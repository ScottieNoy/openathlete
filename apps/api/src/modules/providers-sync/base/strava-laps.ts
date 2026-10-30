import { z } from 'zod';

import { Prisma } from '@openathlete/database';

import { stravaStorageId } from '../../core/helpers/provider-activity-id';
import { PrismaService } from '../../prisma/services/prisma.service';

const id = z.number().int().positive().safe();
const metric = z.number().finite().nonnegative().nullish();
const lapSchema = z.object({
  id,
  activity: z.object({ id }),
  athlete: z.object({ id }),
  lap_index: z.number().int().nonnegative(),
  start_index: z.number().int().nonnegative().nullish(),
  end_index: z.number().int().nonnegative().nullish(),
  name: z.string().max(1000).optional(),
  start_date: z.string().datetime({ offset: true }),
  elapsed_time: z.number().int().nonnegative().max(2147483647),
  moving_time: z.number().int().nonnegative().max(2147483647).nullish(),
  distance: metric,
  total_elevation_gain: metric,
  average_speed: metric,
  max_speed: metric,
  average_cadence: metric,
  average_watts: metric,
  max_watts: metric,
  average_heartrate: metric,
  max_heartrate: metric,
  kilojoules: metric,
});

export type StravaLapSource = {
  id: string;
  startDate: Date;
  elapsedSeconds: number;
  athleteId?: string | null;
};

/** Provider timestamps define boundaries. Stream indices are not seconds. */
export function originalStravaLaps(source: StravaLapSource, value: unknown) {
  if (
    !/^\d{1,20}$/.test(source.id) ||
    !Number.isFinite(source.startDate.getTime()) ||
    !Number.isFinite(source.elapsedSeconds) ||
    source.elapsedSeconds < 0
  ) {
    throw new Error('Invalid Strava activity timeline');
  }
  const laps = z.array(lapSchema).max(2000).parse(value);
  const identities = new Set<number>();
  const orders = new Set<number>();
  return laps
    .sort((a, b) => a.lap_index - b.lap_index)
    .map((lap, orderIndex) => {
      const start =
        (new Date(lap.start_date).getTime() - source.startDate.getTime()) /
        1000;
      const end = start + lap.elapsed_time;
      if (
        String(lap.activity.id) !== source.id ||
        (source.athleteId && String(lap.athlete.id) !== source.athleteId) ||
        !Number.isSafeInteger(start) ||
        start < 0 ||
        start > source.elapsedSeconds + 1 ||
        end > 2147483647 ||
        identities.has(lap.id) ||
        orders.has(lap.lap_index)
      ) {
        throw new Error('Strava lap does not match its source activity');
      }
      identities.add(lap.id);
      orders.add(lap.lap_index);
      return {
        segmentType: 'LAP' as const,
        sourceProvider: 'STRAVA' as const,
        sourceExternalId: String(lap.id),
        sourceData: {
          basis: 'provider_start_date_and_elapsed_time',
          activityStartDate: source.startDate.toISOString(),
          startDate: lap.start_date,
          elapsedSeconds: lap.elapsed_time,
          movingTimeSeconds: lap.moving_time ?? null,
          movingTimeExceedsElapsedTime:
            lap.moving_time != null && lap.moving_time > lap.elapsed_time,
          lapIndex: lap.lap_index,
          startIndex: lap.start_index ?? null,
          endIndex: lap.end_index ?? null,
        },
        name: lap.name,
        orderIndex,
        startTimeSeconds: start,
        endTimeSeconds: end,
        movingTime: lap.moving_time,
        distance: lap.distance,
        elevationGain: lap.total_elevation_gain,
        averageSpeed: lap.average_speed,
        maxSpeed: lap.max_speed,
        averageCadence: lap.average_cadence,
        averageWatts: lap.average_watts,
        maxWatts: lap.max_watts,
        averageHeartrate: lap.average_heartrate,
        maxHeartrate: lap.max_heartrate,
        kilojoules: lap.kilojoules,
      } satisfies Prisma.ActivitySegmentCreateWithoutEventActivityInput;
    });
}

/** Append missing provider identities; never rewrite existing or unclassified segments. */
export async function appendOriginalStravaLaps(
  prisma: PrismaService,
  input: {
    athleteId: number;
    eventActivityId: number;
    source: StravaLapSource;
    laps: unknown;
  },
) {
  const segments = originalStravaLaps(input.source, input.laps);
  return prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT event_activity_id FROM event_activity WHERE event_activity_id = ${input.eventActivityId} FOR UPDATE`;
    const identity = {
      athleteId: input.athleteId,
      provider: 'STRAVA' as const,
      externalId: input.source.id,
    };
    const activity = await tx.eventActivity.findFirst({
      where: {
        eventActivityId: input.eventActivityId,
        event: { athleteId: input.athleteId },
        OR: [
          {
            provider: 'STRAVA',
            externalId: {
              in: [
                input.source.id,
                stravaStorageId(input.athleteId, input.source.id),
              ],
            },
          },
          { sources: { some: identity } },
        ],
      },
      select: {
        segments: { select: { sourceProvider: true, sourceExternalId: true } },
      },
    });
    if (!activity)
      throw new Error('Strava source does not belong to this activity');
    if (
      activity.segments.some(
        (s) => s.sourceProvider !== 'STRAVA' || !s.sourceExternalId,
      )
    ) {
      return { imported: 0, protectedExistingSegments: true };
    }
    const result = await tx.activitySegment.createMany({
      data: segments.map((s) => ({
        ...s,
        eventActivityId: input.eventActivityId,
      })),
      skipDuplicates: true,
    });
    return { imported: result.count, protectedExistingSegments: false };
  });
}
