import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { importedWorkout, registerWearablesTools } from './wearables.tools';

const workout = {
  sourceId: '00000000-0000-0000-0000-000000000001',
  name: 'Ride',
  sport: 'CYCLING',
  start: '2020-01-01T10:00:00Z',
  end: '2020-01-01T11:00:00Z',
  movingTime: 3000,
  distance: 25000,
  elevationGain: 200,
  averageSpeed: 8,
  maxSpeed: 12,
  averageWatts: 200,
  laps: [{ start: 0, end: 600, distance: 4000 }],
};
function setup(self = true, canWrite = true) {
  type Handler = (args: {
    workout: z.output<typeof importedWorkout>;
  }) => Promise<CallToolResult>;
  const tools: Record<string, Handler> = {};
  const server = {
    registerTool: (name: string, _config: unknown, handler: Handler) => {
      tools[name] = handler;
    },
  };
  const tx = {
    eventActivity: { findFirst: jest.fn().mockResolvedValue(null) },
    $queryRaw: jest.fn().mockResolvedValue([]),
    activityImportSource: { upsert: jest.fn() },
    event: {
      findMany: jest.fn().mockResolvedValue([]),
      create: jest
        .fn()
        .mockResolvedValue({ activity: { eventActivityId: 7, eventId: 9 } }),
    },
  };
  const prisma = {
    $transaction: jest.fn(async (fn: (client: typeof tx) => Promise<unknown>) =>
      fn(tx),
    ),
  };
  const queue = {
    addActivityProcessingJob: jest.fn().mockResolvedValue(undefined),
  };
  const ctx = {
    athlete: jest.fn().mockResolvedValue({ athleteId: 1, isSelf: self }),
    can: () => canWrite,
  };
  registerWearablesTools(
    server as never,
    ctx as never,
    { prisma, queue } as never,
  );
  const call = (value: unknown = workout) =>
    tools.import_wearable_workout({ workout: importedWorkout.parse(value) });
  return { tx, prisma, queue, call };
}

describe('Open Wearables workout import', () => {
  it('binds writes to the owner and preserves original summary and laps', async () => {
    const s = setup();
    const result = await s.call();
    expect(result.isError).toBeUndefined();
    const saved = s.tx.event.create.mock.calls[0][0].data;
    expect(saved.athleteId).toBe(1);
    expect(saved.activity.create.provider).toBe('APPLE_HEALTH');
    expect(saved.activity.create.externalId).toBe(
      'openwearables:1:' + workout.sourceId,
    );
    expect(saved.activity.create.averageWatts).toBe(200);
    expect(saved.activity.create.segments.create[0]).toMatchObject({
      startTimeSeconds: 0,
      endTimeSeconds: 600,
      distance: 4000,
    });
    expect(saved.activity.create.stream).toBeUndefined();
    expect(s.queue.addActivityProcessingJob).toHaveBeenCalledWith(7, 9, true);
  });
  it('refuses coach-only access and missing write scope before database writes', async () => {
    for (const s of [setup(false), setup(true, false)]) {
      expect((await s.call()).isError).toBe(true);
      expect(s.prisma.$transaction).not.toHaveBeenCalled();
    }
  });
  it('returns an existing source import without rewriting user edits', async () => {
    const s = setup();
    s.tx.eventActivity.findFirst.mockResolvedValue({
      provider: 'APPLE_HEALTH',
      eventId: 9,
      eventActivityId: 7,
    } as never);
    const result = await s.call();
    expect(result.structuredContent?.alreadyImported).toBe(true);
    expect(s.tx.event.create).not.toHaveBeenCalled();
  });
  it('protects a nearby existing recording from another provider', async () => {
    const s = setup();
    s.tx.event.findMany.mockResolvedValue([
      {
        startDate: new Date(workout.start),
        endDate: new Date(workout.end),
        activity: {
          eventActivityId: 7,
          eventId: 9,
          provider: 'STRAVA',
          sport: 'CYCLING',
          distance: 25000,
        },
      },
    ] as never);
    const result = await s.call();
    expect(result.structuredContent?.protected).toBe(true);
    expect(s.tx.event.create).not.toHaveBeenCalled();
    expect(s.queue.addActivityProcessingJob).not.toHaveBeenCalled();
  });
  it('does not confirm processing when the durable queue is unavailable', async () => {
    const s = setup();
    s.queue.addActivityProcessingJob.mockRejectedValue(
      new Error('queue offline'),
    );
    const result = await s.call();
    expect(result.structuredContent?.processingQueued).toBe(false);
  });
  it('rejects inconsistent durations and laps before database writes', async () => {
    for (const value of [
      { ...workout, movingTime: 4000 },
      { ...workout, laps: [{ start: 600, end: 4000 }] },
    ]) {
      const s = setup();
      expect((await s.call(value)).isError).toBe(true);
      expect(s.prisma.$transaction).not.toHaveBeenCalled();
    }
    expect(() =>
      importedWorkout.parse({ ...workout, averageWatts: NaN }),
    ).toThrow();
    expect(() =>
      importedWorkout.parse({ ...workout, sourceId: 'someone-else' }),
    ).toThrow();
  });
});
