import React, { useState } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api } from '../services/api';
import { useAuth } from '../context/AuthContext';

export default function Login() {
  const { t } = useTranslation();
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [form, setForm] = useState({ email: '', password: '' });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  function set(field) {
    return (e) => setForm((f) => ({ ...f, [field]: e.target.value }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!form.email.trim() || !form.password.trim()) {
      setError(t('login.required'));
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) {
      setError(t('login.invalidEmail'));
      return;
    }
    setLoading(true);
    setError('');
    try {
      const { user } = await api.login(form);
      login(user);
      navigate(location.state?.from || '/', { replace: true });
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="container" style={{ paddingTop: '4rem', maxWidth: '400px' }}>
      <h1 style={{ fontSize: '1.6rem', fontWeight: 800, marginBottom: '1.5rem' }}>{t('login.title')}</h1>
      <form noValidate onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
        <label className="label-strong" htmlFor="login-email">{t('login.email')}</label>
        <input
          id="login-email"
          type="email"
          placeholder={t('login.email')}
          value={form.email}
          onChange={set('email')}
          required
          autoComplete="email"
        />
        <label className="label-strong" htmlFor="login-password">{t('login.password')}</label>
        <div style={{ position: 'relative' }}>
          <input
            id="login-password"
            type={showPassword ? 'text' : 'password'}
            placeholder={t('login.password')}
            value={form.password}
            onChange={set('password')}
            required
            style={{ paddingRight: '2.5rem', width: '100%' }}
            autoComplete="current-password"
          />
          <button
            type="button"
            aria-label={showPassword ? t('login.hidePassword') : t('login.showPassword')}
            onClick={() => setShowPassword((v) => !v)}
            style={{
              position: 'absolute',
              right: '0.6rem',
              top: '50%',
              transform: 'translateY(-50%)',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: '#888',
              padding: '0.2rem',
              minHeight: 'auto',
              fontSize: '0.85rem',
            }}
          >
            {showPassword ? t('common.hide') : t('common.show')}
          </button>
        </div>
        {error && <p role="alert" style={{ color: 'var(--color-status-error)', fontSize: '0.875rem' }}>{error}</p>}
        <button type="submit" className="btn-primary" disabled={loading} style={{ padding: '0.8rem' }}>
          {loading ? t('login.loading') : t('login.submit')}
        </button>
        <div style={{ textAlign: 'center' }}>
          <Link
            to="/forgot-password"
            style={{ color: 'var(--color-text-hint)', fontSize: '0.85rem', textDecoration: 'none' }}
          >
            {t('login.forgotPassword')}
          </Link>
        </div>
      </form>
      <p style={{ marginTop: '1.25rem', color: 'var(--color-text-hint)', fontSize: '0.9rem' }}>
        {t('login.noAccount')}{' '}
        <Link to="/register" style={{ color: 'var(--color-accent)', fontWeight: 600 }}>
          {t('login.signUp')}
        </Link>
      </p>
    </main>
  );
}
