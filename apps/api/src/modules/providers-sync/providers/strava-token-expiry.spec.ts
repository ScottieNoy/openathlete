import { ProviderAccount } from '@openathlete/database';

import { StravaProviderService } from './strava.provider.service';

describe('Strava token expiry', () => {
  const account = () =>
    ({
      providerAccountId: 1,
      athleteId: 7,
      provider: 'STRAVA',
      status: 'active',
      accessToken: 'synthetic-old-access',
      refreshToken: 'synthetic-refresh',
      expiresAt: null,
    }) as ProviderAccount;
  function setup() {
    const prisma = {
      providerAccount: {
        update: jest
          .fn()
          .mockImplementation(({ data }) =>
            Promise.resolve({ ...account(), ...data }),
          ),
      },
    };
    const service = new StravaProviderService(
      prisma as never,
      { get: jest.fn() } as never,
      {} as never,
    );
    const refresh = jest
      .spyOn(service, 'refreshAccessToken')
      .mockResolvedValue({
        access_token: 'synthetic-new-access',
        refresh_token: 'synthetic-next-refresh',
        expires_in: 21600,
      });
    return { service, prisma, refresh };
  }
  it('uses a known unexpired token without renewal', async () => {
    const { service, refresh } = setup();
    expect(
      await service.getValidAccessToken({
        ...account(),
        expiresAt: new Date(Date.now() + 3600000),
      }),
    ).toBe('synthetic-old-access');
    expect(refresh).not.toHaveBeenCalled();
  });
  it.each([null, new Date(0)])(
    'renews unknown/expired tokens and retains expiry for subsequent requests: %s',
    async (expiresAt) => {
      const { service, prisma, refresh } = setup();
      const current = { ...account(), expiresAt };
      expect(await service.getValidAccessToken(current)).toBe(
        'synthetic-new-access',
      );
      expect(current.expiresAt!.getTime()).toBeGreaterThan(
        Date.now() + 21000000,
      );
      expect(await service.getValidAccessToken(current)).toBe(
        'synthetic-new-access',
      );
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(
        prisma.providerAccount.update.mock.calls[0][0].data,
      ).not.toHaveProperty('scopes');
      expect(
        prisma.providerAccount.update.mock.calls[0][0].data,
      ).not.toHaveProperty('status');
    },
  );
  it('uses the provider absolute expiry when present', async () => {
    const { service, refresh } = setup();
    const expires_at = Math.floor(Date.now() / 1000) + 21600;
    refresh.mockResolvedValue({
      access_token: 'synthetic-new-access',
      expires_at,
    } as never);
    const current = account();
    await service.getValidAccessToken(current);
    expect(current.expiresAt!.getTime()).toBe(expires_at * 1000);
  });
  it('fails closed for revoked connections or failed/invalid renewal without persisting changes', async () => {
    const { service, prisma, refresh } = setup();
    await expect(
      service.getValidAccessToken({ ...account(), status: 'revoked' }),
    ).rejects.toThrow();
    expect(refresh).not.toHaveBeenCalled();
    refresh.mockRejectedValueOnce(new Error('Provider denied renewal'));
    await expect(service.getValidAccessToken(account())).rejects.toThrow(
      'Provider denied renewal',
    );
    refresh.mockResolvedValueOnce({ access_token: 'synthetic-new-access' });
    await expect(service.getValidAccessToken(account())).rejects.toThrow(
      'Invalid Strava token expiry',
    );
    expect(prisma.providerAccount.update).not.toHaveBeenCalled();
  });
});
