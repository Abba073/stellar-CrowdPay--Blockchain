import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import WithdrawalsSection from './WithdrawalsSection';
import * as freighter from '@stellar/freighter-api';
import { api } from '../services/api';

vi.mock('@stellar/freighter-api', () => ({
  getNetwork: vi.fn(),
  signTransaction: vi.fn(),
}));

const toast = vi.fn();
vi.mock('../context/ToastContext', () => ({
  useToast: () => toast,
}));

vi.mock('../services/api', () => ({
  api: {
    getWithdrawalCapabilities: vi.fn(),
    listWithdrawals: vi.fn(),
    getCampaignBalance: vi.fn(),
    requestWithdrawal: vi.fn(),
    approveWithdrawalCreator: vi.fn(),
    approveWithdrawalPlatform: vi.fn(),
    cancelWithdrawal: vi.fn(),
    rejectWithdrawal: vi.fn(),
    getWithdrawal: vi.fn(),
    getWithdrawalEvents: vi.fn(),
    submitMilestoneEvidence: vi.fn(),
  },
}));

const DEST = 'GDESTINATIONAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAXYZ';

const campaign = {
  id: 'camp-1',
  creator_id: 'creator-1',
  status: 'active',
  asset_type: 'USDC',
};

const creator = { id: 'creator-1', role: 'creator', wallet_type: 'custodial' };
const admin = { id: 'admin-1', role: 'admin' };

function pendingRow(overrides = {}) {
  return {
    id: 'wd-1',
    amount: '40',
    destination_key: DEST,
    status: 'pending',
    creator_signed: false,
    platform_signed: false,
    ...overrides,
  };
}

const onReleased = vi.fn();

function renderSection(props = {}) {
  return render(
    <WithdrawalsSection campaign={campaign} user={creator} onReleased={onReleased} {...props} />
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  api.getWithdrawalCapabilities.mockResolvedValue({ can_approve_platform: false });
  api.listWithdrawals.mockResolvedValue([]);
  api.getCampaignBalance.mockResolvedValue({ USDC: '100' });
  api.requestWithdrawal.mockResolvedValue({ id: 'wd-new' });
  api.approveWithdrawalCreator.mockResolvedValue({});
  api.approveWithdrawalPlatform.mockResolvedValue({});
  api.cancelWithdrawal.mockResolvedValue({});
  api.rejectWithdrawal.mockResolvedValue({});
  api.submitMilestoneEvidence.mockResolvedValue({});
});

describe('WithdrawalsSection visibility', () => {
  it('renders for a signed-in creator with cookie auth (no bearer token prop)', async () => {
    renderSection();
    expect(await screen.findByRole('heading', { name: /request a release/i })).toBeInTheDocument();
    expect(api.getWithdrawalCapabilities).toHaveBeenCalledWith();
    expect(api.listWithdrawals).toHaveBeenCalledWith('camp-1');
  });

  it('renders nothing for signed-out visitors and makes no requests', () => {
    const { container } = renderSection({ user: null });
    expect(container).toBeEmptyDOMElement();
    expect(api.listWithdrawals).not.toHaveBeenCalled();
  });

  it('renders nothing for users who are neither creator nor platform approver', async () => {
    const { container } = renderSection({ user: { id: 'someone-else', role: 'contributor' } });
    await waitFor(() => expect(api.listWithdrawals).toHaveBeenCalled());
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('hides itself when the API returns 403', async () => {
    api.listWithdrawals.mockRejectedValue(Object.assign(new Error('Forbidden'), { status: 403 }));
    const { container } = renderSection();
    await waitFor(() => expect(api.listWithdrawals).toHaveBeenCalled());
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it('shows a load error instead of hiding for other failures', async () => {
    api.listWithdrawals.mockRejectedValue(Object.assign(new Error('DB down'), { status: 500 }));
    renderSection();
    expect(await screen.findByRole('alert')).toHaveTextContent('DB down');
  });
});

describe('WithdrawalsSection creator request', () => {
  it('submits a release request and refreshes the list', async () => {
    const user = userEvent.setup();
    renderSection();
    await screen.findByText(/available on-chain/i);
    await user.type(screen.getByLabelText(/destination address/i), `  ${DEST}  `);
    await user.type(screen.getByLabelText(/amount \(usdc\)/i), '60');
    await user.click(screen.getByRole('button', { name: /submit request/i }));
    await waitFor(() =>
      expect(api.requestWithdrawal).toHaveBeenCalledWith({
        campaign_id: 'camp-1',
        destination_key: DEST,
        amount: '60',
      })
    );
    await waitFor(() => expect(api.listWithdrawals).toHaveBeenCalledTimes(2));
    expect(onReleased).toHaveBeenCalled();
  });

  it('blocks amounts above the live on-chain balance', async () => {
    const user = userEvent.setup();
    renderSection();
    await screen.findByText(/available on-chain/i);
    await user.type(screen.getByLabelText(/destination address/i), DEST);
    await user.type(screen.getByLabelText(/amount \(usdc\)/i), '150');
    expect(screen.getByRole('alert')).toHaveTextContent(/amount exceeds available balance/i);
    expect(screen.getByRole('button', { name: /amount exceeds balance/i })).toBeDisabled();
  });

  it('fills the full balance with "Use max"', async () => {
    const user = userEvent.setup();
    renderSection();
    await user.click(await screen.findByRole('button', { name: /use max/i }));
    expect(screen.getByLabelText(/amount \(usdc\)/i)).toHaveValue(100);
  });

  it('shows the API error when the request is rejected', async () => {
    api.requestWithdrawal.mockRejectedValue(new Error('Multisig configuration invalid'));
    const user = userEvent.setup();
    renderSection();
    await screen.findByText(/available on-chain/i);
    await user.type(screen.getByLabelText(/destination address/i), DEST);
    await user.type(screen.getByLabelText(/amount \(usdc\)/i), '10');
    await user.click(screen.getByRole('button', { name: /submit request/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Multisig configuration invalid');
    expect(onReleased).not.toHaveBeenCalled();
  });

  it('disables new requests while one is pending or when the campaign is not eligible', async () => {
    api.listWithdrawals.mockResolvedValue([pendingRow()]);
    const { unmount } = renderSection();
    expect(await screen.findByText(/you have a pending release/i)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /request a release/i })).not.toBeInTheDocument();
    unmount();

    api.listWithdrawals.mockResolvedValue([]);
    renderSection({ campaign: { ...campaign, status: 'failed' } });
    expect(await screen.findByText(/new withdrawal requests are disabled/i)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: /request a release/i })).not.toBeInTheDocument();
  });
});

describe('WithdrawalsSection creator signing', () => {
  it('signs a pending request with the custodial key', async () => {
    api.listWithdrawals.mockResolvedValue([pendingRow()]);
    const user = userEvent.setup();
    renderSection();
    await user.click(await screen.findByRole('button', { name: /sign as creator/i }));
    await waitFor(() => expect(api.approveWithdrawalCreator).toHaveBeenCalledWith('wd-1'));
    expect(toast).toHaveBeenCalledWith('Withdrawal signed', 'success');
    expect(onReleased).toHaveBeenCalled();
  });

  it('cancels a pending request before signing', async () => {
    api.listWithdrawals.mockResolvedValue([pendingRow()]);
    const user = userEvent.setup();
    renderSection();
    await screen.findByText(/awaiting creator signature/i);
    const row = screen.getByText(/awaiting creator signature/i).closest('li');
    await user.click(within(row).getByRole('button', { name: /^cancel$/i }));
    await waitFor(() =>
      expect(api.cancelWithdrawal).toHaveBeenCalledWith('wd-1', { reason: 'Cancelled by creator' })
    );
    expect(toast).toHaveBeenCalledWith('Withdrawal cancelled', 'success');
  });

  it('flags an expired XDR (410) and asks the creator to re-request', async () => {
    api.listWithdrawals.mockResolvedValue([pendingRow()]);
    api.approveWithdrawalCreator.mockRejectedValue(
      Object.assign(new Error('Gone'), { status: 410 })
    );
    const user = userEvent.setup();
    renderSection();
    await user.click(await screen.findByRole('button', { name: /sign as creator/i }));
    expect(await screen.findByText(/expired — please re-request/i)).toBeInTheDocument();
    expect(screen.getByText(/this withdrawal xdr has expired/i)).toBeInTheDocument();
    expect(toast).not.toHaveBeenCalled();
  });

  it('signs in Freighter for non-custodial creators', async () => {
    api.listWithdrawals.mockResolvedValue([pendingRow()]);
    api.getWithdrawal.mockResolvedValue({ id: 'wd-1', unsigned_xdr: 'UNSIGNED' });
    freighter.getNetwork.mockResolvedValue({
      networkPassphrase: 'Test SDF Network ; September 2015',
    });
    freighter.signTransaction.mockResolvedValue({ signedTxXdr: 'SIGNED' });
    const user = userEvent.setup();
    renderSection({
      user: { ...creator, wallet_type: 'freighter', wallet_public_key: 'GCREATOR' },
    });
    await user.click(await screen.findByRole('button', { name: /sign in freighter/i }));
    await waitFor(() =>
      expect(api.approveWithdrawalCreator).toHaveBeenCalledWith('wd-1', { signed_xdr: 'SIGNED' })
    );
    expect(api.getWithdrawal).toHaveBeenCalledWith('wd-1');
    expect(freighter.signTransaction).toHaveBeenCalledWith('UNSIGNED', {
      networkPassphrase: 'Test SDF Network ; September 2015',
      address: 'GCREATOR',
    });
  });

  it('reports a missing unsigned XDR without calling Freighter', async () => {
    api.listWithdrawals.mockResolvedValue([pendingRow()]);
    api.getWithdrawal.mockResolvedValue({ id: 'wd-1' });
    const user = userEvent.setup();
    renderSection({ user: { ...creator, wallet_type: 'freighter' } });
    await user.click(await screen.findByRole('button', { name: /sign in freighter/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/missing unsigned transaction/i);
    expect(freighter.signTransaction).not.toHaveBeenCalled();
    expect(api.approveWithdrawalCreator).not.toHaveBeenCalled();
  });
});

describe('WithdrawalsSection platform approval', () => {
  beforeEach(() => {
    api.getWithdrawalCapabilities.mockResolvedValue({ can_approve_platform: true });
    api.listWithdrawals.mockResolvedValue([pendingRow({ creator_signed: true })]);
  });

  it('approves and submits a creator-signed request', async () => {
    const user = userEvent.setup();
    renderSection({ user: admin });
    expect(await screen.findByText(/awaiting platform release/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /admin approve & submit/i }));
    await waitFor(() => expect(api.approveWithdrawalPlatform).toHaveBeenCalledWith('wd-1'));
    expect(toast).toHaveBeenCalledWith('Withdrawal approved', 'success');
  });

  it('rejects with a reason that is saved to the audit log', async () => {
    const user = userEvent.setup();
    renderSection({ user: admin });
    await user.click(await screen.findByRole('button', { name: /^reject$/i }));
    await user.type(
      screen.getByPlaceholderText(/reason for rejection/i),
      'Destination not verified'
    );
    await user.click(screen.getByRole('button', { name: /confirm reject/i }));
    await waitFor(() =>
      expect(api.rejectWithdrawal).toHaveBeenCalledWith('wd-1', {
        reason: 'Destination not verified',
      })
    );
    expect(api.approveWithdrawalPlatform).not.toHaveBeenCalled();
  });

  it('shows the Stellar error when submission fails', async () => {
    api.approveWithdrawalPlatform.mockRejectedValue(new Error('Stellar rejected the transaction'));
    const user = userEvent.setup();
    renderSection({ user: admin });
    await user.click(await screen.findByRole('button', { name: /admin approve & submit/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Stellar rejected the transaction');
    expect(toast).not.toHaveBeenCalled();
  });

  it('links released withdrawals to the explorer and loads the audit trail', async () => {
    api.listWithdrawals.mockResolvedValue([
      pendingRow({
        status: 'submitted',
        creator_signed: true,
        platform_signed: true,
        tx_hash: 'txhash1',
      }),
    ]);
    api.getWithdrawalEvents.mockResolvedValue([
      { id: 'e1', action: 'requested', created_at: new Date().toISOString() },
      { id: 'e2', action: 'platform_signed', note: 'ok', created_at: new Date().toISOString() },
    ]);
    const user = userEvent.setup();
    renderSection({ user: admin });
    expect(await screen.findByText(/released on-chain/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /view transaction/i })).toHaveAttribute(
      'href',
      expect.stringContaining('/tx/txhash1')
    );
    await user.click(screen.getByRole('button', { name: /audit trail/i }));
    expect(await screen.findByText('platform_signed')).toBeInTheDocument();
    expect(api.getWithdrawalEvents).toHaveBeenCalledWith('wd-1');
  });
});

describe('WithdrawalsSection milestone releases', () => {
  const milestones = [
    { id: 'm1', title: 'Prototype', release_percentage: '25', status: 'pending' },
    { id: 'm2', title: 'Done', release_percentage: '75', status: 'released' },
  ];

  it('replaces manual requests with per-milestone release forms', async () => {
    renderSection({ milestones });
    expect(await screen.findByText(/uses milestone-based releases/i)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /request milestone release/i })).toHaveLength(1);
    expect(screen.queryByRole('heading', { name: /request a release/i })).not.toBeInTheDocument();
  });

  it('requires evidence and a destination before submitting', async () => {
    const user = userEvent.setup();
    renderSection({ milestones });
    await user.click(await screen.findByRole('button', { name: /request milestone release/i }));
    expect(screen.getByRole('alert')).toHaveTextContent(
      /evidence and payout destination are both required/i
    );
    expect(api.submitMilestoneEvidence).not.toHaveBeenCalled();
  });

  it('submits milestone evidence and payout destination', async () => {
    const user = userEvent.setup();
    renderSection({ milestones });
    await user.type(await screen.findByLabelText(/evidence url/i), 'https://proof.example');
    await user.type(screen.getByLabelText(/destination address/i), DEST);
    await user.click(screen.getByRole('button', { name: /request milestone release/i }));
    await waitFor(() =>
      expect(api.submitMilestoneEvidence).toHaveBeenCalledWith('m1', {
        evidence_url: 'https://proof.example',
        destination_key: DEST,
      })
    );
    expect(onReleased).toHaveBeenCalled();
  });
});
