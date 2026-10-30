import {
  activityStreamInputSchema,
  activityStreamOutputSchema,
} from '@openathlete/shared';

import { compressActivityStream } from 'src/modules/core/helpers/activity-stream';

import { inspectActivityStreams } from './activity-streams';

const page = (stored: unknown, input: Record<string, unknown> = {}) =>
  activityStreamOutputSchema.parse(
    inspectActivityStreams(stored).page(
      activityStreamInputSchema.parse({ eventId: 1, ...input }),
    ),
  );
const values = (result: ReturnType<typeof page>, channel: string) =>
  result.series.find((s) => s.channel === channel)!.values;

describe('MCP original activity streams', () => {
  it('keeps irregular timestamps aligned and derives elapsed interval pace across pages', () => {
    const stored = compressActivityStream({
      time: [0, 2, 7, 9, 10],
      distance: [0, 8, 18, 18, 22],
      heartrate: [100, 110, 120, 0, 130],
      watts: [0, 100, 150, 0, 200],
    });
    const first = page(stored, { limit: 2 });
    expect(first.timeSeconds).toEqual([0, 2]);
    expect(values(first, 'speed')).toEqual([null, 4]);
    expect(values(first, 'pace')).toEqual([null, 250]);
    expect(first.nextOffset).toBe(2);
    const second = page(stored, { offset: first.nextOffset, limit: 3 });
    expect(second.timeSeconds).toEqual([7, 9, 10]);
    expect(values(second, 'heartrate')).toEqual([120, 0, 130]);
    expect(values(second, 'speed')).toEqual([2, 0, 4]);
    expect(values(second, 'pace')).toEqual([500, null, 250]);
    expect(second.nextOffset).toBeNull();
    expect(
      second.availability.channels.find((s) => s.channel === 'pace'),
    ).toMatchObject({
      unit: 's/km',
      source: 'derived_from_distance_and_time',
      status: 'available',
    });
  });

  it('pages repeated and incrementing runs without expanding a long recording', () => {
    const result = page(
      {
        time: [{ s: 0, i: 1_000_000_000 }],
        heartrate: [{ r: 1_000_000_000, v: 140 }],
      },
      { offset: 999_999_997, limit: 500, channels: ['heartrate'] },
    );
    expect(result.timeSeconds).toEqual([999_999_997, 999_999_998, 999_999_999]);
    expect(values(result, 'heartrate')).toEqual([140, 140, 140]);
    expect(result.availability.totalSamples).toBe(1_000_000_000);
    expect(result.nextOffset).toBeNull();
  });

  it('reports missing, malformed and unaligned data instead of guessing timestamps', () => {
    for (const stored of [null, {}, { time: [] }]) {
      const result = page(stored);
      expect(result.timeSeconds).toEqual([]);
      expect(result.availability.timeStatus).toBe('missing');
      expect(result.nextOffset).toBeNull();
    }
    expect(page(null).availability.stored).toBe(false);
    expect(page({}).availability.stored).toBe(true);
    const result = page(
      {
        time: [0, 1, 2],
        heartrate: [140, 141],
        distance: [0, 5, 10],
        watts: [100, null, 0],
      },
      { channels: ['heartrate', 'watts', 'cadence', 'distance'] },
    );
    expect(result.series.map((s) => [s.channel, s.status, s.values])).toEqual([
      ['heartrate', 'misaligned', []],
      ['watts', 'invalid', []],
      ['cadence', 'missing', []],
      ['distance', 'available', [0, 5, 10]],
    ]);
    for (const time of [
      [2, 1],
      [-1, 0],
      [{ r: -1, v: 0 }],
      [{ s: 0, i: Infinity }],
    ]) {
      expect(page({ time }).availability.timeStatus).toBe('invalid');
    }
    expect(page('invalid').availability.timeStatus).toBe('invalid');
    expect(
      page({ distance: [0, 3] }).series.find((s) => s.channel === 'speed')
        ?.status,
    ).toBe('invalid');
  });

  it('does not invent speed at distance resets or duplicate times', () => {
    const result = page({ time: [0, 1, 1, 3, 4], distance: [0, 3, 5, 2, 6] });
    expect(values(result, 'speed')).toEqual([null, 3, null, null, 4]);
    expect(values(result, 'pace')[4]).toBe(250);
  });

  it('returns all stored scalar channels with units, preserving signed values and zeros', () => {
    const result = page(
      {
        time: [0, 10],
        distance: [0, 30],
        heartrate: [0, 140],
        watts: [0, 200],
        cadence: [0, 80],
        altitude: [-5, 0],
        temp: [-2, 0],
        gap: [0, 3.5],
        norm: [0, 3.8],
        latlng: [
          [55, 12],
          [56, 13],
        ],
      },
      {
        channels: [
          'heartrate',
          'distance',
          'watts',
          'cadence',
          'altitude',
          'temp',
          'gap',
          'norm',
        ],
      },
    );
    expect(values(result, 'altitude')).toEqual([-5, 0]);
    expect(values(result, 'temp')).toEqual([-2, 0]);
    expect(values(result, 'watts')).toEqual([0, 200]);
    expect(result.series.every((s) => s.status === 'available')).toBe(true);
    expect(JSON.stringify(result)).not.toContain('latlng');
  });

  it('bounds requests and returns an empty terminal page beyond the recording', () => {
    expect(
      activityStreamInputSchema.safeParse({ eventId: 1, limit: 501 }).success,
    ).toBe(false);
    expect(
      activityStreamInputSchema.safeParse({ eventId: 1, offset: -1 }).success,
    ).toBe(false);
    expect(
      activityStreamInputSchema.safeParse({ eventId: 1, channels: ['latlng'] })
        .success,
    ).toBe(false);
    const result = page({ time: [{ s: 0, i: 1000 }] }, { offset: 1001 });
    expect(result.returnedSamples).toBe(0);
    expect(result.nextOffset).toBeNull();
    expect(
      page({ time: [{ s: 0, i: 1000 }] }, { limit: 500 }).returnedSamples,
    ).toBe(500);
  });
});
