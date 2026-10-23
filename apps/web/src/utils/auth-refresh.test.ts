// @vitest-environment jsdom
import axios, { AxiosError, type InternalAxiosRequestConfig } from 'axios';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import client, { isSessionUnavailable } from './axios';
import { ACCESS_TOKEN, REFRESH_TOKEN } from './local-storage';

vi.mock('@/config', () => ({ API_BASE_URL: 'https://api.example' }));

const EXPIRED = `header.${btoa(JSON.stringify({ exp: 1 }))}.signature`;
const VALID = `header.${btoa(JSON.stringify({ exp: 4102444800 }))}.signature`;
const answered = (status: number) =>
  new AxiosError(
    `HTTP ${status}`,
    AxiosError.ERR_BAD_REQUEST,
    undefined,
    undefined,
    {
      status,
      statusText: '',
      data: {},
      headers: {},
      config: {} as InternalAxiosRequestConfig,
    },
  );

describe('expired web login recovery', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem(ACCESS_TOKEN, EXPIRED);
    localStorage.setItem(REFRESH_TOKEN, 'saved-refresh');
  });
  afterEach(() => vi.restoreAllMocks());

  it.each([
    new AxiosError('Network Error', AxiosError.ERR_NETWORK),
    new AxiosError('timeout', AxiosError.ECONNABORTED),
    answered(503),
    answered(429),
  ])(
    'retains the login and does not send an anonymous request after refresh failure: %s',
    async (failure) => {
      vi.spyOn(axios, 'post').mockRejectedValueOnce(failure);
      let protectedRequests = 0;
      const request = client.get('/user/me', {
        adapter: async (config) => {
          protectedRequests += 1;
          throw new AxiosError(
            'Unauthorized',
            AxiosError.ERR_BAD_REQUEST,
            config,
            null,
            { status: 401, statusText: '', data: {}, headers: {}, config },
          );
        },
      });
      await expect(request).rejects.toBe(failure);
      expect(protectedRequests).toBe(0);
      expect(localStorage.getItem(ACCESS_TOKEN)).toBe(EXPIRED);
      expect(localStorage.getItem(REFRESH_TOKEN)).toBe('saved-refresh');
    },
  );

  it('retries successfully in the same tab after a temporary outage', async () => {
    vi.spyOn(axios, 'post')
      .mockRejectedValueOnce(
        new AxiosError('Network Error', AxiosError.ERR_NETWORK),
      )
      .mockResolvedValueOnce({
        data: { accessToken: VALID, refreshToken: 'new-refresh' },
      });
    const adapter = vi.fn(async (config: InternalAxiosRequestConfig) => ({
      status: 200,
      statusText: '',
      data: {},
      headers: {},
      config,
    }));
    await expect(client.get('/user/me', { adapter })).rejects.toBeDefined();
    await client.get('/user/me', { adapter });
    expect(adapter).toHaveBeenCalledTimes(1);
    expect(adapter.mock.calls[0][0].headers.get('Authorization')).toBe(
      `Bearer ${VALID}`,
    );
    expect(localStorage.getItem(REFRESH_TOKEN)).toBe('new-refresh');
  });

  it('requires login again when the server actually rejects the refresh token', async () => {
    vi.spyOn(axios, 'post').mockRejectedValueOnce(answered(401));
    await expect(
      client.get('/user/me', {
        adapter: async (config) => {
          throw new AxiosError(
            'Unauthorized',
            AxiosError.ERR_BAD_REQUEST,
            config,
            null,
            { status: 401, statusText: '', data: {}, headers: {}, config },
          );
        },
      }),
    ).rejects.toMatchObject({ response: { status: 401 } });
    expect(localStorage.getItem(ACCESS_TOKEN)).toBeNull();
    expect(localStorage.getItem(REFRESH_TOKEN)).toBeNull();
  });

  it.each([408, 429, 500, 503])(
    'treats a temporary HTTP %i as an unavailable session',
    (status) => {
      expect(isSessionUnavailable(answered(status))).toBe(true);
      expect(isSessionUnavailable(answered(401))).toBe(false);
    },
  );

  it('does not let a late 401 erase a newer login', async () => {
    localStorage.setItem(ACCESS_TOKEN, VALID);
    await expect(
      client.get('/user/me', {
        adapter: async (config) => {
          localStorage.setItem(ACCESS_TOKEN, 'new-account-access');
          localStorage.setItem(REFRESH_TOKEN, 'new-account-refresh');
          throw new AxiosError(
            'Unauthorized',
            AxiosError.ERR_BAD_REQUEST,
            config,
            null,
            { status: 401, statusText: '', data: {}, headers: {}, config },
          );
        },
      }),
    ).rejects.toBeDefined();
    expect(localStorage.getItem(ACCESS_TOKEN)).toBe('new-account-access');
    expect(localStorage.getItem(REFRESH_TOKEN)).toBe('new-account-refresh');
  });

  it('does not overwrite an account that changed during refresh', async () => {
    vi.spyOn(axios, 'post').mockImplementationOnce(async () => {
      localStorage.setItem(ACCESS_TOKEN, 'new-account-access');
      localStorage.setItem(REFRESH_TOKEN, 'new-account-refresh');
      return {
        data: { accessToken: VALID, refreshToken: 'old-account-refresh' },
      };
    });
    await expect(client.get('/user/me')).rejects.toMatchObject({
      code: AxiosError.ERR_CANCELED,
    });
    expect(localStorage.getItem(ACCESS_TOKEN)).toBe('new-account-access');
    expect(localStorage.getItem(REFRESH_TOKEN)).toBe('new-account-refresh');
  });

  it('retains credentials when a refresh response is incomplete', async () => {
    vi.spyOn(axios, 'post').mockResolvedValueOnce({ data: {} });
    await expect(client.get('/user/me')).rejects.toMatchObject({
      code: AxiosError.ERR_BAD_RESPONSE,
    });
    expect(localStorage.getItem(REFRESH_TOKEN)).toBe('saved-refresh');
  });
});
