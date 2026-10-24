import { providerActivityId, stravaStorageId } from './provider-activity-id';

describe('provider activity storage IDs', () => {
  it('scopes new Strava identities to the provider and athlete', () => {
    expect(stravaStorageId(1, '123')).toBe('strava:1:123');
    expect(stravaStorageId(2, '123')).not.toBe(stravaStorageId(1, '123'));
  });
  it('exposes the original Strava ID for public links without changing legacy or other IDs', () => {
    expect(providerActivityId('STRAVA', 'strava:1:123')).toBe('123');
    expect(providerActivityId('STRAVA', '123')).toBe('123');
    expect(providerActivityId('GARMIN', '123')).toBe('123');
    expect(providerActivityId('GARMIN', 'strava:1:123')).toBe('strava:1:123');
    expect(providerActivityId('STRAVA', 'strava:1:invalid')).toBe(
      'strava:1:invalid',
    );
  });
});
