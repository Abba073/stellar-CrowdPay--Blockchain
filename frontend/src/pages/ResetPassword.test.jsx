import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import ResetPassword from './ResetPassword';

const mockResetPassword = vi.fn();
const mockNavigate = vi.fn();

vi.mock('../services/api', () => ({
  api: {
    resetPassword: (...args) => mockResetPassword(...args),
  },
}));

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

function renderWithToken(token) {
  const initialEntry = token ? `/reset-password?token=${token}` : '/reset-password';
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route path="/reset-password" element={<ResetPassword />} />
      </Routes>
    </MemoryRouter>
  );
}

describe('ResetPassword', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    mockResetPassword.mockReset();
    mockNavigate.mockReset();
  });

  it('shows an invalid link message when the token is missing', () => {
    renderWithToken(null);
    expect(screen.getByText('Invalid link')).toBeInTheDocument();
    expect(screen.getByText(/invalid or missing a token/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /request a new link/i })).toHaveAttribute(
      'href',
      '/forgot-password'
    );
  });

  it('renders the reset form when a token is present', () => {
    renderWithToken('abc123');
    expect(screen.getByText('Reset password')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('New password')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Confirm new password')).toBeInTheDocument();
  });

  it('rejects mismatched passwords without calling the API', async () => {
    const user = userEvent.setup();
    renderWithToken('abc123');
    await user.type(screen.getByPlaceholderText('New password'), 'Password1');
    await user.type(screen.getByPlaceholderText('Confirm new password'), 'Password2');
    await user.click(screen.getByRole('button', { name: /reset password/i }));

    expect(await screen.findByText('Passwords do not match')).toBeInTheDocument();
    expect(mockResetPassword).not.toHaveBeenCalled();
  });

  it('rejects passwords shorter than 8 characters', async () => {
    const user = userEvent.setup();
    renderWithToken('abc123');
    await user.type(screen.getByPlaceholderText('New password'), 'Pass1');
    await user.type(screen.getByPlaceholderText('Confirm new password'), 'Pass1');
    await user.click(screen.getByRole('button', { name: /reset password/i }));

    expect(await screen.findByText(/at least 8 characters/i)).toBeInTheDocument();
    expect(mockResetPassword).not.toHaveBeenCalled();
  });

  it('rejects passwords missing an uppercase letter', async () => {
    const user = userEvent.setup();
    renderWithToken('abc123');
    await user.type(screen.getByPlaceholderText('New password'), 'password1');
    await user.type(screen.getByPlaceholderText('Confirm new password'), 'password1');
    await user.click(screen.getByRole('button', { name: /reset password/i }));

    expect(await screen.findByText(/uppercase letter/i)).toBeInTheDocument();
    expect(mockResetPassword).not.toHaveBeenCalled();
  });

  it('rejects passwords missing a number', async () => {
    const user = userEvent.setup();
    renderWithToken('abc123');
    await user.type(screen.getByPlaceholderText('New password'), 'Password');
    await user.type(screen.getByPlaceholderText('Confirm new password'), 'Password');
    await user.click(screen.getByRole('button', { name: /reset password/i }));

    expect(await screen.findByText(/include a number/i)).toBeInTheDocument();
    expect(mockResetPassword).not.toHaveBeenCalled();
  });

  it('submits the new password and redirects to login on success', async () => {
    mockResetPassword.mockResolvedValue({});
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderWithToken('abc123');
    await user.type(screen.getByPlaceholderText('New password'), 'Password1');
    await user.type(screen.getByPlaceholderText('Confirm new password'), 'Password1');
    await user.click(screen.getByRole('button', { name: /reset password/i }));

    await waitFor(() => {
      expect(mockResetPassword).toHaveBeenCalledWith({ token: 'abc123', password: 'Password1' });
    });
    expect(await screen.findByText(/password reset successfully/i)).toBeInTheDocument();

    await vi.advanceTimersByTimeAsync(3000);
    expect(mockNavigate).toHaveBeenCalledWith('/login');
  });

  it('shows the API error message when the reset fails', async () => {
    mockResetPassword.mockRejectedValue(new Error('Token has expired'));
    const user = userEvent.setup();
    renderWithToken('abc123');
    await user.type(screen.getByPlaceholderText('New password'), 'Password1');
    await user.type(screen.getByPlaceholderText('Confirm new password'), 'Password1');
    await user.click(screen.getByRole('button', { name: /reset password/i }));

    expect(await screen.findByText('Token has expired')).toBeInTheDocument();
  });
});
