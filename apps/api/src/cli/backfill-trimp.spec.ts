import { backfillMissingTrimp } from './backfill-trimp';

function setup() {
  const stored = new Set([202]);
  const events = [
    {
      eventId: 19,
      startDate: new Date('2026-09-14T08:12:00Z'),
      activity: {
        eventActivityId: 101,
        averageHeartrate: 145,
        movingTime: 3000,
      },
    },
    {
      eventId: 1113,
      startDate: new Date('2026-10-13T13:44:00Z'),
      activity: {
        eventActivityId: 202,
        averageHeartrate: 148,
        movingTime: 3300,
      },
    },
  ];
  const prisma = {
    user: {
      findFirst: jest
        .fn()
        .mockResolvedValue({ userId: 10, email: 'runner@example.test' }),
    },
    athlete: {
      findUnique: jest.fn().mockResolvedValue({ athleteId: 1 }),
    },
    athleteMetric: {
      findFirst: jest.fn(async ({ where }: { where: { type: string } }) => ({
        value: where.type === 'HR_MAX' ? 197 : 58,
      })),
    },
    trainingLoadCalculation: {
      findUnique: jest.fn().mockResolvedValue({ trainingLoadCalculationId: 7 }),
    },
    trainingLoadEntry: {
      findMany: jest.fn(async () =>
        [...stored].map((activityId) => ({ activityId })),
      ),
    },
    event: { findMany: jest.fn().mockResolvedValue(events) },
    eventActivity: { findUnique: jest.fn() },
  };
  const trainingLoad = {
    calculateActivityLoad: jest.fn(async (_user, eventId: number) => {
      if (eventId === 19) stored.add(101);
      return { value: 74 };
    }),
  };
  const deps = { prisma, trainingLoad } as unknown as Parameters<
    typeof backfillMissingTrimp
  >[1];
  const lines: string[] = [];
  const run = (...args: string[]) =>
    backfillMissingTrimp(args, deps, (line) => lines.push(line));

  return { prisma, trainingLoad, stored, lines, run };
}

describe('backfillMissingTrimp', () => {
  it('only previews by default, preserving every stored load', async () => {
    const { run, prisma, trainingLoad, lines, stored } = setup();
    expect(await run('runner@example.test')).toBe(0);
    expect(trainingLoad.calculateActivityLoad).not.toHaveBeenCalled();
    expect(prisma.trainingLoadEntry.findMany).toHaveBeenCalledTimes(1);
    expect([...stored]).toEqual([202]);
    expect(lines.join(' ')).toContain('1 missing candidates');
    expect(lines.join(' ')).toContain('Dry run only');
  });

  it('calculates only missing load and verifies persistence on --yes', async () => {
    const { run, trainingLoad, lines, stored } = setup();
    expect(await run('runner@example.test', '--yes')).toBe(0);
    expect(trainingLoad.calculateActivityLoad).toHaveBeenCalledTimes(1);
    expect(trainingLoad.calculateActivityLoad).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 10,
        athlete: { athleteId: 1 },
      }),
      19,
      'TRIMP',
    );
    expect([...stored].sort()).toEqual([101, 202]);
    expect(lines.join(' ')).toContain('Verified 2 stored TRIMP entries');

    trainingLoad.calculateActivityLoad.mockClear();
    expect(await run('runner@example.test', '--yes')).toBe(0);
    expect(trainingLoad.calculateActivityLoad).not.toHaveBeenCalled();
  });

  it('uses an inclusive date range and rejects malformed flags', async () => {
    const { run, prisma, trainingLoad } = setup();
    expect(
      await run('runner@example.test', '--from', '2026-09-01', '--to', '2026-09-30'),
    ).toBe(0);
    expect(prisma.event.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          startDate: {
            gte: new Date('2026-09-01T00:00:00Z'),
            lt: new Date('2026-10-01T00:00:00Z'),
          },
        }),
      }),
    );
    expect(await run('runner@example.test', '--from', '2026-02-30', '--yes')).toBe(1);
    expect(await run('runner@example.test', '--wrong', '--yes')).toBe(1);
    expect(await run('runner@example.test', '--to', '2026-09-01', '--from', '2026-10-01', '--yes')).toBe(1);
    expect(trainingLoad.calculateActivityLoad).not.toHaveBeenCalled();
  });

  it('refuses writes if HR metrics are unavailable', async () => {
    const { run, prisma, trainingLoad, lines } = setup();
    prisma.athleteMetric.findFirst.mockResolvedValue(null as never);
    expect(await run('runner@example.test', '--yes')).toBe(1);
    expect(trainingLoad.calculateActivityLoad).not.toHaveBeenCalled();
    expect(lines.join(' ')).toContain('no changes made');
  });

  it('leaves activities without HR data untouched', async () => {
    const { run, prisma, trainingLoad, lines } = setup();
    prisma.event.findMany.mockResolvedValueOnce([
      {
        eventId: 19,
        activity: { eventActivityId: 101, averageHeartrate: null, movingTime: 3000 },
      },
    ] as never);
    prisma.eventActivity.findUnique.mockResolvedValueOnce({ stream: null } as never);
    expect(await run('runner@example.test', '--yes')).toBe(0);
    expect(trainingLoad.calculateActivityLoad).not.toHaveBeenCalled();
    expect(lines.join(' ')).toContain('1 without HR data');
  });
});
