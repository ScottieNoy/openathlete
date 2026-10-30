import { z } from 'zod';

import { Prisma, SportType } from '@openathlete/database';
import {
  activityStreamAvailabilitySchema,
  activityStreamInputSchema,
  activityStreamOutputSchema,
} from '@openathlete/shared';

import { zonedClock } from 'src/common/utils/time-zone';
import { accessibleBy } from 'src/modules/auth/services/casl-prisma';

import { inspectActivityStreams } from '../activity-streams';
import { ToolError, athleteIdInput, run } from '../context';
import { localDate, localRange } from '../dates';
import {
  CALENDAR_INCLUDE,
  EVENT_TYPE_OF_KIND,
  calendarItemSchema,
  speedFields,
  toCalendarItem,
  workoutOf,
} from '../presenters';
import { workoutSchema } from '../workout-format';
import { READ_ONLY, ToolRegistrar, registerTool, zoneNamesOf } from './deps';

const round = (value: number, digits = 0) =>
  Math.round(value * 10 ** digits) / 10 ** digits;

const periodSchema = z.object({
  periodId: z.number(),
  name: z.string(),
  kind: z.enum(['training', 'travel', 'illness', 'injury']),
  startDate: z.string(),
  endDate: z.string(),
  description: z.string().optional(),
});

const calendarOutput = z.object({
  athleteId: z.number(),
  timeZone: z.string(),
  today: z.string(),
  from: z.string(),
  to: z.string(),
  items: z.array(calendarItemSchema),
  periods: z.array(periodSchema),
});

const sessionOutput = z.object({
  session: calendarItemSchema,
  workoutSteps: workoutSchema
    .optional()
    .describe('The structured workout, in the format update_session takes'),
  doneActivity: calendarItemSchema.optional(),
});

const activityOutput = z.object({
  activity: calendarItemSchema,
  laps: z
    .array(
      z.object({
        segmentId: z.number(),
        orderIndex: z.number(),
        startTimeSeconds: z
          .number()
          .describe('Seconds from activity start, inclusive'),
        endTimeSeconds: z
          .number()
          .describe(
            'Seconds from activity start; exclusive except the final segment may include its endpoint',
          ),
        elapsedSeconds: z.number(),
        movingSeconds: z.number().optional(),
        name: z.string().optional(),
        type: z.string(),
        minutes: z.number(),
        distanceKm: z.number().optional(),
        avgHeartRate: z.number().optional(),
        avgPower: z.number().optional(),
        maxHeartRate: z.number().optional().describe('bpm'),
        avgCadence: z
          .number()
          .optional()
          .describe(
            'Provider-recorded revolutions or steps per minute; no running cadence doubling',
          ),
        avgSpeedMetersPerSecond: z.number().optional(),
        avgPaceSecondsPerKm: z.number().optional(),
        avgPace: z.string().optional(),
        avgSpeedKmh: z.number().optional(),
      }),
    )
    .describe(
      'Stored segments of their stated type; an empty array does not mean streams are missing. minutes uses moving time when stored, otherwise elapsed time.',
    ),
  lapPage: z.object({
    total: z.number(),
    offset: z.number(),
    nextOffset: z.number().nullable(),
  }),
  streams: activityStreamAvailabilitySchema.describe(
    'Read values with get_activity_streams; missing means not stored, not omitted by this tool',
  ),
  feedback: z
    .array(z.object({ question: z.string(), answer: z.string() }))
    .describe("The athlete's answers after the activity"),
  plannedSession: calendarItemSchema.optional(),
});

const activitiesOutput = z.object({
  athleteId: z.number(),
  from: z.string(),
  to: z.string(),
  count: z.number(),
  truncated: z
    .boolean()
    .describe('More activities than the limit: narrow the range'),
  activities: z.array(calendarItemSchema),
});

const templateSchema = calendarItemSchema
  .omit({
    eventId: true,
    date: true,
    start: true,
    status: true,
    doneActivityId: true,
    completion: true,
  })
  .extend({
    templateId: z.number(),
    folder: z.string().optional(),
    workoutSteps: workoutSchema.optional(),
  });

const templatesOutput = z.object({ templates: z.array(templateSchema) });

const kindsInput = z
  .array(z.enum(['training', 'race', 'note', 'activity']))
  .optional()
  .describe('Only these kinds of items; all by default');

export const registerCalendarReadTools: ToolRegistrar = (server, ctx, deps) => {
  const prisma = deps.prisma;

  registerTool(
    server,
    'get_calendar',
    {
      title: 'Calendar',
      description:
        'Planned sessions, races, notes and done activities between two dates (at most 92 days), with the periods overlapping them. Planned sessions show their workout in one line and whether they were done or missed; activities show their metrics and load.',
      inputSchema: {
        athleteId: athleteIdInput,
        from: localDate.describe('First day, YYYY-MM-DD'),
        to: localDate.describe('Last day, included, YYYY-MM-DD'),
        types: kindsInput,
      },
      outputSchema: calendarOutput,
      annotations: READ_ONLY,
    },
    ({ athleteId, from, to, types }) =>
      run(calendarOutput, async () => {
        const scope = await ctx.athlete(athleteId);
        const { start, end } = localRange(from, to, scope.timeZone, 92);
        const ability = await deps.abilities.getFor({ user: ctx.user });
        const [events, periods, zoneNames] = await Promise.all([
          prisma.event.findMany({
            where: {
              AND: [
                accessibleBy(ability, 'read').Event,
                { athleteId: scope.athleteId },
                { startDate: { gte: start, lte: end } },
                ...(types?.length
                  ? [
                      {
                        type: {
                          in: types.map((kind) => EVENT_TYPE_OF_KIND[kind]),
                        },
                      },
                    ]
                  : []),
              ],
            },
            include: CALENDAR_INCLUDE,
            orderBy: { startDate: 'asc' },
          }),
          prisma.cycle.findMany({
            where: {
              athleteId: scope.athleteId,
              startDate: { lte: end },
              endDate: { gte: start },
            },
            orderBy: { startDate: 'asc' },
          }),
          zoneNamesOf(deps, scope.athleteId),
        ]);
        const day = (instant: Date) => zonedClock(instant, scope.timeZone).date;
        return {
          athleteId: scope.athleteId,
          timeZone: scope.timeZone,
          today: scope.today,
          from,
          to,
          items: events.map((event) =>
            toCalendarItem(event, scope.timeZone, scope.today, zoneNames),
          ),
          periods: periods.map((period) => ({
            periodId: period.cycleId,
            name: period.name,
            kind: period.kind.toLowerCase() as z.infer<
              typeof periodSchema
            >['kind'],
            startDate: day(period.startDate),
            endDate: day(period.endDate),
            ...(period.description && { description: period.description }),
          })),
        };
      }),
  );

  /** An event the user can read, with what the presenters need */
  const readEvent = async (eventId: number) => {
    const scope = await ctx.athleteOfEvent(eventId);
    const ability = await deps.abilities.getFor({ user: ctx.user });
    const event = await prisma.event.findFirst({
      where: { AND: [{ eventId }, accessibleBy(ability, 'read').Event] },
      include: CALENDAR_INCLUDE,
    });
    if (!event) {
      throw new ToolError(`Event ${eventId} not found.`);
    }
    return { scope, event, ability };
  };

  registerTool(
    server,
    'get_session',
    {
      title: 'Session details',
      description:
        'One planned session or race in full: its structured workout step by step (in the format update_session takes) and the activity that fulfilled it, if any.',
      inputSchema: {
        eventId: z.number().int().describe('eventId from get_calendar'),
      },
      outputSchema: sessionOutput,
      annotations: READ_ONLY,
    },
    ({ eventId }) =>
      run(sessionOutput, async () => {
        const { scope, event, ability } = await readEvent(eventId);
        const zoneNames = await zoneNamesOf(deps, scope.athleteId);
        const doneId =
          event.training?.relatedActivity?.eventId ??
          event.competition?.relatedActivity?.eventId;
        const done = doneId
          ? await prisma.event.findFirst({
              where: {
                AND: [{ eventId: doneId }, accessibleBy(ability, 'read').Event],
              },
              include: CALENDAR_INCLUDE,
            })
          : null;
        const workoutSteps = workoutOf(event, zoneNames);
        return {
          session: toCalendarItem(
            event,
            scope.timeZone,
            scope.today,
            zoneNames,
          ),
          ...(workoutSteps && { workoutSteps }),
          ...(done && {
            doneActivity: toCalendarItem(
              done,
              scope.timeZone,
              scope.today,
              zoneNames,
            ),
          }),
        };
      }),
  );

  registerTool(
    server,
    'get_activity',
    {
      title: 'Activity details',
      description:
        'One done activity: metrics, paginated stored laps/segments, stream availability, feedback and planned session. Use get_activity_streams for aligned time-series values. lapPage.total counts stored segments even on an empty page; stream availability is independent.',
      inputSchema: {
        eventId: z.number().int().describe('eventId of the activity'),
        lapOffset: z.number().int().min(0).max(2147483647).default(0),
        lapLimit: z.number().int().min(1).max(100).default(100),
      },
      outputSchema: activityOutput,
      annotations: READ_ONLY,
    },
    ({ eventId, lapOffset, lapLimit }) =>
      run(activityOutput, async () => {
        const { scope, event, ability } = await readEvent(eventId);
        if (!event.activity) {
          throw new ToolError(
            `Event ${eventId} is not an activity: use get_session for planned sessions.`,
          );
        }
        const [details, zoneNames] = await Promise.all([
          prisma.eventActivity.findUniqueOrThrow({
            where: { eventActivityId: event.activity.eventActivityId },
            select: {
              stream: true,
              _count: { select: { segments: true } },
              segments: {
                orderBy: [{ orderIndex: 'asc' }, { activitySegmentId: 'asc' }],
                skip: lapOffset,
                take: lapLimit,
              },
              feedbackQuestions: {
                where: { answerText: { not: null } },
                orderBy: { activityFeedbackQuestionId: 'asc' },
                select: { questionText: true, answerText: true },
              },
            },
          }),
          zoneNamesOf(deps, scope.athleteId),
        ]);
        const plannedId =
          event.activity.relatedTraining?.eventId ??
          event.activity.relatedCompetition?.eventId;
        const planned = plannedId
          ? await prisma.event.findFirst({
              where: {
                AND: [
                  { eventId: plannedId },
                  accessibleBy(ability, 'read').Event,
                ],
              },
              include: CALENDAR_INCLUDE,
            })
          : null;
        const sport = event.activity.sport;
        return {
          activity: toCalendarItem(
            event,
            scope.timeZone,
            scope.today,
            zoneNames,
          ),
          streams: inspectActivityStreams(details.stream).availability,
          lapPage: {
            total: details._count.segments,
            offset: lapOffset,
            nextOffset:
              lapOffset + details.segments.length < details._count.segments
                ? lapOffset + details.segments.length
                : null,
          },
          laps: details.segments.map((segment) => ({
            segmentId: segment.activitySegmentId,
            orderIndex: segment.orderIndex,
            startTimeSeconds: segment.startTimeSeconds,
            endTimeSeconds: segment.endTimeSeconds,
            elapsedSeconds: segment.endTimeSeconds - segment.startTimeSeconds,
            ...(segment.movingTime !== null && {
              movingSeconds: segment.movingTime,
            }),
            ...(segment.name && { name: segment.name }),
            type: segment.segmentType.toLowerCase(),
            minutes: round(
              (segment.movingTime ??
                segment.endTimeSeconds - segment.startTimeSeconds) / 60,
              1,
            ),
            ...(segment.distance !== null && {
              distanceKm: round(segment.distance / 1000, 2),
            }),
            ...(segment.averageHeartrate !== null && {
              avgHeartRate: round(segment.averageHeartrate),
            }),
            ...(segment.averageWatts !== null && {
              avgPower: round(segment.averageWatts),
            }),
            ...(segment.maxHeartrate !== null && {
              maxHeartRate: segment.maxHeartrate,
            }),
            ...(segment.averageCadence !== null && {
              avgCadence: segment.averageCadence,
            }),
            ...(segment.averageSpeed !== null && {
              avgSpeedMetersPerSecond: segment.averageSpeed,
            }),
            ...(segment.averageSpeed !== null &&
              segment.averageSpeed > 0 && {
                avgPaceSecondsPerKm: 1000 / segment.averageSpeed,
              }),
            ...(segment.averageSpeed
              ? speedFields(sport, segment.averageSpeed)
              : {}),
          })),
          feedback: details.feedbackQuestions.map((entry) => ({
            question: entry.questionText,
            answer: entry.answerText ?? '',
          })),
          ...(planned && {
            plannedSession: toCalendarItem(
              planned,
              scope.timeZone,
              scope.today,
              zoneNames,
            ),
          }),
        };
      }),
  );

  registerTool(
    server,
    'get_activity_streams',
    {
      title: 'Activity time series',
      description:
        'Original time-aligned samples for one activity, at most 500 per page. Follow nextOffset until null for the full recording. Availability lists missing, invalid and misaligned channels separately; unavailable channels have no values. Time is elapsed seconds, distance meters, heart rate bpm, speed m/s, pace s/km. Speed and pace are derived from consecutive original distance/time samples, including pauses; first pace, stationary pace, duplicate timestamps and distance resets yield null. GAP and normalized speed are stored m/s channels. No GPS coordinates are returned. Does not fetch or repair provider data.',
      inputSchema: activityStreamInputSchema.shape,
      outputSchema: activityStreamOutputSchema,
      annotations: READ_ONLY,
    },
    (input) =>
      run(activityStreamOutputSchema, async () => {
        const { event } = await readEvent(input.eventId);
        if (!event.activity) {
          throw new ToolError(
            `Event ${input.eventId} is not an activity: use get_session for planned sessions.`,
          );
        }
        const details = await prisma.eventActivity.findUniqueOrThrow({
          where: { eventActivityId: event.activity.eventActivityId },
          select: { stream: true },
        });
        return inspectActivityStreams(details.stream).page(input);
      }),
  );

  registerTool(
    server,
    'get_activities',
    {
      title: 'Activity history',
      description:
        'Done activities between two dates (at most a year), newest first, with their metrics and load: use it to judge training history and trends over months.',
      inputSchema: {
        athleteId: athleteIdInput,
        from: localDate,
        to: localDate,
        sport: z.nativeEnum(SportType).optional().describe('Only this sport'),
        limit: z.number().int().min(1).max(300).default(150),
      },
      outputSchema: activitiesOutput,
      annotations: READ_ONLY,
    },
    ({ athleteId, from, to, sport, limit }) =>
      run(activitiesOutput, async () => {
        const scope = await ctx.athlete(athleteId);
        const { start, end } = localRange(from, to, scope.timeZone, 366);
        const ability = await deps.abilities.getFor({ user: ctx.user });
        const where: Prisma.EventWhereInput = {
          AND: [
            accessibleBy(ability, 'read').Event,
            { athleteId: scope.athleteId, type: 'ACTIVITY' },
            { startDate: { gte: start, lte: end } },
            ...(sport ? [{ activity: { sport } }] : []),
          ],
        };
        const [count, events] = await Promise.all([
          prisma.event.count({ where }),
          prisma.event.findMany({
            where,
            include: CALENDAR_INCLUDE,
            orderBy: { startDate: 'desc' },
            take: limit,
          }),
        ]);
        return {
          athleteId: scope.athleteId,
          from,
          to,
          count,
          truncated: count > events.length,
          activities: events.map((event) =>
            toCalendarItem(event, scope.timeZone, scope.today, new Map(), {
              withDescription: false,
            }),
          ),
        };
      }),
  );

  registerTool(
    server,
    'list_workout_templates',
    {
      title: 'Workout library',
      description:
        "The user's saved session templates, with their structured workouts: reuse them when planning, by passing their workoutSteps to plan_sessions.",
      inputSchema: {
        search: z.string().max(100).optional().describe('Part of the name'),
      },
      outputSchema: templatesOutput,
      annotations: READ_ONLY,
    },
    ({ search }) =>
      run(templatesOutput, async () => {
        const templates = await prisma.eventTemplate.findMany({
          where: {
            userId: ctx.user.userId,
            ...(search && {
              event: { name: { contains: search, mode: 'insensitive' } },
            }),
          },
          include: { event: { include: CALENDAR_INCLUDE }, folder: true },
          orderBy: { event: { name: 'asc' } },
          take: 100,
        });
        const own = ctx.user.athlete?.athleteId;
        const zoneNames = own ? await zoneNamesOf(deps, own) : new Map();
        return {
          templates: templates.map((template) => {
            const workoutSteps = workoutOf(template.event, zoneNames);
            return {
              // Dates mean nothing on a template: the output drops them
              ...toCalendarItem(template.event, 'UTC', '', zoneNames),
              templateId: template.eventTemplateId,
              ...(template.folder && { folder: template.folder.name }),
              ...(workoutSteps && { workoutSteps }),
            };
          }),
        };
      }),
  );
};
