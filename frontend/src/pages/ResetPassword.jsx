import React, { useState } from 'react';
import { Link, useSearchParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api } from '../services/api';

export default function ResetPassword() {
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const token = searchParams.get('token');

  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);

  function validatePassword(value) {
    if (value.length < 8) return t('resetPassword.errorTooShort');
    if (!/[a-z]/.test(value)) return t('resetPassword.errorLowercase');
    if (!/[A-Z]/.test(value)) return t('resetPassword.errorUppercase');
    if (!/[0-9]/.test(value)) return t('resetPassword.errorNumber');
    return '';
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (password !== confirmPassword) {
      return setError(t('resetPassword.errorMismatch'));
    }
    const passwordError = validatePassword(password);
    if (passwordError) {
      return setError(passwordError);
    }

    setLoading(true);
    setError('');
    try {
      await api.resetPassword({ token, password });
      setSuccess(true);
      setTimeout(() => navigate('/login'), 3000);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  if (!token) {
    return (
      <main className="container" style={{ paddingTop: '4rem', maxWidth: '400px' }}>
        <h1 style={{ fontSize: '1.6rem', fontWeight: 800, marginBottom: '1rem' }}>{t('resetPassword.invalidTitle')}</h1>
        <p style={{ color: 'var(--color-text-hint)', marginBottom: '1.5rem' }}>
          {t('resetPassword.invalidBody')}
        </p>
        <Link to="/forgot-password" style={{ color: 'var(--color-accent)', fontWeight: 600 }}>{t('resetPassword.requestNew')}</Link>
      </main>
    );
  }

  return (
    <main className="container" style={{ paddingTop: '4rem', maxWidth: '400px' }}>
      <h1 style={{ fontSize: '1.6rem', fontWeight: 800, marginBottom: '0.5rem' }}>{t('resetPassword.title')}</h1>
      <p style={{ color: 'var(--color-text-hint)', marginBottom: '1.5rem', fontSize: '0.9rem' }}>
        {t('resetPassword.body')}
      </p>

      {success ? (
        <div style={{ padding: '1rem', backgroundColor: 'var(--color-success-bg)', color: 'var(--color-success-text)', borderRadius: '0.5rem', fontSize: '0.9rem', marginBottom: '1.5rem', border: '1px solid var(--color-success-border)' }}>
          {t('resetPassword.success')}
        </div>
      ) : (
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
          <label className="label-strong" htmlFor="reset-password">{t('resetPassword.newPassword')}</label>
          <input
            id="reset-password"
            type="password"
            placeholder={t('resetPassword.newPassword')}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
          />
          <label className="label-strong" htmlFor="reset-confirm-password">{t('resetPassword.confirmPassword')}</label>
          <input
            id="reset-confirm-password"
            type="password"
            placeholder={t('resetPassword.confirmPassword')}
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            required
            minLength={8}
          />
          {error && <p role="alert" style={{ color: 'var(--color-status-error)', fontSize: '0.875rem' }}>{error}</p>}
          <button type="submit" className="btn-primary" disabled={loading} style={{ padding: '0.8rem' }}>
            {loading ? t('common.loading') : t('resetPassword.submit')}
          </button>
        </form>
      )}
    </main>
  );
}
