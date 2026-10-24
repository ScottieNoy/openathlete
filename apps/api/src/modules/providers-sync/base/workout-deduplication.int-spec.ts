import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { ProviderAccount } from '@openathlete/database';

import { StravaSummaryActivity } from '../../core/types/connector';
import {
  importedWorkout,
  registerWearablesTools,
} from '../../mcp/server/tools/wearables.tools';
import { PrismaService } from '../../prisma/services/prisma.service';
import { StravaProviderService } from '../providers/strava.provider.service';

const databaseUrl = process.env.INTEGRATION_DATABASE_URL;
if (!databaseUrl)
  throw new Error(
    'INTEGRATION_DATABASE_URL must point to a disposable test database',
  );

const startDate = new Date('2026-01-01T10:00:00Z');
const endDate = new Date('2026-01-01T11:00:00Z');
const health = {
  sourceId: '00000000-0000-0000-0000-000000000001',
  name: 'Health run',
  sport: 'RUNNING',
  start: startDate.toISOString(),
  end: endDate.toISOString(),
  distance: 10000,
  movingTime: 3300,
  elevationGain: 100,
  averageSpeed: 3,
  maxSpeed: 5,
  laps: [{ start: 0, end: 600, distance: 1700 }],
};

describe('Apple Health / Strava imports (PostgreSQL)', () => {
  let prisma: PrismaService;
  let athleteId: number;
  let otherAthleteId: number;
  let strava: StravaProviderService;
  const queue = {
    addActivityProcessingJob: jest.fn().mockResolvedValue(undefined),
    addActivityImportJobs: jest.fn().mockResolvedValue(undefined),
  };

  beforeAll(async () => {
    prisma = new PrismaService({ datasourceUrl: databaseUrl });
    await prisma.$connect();
    strava = new StravaProviderService(
      prisma,
      { get: jest.fn() } as never,
      queue as never,
    );
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    const tables = await prisma.$queryRaw<{ table_name: string }[]>`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name <> '_prisma_migrations'`;
    await prisma.$executeRawUnsafe(
      `TRUNCATE ${tables.map((t) => `"${t.table_name}"`).join(', ')} RESTART IDENTITY CASCADE`,
    );
    const createAthlete = (email: string) =>
      prisma.user.create({
        data: {
          email,
          password: 'unused',
          firstName: 'Test',
          lastName: 'Only',
          roles: ['ATHLETE'],
          athlete: { create: {} },
        },
        include: { athlete: true },
      });
    athleteId = (await createAthlete('one@example.invalid')).athlete!.athleteId;
    otherAthleteId = (await createAthlete('two@example.invalid')).athlete!
      .athleteId;
    jest.clearAllMocks();
  });

  async function apple(value = health, owner = athleteId) {
    let handler!: (args: { workout: unknown }) => Promise<CallToolResult>;
    registerWearablesTools(
      {
        registerTool: (_name: string, _config: unknown, fn: typeof handler) => {
          handler = fn;
        },
      } as never,
      {
        athlete: async () => ({ athleteId: owner, isSelf: true }),
        can: () => true,
      } as never,
      { prisma, queue } as never,
    );
    const result = await handler({ workout: importedWorkout.parse(value) });
    if (result.isError) throw new Error(JSON.stringify(result));
    return result.structuredContent!;
  }
  const fetchedStrava = (id = '123', changes = {}) => ({
    externalId: id,
    name: 'Strava run',
    startDate,
    endDate,
    sport: 'RUNNING',
    distance: 10000,
    duration: 3600,
    raw: {
      id: Number(id),
      name: 'Strava run',
      sport_type: 'Run',
      type: 'Run',
      manual: true,
      distance: 10000,
      total_elevation_gain: 100,
      moving_time: 3200,
      elapsed_time: 3600,
      start_date: startDate.toISOString(),
      average_speed: 3,
      max_speed: 5,
    } as StravaSummaryActivity,
    ...changes,
  });
  const account = (owner = athleteId) =>
    ({ athleteId: owner }) as ProviderAccount;

  it.each(['apple-first', 'strava-first', 'concurrent'])(
    'saves one event and both stable identities: %s',
    async (order) => {
      let appleResult: Record<string, unknown>;
      let stravaResult;
      if (order === 'apple-first') {
        appleResult = await apple();
        stravaResult = await strava.importActivity(account(), fetchedStrava());
      } else if (order === 'strava-first') {
        stravaResult = await strava.importActivity(account(), fetchedStrava());
        appleResult = await apple();
      } else {
        [appleResult, stravaResult] = await Promise.all([
          apple(),
          strava.importActivity(account(), fetchedStrava()),
        ]);
      }
      expect(appleResult.eventId).toBe(stravaResult.activity.eventId);
      expect(await prisma.event.count()).toBe(1);
      expect(await prisma.activityImportSource.count()).toBe(2);
      expect(
        Number(appleResult.alreadyImported) + Number(!stravaResult.created),
      ).toBe(1);
    },
  );

  it('keeps stable aliases after the athlete edits time, sport, title and summary', async () => {
    const result = await apple();
    await strava.importActivity(account(), fetchedStrava());
    await prisma.event.update({
      where: { eventId: result.eventId as number },
      data: {
        name: 'My edited session',
        startDate: new Date('2026-01-01T15:00:00Z'),
        activity: {
          update: {
            sport: 'HIKING',
            distance: 5555,
            description: 'My notes',
            rpe: 0.7,
          },
        },
      },
    });
    await Promise.all([
      apple(),
      strava.importActivity(account(), fetchedStrava()),
    ]);
    expect(await prisma.event.count()).toBe(1);
    expect(
      await prisma.event.findFirst({ include: { activity: true } }),
    ).toMatchObject({
      name: 'My edited session',
      activity: {
        sport: 'HIKING',
        distance: 5555,
        description: 'My notes',
        rpe: 0.7,
      },
    });
    jest
      .spyOn(strava, 'importActivities')
      .mockResolvedValueOnce([fetchedStrava()]);
    expect(await strava.queueFullImport(account())).toEqual({
      queuedActivities: 0,
    });
    expect(queue.addActivityImportJobs).not.toHaveBeenCalled();
  });

  it('recognizes a linked Strava webhook without fetching or queuing another copy', async () => {
    await apple();
    await strava.importActivity(account(), fetchedStrava());
    await prisma.providerAccount.create({
      data: {
        athleteId,
        provider: 'STRAVA',
        accessToken: 'unused-test-token',
        externalUserId: '88',
      },
    });
    await strava.handleWebhook({
      object_id: 123,
      owner_id: 88,
      aspect_type: 'create',
    });
    expect(await prisma.event.count()).toBe(1);
  });

  it('serializes retries of the same source as well as different providers', async () => {
    await Promise.all([apple(), apple(), apple()]);
    await Promise.all([
      strava.importActivity(account(), fetchedStrava()),
      strava.importActivity(account(), fetchedStrava()),
    ]);
    expect(await prisma.event.count()).toBe(1);
    expect(await prisma.activityImportSource.count()).toBe(2);
  });

  it('does not combine the same recording belonging to different athletes', async () => {
    await apple();
    await strava.importActivity(account(otherAthleteId), fetchedStrava());
    expect(await prisma.event.count()).toBe(2);
  });

  it('does not confuse Garmin and Strava numeric IDs, or the same ID in different athlete accounts', async () => {
    await prisma.event.create({
      data: {
        athleteId,
        type: 'ACTIVITY',
        name: 'Different Garmin workout',
        startDate: new Date('2025-12-01T10:00:00Z'),
        endDate: new Date('2025-12-01T11:00:00Z'),
        activity: {
          create: {
            provider: 'GARMIN',
            externalId: '123',
            sport: 'RUNNING',
            movingTime: 3300,
            distance: 10000,
            elevationGain: 100,
            averageSpeed: 3,
            maxSpeed: 5,
          },
        },
      },
    });
    const one = await strava.importActivity(account(), fetchedStrava());
    const two = await strava.importActivity(
      account(otherAthleteId),
      fetchedStrava(),
    );
    expect(one.activity.externalId).toBe(`strava:${athleteId}:123`);
    expect(two.activity.externalId).toBe(`strava:${otherAthleteId}:123`);
    expect(await prisma.event.count()).toBe(3);
    expect(await prisma.activityImportSource.count()).toBe(2);
    expect(
      (await strava.importActivity(account(), fetchedStrava())).created,
    ).toBe(false);
  });

  it('does not combine nearby recordings with different duration or distance', async () => {
    await apple();
    await strava.importActivity(
      account(),
      fetchedStrava('123', { endDate: new Date('2026-01-01T10:30:00Z') }),
    );
    await strava.importActivity(
      account(),
      fetchedStrava('124', {
        distance: 20000,
        raw: { ...fetchedStrava().raw, id: 124, distance: 20000 },
      }),
    );
    expect(await prisma.event.count()).toBe(3);
  });

  it('leaves ambiguous pre-existing duplicates untouched rather than guessing or deleting', async () => {
    await apple();
    // Simulate duplicates that already existed before this release.
    await prisma.event.create({
      data: {
        athleteId,
        type: 'ACTIVITY',
        name: 'Old duplicate',
        startDate,
        endDate,
        activity: {
          create: {
            provider: 'APPLE_HEALTH',
            externalId: 'old-health-duplicate',
            sport: 'RUNNING',
            movingTime: 3300,
            distance: 10000,
            elevationGain: 100,
            averageSpeed: 3,
            maxSpeed: 5,
          },
        },
      },
    });
    await strava.importActivity(account(), fetchedStrava());
    expect(await prisma.event.count()).toBe(3);
  });

  it.each(['apple-first', 'strava-first'])(
    'recognizes multiple Health UUIDs for copies from recording apps: %s',
    async (order) => {
      if (order === 'strava-first')
        await strava.importActivity(account(), fetchedStrava());
      await apple();
      await apple({
        ...health,
        sourceId: '00000000-0000-0000-0000-000000000002',
      });
      if (order === 'apple-first')
        await strava.importActivity(account(), fetchedStrava());
      expect(await prisma.event.count()).toBe(1);
      expect(await prisma.activityImportSource.count()).toBe(3);
    },
  );

  it('recognizes legacy imports without aliases and preserves their existing streams', async () => {
    const first = await strava.importActivity(account(), fetchedStrava());
    await prisma.activityImportSource.deleteMany();
    await prisma.eventActivity.update({
      where: { eventActivityId: first.activity.eventActivityId },
      data: {
        externalId: '123',
        stream: { time: [0, 1], heartrate: [120, 121] },
      },
    });
    expect((await apple()).eventId).toBe(first.activity.eventId);
    expect(await prisma.eventActivity.findFirst()).toMatchObject({
      stream: { time: [0, 1], heartrate: [120, 121] },
    });
    expect(await prisma.event.count()).toBe(1);
  });

  it('rolls back the calendar event if saving its source identity fails', async () => {
    await prisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION reject_import_source()
      RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'source failure'; END $$`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER reject_import_source BEFORE INSERT
      ON activity_import_source FOR EACH ROW EXECUTE FUNCTION reject_import_source()`);
    try {
      await expect(
        strava.importActivity(account(), fetchedStrava()),
      ).rejects.toThrow('source failure');
      expect(await prisma.event.count()).toBe(0);
    } finally {
      await prisma.$executeRawUnsafe(
        'DROP TRIGGER reject_import_source ON activity_import_source',
      );
      await prisma.$executeRawUnsafe('DROP FUNCTION reject_import_source()');
    }
  });
});
