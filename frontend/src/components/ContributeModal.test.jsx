import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import ContributeModal from './ContributeModal';
import * as freighter from '@stellar/freighter-api';
import { api } from '../services/api';

vi.mock('@stellar/freighter-api', () => ({
  getNetwork: vi.fn(),
  isConnected: vi.fn(),
  requestAccess: vi.fn(),
  signTransaction: vi.fn(),
}));

// Auth is cookie-based: AuthContext exposes the user, never a bearer token.
vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ user: { id: 'user-1', wallet_public_key: 'GUSER' }, ready: true }),
}));

vi.mock('../services/api', () => ({
  api: {
    getPlatformConfig: vi.fn(),
    getContributions: vi.fn(),
    getAnchorInfo: vi.fn(),
    quoteContribution: vi.fn(),
    contribute: vi.fn(),
    prepareContribution: vi.fn(),
    submitSignedContribution: vi.fn(),
    getContributionFinalization: vi.fn(),
    startAnchorDeposit: vi.fn(),
    getAnchorDepositStatus: vi.fn(),
  },
}));

const TESTNET = 'Test SDF Network ; September 2015';

const campaign = {
  id: '11111111-1111-1111-1111-111111111111',
  title: 'Test Campaign',
  asset_type: 'USDC',
  status: 'active',
};

const onClose = vi.fn();
const onSuccess = vi.fn();

function renderModal(overrides = {}, props = {}) {
  return render(
    <ContributeModal
      campaign={{ ...campaign, ...overrides }}
      onClose={onClose}
      onSuccess={onSuccess}
      {...props}
    />
  );
}

function amountInput() {
  return screen.getByLabelText(/amount campaign receives/i);
}

// Flushes the 2 s finalization poll interval under fake timers.
async function advancePoll(times = 1) {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  api.getPlatformConfig.mockResolvedValue({ platform_fee_bps: 0 });
  api.getContributions.mockResolvedValue({ contributions: [] });
  api.getAnchorInfo.mockResolvedValue({ anchors: [] });
  api.quoteContribution.mockResolvedValue({
    send_asset: 'XLM',
    dest_asset: 'USDC',
    dest_amount: '10',
    max_send_amount: '12',
    path: ['USDC'],
  });
  api.contribute.mockResolvedValue({ tx_hash: 'abc123', conversion_quote: null });
  api.getContributionFinalization.mockResolvedValue({ finalization_status: 'pending' });
  freighter.isConnected.mockResolvedValue({ isConnected: false });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ContributeModal form', () => {
  it('renders the contribution form when opened', () => {
    renderModal();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(screen.getByText(/support this campaign/i)).toBeInTheDocument();
  });

  it('validates that amount must be a positive number', async () => {
    const user = userEvent.setup();
    renderModal();
    await user.type(amountInput(), '0');
    await user.click(screen.getByRole('button', { name: /confirm payment/i }));
    expect(screen.getByText(/enter an amount greater than zero/i)).toBeInTheDocument();
    expect(api.contribute).not.toHaveBeenCalled();
  });

  it('validates minimum contribution limit', async () => {
    const user = userEvent.setup();
    renderModal({ min_contribution: '5' });
    await user.type(amountInput(), '4');
    await user.click(screen.getByRole('button', { name: /confirm payment/i }));
    expect(
      await screen.findByText(/Contribution amount is below the minimum limit of 5 USDC/i)
    ).toBeInTheDocument();
    expect(api.contribute).not.toHaveBeenCalled();
  });

  it('validates maximum contribution limit', async () => {
    const user = userEvent.setup();
    renderModal({ max_contribution: '100' });
    await user.type(amountInput(), '101');
    await user.click(screen.getByRole('button', { name: /confirm payment/i }));
    expect(
      await screen.findByText(/Contribution violates the maximum limit of 100 USDC/i)
    ).toBeInTheDocument();
    expect(api.contribute).not.toHaveBeenCalled();
  });

  it('validates cumulative per-contributor cap', async () => {
    const user = userEvent.setup();
    renderModal({ max_per_user: '50', user_contributed_amount: 30 });
    await user.type(amountInput(), '25');
    await user.click(screen.getByRole('button', { name: /confirm payment/i }));
    expect(
      await screen.findByText(
        /You have already contributed 30 USDC. The per-contributor limit is 50./i
      )
    ).toBeInTheDocument();
    expect(api.contribute).not.toHaveBeenCalled();
  });

  it('shows the platform fee split when a fee is configured', async () => {
    api.getPlatformConfig.mockResolvedValue({ platform_fee_bps: 250 });
    const user = userEvent.setup();
    renderModal();
    await user.type(amountInput(), '100');
    expect(await screen.findByText(/platform fee:/i)).toBeInTheDocument();
    expect(screen.getByText(/2.5%/)).toBeInTheDocument();
  });

  it('closes on cancel', async () => {
    const user = userEvent.setup();
    renderModal();
    await user.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onClose).toHaveBeenCalled();
  });
});

describe('ContributeModal cross-asset quotes', () => {
  it('shows conversion preview when a quote is returned', async () => {
    const user = userEvent.setup();
    renderModal();
    await user.click(screen.getByRole('radio', { name: /XLM/i }));
    await user.type(amountInput(), '25');
    await waitFor(() =>
      expect(api.quoteContribution).toHaveBeenCalledWith({
        send_asset: 'XLM',
        dest_asset: 'USDC',
        dest_amount: '25',
      })
    );
    expect(await screen.findByText(/up to/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /confirm payment/i })).toBeEnabled();
  });

  it('explains a missing DEX path and blocks submission', async () => {
    api.quoteContribution.mockRejectedValue(Object.assign(new Error('not found'), { status: 404 }));
    const user = userEvent.setup();
    renderModal();
    await user.click(screen.getByRole('radio', { name: /XLM/i }));
    await user.type(amountInput(), '25');
    expect(await screen.findByText(/no conversion path is available/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /confirm payment/i })).toBeDisabled();
  });
});

describe('ContributeModal custodial payment and finalization', () => {
  async function submitCustodial(amount = '15') {
    renderModal();
    fireEvent.change(amountInput(), { target: { value: amount } });
    // Settle the submit promise chain without timers so this works with fake timers.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /confirm payment/i }));
    });
    expect(screen.getByRole('heading', { name: /confirming on stellar/i })).toBeInTheDocument();
  }

  it('submits the contribution without a bearer token argument', async () => {
    await submitCustodial('15');
    expect(api.contribute).toHaveBeenCalledTimes(1);
    expect(api.contribute.mock.calls[0]).toEqual([
      {
        campaign_id: campaign.id,
        amount: '15',
        send_asset: 'USDC',
        display_name: undefined,
      },
    ]);
  });

  it('shows the confirming state with an explorer link until the ledger finalizes', async () => {
    vi.useFakeTimers();
    await submitCustodial();
    expect(
      screen.getByRole('link', { name: /view transaction on stellar expert/i })
    ).toHaveAttribute('href', expect.stringContaining('/tx/abc123'));
    await advancePoll(2);
    expect(api.getContributionFinalization).toHaveBeenCalledWith('abc123');
    expect(screen.getByText(/confirming on stellar/i)).toBeInTheDocument();
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('moves to success once finalization_status is finalized', async () => {
    vi.useFakeTimers();
    api.getContributionFinalization
      .mockResolvedValueOnce({ finalization_status: 'pending' })
      .mockResolvedValueOnce({ finalization_status: 'finalized' });
    await submitCustodial();
    await advancePoll(2);
    expect(screen.getByRole('heading', { name: /payment submitted/i })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(api.getContributionFinalization).toHaveBeenCalledTimes(2);
  });

  it('surfaces an on-chain failure reported by finalization', async () => {
    vi.useFakeTimers();
    api.getContributionFinalization.mockResolvedValue({ finalization_status: 'failed' });
    await submitCustodial();
    await advancePoll(1);
    expect(screen.getByRole('alert')).toHaveTextContent(/transaction failed on stellar/i);
    expect(screen.getByRole('heading', { name: /payment failed/i })).toBeInTheDocument();
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('keeps polling through finalization errors and stops after the attempt budget', async () => {
    vi.useFakeTimers();
    api.getContributionFinalization
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValue({ finalization_status: 'pending' });
    await submitCustodial();
    await advancePoll(15);
    expect(api.getContributionFinalization).toHaveBeenCalledTimes(15);
    expect(screen.getByRole('heading', { name: /confirmation pending/i })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(/could not confirm whether this transaction reached the stellar ledger/i);
    expect(onSuccess).not.toHaveBeenCalled();

    await advancePoll(3);
    expect(api.getContributionFinalization).toHaveBeenCalledTimes(15);
  });

  it.each([
    [404, 'Campaign not found or no longer active.'],
    [422, 'Path payment failed'],
    [500, 'Server exploded'],
  ])(
    'shows a friendly error and stays on the form when submit fails with %s',
    async (status, text) => {
      api.contribute.mockRejectedValue(
        Object.assign(new Error(status === 404 ? 'x' : text), { status })
      );
      const user = userEvent.setup();
      renderModal();
      await user.type(amountInput(), '15');
      await user.click(screen.getByRole('button', { name: /confirm payment/i }));
      expect(await screen.findByRole('alert')).toHaveTextContent(text);
      expect(screen.getByText(/support this campaign/i)).toBeInTheDocument();
      expect(api.getContributionFinalization).not.toHaveBeenCalled();
      expect(onSuccess).not.toHaveBeenCalled();
    }
  );
});

describe('ContributeModal Freighter payment', () => {
  beforeEach(() => {
    freighter.isConnected.mockResolvedValue({ isConnected: true });
    freighter.requestAccess.mockResolvedValue({ address: 'GFREIGHTER' });
    freighter.getNetwork.mockResolvedValue({ network: 'TESTNET', networkPassphrase: TESTNET });
    freighter.signTransaction.mockResolvedValue({ signedTxXdr: 'SIGNED_XDR' });
    api.prepareContribution.mockResolvedValue({
      unsigned_xdr: 'UNSIGNED_XDR',
      prepare_token: 'prep-token',
      network_passphrase: TESTNET,
      network_name: 'TESTNET',
    });
    api.submitSignedContribution.mockResolvedValue({ tx_hash: 'freighter-hash' });
  });

  async function payWithFreighter(amount = '20') {
    const user = userEvent.setup();
    renderModal();
    await user.click(await screen.findByRole('radio', { name: /pay with freighter/i }));
    await user.type(amountInput(), amount);
    await user.click(screen.getByRole('button', { name: /review in freighter/i }));
  }

  it('prepares, signs locally and submits the signed XDR', async () => {
    await payWithFreighter('20');
    await screen.findByText(/confirming on stellar/i);
    expect(api.prepareContribution).toHaveBeenCalledWith({
      campaign_id: campaign.id,
      amount: '20',
      send_asset: 'USDC',
      sender_public_key: 'GFREIGHTER',
      display_name: undefined,
    });
    expect(freighter.signTransaction).toHaveBeenCalledWith('UNSIGNED_XDR', {
      networkPassphrase: TESTNET,
      address: 'GFREIGHTER',
    });
    expect(api.submitSignedContribution).toHaveBeenCalledWith({
      prepare_token: 'prep-token',
      signed_xdr: 'SIGNED_XDR',
    });
    expect(api.contribute).not.toHaveBeenCalled();
  });

  it('refuses to sign when Freighter is on a different network', async () => {
    freighter.getNetwork.mockResolvedValue({
      network: 'PUBLIC',
      networkPassphrase: 'Public Global Stellar Network ; September 2015',
    });
    await payWithFreighter();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /Freighter is connected to PUBLIC. Switch it to TESTNET/
    );
    expect(freighter.signTransaction).not.toHaveBeenCalled();
    expect(api.submitSignedContribution).not.toHaveBeenCalled();
  });

  it('reports a rejected signature without submitting', async () => {
    freighter.signTransaction.mockResolvedValue({ error: { message: 'User declined' } });
    await payWithFreighter();
    expect(await screen.findByRole('alert')).toHaveTextContent('User declined');
    expect(api.submitSignedContribution).not.toHaveBeenCalled();
  });
});

describe('ContributeModal anchor deposit', () => {
  const anchor = {
    id: 'moneygram',
    name: 'MoneyGram',
    available: true,
    environment: 'sandbox',
    asset: { code: 'USDC' },
  };

  beforeEach(() => {
    api.getAnchorInfo.mockResolvedValue({ anchors: [anchor] });
    api.startAnchorDeposit.mockResolvedValue({
      id: 'session-1',
      interactive_url: 'https://anchor.example/flow',
      anchor_transaction_id: 'anchor-tx-1',
    });
    vi.spyOn(window, 'open').mockReturnValue({ closed: false, close: vi.fn(), location: {} });
  });

  afterEach(() => {
    window.open.mockRestore();
  });

  async function startAnchorFlow() {
    const user = userEvent.setup();
    renderModal();
    await user.click(await screen.findByRole('radio', { name: /deposit via anchor/i }));
    await user.type(amountInput(), '30');
    await user.click(screen.getByRole('button', { name: /open deposit flow/i }));
  }

  it('starts the SEP-24 session and does not also submit a custodial contribution', async () => {
    api.getAnchorDepositStatus.mockResolvedValue({
      id: 'session-1',
      status: 'pending_user_transfer_start',
    });
    await startAnchorFlow();
    expect(await screen.findByText(/complete your deposit/i)).toBeInTheDocument();
    expect(api.startAnchorDeposit).toHaveBeenCalledWith({
      campaign_id: campaign.id,
      amount: '30',
      anchor_id: 'moneygram',
    });
    expect(api.contribute).not.toHaveBeenCalled();
    await waitFor(() => expect(api.getAnchorDepositStatus).toHaveBeenCalledWith('session-1'));
  });

  it('finishes when the backend reports the contribution transaction', async () => {
    api.getAnchorDepositStatus.mockResolvedValue({
      id: 'session-1',
      status: 'completed',
      contribution_tx_hash: 'anchor-contribution-hash',
      anchor_transaction_id: 'anchor-tx-1',
    });
    await startAnchorFlow();
    expect(await screen.findByRole('heading', { name: /payment submitted/i })).toBeInTheDocument();
    expect(screen.getByText('anchor-tx-1')).toBeInTheDocument();
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(api.contribute).not.toHaveBeenCalled();
  });

  it('returns to the form with the anchor error when the deposit fails', async () => {
    api.getAnchorDepositStatus.mockResolvedValue({
      id: 'session-1',
      status: 'failed',
      last_error: 'KYC rejected by anchor',
    });
    await startAnchorFlow();
    expect(await screen.findByRole('alert')).toHaveTextContent('KYC rejected by anchor');
    expect(screen.getByText(/support this campaign/i)).toBeInTheDocument();
    expect(onSuccess).not.toHaveBeenCalled();
  });
});
