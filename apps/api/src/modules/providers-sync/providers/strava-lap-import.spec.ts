import axios from 'axios';

import { ProviderAccount } from '@openathlete/database';

import { StravaProviderService } from './strava.provider.service';

const account = {
  providerAccountId: 1,
  athleteId: 7,
  externalUserId: '99',
  provider: 'STRAVA',
  status: 'active',
} as ProviderAccount;
const start = new Date('2026-01-01T10:00:00Z');
const incoming = {
  externalId: '123',
  name: 'Synthetic run',
  startDate: start,
  endDate: new Date(start.getTime() + 300000),
  sport: 'RUNNING' as const,
  distance: 1000,
  duration: 300,
  raw: {
    id: 123,
    start_date: start.toISOString(),
    elapsed_time: 300,
    moving_time: 290,
    manual: false,
    sport_type: 'Run',
    distance: 1000,
    total_elevation_gain: 5,
    average_speed: 3,
    max_speed: 4,
  },
};

function setup(failLaps = false) {
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    eventActivity: { findFirst: jest.fn().mockResolvedValue(null) },
    event: {
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({
        activity: { eventActivityId: 80, provider: 'STRAVA' },
      }),
    },
    activityImportSource: { upsert: jest.fn() },
  };
  const prisma = {
    eventActivity: { findFirst: jest.fn().mockResolvedValue(null) },
    $transaction: jest.fn((fn: (value: typeof tx) => Promise<unknown>) =>
      fn(tx),
    ),
  };
  const service = new StravaProviderService(
    prisma as never,
    { get: jest.fn() } as never,
    {} as never,
  );
  jest
    .spyOn(service, 'getValidAccessToken')
    .mockResolvedValue('synthetic-access');
  const request = jest.spyOn(axios, 'get').mockImplementation(async (url) => {
    if (String(url).endsWith('/streams'))
      return {
        data: [
          { type: 'time', data: [0, 1, 2] },
          { type: 'heartrate', data: [100, 101, 102] },
        ],
      };
    if (String(url).endsWith('/laps')) {
      if (failLaps) throw new Error('Synthetic provider outage');
      return {
        data: [
          {
            id: 101,
            activity: { id: 123 },
            athlete: { id: 99 },
            lap_index: 0,
            name: 'Original lap',
            start_date: start.toISOString(),
            elapsed_time: 300,
            distance: 1000,
          },
        ],
      };
    }
    throw new Error('Unexpected provider request');
  });
  return { tx, prisma, service, request };
}

describe('Strava original-lap import wiring', () => {
  afterEach(() => jest.restoreAllMocks());
  it('fetches original laps with streams and stores stable identities during a new import', async () => {
    const { tx, service, request } = setup();
    const result = await service.importActivity(account, incoming);
    expect(result.created).toBe(true);
    expect(request.mock.calls.map(([url]) => url)).toEqual(
      expect.arrayContaining([
        'https://www.strava.com/api/v3/activities/123/streams',
        'https://www.strava.com/api/v3/activities/123/laps',
      ]),
    );
    expect(
      tx.event.create.mock.calls[0][0].data.activity.create.segments.create[0],
    ).toMatchObject({
      sourceProvider: 'STRAVA',
      sourceExternalId: '101',
      segmentType: 'LAP',
      startTimeSeconds: 0,
      endTimeSeconds: 300,
      sourceData: { lapIndex: 0 },
    });
  });
  it('retains the summary and stream if optional original laps cannot be read', async () => {
    const { tx, service } = setup(true);
    expect((await service.importActivity(account, incoming)).created).toBe(
      true,
    );
    const saved = tx.event.create.mock.calls[0][0].data.activity.create;
    expect(saved.stream.time).toBeDefined();
    expect(saved.segments.create).toEqual([]);
  });
  it('does not turn ordinary duplicate imports into a history backfill or overwrite user data', async () => {
    const { tx, prisma, service, request } = setup();
    prisma.eventActivity.findFirst.mockResolvedValue({
      eventActivityId: 80,
      description: 'User notes',
    } as never);
    expect((await service.importActivity(account, incoming)).created).toBe(
      false,
    );
    expect(request).not.toHaveBeenCalled();
    expect(tx.event.create).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
