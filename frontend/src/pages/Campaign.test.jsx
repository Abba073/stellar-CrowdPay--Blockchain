import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import Campaign from './Campaign';

const mockCampaign = {
  id: 1,
  title: 'Community Garden Project',
  description: 'Building a sustainable urban garden',
  target_amount: '5000',
  current_amount: '2500',
  asset: 'USDC',
  creator_id: 42,
  creator_name: 'Alice Green',
  status: 'active',
  deadline: new Date(Date.now() + 86400000 * 7).toISOString(),
  created_at: new Date().toISOString(),
  wallet_address: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
  allow_other_assets: false,
};

const mockContributions = {
  contributions: [
    {
      id: 101,
      sender_public_key: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      amount: '100',
      created_at: new Date().toISOString(),
      transaction_hash: 'abc123hash',
    },
  ],
  total: 1,
};

const mockUpdates = [
  {
    id: 1,
    campaign_id: 1,
    title: 'First Milestone Reached!',
    body: 'We have broken ground on the garden plot. **Thank you** everyone!',
    author_name: 'Alice Green',
    created_at: new Date().toISOString(),
  },
];

vi.mock('../components/CampaignQRCode', () => ({
  default: () => <div data-testid="campaign-qr-code" />,
}));

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { id: 42, email: 'alice@example.com', role: 'creator' },
    ready: true,
  }),
}));

vi.mock('../services/api', () => ({
  api: {
    getCampaign: vi.fn(),
    getContributions: vi.fn(),
    getMilestones: vi.fn(),
    getCampaignUpdates: vi.fn(),
    getCampaignAnalytics: vi.fn(),
    getCampaignMembers: vi.fn(),
    listWithdrawals: vi.fn(),
    getWithdrawalCapabilities: vi.fn().mockResolvedValue({ can_approve_platform: false }),
    getCampaignBalance: vi.fn().mockResolvedValue({ USDC: '2500' }),
    getStellarTransactions: vi.fn().mockResolvedValue({ transactions: [] }),
    checkBookmark: vi.fn().mockResolvedValue({ isBookmarked: false }),
  },
}));

vi.mock('@stellar/freighter-api', () => ({
  isConnected: vi.fn().mockResolvedValue(false),
  getPublicKey: vi.fn().mockResolvedValue(null),
  getNetwork: vi.fn().mockResolvedValue('TESTNET'),
  signTransaction: vi.fn(),
}));

import { api } from '../services/api';

describe('Campaign Page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getCampaign.mockResolvedValue({ ...mockCampaign, user_role: 'owner' });
    api.getContributions.mockResolvedValue(mockContributions);
    api.getMilestones.mockResolvedValue([]);
    api.getCampaignUpdates.mockResolvedValue(mockUpdates);
    api.getCampaignAnalytics.mockResolvedValue(null);
    api.getCampaignMembers.mockResolvedValue([]);
    api.listWithdrawals.mockResolvedValue([]);
    api.getStellarTransactions.mockResolvedValue({ transactions: [] });
    api.getCampaignBalance.mockResolvedValue({ USDC: '2500' });
  });

  it('renders campaign details, Updates section, and Backer Wall section correctly', async () => {
    render(
      <MemoryRouter initialEntries={['/campaigns/1']}>
        <Routes>
          <Route path="/campaigns/:id" element={<Campaign />} />
        </Routes>
      </MemoryRouter>
    );

    // Verify campaign title
    await waitFor(() => {
      expect(screen.getByText('Community Garden Project')).toBeInTheDocument();
    });

    // Verify Updates section and update title
    await waitFor(() => {
      expect(screen.getByText(/Updates \(1\)/i)).toBeInTheDocument();
      expect(screen.getByText('First Milestone Reached!')).toBeInTheDocument();
    });

    // Verify Backer Wall section and contribution
    await waitFor(() => {
      expect(screen.getByText(/Backer Wall \(1\)/i)).toBeInTheDocument();
    });
  });

  it('connects to SSE using base URL and auto-reconnects on error', async () => {
    const instances = [];
    class MockEventSource {
      constructor(url) {
        this.url = url;
        this.onopen = null;
        this.onmessage = null;
        this.onerror = null;
        this.close = vi.fn();
        instances.push(this);
      }
    }
    vi.stubGlobal('EventSource', MockEventSource);

    render(
      <MemoryRouter initialEntries={['/campaigns/1']}>
        <Routes>
          <Route path="/campaigns/:id" element={<Campaign />} />
        </Routes>
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(instances.length).toBeGreaterThanOrEqual(1);
    });
    expect(instances[0].url).toMatch(/\/api\/campaigns\/1\/stream$/);

    // Trigger error on first EventSource instance
    act(() => {
      instances[0].onerror(new Event('error'));
    });
    expect(instances[0].close).toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it('injects campaign meta tags once the campaign loads', async () => {
    render(
      <MemoryRouter initialEntries={['/campaigns/1']}>
        <Routes>
          <Route path="/campaigns/:id" element={<Campaign />} />
        </Routes>
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(document.title).toBe('Community Garden Project | CrowdPay');
      expect(
        document.querySelector('meta[property="og:title"]')?.getAttribute('content')
      ).toBe('Community Garden Project');
      expect(
        document.querySelector('meta[name="twitter:title"]')?.getAttribute('content')
      ).toBe('Community Garden Project');
      expect(
        document.querySelector('meta[name="description"]')?.getAttribute('content')
      ).toBe('Building a sustainable urban garden');
    });
  });

  it('resets the title and removes campaign meta tags on unmount', async () => {
    // Simulate tags injected server-side by nginx SSI before React mounts.
    const injected = document.createElement('meta');
    injected.setAttribute('property', 'og:title');
    injected.setAttribute('content', 'Server injected title');
    document.head.appendChild(injected);

    const { unmount } = render(
      <MemoryRouter initialEntries={['/campaigns/1']}>
        <Routes>
          <Route path="/campaigns/:id" element={<Campaign />} />
        </Routes>
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(
        document.querySelector('meta[property="og:title"]')?.getAttribute('content')
      ).toBe('Community Garden Project');
    });

    unmount();

    expect(document.title).toBe('CrowdPay');
    expect(document.querySelector('meta[property="og:title"]')).toBeNull();
    expect(document.querySelector('meta[property="og:description"]')).toBeNull();
    expect(document.querySelector('meta[property="og:url"]')).toBeNull();
    expect(document.querySelector('meta[name="twitter:title"]')).toBeNull();
    expect(document.querySelector('meta[name="twitter:description"]')).toBeNull();
    expect(document.querySelector('meta[name="twitter:card"]')).toBeNull();
    expect(document.querySelector('meta[name="description"]')).toBeNull();
  });
});
