import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import ForgotPassword from './ForgotPassword';

const mockForgotPassword = vi.fn();

vi.mock('../services/api', () => ({
  api: {
    forgotPassword: (...args) => mockForgotPassword(...args),
  },
}));

describe('ForgotPassword', () => {
  beforeEach(() => {
    mockForgotPassword.mockReset();
  });

  it('renders the forgot password form', () => {
    render(
      <MemoryRouter>
        <ForgotPassword />
      </MemoryRouter>
    );
    expect(screen.getByText('Forgot password?')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Email')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /send reset link/i })).toBeInTheDocument();
  });

  it('shows a link back to login', () => {
    render(
      <MemoryRouter>
        <ForgotPassword />
      </MemoryRouter>
    );
    expect(screen.getByRole('link', { name: /log in/i })).toHaveAttribute('href', '/login');
  });

  it('calls the API and shows the returned message on success', async () => {
    mockForgotPassword.mockResolvedValue({ message: 'Reset link sent to your email.' });
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <ForgotPassword />
      </MemoryRouter>
    );
    await user.type(screen.getByPlaceholderText('Email'), 'a@b.c');
    await user.click(screen.getByRole('button', { name: /send reset link/i }));

    await waitFor(() => {
      expect(mockForgotPassword).toHaveBeenCalledWith({ email: 'a@b.c' });
    });
    expect(await screen.findByText('Reset link sent to your email.')).toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Email')).not.toBeInTheDocument();
  });

  it('shows the error message when the request fails', async () => {
    mockForgotPassword.mockRejectedValue(new Error('Account not found'));
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <ForgotPassword />
      </MemoryRouter>
    );
    await user.type(screen.getByPlaceholderText('Email'), 'a@b.c');
    await user.click(screen.getByRole('button', { name: /send reset link/i }));

    expect(await screen.findByText('Account not found')).toBeInTheDocument();
    expect(mockForgotPassword).toHaveBeenCalledTimes(1);
  });

  it('disables the submit button while the request is in flight', async () => {
    let resolve;
    mockForgotPassword.mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        })
    );
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <ForgotPassword />
      </MemoryRouter>
    );
    await user.type(screen.getByPlaceholderText('Email'), 'a@b.c');
    await user.click(screen.getByRole('button', { name: /send reset link/i }));

    expect(await screen.findByRole('button', { name: /sending link/i })).toBeDisabled();
    resolve({ message: 'sent' });
  });
});
