import axios, { isAxiosError } from 'axios';

import { Inject, Injectable, forwardRef } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  ConnectorProvider,
  ProviderAccount,
  SportType,
} from '@openathlete/database';
import { ActivityStream, ApiEnvSchemaType } from '@openathlete/shared';

import { AuthUser } from 'src/modules/auth/decorators/user.decorator';

import { compressActivityStream } from '../../core/helpers/activity-stream';
import {
  providerActivityId,
  stravaStorageId,
} from '../../core/helpers/provider-activity-id';
import {
  roundCadence,
  roundDistance,
  roundElevation,
  roundEnergy,
  roundHeartrate,
  roundPower,
  roundSpeed,
} from '../../core/helpers/round-activity-values';
import { stravaActivitySport } from '../../core/helpers/strava';
import { StravaSteam, StravaSummaryActivity } from '../../core/types/connector';
import { PrismaService } from '../../prisma/services/prisma.service';
import { QueueService } from '../../queue/queue.service';
import {
  BaseProviderService,
  FullImportResult,
  OAuthConfig,
  OAuthTokenResponse,
} from '../base';
import {
  ImportOptions,
  ImportResult,
  ImportedActivity,
  ProviderImportCapability,
} from '../base/provider-import.interface';
import { providerRedirectUri } from '../base/provider-urls';
import {
  StravaLapSource,
  appendOriginalStravaLaps,
  originalStravaLaps,
} from '../base/strava-laps';
import { saveImportedWorkout } from '../base/workout-deduplication';

@Injectable()
export class StravaProviderService
  extends BaseProviderService
  implements ProviderImportCapability
{
  protected readonly provider = ConnectorProvider.STRAVA;
  private static readonly stravaActivityIdAllowlist = /^\d{1,20}$/;

  private tryNormalizeStravaActivityId(activityId: unknown): string | null {
    const idStr =
      typeof activityId === 'string'
        ? activityId.trim()
        : String(activityId).trim();

    if (!StravaProviderService.stravaActivityIdAllowlist.test(idStr)) {
      return null;
    }

    if (idStr === '0') {
      return null;
    }

    return idStr;
  }

  private getStravaActivityUrl(activityId: string): string {
    return new URL(
      `/api/v3/activities/${encodeURIComponent(activityId)}`,
      'https://www.strava.com',
    ).toString();
  }

  protected get oauthConfig(): OAuthConfig {
    return {
      authorizationUrl: 'https://www.strava.com/oauth/authorize',
      tokenUrl: 'https://www.strava.com/api/v3/oauth/token',
      clientId: this.configService.get('STRAVA_CLIENT_ID') || '',
      clientSecret: this.configService.get('STRAVA_CLIENT_SECRET') || '',
      redirectUri: providerRedirectUri(
        this.configService.get('STRAVA_REDIRECT_URI'),
        this.configService.get('APP_URL'),
        'strava',
      ),
      scopes: ['read', 'activity:read_all'],
    };
  }

  constructor(
    prisma: PrismaService,
    configService: ConfigService<ApiEnvSchemaType, true>,
    @Inject(forwardRef(() => QueueService))
    private readonly queueService: QueueService,
  ) {
    super(prisma, configService);
  }

  /**
   * Strava-specific: Override refresh to use different endpoint
   */
  override async refreshAccessToken(
    refreshToken: string,
  ): Promise<OAuthTokenResponse> {
    try {
      const { data } = await axios.post<OAuthTokenResponse>(
        'https://www.strava.com/api/v3/oauth/token',
        {
          client_id: this.oauthConfig.clientId,
          client_secret: this.oauthConfig.clientSecret,
          refresh_token: refreshToken,
          grant_type: 'refresh_token',
        },
        {
          headers: {
            'Content-Type': 'application/json',
          },
        },
      );

      return data;
    } catch (error) {
      if (isAxiosError(error)) {
        this.logger.error(
          `Strava token refresh failed: ${JSON.stringify(error.response?.data)}`,
        );
      }
      throw error;
    }
  }

  /** Strava access tokens are short lived; legacy null expiries must be renewed. */
  override async getValidAccessToken(
    account: ProviderAccount,
  ): Promise<string> {
    if (account.status !== 'active') return super.getValidAccessToken(account);
    if (
      account.accessToken &&
      account.expiresAt &&
      account.expiresAt.getTime() > Date.now() + 30000
    )
      return account.accessToken;
    return this.refreshAndSaveAccessToken(account);
  }

  private async refreshAndSaveAccessToken(
    account: ProviderAccount,
  ): Promise<string> {
    if (!account.refreshToken)
      throw new Error('No refresh token available for Strava');
    const tokenResponse = await this.refreshAccessToken(account.refreshToken);
    const absolute = (
      tokenResponse as OAuthTokenResponse & { expires_at?: number }
    ).expires_at;
    const expiresAt =
      typeof absolute === 'number' && Number.isFinite(absolute)
        ? new Date(absolute * 1000)
        : typeof tokenResponse.expires_in === 'number' &&
            Number.isFinite(tokenResponse.expires_in)
          ? new Date(Date.now() + tokenResponse.expires_in * 1000)
          : null;
    if (
      !expiresAt ||
      !Number.isFinite(expiresAt.getTime()) ||
      expiresAt.getTime() <= Date.now() ||
      !tokenResponse.access_token
    )
      throw new Error('Invalid Strava token expiry');
    const updated = await this.prisma.providerAccount.update({
      where: {
        providerAccountId: account.providerAccountId,
        athleteId: account.athleteId,
        status: 'active',
      },
      data: {
        accessToken: tokenResponse.access_token,
        refreshToken: tokenResponse.refresh_token ?? account.refreshToken,
        expiresAt,
      },
    });
    Object.assign(account, updated);
    return updated.accessToken;
  }

  /**
   * Make an authenticated request to Strava API with automatic token refresh on 401
   * @param account Provider account
   * @param requestFn Function that makes the API request with the access token
   * @returns The response data
   */
  private async makeAuthenticatedRequest<T>(
    account: ProviderAccount,
    requestFn: (accessToken: string) => Promise<T>,
  ): Promise<T> {
    let accessToken = await this.getValidAccessToken(account);

    try {
      return await requestFn(accessToken);
    } catch (error) {
      // Check if it's a 401 Unauthorized error
      if (
        isAxiosError(error) &&
        error.response?.status === 401 &&
        account.refreshToken
      ) {
        this.logger.warn(
          `Access token invalid for Strava account ${account.providerAccountId}, refreshing...`,
        );

        accessToken = await this.refreshAndSaveAccessToken(account);
        return await requestFn(accessToken);
      }

      // Re-throw if it's not a 401 or if we can't refresh
      throw error;
    }
  }

  /**
   * Complete OAuth flow and save account
   */
  async connect(user: AuthUser, code: string): Promise<ProviderAccount> {
    const tokenResponse = await this.exchangeCodeForTokens(code);

    // Get athlete
    const athlete = await this.prisma.athlete.findUnique({
      where: { userId: user.userId },
      include: { user: true },
    });

    if (!athlete) {
      throw new Error('Athlete not found');
    }

    // Extract external user ID from Strava response
    // Strava includes athlete data in the token response
    const tokenData = tokenResponse;
    const externalUserId = tokenData.athlete?.id?.toString();

    // Save provider account
    const account = await this.saveProviderAccount({
      athleteId: athlete.athleteId,
      accessToken: tokenResponse.access_token,
      refreshToken: tokenResponse.refresh_token ?? '',
      scopes: tokenResponse.scope,
      externalUserId,
    });

    return account;
  }

  /**
   * Import activities from Strava
   */
  async importActivities(
    account: ProviderAccount,
    options?: ImportOptions,
  ): Promise<ImportedActivity[]> {
    let page = 1;
    const limit = options?.limit ?? Number.POSITIVE_INFINITY;
    const activities: ImportedActivity[] = [];

    while (activities.length < limit) {
      const data = await this.makeAuthenticatedRequest<StravaSummaryActivity[]>(
        account,
        async (accessToken) => {
          const response = await axios.get<StravaSummaryActivity[]>(
            // 200 is the largest page Strava allows: 7x fewer rate-limited calls
            `https://www.strava.com/api/v3/athlete/activities?page=${page}&per_page=200`,
            {
              headers: {
                Authorization: `Bearer ${accessToken}`,
              },
              // Pages of 200 activities regularly took more than 15s
              timeout: 30000,
            },
          );
          return response.data;
        },
      );

      if (data.length === 0) break;

      for (const activity of data) {
        if (activities.length >= limit) break;

        const startDate = new Date(activity.start_date);
        const endDate = new Date(startDate);
        endDate.setSeconds(endDate.getSeconds() + activity.elapsed_time);

        // Apply date filters if provided
        if (options?.startDate && startDate < options.startDate) continue;
        if (options?.endDate && startDate > options.endDate) continue;

        activities.push({
          externalId: activity.id.toString(),
          name: activity.name,
          startDate,
          endDate,
          sport: stravaActivitySport(activity),
          distance: activity.distance,
          duration: activity.elapsed_time,
          raw: activity,
        });
      }

      page++;
    }

    return activities;
  }

  /**
   * Import and save a single activity
   */
  async importActivity(
    account: ProviderAccount,
    activity: ImportedActivity,
  ): Promise<ImportResult> {
    const existing = await this.prisma.eventActivity.findFirst({
      where: {
        event: { athleteId: account.athleteId },
        OR: [
          {
            provider: 'STRAVA',
            externalId: {
              in: [
                activity.externalId,
                stravaStorageId(account.athleteId, activity.externalId),
              ],
            },
          },
          {
            sources: {
              some: {
                athleteId: account.athleteId,
                provider: 'STRAVA',
                externalId: activity.externalId,
              },
            },
          },
        ],
      },
    });
    if (existing) return { activity: existing, created: false };
    // Fetch streams outside the transaction/athlete lock. Persistence checks
    // both provider identities and nearby recordings again under the lock.
    const data = await this.fetchStravaActivityData(
      account,
      activity.raw as StravaSummaryActivity,
    );
    const result = await saveImportedWorkout(this.prisma, {
      athleteId: account.athleteId,
      provider: 'STRAVA',
      externalId: activity.externalId,
      legacyExternalId: activity.externalId,
      startDate: new Date(activity.startDate),
      endDate: new Date(activity.endDate),
      sport: data.sport,
      distance: data.distance,
      create: {
        athleteId: account.athleteId,
        name: activity.name,
        type: 'ACTIVITY',
        startDate: activity.startDate,
        endDate: activity.endDate,
        activity: { create: data },
      },
    });
    return result;
  }

  /**
   * Fetch full activity data with streams (from original StravaConnectorService)
   */
  private async fetchStravaActivityData(
    account: ProviderAccount,
    activity: StravaSummaryActivity,
  ) {
    const shouldFetchStreams = !activity.manual;

    let streams: StravaSteam[] = [];

    if (shouldFetchStreams) {
      streams = await this.makeAuthenticatedRequest<StravaSteam[]>(
        account,
        async (accessToken) => {
          try {
            const response = await axios.get(
              `https://www.strava.com/api/v3/activities/${activity.id}/streams`,
              {
                headers: {
                  Authorization: `Bearer ${accessToken}`,
                },
                params: {
                  keys: 'time,distance,latlng,altitude,heartrate,cadence,watts,temp',
                },
                timeout: 45000, // 45 seconds timeout for stream fetching (increased for large activities)
              },
            );
            return response.data;
          } catch (error) {
            this.logger.error(
              `Error fetching Strava activity data for activity ${activity.id}: ${error instanceof Error ? error.message : String(error)}`,
            );
            return [];
          }
        },
      );
    } else {
      this.logger.warn(
        `Skipping stream fetch for Strava activity ${activity.id} (manual: ${activity.manual}, hasPolyline: ${!!activity.map?.summary_polyline?.length}, distance: ${activity.distance})`,
      );
    }

    const mergedData: ActivityStream = {};
    for (const stream of streams) {
      const key = stream.type as keyof ActivityStream;
      if (key === 'latlng') {
        mergedData[key] = stream.data as number[][];
      } else {
        mergedData[key] = stream.data as number[];
      }
    }

    const compressionStart = Date.now();
    const compressedActivityStream = compressActivityStream(mergedData);
    const compressionTime = Date.now() - compressionStart;
    if (compressionTime > 1000) {
      this.logger.debug(
        `Stream compression took ${compressionTime}ms for activity ${activity.id}`,
      );
    }

    let segments: ReturnType<typeof originalStravaLaps> = [];
    try {
      segments = originalStravaLaps(
        {
          id: String(activity.id),
          startDate: new Date(activity.start_date),
          elapsedSeconds: activity.elapsed_time,
          athleteId: account.externalUserId,
        },
        await this.fetchOriginalLaps(account, String(activity.id)),
      );
    } catch {
      this.logger.warn(
        `Original Strava laps unavailable for activity ${activity.id}; activity streams and summary retained`,
      );
    }
    const sport = stravaActivitySport(activity);

    return {
      provider: ConnectorProvider.STRAVA as typeof ConnectorProvider.STRAVA,
      distance: roundDistance(activity.distance),
      elevationGain: roundElevation(activity.total_elevation_gain),
      movingTime: activity.moving_time,
      averageSpeed: roundSpeed(activity.average_speed) ?? 0,
      maxSpeed: roundSpeed(activity.max_speed) ?? 0,
      averageCadence: roundCadence(activity.average_cadence),
      averageWatts: roundPower(activity.average_watts),
      maxWatts: roundPower(activity.max_watts),
      weightedAverageWatts: roundPower(activity.weighted_average_watts),
      averageHeartrate: roundHeartrate(activity.average_heartrate),
      maxHeartrate: roundHeartrate(activity.max_heartrate),
      kilojoules: roundEnergy(activity.kilojoules),
      sport,
      stream: compressedActivityStream as object,
      segments: { create: segments },
      externalId: stravaStorageId(account.athleteId, activity.id.toString()),
    };
  }

  private fetchOriginalLaps(
    account: ProviderAccount,
    sourceId: string,
  ): Promise<unknown> {
    return this.makeAuthenticatedRequest(account, async (token) => {
      const response = await axios.get(
        this.getStravaActivityUrl(sourceId) + '/laps',
        {
          headers: { Authorization: `Bearer ${token}` },
          timeout: 30000,
        },
      );
      return response.data;
    });
  }

  /** Explicit, targeted enrichment; ordinary duplicate imports keep their existing content. */
  async importOriginalLaps(account: ProviderAccount, eventId: number) {
    const activity = await this.prisma.eventActivity.findFirstOrThrow({
      where: { eventId, event: { athleteId: account.athleteId } },
      include: {
        sources: {
          where: { athleteId: account.athleteId, provider: 'STRAVA' },
        },
      },
    });
    const primary =
      activity.provider === 'STRAVA'
        ? providerActivityId('STRAVA', activity.externalId)
        : undefined;
    const ids = [
      ...new Set([
        ...activity.sources.map((s) => s.externalId),
        ...(primary ? [primary] : []),
      ]),
    ];
    if (ids.length !== 1 || !this.tryNormalizeStravaActivityId(ids[0]))
      throw new Error('No unique Strava source for this activity');
    const detail = await this.makeAuthenticatedRequest<StravaSummaryActivity>(
      account,
      async (token) =>
        (
          await axios.get<StravaSummaryActivity>(
            this.getStravaActivityUrl(ids[0]),
            { headers: { Authorization: `Bearer ${token}` }, timeout: 30000 },
          )
        ).data,
    );
    if (
      String(detail.id) !== ids[0] ||
      (account.externalUserId &&
        String(detail.athlete?.id) !== account.externalUserId)
    )
      throw new Error('Strava source activity mismatch');
    const source: StravaLapSource = {
      id: ids[0],
      startDate: new Date(detail.start_date),
      elapsedSeconds: detail.elapsed_time,
      athleteId: account.externalUserId,
    };
    return appendOriginalStravaLaps(this.prisma, {
      athleteId: account.athleteId,
      eventActivityId: activity.eventActivityId,
      source,
      laps: await this.fetchOriginalLaps(account, ids[0]),
    });
  }

  /**
   * Import initial activities from Strava when connecting
   * Fetches activities and adds them to the import queue
   */
  async queueFullImport(account: ProviderAccount): Promise<FullImportResult> {
    this.logger.log(
      `Queueing Strava historical import for account ${account.providerAccountId}`,
    );

    try {
      // Fetch all activities using importActivities
      const activities = await this.importActivities(account);

      this.logger.log(
        `Fetched ${activities.length} activities from Strava for account ${account.providerAccountId}`,
      );

      if (activities.length === 0) {
        this.logger.log('No new activities to import');
        return { queuedActivities: 0 };
      }

      const queued = await this.enqueueActivities(account, activities);

      this.logger.log(
        `Successfully queued ${queued} activities for import (out of ${activities.length} total)`,
      );

      return { queuedActivities: queued };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      const errorName = error instanceof Error ? error.name : 'UnknownError';

      this.logger.error(
        `Error in queueFullImport for account ${account.providerAccountId}: ${errorName}: ${errorMessage}`,
        error instanceof Error ? error.stack : undefined,
      );

      // Re-throw to be caught by the caller
      throw error;
    }
  }

  /**
   * Activities imported before the sport was read from `sport_type` were
   * filed under the parent sport (a trail run as a run). An import that
   * fetches them again puts them right, from the summaries it already has.
   */
  private async correctSports(
    existing: {
      eventActivityId: number;
      externalId: string;
      sport: SportType;
      provider: ConnectorProvider | null;
    }[],
    activities: ImportedActivity[],
  ) {
    const fetched = new Map(
      activities.map((a) => [a.externalId, a.sport as SportType]),
    );
    const bySport = new Map<SportType, number[]>();
    for (const activity of existing) {
      const sport = fetched.get(activity.externalId);
      if (
        activity.provider !== ConnectorProvider.STRAVA ||
        !sport ||
        sport === SportType.OTHER ||
        sport === activity.sport
      ) {
        continue;
      }
      bySport.set(sport, [
        ...(bySport.get(sport) ?? []),
        activity.eventActivityId,
      ]);
    }
    for (const [sport, ids] of bySport) {
      await this.prisma.eventActivity.updateMany({
        where: { eventActivityId: { in: ids } },
        data: { sport },
      });
      this.logger.log(`Filed ${ids.length} Strava activities under ${sport}`);
    }
  }

  private async enqueueActivities(
    account: ProviderAccount,
    activities: ImportedActivity[],
  ): Promise<number> {
    if (activities.length === 0) {
      return 0;
    }

    const existing = await this.prisma.eventActivity.findMany({
      where: {
        event: { athleteId: account.athleteId },
        provider: 'STRAVA',
        externalId: {
          in: activities.flatMap((a) => [
            a.externalId,
            stravaStorageId(account.athleteId, a.externalId),
          ]),
        },
      },
      select: {
        eventActivityId: true,
        externalId: true,
        sport: true,
        provider: true,
      },
    });

    const existingIdsSet = new Set(
      existing.map((a) => providerActivityId(a.provider, a.externalId)),
    );
    const sources = await this.prisma.activityImportSource.findMany({
      where: {
        athleteId: account.athleteId,
        provider: 'STRAVA',
        externalId: { in: activities.map((a) => a.externalId) },
      },
      select: { externalId: true },
    });
    for (const source of sources) existingIdsSet.add(source.externalId);
    await this.correctSports(
      existing.map((a) => ({
        ...a,
        externalId: providerActivityId(a.provider, a.externalId),
      })),
      activities,
    );

    const newActivities = activities.filter(
      (a) => !existingIdsSet.has(a.externalId),
    );

    if (newActivities.length === 0) {
      this.logger.log('All activities already imported');
      return 0;
    }

    await this.queueService.addActivityImportJobs(account, newActivities, true);
    return newActivities.length;
  }

  /**
   * Handle Strava webhook
   */
  async handleWebhook(payload: {
    object_id: number;
    owner_id: number;
    aspect_type: 'create' | 'delete';
  }): Promise<void> {
    this.logger.log(
      `Handling Strava webhook: objectId=${payload.object_id}, ownerId=${payload.owner_id}, aspectType=${payload.aspect_type}`,
    );
    if (
      payload.aspect_type === 'create' &&
      payload.object_id &&
      payload.owner_id
    ) {
      const activityId = this.tryNormalizeStravaActivityId(payload.object_id);
      if (!activityId) {
        // Webhook payload is untrusted; reject unexpected IDs to prevent request forgery / SSRF.
        // Don't throw: webhook handlers should be resilient and return 200.
        this.logger.warn(
          `Invalid Strava webhook object_id: ${String(payload.object_id)}`,
        );
        return;
      }

      // Find account by external_user_id (Strava athlete ID)
      const account = await this.prisma.providerAccount.findFirst({
        where: {
          provider: ConnectorProvider.STRAVA,
          externalUserId: payload.owner_id.toString(),
          status: 'active',
        },
        include: {
          athlete: {
            include: {
              user: true,
            },
          },
        },
      });

      if (!account || !account.athlete || !account.athlete.user) {
        this.logger.warn(
          `No active Strava account found for owner_id ${payload.owner_id}`,
        );
        return;
      }

      if (!account.importActivitiesEnabled) {
        this.logger.debug(
          `Import disabled for Strava account ${account.providerAccountId}, skipping webhook activity ${payload.object_id}`,
        );
        return;
      }

      // Check if activity already imported
      const existingActivity = await this.prisma.eventActivity.findFirst({
        where: {
          event: { athleteId: account.athleteId },
          OR: [
            {
              provider: 'STRAVA',
              externalId: {
                in: [
                  activityId,
                  stravaStorageId(account.athleteId, activityId),
                ],
              },
            },
            {
              sources: {
                some: {
                  athleteId: account.athleteId,
                  provider: 'STRAVA',
                  externalId: activityId,
                },
              },
            },
          ],
        },
      });

      if (existingActivity) {
        this.logger.debug(
          `Activity ${payload.object_id} already imported, skipping`,
        );
        return;
      }

      // Fetch activity details from Strava
      const activity =
        await this.makeAuthenticatedRequest<StravaSummaryActivity>(
          account,
          async (accessToken) => {
            const response = await axios.get<StravaSummaryActivity>(
              this.getStravaActivityUrl(activityId),
              {
                headers: {
                  Authorization: `Bearer ${accessToken}`,
                },
                timeout: 15000, // 15 seconds timeout for activity details
              },
            );
            return response.data;
          },
        );

      const endDate = new Date(activity.start_date);
      endDate.setSeconds(endDate.getSeconds() + activity.elapsed_time);

      const importedActivity: ImportedActivity = {
        externalId: activity.id.toString(),
        name: activity.name,
        startDate: new Date(activity.start_date),
        endDate,
        sport: stravaActivitySport(activity),
        distance: activity.distance,
        duration: activity.elapsed_time,
        raw: activity,
      };

      await this.queueService.addActivityImportJob(
        account,
        importedActivity,
        false,
      );

      this.logger.log(`Queued activity ${activityId} from webhook for import`);
    }
  }
}
