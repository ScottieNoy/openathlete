import { z } from 'zod';

export const activityStreamChannelSchema = z.enum([
  'distance',
  'heartrate',
  'cadence',
  'watts',
  'altitude',
  'temp',
  'gap',
  'norm',
  'speed',
  'pace',
]);
export type ActivityStreamChannel = z.infer<typeof activityStreamChannelSchema>;

const channelInfoSchema = z.object({
  channel: activityStreamChannelSchema,
  status: z.enum(['available', 'missing', 'misaligned', 'invalid']),
  unit: z.string(),
  source: z.enum(['recorded', 'derived_from_distance_and_time']),
  sampleCount: z.number().int().nonnegative(),
});

export const activityStreamAvailabilitySchema = z.object({
  stored: z.boolean().describe('A stream JSON value is stored, possibly empty'),
  timeStatus: z.enum(['available', 'missing', 'invalid']),
  totalSamples: z.number().int().nonnegative(),
  channels: z.array(channelInfoSchema),
});
export type ActivityStreamAvailability = z.infer<
  typeof activityStreamAvailabilitySchema
>;

export const activityStreamInputSchema = z.object({
  eventId: z
    .number()
    .int()
    .positive()
    .describe('Activity eventId from get_activity'),
  channels: z
    .array(activityStreamChannelSchema)
    .min(1)
    .max(10)
    .default(['heartrate', 'distance', 'speed', 'pace']),
  offset: z
    .number()
    .int()
    .min(0)
    .max(Number.MAX_SAFE_INTEGER - 500)
    .default(0),
  limit: z.number().int().min(1).max(500).default(200),
});

export const activityStreamOutputSchema = z.object({
  eventId: z.number(),
  availability: activityStreamAvailabilitySchema,
  offset: z.number().int(),
  returnedSamples: z.number().int(),
  nextOffset: z.number().int().nullable(),
  timeSeconds: z
    .array(z.number())
    .describe('Elapsed seconds from activity start'),
  series: z.array(
    channelInfoSchema.extend({
      values: z
        .array(z.number().nullable())
        .describe(
          'Available channels align with timeSeconds; unavailable channels return []. null means no valid derived value.',
        ),
    }),
  ),
  sampling: z.literal('original'),
  paceMethod: z.literal('previous_original_sample_elapsed_interval'),
});
