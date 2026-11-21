const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/+$/, '');
const BASE = `${API_BASE_URL}/api`;
let refreshPromise = null;

const TIMEOUTS = {
  GET: 10_000, // 10 s
  POST: 20_000, // 20 s — Stellar submissions can be slow
  PATCH: 15_000,
  DELETE: 10_000,
};

function jsonHeaders() {
  return {
    'Content-Type': 'application/json',
  };
}

async function request(method, path, body, options = {}) {
  const { query, _retry = false } = options || {};
  let url = `${BASE}${path}`;

  if (query && Object.keys(query).length) {
    const params = new URLSearchParams();
    Object.entries(query).forEach(([k, v]) => {
      if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
    });
    url += `?${params.toString()}`;
  }

  const controller = new AbortController();
  const timeoutMs = TIMEOUTS[method] ?? 15_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  try {
    res = await fetch(url, {
      method,
      headers: body ? jsonHeaders() : undefined,
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'include',
      signal: controller.signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('Request timed out. Check your connection and try again.');
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error('Unexpected server response. Please try again.');
    }
  }

  const publicAuthPaths = [
    '/auth/refresh',
    '/auth/login',
    '/auth/forgot-password',
    '/auth/reset-password',
  ];

  if (res.status === 401 && !_retry && !publicAuthPaths.includes(path)) {
    const promise = refresh();
    if (promise) {
      try {
        await promise;
        return request(method, path, body, { ...options, _retry: true });
      } catch {
        const err = new Error("Session expired. Please log in again.");
        err.status = res.status;
        throw err;
      }
    }
  }

  if (!res.ok) {
    const errorBody = data.error;
    const message =
      typeof errorBody === 'string'
        ? errorBody
        : errorBody?.message || `Request failed (${res.status})`;

    const err = new Error(message);
    err.status = res.status;

    if (errorBody && typeof errorBody === 'object') {
      err.code = errorBody.code;
      err.fields = errorBody.fields;
    }

    throw err;
  }

  return data;
}

async function uploadFormData(path, formData) {
  const url = `${BASE}${path}`;

  const res = await fetch(url, {
    method: 'POST',
    body: formData,
    credentials: 'include',
  });

  const text = await res.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error('Unexpected server response. Please try again.');
    }
  }

  if (!res.ok) {
    const errorBody = data.error;
    const message =
      typeof errorBody === 'string'
        ? errorBody
        : errorBody?.message || `Request failed (${res.status})`;

    const err = new Error(message);
    err.status = res.status;

    if (errorBody && typeof errorBody === 'object') {
      err.code = errorBody.code;
      err.fields = errorBody.fields;
    }

    throw err;
  }

  return data;
}

async function refresh() {
  if (refreshPromise) {
    return refreshPromise;
  }

  refreshPromise = (async () => {
    try {
      const res = await fetch(`${BASE}/auth/refresh`, {
        method: "POST",
        credentials: "include",
      });

      if (!res.ok) {
        const text = await res.text();
        let error = "Refresh failed";
        try {
          const data = JSON.parse(text);
          error = data.error || error;
        } catch {}
        throw new Error(error);
      }

      const data = await res.json();
      return data;
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

async function logout() {
  const res = await fetch(`${BASE}/auth/logout`, {
    method: 'POST',
    credentials: 'include',
  });

  if (!res.ok) {
    const text = await res.text();
    let error = 'Logout failed';
    try {
      const data = JSON.parse(text);
      error = data.error || error;
    } catch {}
    throw new Error(error);
  }

  return { message: 'Logged out' };
}

export const api = {
  getPlatformConfig: () => request('GET', '/config'),

  register: (body) => request('POST', '/auth/register', body),
  login: (body) => request('POST', '/auth/login', body),
  forgotPassword: (body) => request('POST', '/auth/forgot-password', body),
  resetPassword: (body) => request('POST', '/auth/reset-password', body),
  logout: () => logout(),
  refresh,

  getMe: () => request('GET', '/users/me'),
  updateMe: (body) => request('PATCH', '/users/me', body),
  getMyBalance: () => request('GET', '/users/me/balance'),
  getMyStats: () => request('GET', '/users/me/stats'),
  getMyContributions: () => request('GET', '/contributions/mine'),
  startKyc: () => request('POST', '/users/me/kyc/start'),

  getMyCampaigns: () => request('GET', '/campaigns/mine'),
  getFeaturedCampaigns: () => request('GET', '/campaigns/featured'),
  getCampaigns: (options = {}) => request('GET', '/campaigns', null, { query: options }),
  getCampaign: (id) => request('GET', `/campaigns/${id}`),
  getCampaignCategories: () => request('GET', '/campaigns/categories'),
  getCloneData: async (id) => {
    const c = await request('GET', `/campaigns/${id}`);
    return {
      title: c.title,
      description: c.description,
      target_amount: c.target_amount,
      asset_type: c.asset_type,
      min_contribution: c.min_contribution ?? '',
      max_contribution: c.max_contribution ?? '',
      max_per_user: c.max_per_user ?? '',
      show_backer_amounts: c.show_backer_amounts,
      category: c.category ?? '',
    };
  },
  getCampaignAnalytics: (id) => request('GET', `/campaigns/${id}/analytics`),
  getCampaignEmbed: (id) => request('GET', `/campaigns/${id}/embed`),
  getCampaignBackers: (id) => request('GET', `/campaigns/${id}/backers`),
  getCampaignBalance: (id) => request('GET', `/campaigns/${id}/balance`),
  createCampaign: (body) => request('POST', '/campaigns', body),
  updateCampaign: (id, body) => request('PATCH', `/campaigns/${id}`, body),
  deleteCampaign: (id) => request('DELETE', `/campaigns/${id}`),
  uploadCampaignCoverImage: (campaignId, file) => {
    const formData = new FormData();
    formData.append('cover_image', file);
    return uploadFormData(`/campaigns/${encodeURIComponent(campaignId)}/cover-image`, formData);
  },

  getCampaignMembers: (campaignId) => request('GET', `/campaigns/${campaignId}/members`),
  inviteCampaignMember: (campaignId, body) =>
    request('POST', `/campaigns/${campaignId}/members`, body),
  updateCampaignMemberRole: (campaignId, userId, body) =>
    request('PATCH', `/campaigns/${campaignId}/members/${userId}`, body),
  removeCampaignMember: (campaignId, userId) =>
    request('DELETE', `/campaigns/${campaignId}/members/${userId}`),
  acceptCampaignInvitation: (campaignId, body) =>
    request('POST', `/campaigns/${campaignId}/members/accept`, body),
  getAnchorInfo: () => request('GET', '/anchor/info'),
  startAnchorDeposit: (body) => request('POST', '/anchor/deposits/start', body),
  getAnchorDepositStatus: (id) => request('GET', `/anchor/deposits/${id}`),
  getSep24Assets: () => request('GET', '/anchor/sep24/assets'),
  startWalletDeposit: (body) => request('POST', '/anchor/sep24/deposit', body),
  getCampaignUpdates: (campaignId, options = {}) =>
    request('GET', `/campaigns/${campaignId}/updates`, null, {
      query: options,
    }),
  postCampaignUpdate: (campaignId, body) =>
    request('POST', `/campaigns/${campaignId}/updates`, body),
  updateCampaignUpdate: (campaignId, updateId, body) =>
    request('PATCH', `/campaigns/${campaignId}/updates/${updateId}`, body),
  deleteCampaignUpdate: (campaignId, updateId) =>
    request('DELETE', `/campaigns/${campaignId}/updates/${updateId}`),

  getContributions: (campaignId, options = {}) =>
    request('GET', `/contributions/campaign/${campaignId}`, null, {
      query: options,
    }),
  getMilestones: (campaignId) => request('GET', `/campaigns/${campaignId}/milestones`),
  setCampaignMilestones: (campaignId, milestones) =>
    request('POST', `/campaigns/${campaignId}/milestones`, { milestones }),
  submitMilestoneEvidence: (id, body) => request('POST', `/milestones/${id}/submit`, body),
  approveMilestone: (id, body) => request('POST', `/milestones/${id}/release`, body || {}),
  rejectMilestone: (id, body) => request('POST', `/milestones/${id}/reject`, body || {}),
  contribute: (body) => request('POST', '/contributions', body),
  prepareContribution: (body) => request('POST', '/contributions/prepare', body),
  submitSignedContribution: (body) => request('POST', '/contributions/submit-signed', body),
  buildContributionXdr: (body) => request('POST', '/contributions/build-xdr', body),
  guestContribute: (body) => request('POST', '/contributions/guest', body),
  quoteContribution: ({ send_asset, dest_asset, dest_amount }) =>
    request('GET', '/contributions/quote', null, {
      query: { send_asset, dest_asset, dest_amount },
    }),
  getContributionFinalization: (txHash) => request('GET', `/contributions/finalization/${txHash}`),
  getStellarTransactions: (options = {}) => {
    const { campaignId, campaign_id, ...rest } = options || {};
    const query = {
      ...rest,
      ...(campaignId || campaign_id ? { campaign_id: campaign_id || campaignId } : {}),
    };
    return request('GET', '/stellar/transactions', null, { query });
  },
  failExpiredCampaigns: () => request('POST', '/campaigns/cron/fail-expired'),
  triggerCampaignRefunds: (campaignId) =>
    request('POST', `/campaigns/${campaignId}/trigger-refunds`),
  initiateRefund: (id) => request('POST', `/campaigns/${id}/refund/initiate`, {}),
  approveRefundCreator: (id, body) =>
    request('POST', `/campaigns/${id}/refund/approve/creator`, body || {}),
  approveRefundPlatform: (id) => request('POST', `/campaigns/${id}/refund/approve/platform`, {}),

  getWithdrawalCapabilities: () => request('GET', '/withdrawals/capabilities'),
  listWithdrawals: (campaignId) => request('GET', `/withdrawals/campaign/${campaignId}`),
  requestWithdrawal: (body) => request('POST', '/withdrawals/request', body),
  approveWithdrawalCreator: (id, body) =>
    request('POST', `/withdrawals/${id}/approve/creator`, body || {}),
  approveWithdrawalPlatform: (id) => request('POST', `/withdrawals/${id}/approve/platform`, {}),
  cancelWithdrawal: (id, body) => request('POST', `/withdrawals/${id}/cancel`, body || {}),
  rejectWithdrawal: (id, body) => request('POST', `/withdrawals/${id}/reject`, body || {}),
  getWithdrawalEvents: (id) => request('GET', `/withdrawals/${id}/events`),
  getWithdrawal: (id) => request('GET', `/withdrawals/${id}`),

  raiseDispute: (campaignId, body) => request('POST', `/campaigns/${campaignId}/disputes`, body),
  getCampaignDisputes: (campaignId) => request('GET', `/campaigns/${campaignId}/disputes`),
  updateDispute: (id, body) => request('PATCH', `/disputes/${id}`, body),
  getDisputeEvents: (id) => request('GET', `/disputes/${id}/events`),

  getAdminStats: () => request('GET', '/admin/stats'),
  getAdminCampaigns: () => request('GET', '/admin/campaigns'),
  getAdminMilestones: (options = {}) =>
    request('GET', '/admin/milestones', null, { query: options }),
  getAdminUsers: (include_banned = false) =>
    request('GET', '/admin/users', null, {
      query: { include_banned: include_banned ? 'true' : 'false' },
    }),
  getAdminAuditLog: (options = {}) => request('GET', '/admin/audit-log', null, { query: options }),
  getAdminDisputes: (options = {}) => request('GET', '/admin/disputes', null, { query: options }),
  updateCampaignStatus: (id, status) => request('PATCH', `/admin/campaigns/${id}/status`, { status }),
  adminSuspendCampaign: (id, body) => request('PATCH', `/admin/campaigns/${id}/suspend`, body),
  adminRestoreCampaign: (id) => request('PATCH', `/admin/campaigns/${id}/restore`, {}),
  adminFeatureCampaign: (id, body) => request('PATCH', `/admin/campaigns/${id}/feature`, body),
  adminUnfeatureCampaign: (id) => request('PATCH', `/admin/campaigns/${id}/unfeature`, {}),
  adminDeleteCampaign: (id, body) => request('DELETE', `/admin/campaigns/${id}`, body),
  adminBanUser: (id, body) => request('PATCH', `/admin/users/${id}/ban`, body),
  adminUnbanUser: (id) => request('PATCH', `/admin/users/${id}/unban`, {}),
  adminPromoteUser: (id) => request('PATCH', `/admin/users/${id}/promote`, {}),
  adminDemoteUser: (id) => request('PATCH', `/admin/users/${id}/demote`, {}),
  listApiKeys: () => request('GET', '/api-keys'),
  createApiKey: (body) => request('POST', '/api-keys', body),
  deleteApiKey: (id) => request('DELETE', `/api-keys/${id}`),
  listWebhooks: () => request('GET', '/webhooks'),
  createWebhook: (body) => request('POST', '/webhooks', body),
  listWebhookDeliveries: (options = {}) =>
    request('GET', '/webhooks/deliveries', null, { query: options }),
  deleteWebhook: (id) => request('DELETE', `/webhooks/${id}`),

  getNotifications: () => request('GET', '/notifications'),
  markNotificationRead: (id) => request('PATCH', `/notifications/${id}/read`, {}),
  markAllNotificationsRead: () => request('PATCH', '/notifications/read-all', {}),
};
