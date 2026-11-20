import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import Profile from './Profile';

const mockUpdateMe = vi.fn();
const mockUpdateUser = vi.fn();
const authState = {
  user: {
    id: '1',
    name: 'Ada',
    email: 'ada@example.com',
    wallet_public_key: 'GABC123WALLET',
    created_at: '2024-01-15T00:00:00.000Z',
  },
  ready: true,
  updateUser: mockUpdateUser,
};

vi.mock('../services/api', () => ({
  api: {
    updateMe: (...args) => mockUpdateMe(...args),
  },
}));

vi.mock('../context/AuthContext', () => ({
  useAuth: () => authState,
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return actual;
});

describe('Profile', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockUpdateMe.mockReset();
    mockUpdateUser.mockReset();
    authState.user = {
      id: '1',
      name: 'Ada',
      email: 'ada@example.com',
      wallet_public_key: 'GABC123WALLET',
      created_at: '2024-01-15T00:00:00.000Z',
    };
    authState.ready = true;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('redirects to login when there is no user', () => {
    authState.user = null;
    render(
      <MemoryRouter>
        <Profile />
      </MemoryRouter>
    );
    expect(screen.queryByText('Your Profile')).not.toBeInTheDocument();
  });

  it('renders account details for the signed-in user', () => {
    render(
      <MemoryRouter>
        <Profile />
      </MemoryRouter>
    );
    expect(screen.getByText('Your Profile')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Ada')).toBeInTheDocument();
    expect(screen.getByDisplayValue('ada@example.com')).toBeInTheDocument();
    expect(screen.getByText('GABC123WALLET')).toBeInTheDocument();
    expect(screen.getByText('Your Stellar wallet')).toBeInTheDocument();
  });

  it('pre-fills the display name from the user profile', () => {
    render(
      <MemoryRouter>
        <Profile />
      </MemoryRouter>
    );
    const nameInput = screen.getByLabelText(/display name/i);
    expect(nameInput).toHaveValue('Ada');
  });

  it('disables save when the name is unchanged', () => {
    render(
      <MemoryRouter>
        <Profile />
      </MemoryRouter>
    );
    expect(screen.getByRole('button', { name: /save changes/i })).toBeDisabled();
  });

  it('shows a validation error when the name is cleared', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <Profile />
      </MemoryRouter>
    );
    await user.clear(screen.getByLabelText(/display name/i));
    expect(await screen.findByText(/display name is required/i)).toBeInTheDocument();
    expect(mockUpdateMe).not.toHaveBeenCalled();
  });

  it('updates the profile and shows a success message', async () => {
    mockUpdateMe.mockResolvedValue({ id: '1', name: 'Ada Lovelace' });
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <Profile />
      </MemoryRouter>
    );
    await user.clear(screen.getByLabelText(/display name/i));
    await user.type(screen.getByLabelText(/display name/i), 'Ada Lovelace');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => {
      expect(mockUpdateMe).toHaveBeenCalledWith({ name: 'Ada Lovelace' });
    });
    expect(mockUpdateUser).toHaveBeenCalledWith({ id: '1', name: 'Ada Lovelace' });
    expect(await screen.findByText(/profile updated successfully/i)).toBeInTheDocument();
  });

  it('shows an error when the update request fails', async () => {
    mockUpdateMe.mockRejectedValue(new Error('Could not save profile'));
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <Profile />
      </MemoryRouter>
    );
    await user.clear(screen.getByLabelText(/display name/i));
    await user.type(screen.getByLabelText(/display name/i), 'New Name');
    await user.click(screen.getByRole('button', { name: /save changes/i }));

    expect(await screen.findByText('Could not save profile')).toBeInTheDocument();
  });

  it('copies the wallet address to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <Profile />
      </MemoryRouter>
    );
    await user.click(screen.getByRole('button', { name: /copy address/i }));

    expect(writeText).toHaveBeenCalledWith('GABC123WALLET');
    expect(await screen.findByRole('button', { name: /copied!/i })).toBeInTheDocument();
    delete navigator.clipboard;
  });

  it('shows the Stellar Expert link for the wallet', () => {
    render(
      <MemoryRouter>
        <Profile />
      </MemoryRouter>
    );
    const link = screen.getByRole('link', { name: /stellar expert/i });
    expect(link).toHaveAttribute('href', expect.stringContaining('stellar.expert'));
    expect(link).toHaveAttribute('target', '_blank');
  });
});
