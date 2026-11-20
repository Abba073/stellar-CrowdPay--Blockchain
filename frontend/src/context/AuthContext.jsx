import React, { createContext, useContext, useState, useCallback, useEffect } from 'react';
import { api } from '../services/api';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => {
    try {
      const stored = localStorage.getItem('cp_user');
      if (!stored) return null;
      const parsed = JSON.parse(stored);
      if (!parsed.role) {
        parsed.role = parsed.is_admin ? 'admin' : 'contributor';
      }
      return parsed;
    } catch {
      localStorage.removeItem('cp_user');
      return null;
    }
  });
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let active = true;

    async function validateAndRefreshUser() {
      // Auth uses an httpOnly cookie; revalidate any cached session against /users/me
      if (!localStorage.getItem('cp_user')) {
        if (active) {
          setReady(true);
        }
        return;
      }

      try {
        // Validate stored token and refresh user data from server via GET /users/me
        const userData = await api.getMe();
        if (!active) return;
        if (userData && userData.id) {
          // Backend returns user data directly (not wrapped in { user: ... })
          setUser(userData);
          localStorage.setItem('cp_user', JSON.stringify(userData));
        } else {
          setUser(null);
          localStorage.removeItem('cp_user');
        }
      } catch (err) {
        if (!active) return;
        // If token is invalid, expired, or user was deleted, silently log out
        if (err.status === 401 || err.status === 403 || err.status === 404) {
          setUser(null);
          localStorage.removeItem('cp_user');
          localStorage.removeItem('cp_token');
        }
      } finally {
        if (active) {
          setReady(true);
        }
      }
    }

    validateAndRefreshUser();

    return () => {
      active = false;
    };
  }, []);

  const login = useCallback(async (userData) => {
    const normalized = {
      ...userData,
      role: userData.role || (userData.is_admin ? 'admin' : 'contributor'),
    };
    setUser(normalized);
    localStorage.setItem('cp_user', JSON.stringify(normalized));
    setReady(true);
  }, []);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } catch {}
    setUser(null);
    localStorage.removeItem('cp_user');
    setReady(true);
  }, []);

  const updateUser = useCallback((userData) => {
    setUser(userData);
    localStorage.setItem('cp_user', JSON.stringify(userData));
  }, []);

  return (
    <AuthContext.Provider value={{ user, ready, login, logout, updateUser }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
