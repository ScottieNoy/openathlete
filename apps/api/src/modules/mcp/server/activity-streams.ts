import { z } from 'zod';

import {
  ActivityStreamAvailability,
  ActivityStreamChannel,
  activityStreamChannelSchema,
  activityStreamInputSchema,
  activityStreamOutputSchema,
} from '@openathlete/shared';

type Run = { start: number; count: number; increment: boolean };
type Channel = {
  status: 'available' | 'missing' | 'invalid';
  count: number;
  runs: Run[];
};

const units: Record<ActivityStreamChannel, string> = {
  distance: 'm',
  heartrate: 'bpm',
  cadence: 'rpm_or_steps/min',
  watts: 'W',
  altitude: 'm',
  temp: 'degC',
  gap: 'm/s',
  norm: 'm/s',
  speed: 'm/s',
  pace: 's/km',
};
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const finite = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/** Inspect run lengths without expanding the entire workout into memory. */
function channel(value: unknown, time = false): Channel {
  const invalid: Channel = { status: 'invalid', count: 0, runs: [] };
  if (
    value === undefined ||
    value === null ||
    (Array.isArray(value) && !value.length)
  ) {
    return { status: 'missing', count: 0, runs: [] };
  }
  if (!Array.isArray(value)) return invalid;
  const runs: Run[] = [];
  let count = 0;
  let previous = -Infinity;
  for (const item of value) {
    const object = record(item);
    const increment = !!object && 's' in object && 'i' in object;
    const start = finite(item) ? item : object?.[increment ? 's' : 'v'];
    const length = finite(item) ? 1 : object?.[increment ? 'i' : 'r'];
    if (
      !finite(start) ||
      !finite(length) ||
      !Number.isSafeInteger(length) ||
      length < 1
    )
      return invalid;
    const last = start + (increment ? length - 1 : 0);
    count += length;
    if (!Number.isFinite(last) || !Number.isSafeInteger(count)) return invalid;
    if (time && (start < 0 || start < previous)) return invalid;
    previous = last;
    runs.push({ start, count: length, increment });
  }
  return { status: 'available', count, runs };
}

function slice(channel: Channel, offset: number, limit: number): number[] {
  const result: number[] = [];
  let base = 0;
  for (const run of channel.runs) {
    const begin = Math.max(0, offset - base);
    const end = Math.min(run.count, offset + limit - base);
    for (let i = begin; i < end; i++)
      result.push(run.start + (run.increment ? i : 0));
    base += run.count;
    if (base >= offset + limit) break;
  }
  return result;
}

export function inspectActivityStreams(stored: unknown) {
  const object = record(stored);
  const time = channel(object?.time, true);
  const channels = new Map<ActivityStreamChannel, Channel>();
  for (const key of activityStreamChannelSchema.options) {
    if (key !== 'speed' && key !== 'pace')
      channels.set(key, channel(object?.[key]));
  }
  const info = (
    key: ActivityStreamChannel,
  ): ActivityStreamAvailability['channels'][number] => {
    const derived = key === 'speed' || key === 'pace';
    const data = channels.get(derived ? 'distance' : key)!;
    const status =
      data.status !== 'available'
        ? data.status
        : time.status !== 'available'
          ? 'invalid'
          : data.count !== time.count
            ? 'misaligned'
            : 'available';
    return {
      channel: key,
      status,
      unit: units[key],
      sampleCount: data.count,
      source: derived ? 'derived_from_distance_and_time' : 'recorded',
    };
  };
  const availability: ActivityStreamAvailability = {
    stored: stored !== null && stored !== undefined,
    timeStatus: stored != null && !object ? 'invalid' : time.status,
    totalSamples: time.count,
    channels: activityStreamChannelSchema.options.map(info),
  };
  return {
    availability,
    page(
      input: z.output<typeof activityStreamInputSchema>,
    ): z.input<typeof activityStreamOutputSchema> {
      const { eventId, offset, limit } = input;
      const timeSeconds = slice(time, offset, limit);
      const from = Math.max(0, offset - 1);
      const originalTimes = slice(time, from, limit + 1);
      const distance = slice(channels.get('distance')!, from, limit + 1);
      const series = [...new Set(input.channels)].map((key) => {
        const metadata = info(key);
        let values: (number | null)[] = [];
        if (metadata.status === 'available') {
          if (key === 'speed' || key === 'pace') {
            values = timeSeconds.map((_, index) => {
              const i = offset + index - from;
              if (offset + index === 0) return null;
              const dt = originalTimes[i] - originalTimes[i - 1];
              const dd = distance[i] - distance[i - 1];
              if (dt <= 0 || dd < 0) return null;
              const speed = dd / dt;
              const value =
                key === 'speed' ? speed : speed > 0 ? 1000 / speed : null;
              return value !== null && Number.isFinite(value) ? value : null;
            });
          } else values = slice(channels.get(key)!, offset, limit);
        }
        return { ...metadata, values };
      });
      const next = offset + timeSeconds.length;
      return {
        eventId,
        availability,
        offset,
        returnedSamples: timeSeconds.length,
        nextOffset: next < time.count ? next : null,
        timeSeconds,
        series,
        sampling: 'original',
        paceMethod: 'previous_original_sample_elapsed_interval',
      };
    },
  };
}
