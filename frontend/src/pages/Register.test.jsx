import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import Register from './Register';
import { findUnlabeledControls } from '../test/a11y';

const mockNavigate = vi.fn();
const mockLogin = vi.fn();

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({ login: mockLogin }),
}));

vi.mock('../lib/onboarding', () => ({
  markJustRegistered: vi.fn(),
}));

vi.mock('../services/api', () => ({
  api: {
    register: vi.fn(),
  },
}));

import { api } from '../services/api';

describe('Register', () => {
  beforeEach(() => {
    mockNavigate.mockClear();
    mockLogin.mockClear();
    api.register.mockReset();
  });

  it('gives every form control a programmatic label', () => {
    const { container } = render(
      <MemoryRouter>
        <Register />
      </MemoryRouter>
    );
    expect(findUnlabeledControls(container)).toEqual([]);
  });

  it('shows validation error for empty fields', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <Register />
      </MemoryRouter>
    );
    await user.click(screen.getByRole('button', { name: /sign up/i }));
    expect(screen.getByText(/name, email, and password are required/i)).toBeInTheDocument();
  });

  it('shows validation error for invalid email', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <Register />
      </MemoryRouter>
    );
    await user.type(screen.getByPlaceholderText('Full name'), 'Test');
    await user.type(screen.getByPlaceholderText('Email'), 'bad');
    await user.type(screen.getByPlaceholderText('Password'), 'Password1');
    await user.type(screen.getByLabelText(/Confirm password/i), 'Password1');
    await user.click(screen.getByRole('button', { name: /sign up/i }));
    expect(screen.getByText(/valid email/i)).toBeInTheDocument();
  });

  it('calls register and redirects contributor to home', async () => {
    api.register.mockResolvedValue({
      token: 'jwt',
      user: { id: '1', email: 'new@example.com', name: 'New', role: 'contributor' },
    });
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <Register />
      </MemoryRouter>
    );
    await user.type(screen.getByPlaceholderText('Full name'), 'New User');
    await user.type(screen.getByPlaceholderText('Email'), 'new@example.com');
    await user.type(screen.getByPlaceholderText('Password'), 'Password1');
    await user.type(screen.getByLabelText(/Confirm password/i), 'Password1');
    await user.click(screen.getByRole('button', { name: /sign up/i }));
    await waitFor(() => {
      expect(api.register).toHaveBeenCalledWith(
        expect.objectContaining({
          email: 'new@example.com',
          password: 'Password1',
          name: 'New User',
        })
      );
    });
    expect(mockNavigate).toHaveBeenCalledWith('/');
  });
});
