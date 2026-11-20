import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { AuthProvider, useAuth } from './AuthContext';
import { api } from '../services/api';

vi.mock('../services/api', () => ({
  api: {
    getMe: vi.fn(),
    logout: vi.fn(),
  },
}));

function TestConsumer() {
  const { user, ready, login, logout, updateUser } = useAuth();
  return (
    <div>
      <div data-testid="ready">{ready ? 'ready' : 'loading'}</div>
      <div data-testid="user">{user ? JSON.stringify(user) : 'no-user'}</div>
      <button data-testid="btn-login" onClick={() => login({ id: 2, name: 'Bob', is_admin: true })}>
        Login
      </button>
      <button data-testid="btn-logout" onClick={() => logout()}>
        Logout
      </button>
      <button
        data-testid="btn-update"
        onClick={() => updateUser({ id: 2, name: 'Bob Updated', role: 'admin' })}
      >
        Update
      </button>
    </div>
  );
}

describe('AuthContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  describe('Session Restore', () => {
    it('sets ready to true and user to null when no stored session exists', async () => {
      render(
        <AuthProvider>
          <TestConsumer />
        </AuthProvider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('ready')).toHaveTextContent('ready');
      });
      expect(screen.getByTestId('user')).toHaveTextContent('no-user');
      expect(api.getMe).not.toHaveBeenCalled();
    });

    it('restores cached user and validates against api.getMe', async () => {
      const cached = { id: 1, name: 'Alice', role: 'contributor' };
      localStorage.setItem('cp_user', JSON.stringify(cached));

      const freshUser = { id: 1, name: 'Alice Refreshed', role: 'creator' };
      api.getMe.mockResolvedValue(freshUser);

      render(
        <AuthProvider>
          <TestConsumer />
        </AuthProvider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('ready')).toHaveTextContent('ready');
      });

      expect(api.getMe).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId('user')).toHaveTextContent('Alice Refreshed');
      expect(JSON.parse(localStorage.getItem('cp_user'))).toEqual(freshUser);
    });

    it('handles corrupted JSON in cp_user by clearing storage and resetting state', async () => {
      localStorage.setItem('cp_user', '{invalid-json');

      render(
        <AuthProvider>
          <TestConsumer />
        </AuthProvider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('ready')).toHaveTextContent('ready');
      });
      expect(screen.getByTestId('user')).toHaveTextContent('no-user');
      expect(localStorage.getItem('cp_user')).toBeNull();
    });
  });

  describe('Stale Session Handling', () => {
    it('clears user and removes tokens when api.getMe returns 401', async () => {
      localStorage.setItem('cp_user', JSON.stringify({ id: 1, name: 'Alice' }));
      localStorage.setItem('cp_token', 'stale-token');

      const error = new Error('Unauthorized');
      error.status = 401;
      api.getMe.mockRejectedValue(error);

      render(
        <AuthProvider>
          <TestConsumer />
        </AuthProvider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('ready')).toHaveTextContent('ready');
      });

      expect(screen.getByTestId('user')).toHaveTextContent('no-user');
      expect(localStorage.getItem('cp_user')).toBeNull();
      expect(localStorage.getItem('cp_token')).toBeNull();
    });

    it('clears user and removes tokens when api.getMe returns 403', async () => {
      localStorage.setItem('cp_user', JSON.stringify({ id: 1, name: 'Alice' }));
      localStorage.setItem('cp_token', 'banned-token');

      const error = new Error('Forbidden');
      error.status = 403;
      api.getMe.mockRejectedValue(error);

      render(
        <AuthProvider>
          <TestConsumer />
        </AuthProvider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('ready')).toHaveTextContent('ready');
      });

      expect(screen.getByTestId('user')).toHaveTextContent('no-user');
      expect(localStorage.getItem('cp_user')).toBeNull();
      expect(localStorage.getItem('cp_token')).toBeNull();
    });

    it('clears user when api.getMe returns data without id', async () => {
      localStorage.setItem('cp_user', JSON.stringify({ id: 1, name: 'Alice' }));

      api.getMe.mockResolvedValue({}); // Missing id

      render(
        <AuthProvider>
          <TestConsumer />
        </AuthProvider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('ready')).toHaveTextContent('ready');
      });

      expect(screen.getByTestId('user')).toHaveTextContent('no-user');
      expect(localStorage.getItem('cp_user')).toBeNull();
    });
  });

  describe('Login / Logout / UpdateUser', () => {
    it('login normalizes role from is_admin and persists to localStorage', async () => {
      render(
        <AuthProvider>
          <TestConsumer />
        </AuthProvider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('ready')).toHaveTextContent('ready');
      });

      fireEvent.click(screen.getByTestId('btn-login'));

      await waitFor(() => {
        expect(screen.getByTestId('user')).toHaveTextContent('"role":"admin"');
      });

      const stored = JSON.parse(localStorage.getItem('cp_user'));
      expect(stored).toMatchObject({ id: 2, name: 'Bob', role: 'admin' });
    });

    it('logout calls api.logout, clears state and removes user from localStorage', async () => {
      localStorage.setItem('cp_user', JSON.stringify({ id: 2, name: 'Bob', role: 'admin' }));
      api.getMe.mockResolvedValue({ id: 2, name: 'Bob', role: 'admin' });
      api.logout.mockResolvedValue({ message: 'Logged out' });

      render(
        <AuthProvider>
          <TestConsumer />
        </AuthProvider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('user')).toHaveTextContent('Bob');
      });

      fireEvent.click(screen.getByTestId('btn-logout'));

      await waitFor(() => {
        expect(screen.getByTestId('user')).toHaveTextContent('no-user');
      });

      expect(api.logout).toHaveBeenCalledTimes(1);
      expect(localStorage.getItem('cp_user')).toBeNull();
    });

    it('updateUser updates user in state and localStorage', async () => {
      render(
        <AuthProvider>
          <TestConsumer />
        </AuthProvider>
      );

      await waitFor(() => {
        expect(screen.getByTestId('ready')).toHaveTextContent('ready');
      });

      fireEvent.click(screen.getByTestId('btn-update'));

      await waitFor(() => {
        expect(screen.getByTestId('user')).toHaveTextContent('Bob Updated');
      });

      const stored = JSON.parse(localStorage.getItem('cp_user'));
      expect(stored).toMatchObject({ id: 2, name: 'Bob Updated', role: 'admin' });
    });
  });
});
