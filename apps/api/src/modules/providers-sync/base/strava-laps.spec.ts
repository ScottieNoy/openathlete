import { originalStravaLaps } from './strava-laps';

const source = {
  id: '123',
  athleteId: '99',
  startDate: new Date('2026-01-01T10:00:00Z'),
  elapsedSeconds: 1200,
};
const lap = {
  id: 101,
  activity: { id: 123 },
  athlete: { id: 99 },
  lap_index: 1,
  name: 'Recorded lap',
  start_date: '2026-01-01T10:00:00Z',
  elapsed_time: 300,
  moving_time: 280,
  distance: 1000,
  average_speed: 3.5,
  start_index: 17,
  end_index: 200,
};

describe('Original Strava lap mapping', () => {
  it('uses UTC timestamps and elapsed durations, never stream indices or moving time for boundaries', () => {
    const mapped = originalStravaLaps(source, [
      lap,
      {
        ...lap,
        id: 102,
        lap_index: 2,
        start_date: '2026-01-01T11:05:00+01:00',
        elapsed_time: 30,
        moving_time: 30,
      },
    ]);
    expect(mapped[0]).toMatchObject({
      sourceProvider: 'STRAVA',
      sourceExternalId: '101',
      segmentType: 'LAP',
      startTimeSeconds: 0,
      endTimeSeconds: 300,
      movingTime: 280,
    });
    expect(mapped[1]).toMatchObject({
      startTimeSeconds: 300,
      endTimeSeconds: 330,
      orderIndex: 1,
    });
  });
  it('preserves names, zero measurements and provider precision without inferring workout steps', () => {
    const mapped = originalStravaLaps(source, [
      {
        ...lap,
        name: 'Recovery',
        distance: 0,
        average_watts: 0,
        average_heartrate: 0,
        average_cadence: 0,
        average_speed: 1.234567,
      },
    ])[0];
    expect(mapped).toMatchObject({
      name: 'Recovery',
      segmentType: 'LAP',
      distance: 0,
      averageWatts: 0,
      averageHeartrate: 0,
      averageCadence: 0,
      averageSpeed: 1.234567,
    });
  });
  it('keeps the provider order and reports empty source laps without manufacturing splits', () => {
    expect(originalStravaLaps(source, [])).toEqual([]);
    const mapped = originalStravaLaps(source, [
      { ...lap, lap_index: 2 },
      { ...lap, id: 102, lap_index: 1 },
    ]);
    expect(mapped.map((s) => s.sourceExternalId)).toEqual(['102', '101']);
  });
  it('preserves zero-based source indices and clock discrepancies rather than clipping original laps to a summary', () => {
    const mapped = originalStravaLaps({ ...source, elapsedSeconds: 300 }, [
      { ...lap, lap_index: 0, elapsed_time: 301 },
    ])[0];
    expect(mapped.endTimeSeconds).toBe(301);
    expect(mapped.sourceData).toMatchObject({
      basis: 'provider_start_date_and_elapsed_time',
      startIndex: 17,
      endIndex: 200,
      elapsedSeconds: 301,
      lapIndex: 0,
    });
  });
  it('preserves inconsistent provider moving time and flags it without changing elapsed boundaries', () => {
    const mapped = originalStravaLaps(source, [
      { ...lap, moving_time: 301 },
    ])[0];
    expect(mapped).toMatchObject({
      startTimeSeconds: 0,
      endTimeSeconds: 300,
      movingTime: 301,
      sourceData: {
        elapsedSeconds: 300,
        movingTimeSeconds: 301,
        movingTimeExceedsElapsedTime: true,
      },
    });
  });
  it.each([
    { activity: { id: 124 } },
    { athlete: { id: 98 } },
    { start_date: '2026-01-01T09:59:59Z' },
    { start_date: '2026-01-01T10:00:00.500Z' },
    { start_date: '2026-01-01T10:21:00Z' },
    { moving_time: 2147483648 },
    { average_watts: NaN },
  ])(
    'rejects mismatched/malformed original data without partial mapping: %j',
    (change) => {
      expect(() =>
        originalStravaLaps(source, [
          lap,
          { ...lap, id: 102, lap_index: 2, ...change },
        ]),
      ).toThrow();
    },
  );
  it('rejects duplicate provider identities and ambiguous order indices', () => {
    expect(() =>
      originalStravaLaps(source, [lap, { ...lap, lap_index: 2 }]),
    ).toThrow();
    expect(() =>
      originalStravaLaps(source, [lap, { ...lap, id: 102 }]),
    ).toThrow();
  });
});
