import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import Dashboard from './Dashboard';

const api = {
  getMyBalance: vi.fn(),
  getMyContributions: vi.fn(),
  getMe: vi.fn(),
  getMyStats: vi.fn(),
  getMyCampaigns: vi.fn(),
};

const updateUser = vi.fn();
const authState = {
  user: {
    id: '1',
    name: 'Ada',
    email: 'ada@example.com',
    role: 'creator',
    wallet_public_key: 'GKEY',
    kyc_status: 'unverified',
  },
  token: 'jwt-token',
  ready: true,
  updateUser,
};

vi.mock('../services/api', () => ({ api }));
vi.mock('../context/AuthContext', () => ({ useAuth: () => authState }));
vi.mock('../components/KycPrompt', () => ({ default: () => <div data-testid="kyc-prompt" /> }));
vi.mock('../components/VerificationBadge', () => ({
  default: ({ status }) => <span data-testid="verification-badge">{status}</span>,
}));
vi.mock('../components/CampaignStatusBadge', () => ({
  default: ({ status }) => <span data-testid="campaign-status">{status}</span>,
}));
vi.mock('../components/DepositModal', () => ({
  default: ({ onClose, onSuccess }) => (
    <div data-testid="deposit-modal">
      <button onClick={onClose}>close</button>
      <button onClick={onSuccess}>deposited</button>
    </div>
  ),
}));

const ME = {
  id: '1',
  name: 'Ada',
  email: 'ada@example.com',
  role: 'creator',
  kyc_status: 'unverified',
};
const STATS = {
  total_campaigns: 3,
  total_raised: '9000',
  active_campaigns: 2,
  funded_campaigns: 1,
};
const CAMPAIGNS = [
  {
    id: 10,
    title: 'Garden',
    raised_amount: '1000',
    target_amount: '2000',
    asset_type: 'USDC',
    status: 'active',
    contributor_count: 5,
    has_milestones: false,
    deadline: '2024-12-31',
  },
  {
    id: 11,
    title: 'Kernel',
    raised_amount: '8000',
    target_amount: '8000',
    asset_type: 'XLM',
    status: 'funded',
    contributor_count: 20,
    has_milestones: true,
    deadline: null,
  },
];
const CONTRIBUTIONS = [
  {
    id: 'c1',
    campaign_id: 10,
    campaign_title: 'Garden',
    campaign_status: 'active',
    amount: '50',
    asset: 'USDC',
    created_at: '2024-06-01T00:00:00Z',
    tx_hash: 'txhash123',
    conversion_rate: '1',
  },
];

function mockCreatorData() {
  api.getMe.mockResolvedValue(ME);
  api.getMyStats.mockResolvedValue(STATS);
  api.getMyCampaigns.mockResolvedValue(CAMPAIGNS);
  api.getMyContributions.mockResolvedValue(CONTRIBUTIONS);
  api.getMyBalance.mockResolvedValue({ balance: { USDC: '120' } });
}

describe('Dashboard', () => {
  beforeEach(() => {
    api.getMyBalance.mockReset().mockResolvedValue({ balance: null });
    api.getMyContributions.mockReset().mockResolvedValue([]);
    api.getMe.mockReset().mockResolvedValue(ME);
    api.getMyStats.mockReset().mockResolvedValue(null);
    api.getMyCampaigns.mockReset().mockResolvedValue([]);
    updateUser.mockReset();
    authState.user = {
      id: '1',
      name: 'Ada',
      email: 'ada@example.com',
      role: 'creator',
      wallet_public_key: 'GKEY',
      kyc_status: 'unverified',
    };
    authState.token = 'jwt-token';
    authState.ready = true;
  });

  it('redirects to login when there is no user', () => {
    authState.user = null;
    render(
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>
    );
    expect(screen.queryByText('Dashboard')).not.toBeInTheDocument();
  });

  it('shows the wallet balance and opens the deposit modal', async () => {
    mockCreatorData();
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>
    );
    expect(await screen.findByText('Wallet balance')).toBeInTheDocument();
    expect(await screen.findByText(/120 USDC/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /add funds/i }));
    expect(await screen.findByTestId('deposit-modal')).toBeInTheDocument();
  });

  it('shows the balance as empty when there are no funds', async () => {
    api.getMe.mockResolvedValue(ME);
    api.getMyStats.mockResolvedValue(STATS);
    api.getMyCampaigns.mockResolvedValue([]);
    api.getMyContributions.mockResolvedValue([]);
    api.getMyBalance.mockResolvedValue({ balance: { USDC: '0' } });
    render(
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>
    );
    expect(await screen.findByText('No funds')).toBeInTheDocument();
  });

  it('shows creator stats and campaign progress for creators', async () => {
    mockCreatorData();
    render(
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>
    );
    expect(await screen.findByText('Identity verification')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument(); // total campaigns
    expect(screen.getByText('9,000')).toBeInTheDocument(); // total raised
    expect(screen.getByText('2')).toBeInTheDocument(); // active
    expect(screen.getByText('1')).toBeInTheDocument(); // funded
    expect(updateUser).toHaveBeenCalledWith(ME);

    expect(screen.getByText('Garden')).toBeInTheDocument();
    expect(screen.getByText(/1,000 \/ 2,000 USDC/i)).toBeInTheDocument();
    expect(screen.getByText(/5 contributors • Deadline/i)).toBeInTheDocument();
  });

  it('offers milestone release management for funded milestone campaigns', async () => {
    mockCreatorData();
    render(
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>
    );
    expect(await screen.findByText('Kernel')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /manage milestone releases/i });
    expect(link).toHaveAttribute('href', '/campaigns/11#withdrawals');
  });

  it('offers withdrawal for funded campaigns without milestones', async () => {
    mockCreatorData();
    api.getMyCampaigns.mockResolvedValue([
      { ...CAMPAIGNS[1], id: 12, has_milestones: false, title: 'Plain' },
    ]);
    render(
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>
    );
    expect(await screen.findByText('Plain')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /request withdrawal/i })).toHaveAttribute(
      'href',
      '/campaigns/12#withdrawals'
    );
  });

  it('shows an empty state when the creator has no campaigns', async () => {
    api.getMe.mockResolvedValue(ME);
    api.getMyStats.mockResolvedValue(STATS);
    api.getMyCampaigns.mockResolvedValue([]);
    api.getMyContributions.mockResolvedValue([]);
    render(
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>
    );
    expect(await screen.findByText(/no campaigns yet/i)).toBeInTheDocument();
  });

  it('lists contributions for non-creator accounts', async () => {
    authState.user = { ...authState.user, role: 'contributor' };
    api.getMyContributions.mockResolvedValue(CONTRIBUTIONS);
    api.getMyBalance.mockResolvedValue({ balance: { USDC: '5' } });
    render(
      <MemoryRouter initialEntries={['/dashboard?tab=contributions']}>
        <Dashboard />
      </MemoryRouter>
    );
    expect(await screen.findByText('Garden')).toBeInTheDocument();
    expect(screen.getByText(/50 USDC/i)).toBeInTheDocument();
    expect(screen.getByText(/View transaction/i)).toHaveAttribute(
      'href',
      expect.stringContaining('stellar.expert')
    );
  });

  it('shows an empty state for contributors without backing history', async () => {
    authState.user = { ...authState.user, role: 'contributor' };
    api.getMyContributions.mockResolvedValue([]);
    render(
      <MemoryRouter initialEntries={['/dashboard?tab=contributions']}>
        <Dashboard />
      </MemoryRouter>
    );
    expect(await screen.findByText(/not backed any campaigns yet/i)).toBeInTheDocument();
  });

  it('shows the conversion rate when present on a contribution', async () => {
    authState.user = { ...authState.user, role: 'contributor' };
    api.getMyContributions.mockResolvedValue([
      { ...CONTRIBUTIONS[0], source_asset: 'XLM', source_amount: '10' },
    ]);
    render(
      <MemoryRouter initialEntries={['/dashboard?tab=contributions']}>
        <Dashboard />
      </MemoryRouter>
    );
    expect(await screen.findByText(/conversion rate:/i)).toBeInTheDocument();
    expect(screen.getByText(/1 XLM ≈ 1 USDC/i)).toBeInTheDocument();
  });

  it('switches tabs via the tab buttons', async () => {
    mockCreatorData();
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>
    );
    expect(await screen.findByText('Garden')).toBeInTheDocument();

    await user.click(screen.getByRole('tab', { name: /my contributions/i }));
    expect(await screen.findByText('Garden')).toBeInTheDocument(); // contribution row title
    expect(screen.getByRole('tab', { name: /my contributions/i })).toHaveAttribute(
      'aria-selected',
      'true'
    );
  });

  it('shows an error alert when data loading fails', async () => {
    authState.user = { ...authState.user, role: 'contributor' };
    api.getMyContributions.mockRejectedValue(new Error('network down'));
    render(
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>
    );
    expect(await screen.findByText('network down')).toBeInTheDocument();
  });

  it('refreshes the balance after a successful deposit', async () => {
    mockCreatorData();
    api.getMyBalance
      .mockResolvedValueOnce({ balance: { USDC: '120' } })
      .mockResolvedValueOnce({ balance: { USDC: '320' } });
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <Dashboard />
      </MemoryRouter>
    );
    expect(await screen.findByText(/120 USDC/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /add funds/i }));
    const modal = await screen.findByTestId('deposit-modal');
    await user.click(within(modal).getByRole('button', { name: /deposited/i }));

    await waitFor(() => {
      expect(screen.getByText(/320 USDC/i)).toBeInTheDocument();
    });
  });
});
