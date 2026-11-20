import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import AdminDashboard from './AdminDashboard';
import { api } from '../services/api';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => ({
  ...(await importOriginal()),
  useNavigate: () => mockNavigate,
}));

let mockUser = { id: 'admin-1', role: 'admin' };
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: mockUser, ready: true }),
}));

const dialog = { prompt: vi.fn(), confirm: vi.fn(), alert: vi.fn() };
vi.mock('../context/DialogContext', () => ({
  useDialog: () => dialog,
}));

vi.mock('../services/api', () => ({
  api: {
    getAdminCampaigns: vi.fn(),
    getCampaignDisputes: vi.fn(),
    updateDispute: vi.fn(),
    adminFeatureCampaign: vi.fn(),
    adminUnfeatureCampaign: vi.fn(),
  },
}));

const campaigns = [
  { id: 'c1', title: 'Solar Roofs' },
  { id: 'c2', title: 'Clean Water' },
];

const disputesByCampaign = {
  c1: [
    { id: 'd1', status: 'open', reason: 'Funds not delivered', created_at: '2026-01-01T00:00:00Z' },
  ],
  c2: [
    {
      id: 'd2',
      status: 'under_review',
      reason: 'Misleading pitch',
      created_at: '2026-03-01T00:00:00Z',
    },
  ],
};

function renderPage() {
  return render(
    <MemoryRouter>
      <AdminDashboard />
    </MemoryRouter>
  );
}

function disputeCard(reason) {
  return screen.getByText(reason).parentElement;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUser = { id: 'admin-1', role: 'admin' };
  api.getAdminCampaigns.mockResolvedValue(campaigns);
  api.getCampaignDisputes.mockImplementation((id) => Promise.resolve(disputesByCampaign[id] || []));
});

describe('AdminDashboard access', () => {
  it('redirects non-admins home', () => {
    mockUser = { id: 'u1', role: 'contributor' };
    renderPage();
    expect(mockNavigate).toHaveBeenCalledWith('/');
  });

  it('redirects signed-out visitors home', () => {
    mockUser = null;
    renderPage();
    expect(mockNavigate).toHaveBeenCalledWith('/');
  });
});

describe('AdminDashboard dispute queue', () => {
  it('aggregates disputes across campaigns, newest first', async () => {
    renderPage();
    const newest = await screen.findByText('Misleading pitch');
    const oldest = screen.getByText('Funds not delivered');
    expect(
      newest.compareDocumentPosition(oldest) & window.Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(within(disputeCard('Funds not delivered')).getByText('Solar Roofs')).toBeInTheDocument();
    expect(api.getCampaignDisputes).toHaveBeenCalledWith('c1');
    expect(api.getCampaignDisputes).toHaveBeenCalledWith('c2');
  });

  it('keeps the queue usable when one campaign fails to load', async () => {
    api.getCampaignDisputes.mockImplementation((id) =>
      id === 'c1' ? Promise.reject(new Error('boom')) : Promise.resolve(disputesByCampaign[id])
    );
    renderPage();
    expect(await screen.findByText('Misleading pitch')).toBeInTheDocument();
    expect(screen.queryByText('Funds not delivered')).not.toBeInTheDocument();
  });

  it('shows an empty state when there are no disputes', async () => {
    api.getCampaignDisputes.mockResolvedValue([]);
    renderPage();
    expect(await screen.findByText(/no disputes on record/i)).toBeInTheDocument();
  });

  it('offers every transition except the current status', async () => {
    renderPage();
    await screen.findByText('Funds not delivered');
    const card = disputeCard('Funds not delivered');
    expect(within(card).queryByRole('button', { name: '→ open' })).not.toBeInTheDocument();
    expect(
      within(card).getByRole('button', { name: '→ resolved_contributor' })
    ).toBeInTheDocument();
  });

  it('resolves a dispute with the prompted note and updates the card', async () => {
    dialog.prompt.mockResolvedValue('Refund contributors');
    api.updateDispute.mockResolvedValue({ id: 'd1', status: 'resolved_contributor' });
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Funds not delivered');
    await user.click(
      within(disputeCard('Funds not delivered')).getByRole('button', {
        name: '→ resolved_contributor',
      })
    );
    await waitFor(() =>
      expect(api.updateDispute).toHaveBeenCalledWith('d1', {
        status: 'resolved_contributor',
        resolution_note: 'Refund contributors',
      })
    );
    expect(dialog.prompt).toHaveBeenCalledWith('Resolution note (resolved_contributor):', {
      action: 'dispute.resolve',
    });
    const card = disputeCard('Funds not delivered');
    expect(await within(card).findByText('resolved_contributor')).toBeInTheDocument();
    expect(within(card).getByRole('button', { name: '→ open' })).toBeInTheDocument();
  });

  it('does nothing when the admin cancels the prompt', async () => {
    dialog.prompt.mockResolvedValue(null);
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Funds not delivered');
    await user.click(
      within(disputeCard('Funds not delivered')).getByRole('button', { name: '→ closed' })
    );
    await waitFor(() => expect(dialog.prompt).toHaveBeenCalled());
    expect(api.updateDispute).not.toHaveBeenCalled();
  });

  it('alerts the admin and leaves the status unchanged when the update fails', async () => {
    dialog.prompt.mockResolvedValue('');
    api.updateDispute.mockRejectedValue(new Error('Invalid transition'));
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Funds not delivered');
    await user.click(
      within(disputeCard('Funds not delivered')).getByRole('button', { name: '→ closed' })
    );
    await waitFor(() => expect(dialog.alert).toHaveBeenCalledWith('Invalid transition'));
    expect(api.updateDispute).toHaveBeenCalledWith('d1', {
      status: 'closed',
      resolution_note: undefined,
    });
    expect(within(disputeCard('Funds not delivered')).getByText('open')).toBeInTheDocument();
  });
});
