import { describe, it, expect, vi, afterEach } from 'vitest';
import { api } from './api';

function mockFetch(data, options = {}) {
  const { status = 200, ok = true, text = JSON.stringify(data) } = options;
  const fn = vi.fn().mockResolvedValue({
    ok,
    status,
    headers: { get: () => 'application/json' },
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(text),
  });
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

describe('api transport', () => {
  it('getCampaignCategories calls the categories endpoint', async () => {
    const fetchFn = mockFetch([{ category: 'arts', count: 2 }]);
    await expect(api.getCampaignCategories()).resolves.toEqual([{ category: 'arts', count: 2 }]);
    expect(fetchFn.mock.calls[0][0]).toMatch(/\/api\/campaigns\/categories$/);
  });

  it('getCloneData maps a campaign to create-form prefill', async () => {
    mockFetch({
      id: 'c1',
      title: 'T',
      description: 'D',
      target_amount: '100',
      asset_type: 'XLM',
      min_contribution: null,
      show_backer_amounts: false,
      category: 'arts',
      status: 'active',
    });
    const data = await api.getCloneData('c1');
    expect(data).toMatchObject({
      title: 'T',
      description: 'D',
      target_amount: '100',
      asset_type: 'XLM',
      min_contribution: '',
      show_backer_amounts: false,
      category: 'arts',
    });
    expect(data).not.toHaveProperty('id');
    expect(data).not.toHaveProperty('status');
  });

  it('updateMe sends a cookie-authenticated PATCH without a bearer token', async () => {
    const fetchFn = mockFetch({ name: 'New' });
    await api.updateMe({ name: 'New' });
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toMatch(/\/api\/users\/me$/);
    expect(init.method).toBe('PATCH');
    expect(init.credentials).toBe('include');
    expect(JSON.stringify(init.headers || {})).not.toMatch(/Bearer/);
  });

  it('getStellarTransactions passes query parameters correctly', async () => {
    const fetchFn = mockFetch({ transactions: [] });
    await api.getStellarTransactions({ campaignId: 'camp-123', status: 'indexed', limit: 10 });
    const [url] = fetchFn.mock.calls[0];
    expect(url).toMatch(/\/api\/stellar\/transactions\?/);
    expect(url).toContain('campaign_id=camp-123');
    expect(url).toContain('status=indexed');
    expect(url).toContain('limit=10');
  });

  it('throws friendly timeout error on AbortError', async () => {
    const abortErr = new Error('The operation was aborted');
    abortErr.name = 'AbortError';
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abortErr));

    await expect(api.getPlatformConfig()).rejects.toThrow(
      'Request timed out. Check your connection and try again.'
    );
  });

  it('handles server error with structured error body', async () => {
    mockFetch(
      {
        error: {
          message: 'Invalid field value',
          code: 'INVALID_INPUT',
          fields: { amount: 'Must be positive' },
        },
      },
      { status: 400, ok: false }
    );

    try {
      await api.createCampaign({ title: 'Test' });
      expect.fail('Should have thrown');
    } catch (err) {
      expect(err.message).toBe('Invalid field value');
      expect(err.status).toBe(400);
      expect(err.code).toBe('INVALID_INPUT');
      expect(err.fields).toEqual({ amount: 'Must be positive' });
    }
  });

  it('handles server error with string error body', async () => {
    mockFetch({ error: 'Unauthorized action' }, { status: 403, ok: false });

    await expect(api.getMe()).rejects.toThrow('Unauthorized action');
  });

  it('handles server error with malformed JSON response', async () => {
    mockFetch(null, { status: 502, ok: false, text: '<html>Bad Gateway</html>' });

    await expect(api.getPlatformConfig()).rejects.toThrow(
      'Unexpected server response. Please try again.'
    );
  });

  it('refreshes token and retries request on 401', async () => {
    let callCount = 0;
    const fetchFn = vi.fn().mockImplementation((url) => {
      callCount++;
      if (url.includes('/users/me') && callCount === 1) {
        return Promise.resolve({
          ok: false,
          status: 401,
          text: () => Promise.resolve(JSON.stringify({ error: 'Token expired' })),
        });
      }
      if (url.includes('/auth/refresh')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ success: true }),
          text: () => Promise.resolve(JSON.stringify({ success: true })),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ id: 'u1', name: 'Alice' }),
        text: () => Promise.resolve(JSON.stringify({ id: 'u1', name: 'Alice' })),
      });
    });
    vi.stubGlobal('fetch', fetchFn);

    const user = await api.getMe();
    expect(user).toEqual({ id: 'u1', name: 'Alice' });
    expect(fetchFn).toHaveBeenCalledTimes(3); // 1. getMe (401), 2. refresh (200), 3. getMe retry (200)
  });

  it('throws session expired error if refresh fails on 401', async () => {
    let callCount = 0;
    const fetchFn = vi.fn().mockImplementation((url) => {
      callCount++;
      if (url.includes('/auth/refresh')) {
        return Promise.resolve({
          ok: false,
          status: 401,
          text: () => Promise.resolve(JSON.stringify({ error: 'Refresh token invalid' })),
        });
      }
      return Promise.resolve({
        ok: false,
        status: 401,
        text: () => Promise.resolve(JSON.stringify({ error: 'Unauthorized' })),
      });
    });
    vi.stubGlobal('fetch', fetchFn);

    await expect(api.getMe()).rejects.toMatchObject({
      message: 'Session expired. Please log in again.',
      status: 401,
    });
  });

  it('does not attempt refresh for public auth endpoints on 401', async () => {
    const fetchFn = mockFetch({ error: 'Invalid credentials' }, { status: 401, ok: false });

    await expect(api.login({ email: 'test@example.com', password: 'wrong' })).rejects.toThrow(
      'Invalid credentials'
    );
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('logout calls POST /auth/logout with credentials include', async () => {
    const fetchFn = mockFetch({ message: 'Logged out' });
    await api.logout();
    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toMatch(/\/api\/auth\/logout$/);
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('include');
  });

  it('uploadCampaignCoverImage sends FormData', async () => {
    const fetchFn = mockFetch({ cover_image_url: 'https://cdn.example.com/cover.jpg' });
    const dummyFile = new Blob(['image data'], { type: 'image/jpeg' });
    await api.uploadCampaignCoverImage('camp-1', dummyFile);

    const [url, init] = fetchFn.mock.calls[0];
    expect(url).toMatch(/\/api\/campaigns\/camp-1\/cover-image$/);
    expect(init.method).toBe('POST');
    expect(init.body).toBeInstanceOf(FormData);
    expect(init.credentials).toBe('include');
  });
});

describe('api methods existence and contract', () => {
  const expectedMethods = [
    'getPlatformConfig',
    'register',
    'login',
    'forgotPassword',
    'resetPassword',
    'logout',
    'refresh',
    'getMe',
    'updateMe',
    'getMyBalance',
    'getMyStats',
    'getMyContributions',
    'startKyc',
    'getMyCampaigns',
    'getFeaturedCampaigns',
    'getCampaigns',
    'getCampaign',
    'getCampaignCategories',
    'getCloneData',
    'getCampaignAnalytics',
    'getCampaignEmbed',
    'getCampaignBackers',
    'getCampaignBalance',
    'createCampaign',
    'updateCampaign',
    'deleteCampaign',
    'uploadCampaignCoverImage',
    'getCampaignMembers',
    'inviteCampaignMember',
    'updateCampaignMemberRole',
    'removeCampaignMember',
    'acceptCampaignInvitation',
    'getAnchorInfo',
    'startAnchorDeposit',
    'getAnchorDepositStatus',
    'getSep24Assets',
    'startWalletDeposit',
    'getCampaignUpdates',
    'postCampaignUpdate',
    'updateCampaignUpdate',
    'deleteCampaignUpdate',
    'getContributions',
    'getMilestones',
    'setCampaignMilestones',
    'submitMilestoneEvidence',
    'approveMilestone',
    'rejectMilestone',
    'contribute',
    'prepareContribution',
    'submitSignedContribution',
    'buildContributionXdr',
    'guestContribute',
    'quoteContribution',
    'getContributionFinalization',
    'getStellarTransactions',
    'failExpiredCampaigns',
    'triggerCampaignRefunds',
    'initiateRefund',
    'approveRefundCreator',
    'approveRefundPlatform',
    'getWithdrawalCapabilities',
    'listWithdrawals',
    'requestWithdrawal',
    'approveWithdrawalCreator',
    'approveWithdrawalPlatform',
    'cancelWithdrawal',
    'rejectWithdrawal',
    'getWithdrawalEvents',
    'getWithdrawal',
    'raiseDispute',
    'getCampaignDisputes',
    'updateDispute',
    'getDisputeEvents',
    'getAdminStats',
    'getAdminCampaigns',
    'getAdminMilestones',
    'getAdminUsers',
    'getAdminAuditLog',
    'updateCampaignStatus',
    'adminSuspendCampaign',
    'adminRestoreCampaign',
    'adminFeatureCampaign',
    'adminUnfeatureCampaign',
    'adminDeleteCampaign',
    'adminBanUser',
    'adminUnbanUser',
    'adminPromoteUser',
    'adminDemoteUser',
    'listApiKeys',
    'createApiKey',
    'deleteApiKey',
    'listWebhooks',
    'createWebhook',
    'listWebhookDeliveries',
    'deleteWebhook',
    'getNotifications',
    'markNotificationRead',
    'markAllNotificationsRead',
  ];

  it('exposes every required API method as a function', () => {
    for (const methodName of expectedMethods) {
      expect(typeof api[methodName], `Method ${methodName} should exist`).toBe('function');
    }
  });

  it('calls correct endpoints for representative feature methods', async () => {
    const fetchFn = mockFetch({});

    await api.getAdminUsers(true);
    expect(fetchFn.mock.calls[0][0]).toMatch(/\/api\/admin\/users\?include_banned=true$/);

    await api.getAdminAuditLog({ limit: 5 });
    expect(fetchFn.mock.calls[1][0]).toMatch(/\/api\/admin\/audit-log\?limit=5$/);

    await api.getAdminMilestones();
    expect(fetchFn.mock.calls[2][0]).toMatch(/\/api\/admin\/milestones$/);

    await api.listWebhooks();
    expect(fetchFn.mock.calls[3][0]).toMatch(/\/api\/webhooks$/);

    await api.getNotifications();
    expect(fetchFn.mock.calls[4][0]).toMatch(/\/api\/notifications$/);
  });
});
