import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../services/api';

export default function KycPrompt({
  onUserUpdate,
  title = 'Verify your identity to create campaigns',
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function startKyc() {
    setBusy(true);
    setError('');
    try {
      const result = await api.startKyc();
      if (result.user && onUserUpdate) onUserUpdate(result.user);
      if (result.redirect_url) {
        window.location.assign(result.redirect_url);
        return;
      }
      setError(t('kyc.sessionStarted'));
    } catch (err) {
      setError(err.message || t('kyc.error'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="alert alert--warning" role="status">
      <strong>{title || t('kyc.title')}</strong>
      <p style={{ marginTop: '0.35rem' }}>{t('kyc.body')}</p>
      {error && (
        <p className="alert alert--error" style={{ marginTop: '0.75rem' }} role="alert">
          {error}
        </p>
      )}
      <button
        type="button"
        className="btn-primary"
        style={{ marginTop: '0.75rem', width: '100%' }}
        disabled={busy}
        onClick={startKyc}
      >
        {busy ? t('kyc.start') : t('kyc.button')}
      </button>
    </div>
  );
}
