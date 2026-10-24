import { ConnectorProvider } from '@openathlete/database';

/** Storage IDs cannot collide with independently assigned Garmin/Polar IDs. */
export const stravaStorageId = (athleteId: number, externalId: string) =>
  `strava:${athleteId}:${externalId}`;

/** Public activity links still need Strava's original numeric activity ID. */
export function providerActivityId(
  provider: ConnectorProvider | null | undefined,
  storedId: string,
): string {
  if (provider === 'STRAVA') {
    const match = /^strava:[1-9]\d*:(\d+)$/.exec(storedId);
    if (match) return match[1];
  }
  return storedId;
}
