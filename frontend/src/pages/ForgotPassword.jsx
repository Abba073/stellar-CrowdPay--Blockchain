import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api } from '../services/api';

export default function ForgotPassword() {
  const { t } = useTranslation();
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setLoading(true);
    setError('');
    setMessage('');
    try {
      const res = await api.forgotPassword({ email });
      setMessage(res.message);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="container" style={{ paddingTop: '4rem', maxWidth: '400px' }}>
      <h1 style={{ fontSize: '1.6rem', fontWeight: 800, marginBottom: '0.5rem' }}>{t('forgotPassword.title')}</h1>
      <p style={{ color: 'var(--color-text-hint)', marginBottom: '1.5rem', fontSize: '0.9rem' }}>
        {t('forgotPassword.body')}
      </p>

      {message ? (
        <div style={{ padding: '1rem', backgroundColor: 'var(--color-success-bg)', color: 'var(--color-success-text)', borderRadius: '0.5rem', fontSize: '0.9rem', marginBottom: '1.5rem', border: '1px solid var(--color-success-border)' }}>
          {message}
        </div>
      ) : (
        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
          <label className="label-strong" htmlFor="forgot-email">{t('forgotPassword.email')}</label>
          <input
            id="forgot-email"
            type="email"
            placeholder={t('forgotPassword.email')}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />
          {error && <p role="alert" style={{ color: 'var(--color-status-error)', fontSize: '0.875rem' }}>{error}</p>}
          <button type="submit" className="btn-primary" disabled={loading} style={{ padding: '0.8rem' }}>
            {loading ? t('common.loading') : t('forgotPassword.send')}
          </button>
        </form>
      )}

      <p style={{ marginTop: '1.25rem', color: 'var(--color-text-hint)', fontSize: '0.9rem' }}>
        {t('common.back')} <Link to="/login" style={{ color: 'var(--color-accent)', fontWeight: 600 }}>{t('forgotPassword.backToLogin')}</Link>
      </p>
    </main>
  );
}
