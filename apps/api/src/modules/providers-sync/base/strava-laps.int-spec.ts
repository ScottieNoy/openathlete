import {
  COACH_ATHLETE_ID,
  DELETED_ATHLETE_ID,
  accountFixtureSql,
} from 'src/modules/auth/services/account-deletion.fixture';
import { PrismaService } from 'src/modules/prisma/services/prisma.service';

import { appendOriginalStravaLaps, originalStravaLaps } from './strava-laps';

const databaseUrl = process.env.INTEGRATION_DATABASE_URL;
if (!databaseUrl)
  throw new Error(
    'INTEGRATION_DATABASE_URL must point to a disposable database',
  );
const source = {
  id: '123',
  athleteId: '99',
  startDate: new Date('2026-01-06T00:00:00Z'),
  elapsedSeconds: 3300,
};
const laps = [
  {
    id: 101,
    activity: { id: 123 },
    athlete: { id: 99 },
    lap_index: 0,
    name: 'Original warmup lap',
    start_date: '2026-01-06T00:00:00Z',
    elapsed_time: 300,
    average_heartrate: 130,
    distance: 1000,
  },
  {
    id: 102,
    activity: { id: 123 },
    athlete: { id: 99 },
    lap_index: 1,
    name: 'Original short lap',
    start_date: '2026-01-06T00:05:00Z',
    elapsed_time: 25,
    distance: 100,
    average_speed: 4,
  },
];

describe('Original Strava lap persistence (PostgreSQL)', () => {
  let prisma: PrismaService;
  beforeAll(async () => {
    prisma = new PrismaService({ datasourceUrl: databaseUrl });
    await prisma.$connect();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });
  beforeEach(async () => {
    const tables = await prisma.$queryRaw<
      { table_name: string }[]
    >`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' AND table_name <> '_prisma_migrations'`;
    await prisma.$executeRawUnsafe(
      `TRUNCATE ${tables.map((t) => `"${t.table_name}"`).join(', ')} RESTART IDENTITY CASCADE`,
    );
    for (const sql of accountFixtureSql) await prisma.$executeRawUnsafe(sql);
    await prisma.eventActivity.update({
      where: { eventActivityId: 3501 },
      data: {
        provider: 'STRAVA',
        externalId: `strava:${DELETED_ATHLETE_ID}:123`,
        description: 'Keep user notes',
        stream: { time: [0, 1], distance: [0, 4] },
      },
    });
    await prisma.activitySegment.deleteMany({
      where: { eventActivityId: 3501 },
    });
  });
  const input = () => ({
    athleteId: DELETED_ATHLETE_ID,
    eventActivityId: 3501,
    source,
    laps,
  });
  const stored = () =>
    prisma.activitySegment.findMany({
      where: { eventActivityId: 3501 },
      orderBy: { orderIndex: 'asc' },
    });

  it('imports original identities once and preserves existing values, notes and streams on retry', async () => {
    const before = await prisma.eventActivity.findUniqueOrThrow({
      where: { eventActivityId: 3501 },
    });
    expect((await appendOriginalStravaLaps(prisma, input())).imported).toBe(2);
    const first = await stored();
    expect(first[1]).toMatchObject({
      sourceProvider: 'STRAVA',
      sourceExternalId: '102',
      startTimeSeconds: 300,
      endTimeSeconds: 325,
      segmentType: 'LAP',
    });
    expect(
      (
        await appendOriginalStravaLaps(prisma, {
          ...input(),
          laps: laps.map((lap) => ({
            ...lap,
            name: 'Changed upstream name',
            distance: 999,
          })),
        })
      ).imported,
    ).toBe(0);
    expect(await stored()).toEqual(first);
    expect(
      await prisma.eventActivity.findUniqueOrThrow({
        where: { eventActivityId: 3501 },
      }),
    ).toEqual(before);
  });

  it('serializes concurrent imports and keeps one row per original lap', async () => {
    const results = await Promise.all([
      appendOriginalStravaLaps(prisma, input()),
      appendOriginalStravaLaps(prisma, input()),
    ]);
    expect(results.reduce((sum, r) => sum + r.imported, 0)).toBe(2);
    expect(await stored()).toHaveLength(2);
  });

  it('adds only missing identities when a prior provider import was partial', async () => {
    await prisma.activitySegment.createMany({
      data: originalStravaLaps(source, [laps[0]]).map((s) => ({
        ...s,
        eventActivityId: 3501,
      })),
    });
    const first = (await stored())[0];
    expect((await appendOriginalStravaLaps(prisma, input())).imported).toBe(1);
    expect((await stored())[0]).toEqual(first);
    expect(await stored()).toHaveLength(2);
  });

  it.each(['LAP', 'MANUAL', 'WORKOUT_STEP'] as const)(
    'protects existing %s segments without guessing whether they match provider laps',
    async (segmentType) => {
      await prisma.activitySegment.create({
        data: {
          eventActivityId: 3501,
          segmentType,
          orderIndex: 0,
          name: 'User original',
          startTimeSeconds: 0,
          endTimeSeconds: 600,
        },
      });
      const before = await stored();
      expect(await appendOriginalStravaLaps(prisma, input())).toEqual({
        imported: 0,
        protectedExistingSegments: true,
      });
      expect(await stored()).toEqual(before);
    },
  );

  it('refuses another athlete or mismatched source identity before inserts', async () => {
    await expect(
      appendOriginalStravaLaps(prisma, {
        ...input(),
        athleteId: COACH_ATHLETE_ID,
      }),
    ).rejects.toThrow('does not belong');
    await expect(
      appendOriginalStravaLaps(prisma, {
        ...input(),
        source: { ...source, id: '124' },
        laps: [],
      }),
    ).rejects.toThrow('does not belong');
    expect(await stored()).toEqual([]);
  });

  it('follows an existing athlete-scoped Strava alias without replacing a Health recording', async () => {
    await prisma.eventActivity.update({
      where: { eventActivityId: 3501 },
      data: { provider: 'APPLE_HEALTH', externalId: 'health-original' },
    });
    await prisma.activityImportSource.create({
      data: {
        eventActivityId: 3501,
        athleteId: DELETED_ATHLETE_ID,
        provider: 'STRAVA',
        externalId: '123',
      },
    });
    expect((await appendOriginalStravaLaps(prisma, input())).imported).toBe(2);
    expect(
      await prisma.eventActivity.findUniqueOrThrow({
        where: { eventActivityId: 3501 },
      }),
    ).toMatchObject({
      provider: 'APPLE_HEALTH',
      externalId: 'health-original',
      description: 'Keep user notes',
    });
  });

  it('leaves empty/malformed provider data empty rather than generating splits or partial laps', async () => {
    expect(
      (await appendOriginalStravaLaps(prisma, { ...input(), laps: [] }))
        .imported,
    ).toBe(0);
    await expect(
      appendOriginalStravaLaps(prisma, {
        ...input(),
        laps: [laps[0], { ...laps[1], activity: { id: 124 } }],
      }),
    ).rejects.toThrow();
    expect(await stored()).toEqual([]);
  });
});
