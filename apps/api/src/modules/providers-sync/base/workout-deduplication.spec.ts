import { SportType } from '@openathlete/database';

import { sameWorkout } from './workout-deduplication';

const run = {
  sport: SportType.RUNNING,
  startDate: new Date('2026-01-01T10:00:00Z'),
  endDate: new Date('2026-01-01T11:00:00Z'),
  distance: 10000,
};

describe('cross-provider workout matching', () => {
  it('recognizes clock/distance rounding and a Health run classified as trail by Strava', () => {
    expect(
      sameWorkout(run, {
        ...run,
        sport: 'TRAIL_RUNNING',
        distance: 10200,
        startDate: new Date('2026-01-01T10:00:20Z'),
      }),
    ).toBe(true);
  });
  it.each([
    { sport: SportType.CYCLING },
    { distance: 15000 },
    { startDate: new Date('2026-01-01T10:00:31Z') },
    { endDate: new Date('2026-01-01T10:30:00Z') },
    { endDate: run.startDate },
    { endDate: new Date('invalid') },
  ])('keeps incompatible recordings separate: %o', (changes) => {
    expect(sameWorkout(run, { ...run, ...changes })).toBe(false);
  });
  it('can match zero-distance activities without comparing moving time', () => {
    expect(
      sameWorkout(
        { ...run, distance: 0, sport: 'YOGA' },
        { ...run, distance: 0, sport: 'YOGA' },
      ),
    ).toBe(true);
  });
  it('does not conflate virtual or electric cycling with an outdoor ride', () => {
    for (const sport of ['E_BIKE_RIDE', 'VIRTUAL_RIDE'] as const)
      expect(sameWorkout({ ...run, sport: 'CYCLING' }, { ...run, sport })).toBe(
        false,
      );
  });
});
