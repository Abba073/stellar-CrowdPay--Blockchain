import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import AcceptInvite from './AcceptInvite';

const mockAccept = vi.fn();
const mockNavigate = vi.fn();
const authState = { user: { id: '1', name: 'A', email: 'a@b.c' }, ready: true };

vi.mock('../services/api', () => ({
  api: {
    acceptCampaignInvitation: (...args) => mockAccept(...args),
  },
}));

vi.mock('../context/AuthContext', () => ({
  useAuth: () => authState,
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

function renderInvite() {
  return render(
    <MemoryRouter initialEntries={['/campaigns/42/invites/token-abc']}>
      <Routes>
        <Route path="/campaigns/:id/invites/:token" element={<AcceptInvite />} />
      </Routes>
    </MemoryRouter>
  );
}

describe('AcceptInvite', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockAccept.mockReset();
    mockNavigate.mockReset();
    authState.user = { id: '1', name: 'A', email: 'a@b.c' };
    authState.ready = true;
  });

  it('shows a login prompt when the user is not authenticated', () => {
    authState.user = null;
    renderInvite();
    expect(screen.getByText(/must be logged in/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /log in/i })).toHaveAttribute('href', '/login');
    expect(screen.getByRole('link', { name: /create account/i })).toHaveAttribute(
      'href',
      '/register'
    );
  });

  it('renders the invitation screen for a logged-in user', () => {
    renderInvite();
    expect(screen.getByText('Accept Campaign Invitation')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /accept invitation/i })).toBeInTheDocument();
  });

  it('calls the accept endpoint with the campaign id and token', async () => {
    mockAccept.mockResolvedValue({});
    const user = userEvent.setup();
    renderInvite();
    await user.click(screen.getByRole('button', { name: /accept invitation/i }));

    await waitFor(() => {
      expect(mockAccept).toHaveBeenCalledWith('42', { token: 'token-abc' });
    });
  });

  it('shows a success message and redirects to the campaign after accepting', async () => {
    mockAccept.mockResolvedValue({});
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderInvite();
    await user.click(screen.getByRole('button', { name: /accept invitation/i }));

    expect(await screen.findByText(/invitation accepted/i)).toBeInTheDocument();
    expect(mockAccept).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(mockNavigate).toHaveBeenCalledWith('/campaigns/42');
  });

  it('shows an error message when the request fails', async () => {
    mockAccept.mockRejectedValue(new Error('Invitation no longer valid'));
    const user = userEvent.setup();
    renderInvite();
    await user.click(screen.getByRole('button', { name: /accept invitation/i }));

    expect(await screen.findByText('Invitation no longer valid')).toBeInTheDocument();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('disables the button while the request is in flight', async () => {
    let resolve;
    mockAccept.mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        })
    );
    const user = userEvent.setup();
    renderInvite();
    await user.click(screen.getByRole('button', { name: /accept invitation/i }));

    expect(await screen.findByRole('button', { name: /accepting/i })).toBeDisabled();
    await act(async () => {
      resolve({});
      await vi.advanceTimersByTimeAsync(2000);
    });
  });
});
