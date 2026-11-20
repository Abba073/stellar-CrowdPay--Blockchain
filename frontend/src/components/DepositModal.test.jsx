import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import DepositModal from './DepositModal';
import { api } from '../services/api';

vi.mock('../services/api', () => ({
  api: {
    getMyBalance: vi.fn(),
    getSep24Assets: vi.fn(),
    startWalletDeposit: vi.fn(),
    getAnchorDepositStatus: vi.fn(),
  },
}));

const anchors = [
  {
    id: 'moneygram',
    name: 'MoneyGram',
    available: true,
    environment: 'sandbox',
    rails: ['cash', 'bank'],
    asset: { code: 'USDC' },
  },
  {
    id: 'offline',
    name: 'Offline Anchor',
    available: false,
    environment: 'sandbox',
    asset: { code: 'NGN' },
  },
];

const onClose = vi.fn();
const onSuccess = vi.fn();
let popup;

function renderModal() {
  return render(<DepositModal onClose={onClose} onSuccess={onSuccess} />);
}

async function submitDeposit(amount = '50') {
  const user = userEvent.setup();
  renderModal();
  await screen.findByRole('radio', { name: /moneygram/i });
  await user.type(screen.getByLabelText(/amount/i), amount);
  await user.click(screen.getByRole('button', { name: /continue/i }));
  return user;
}

beforeEach(() => {
  vi.clearAllMocks();
  popup = { closed: false, close: vi.fn(), location: {} };
  vi.spyOn(window, 'open').mockReturnValue(popup);
  api.getMyBalance.mockResolvedValue({ balance: { USDC: '12.5', XLM: '0' } });
  api.getSep24Assets.mockResolvedValue({ anchors });
  api.startWalletDeposit.mockResolvedValue({
    id: 'deposit-1',
    interactive_url: 'https://anchor.example/deposit',
    anchor_transaction_id: 'anchor-tx-9',
  });
  api.getAnchorDepositStatus.mockResolvedValue({
    id: 'deposit-1',
    status: 'pending_user_transfer_start',
  });
});

afterEach(() => {
  window.open.mockRestore();
});

describe('DepositModal', () => {
  it('shows the current wallet balance and only available anchors', async () => {
    renderModal();
    expect(await screen.findByText(/12.5 USDC/)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /moneygram/i })).toBeChecked();
    expect(screen.queryByRole('radio', { name: /offline anchor/i })).not.toBeInTheDocument();
  });

  it('rejects a zero amount without starting a deposit', async () => {
    await submitDeposit('0');
    expect(screen.getByRole('alert')).toHaveTextContent(/enter an amount greater than zero/i);
    expect(api.startWalletDeposit).not.toHaveBeenCalled();
    expect(window.open).not.toHaveBeenCalled();
  });

  it('refuses to start when no anchor is available', async () => {
    api.getSep24Assets.mockResolvedValue({ anchors: [anchors[1]] });
    const user = userEvent.setup();
    renderModal();
    await waitFor(() => expect(api.getSep24Assets).toHaveBeenCalled());
    await user.type(screen.getByLabelText(/amount/i), '10');
    await user.click(screen.getByRole('button', { name: /continue/i }));
    expect(screen.getByRole('alert')).toHaveTextContent(/no deposit anchor is available/i);
    expect(api.startWalletDeposit).not.toHaveBeenCalled();
  });

  it('starts the hosted flow in a popup and polls the session', async () => {
    await submitDeposit('50');
    expect(await screen.findByText(/complete your deposit/i)).toBeInTheDocument();
    expect(api.startWalletDeposit).toHaveBeenCalledWith({ amount: '50', anchor_id: 'moneygram' });
    expect(popup.location.href).toBe('https://anchor.example/deposit');
    await waitFor(() => expect(api.getAnchorDepositStatus).toHaveBeenCalledWith('deposit-1'));
    expect(onSuccess).not.toHaveBeenCalled();
  });

  it('finalizes when the anchor reports the deposit as completed', async () => {
    api.getAnchorDepositStatus.mockResolvedValue({
      id: 'deposit-1',
      status: 'completed',
      anchor_transaction_id: 'anchor-tx-9',
    });
    await submitDeposit();
    expect(await screen.findByRole('heading', { name: /deposit submitted/i })).toBeInTheDocument();
    expect(onSuccess).toHaveBeenCalledTimes(1);
    expect(popup.close).toHaveBeenCalled();
  });

  it('returns to the form with the anchor error when the deposit fails', async () => {
    api.getAnchorDepositStatus.mockResolvedValue({
      id: 'deposit-1',
      status: 'failed',
      last_error: 'Bank transfer bounced',
    });
    await submitDeposit();
    expect(await screen.findByRole('alert')).toHaveTextContent('Bank transfer bounced');
    expect(screen.getByRole('heading', { name: /add funds/i })).toBeInTheDocument();
    expect(onSuccess).not.toHaveBeenCalled();
    expect(popup.close).toHaveBeenCalled();
  });

  it('closes the popup and shows the error when the session cannot start', async () => {
    api.startWalletDeposit.mockRejectedValue(new Error('SEP-10 auth failed'));
    await submitDeposit();
    expect(await screen.findByRole('alert')).toHaveTextContent('SEP-10 auth failed');
    expect(popup.close).toHaveBeenCalled();
    expect(api.getAnchorDepositStatus).not.toHaveBeenCalled();
  });

  it('falls back to a new tab when the popup is blocked', async () => {
    window.open.mockReturnValueOnce(null);
    await submitDeposit();
    await screen.findByText(/complete your deposit/i);
    expect(window.open).toHaveBeenLastCalledWith(
      'https://anchor.example/deposit',
      '_blank',
      'noopener,noreferrer'
    );
  });
});
