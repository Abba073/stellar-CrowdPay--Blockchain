import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../services/api';

const REASONS = [
  { value: 'non_delivery', key: 'dispute.nonDelivery' },
  { value: 'misrepresentation', key: 'dispute.misrepresentation' },
  { value: 'abandoned', key: 'dispute.abandoned' },
  { value: 'other', key: 'dispute.other' },
];

export default function DisputeModal({ campaign, onClose, onSubmitted }) {
  const { t } = useTranslation();
  const [form, setForm] = useState({ reason: 'non_delivery', description: '', evidence_url: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      await api.raiseDispute(campaign.id, {
        reason: form.reason,
        description: form.description.trim(),
        evidence_url: form.evidence_url.trim() || undefined,
      });
      onSubmitted?.();
      onClose();
    } catch (err) {
      setError(err.message || t('dispute.error'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={overlay} role="dialog" aria-modal="true" aria-labelledby="dispute-title">
      <div style={modal}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: '1rem',
          }}
        >
          <h2 id="dispute-title" style={{ fontSize: '1.2rem', fontWeight: 700, margin: 0 }}>
            {t('dispute.title')}
          </h2>
          <button type="button" onClick={onClose} aria-label={t('dispute.close')} style={closeBtn}>
            ✖
          </button>
        </div>
        <p
          style={{
            color: 'var(--color-text-secondary)',
            fontSize: '0.9rem',
            marginBottom: '1.25rem',
          }}
        >
          {t('dispute.description', { title: campaign.title })}
        </p>
        <form onSubmit={handleSubmit}>
          <label style={labelStyle} htmlFor="dispute-reason">
            {t('dispute.reason')}
          </label>
          <select
            id="dispute-reason"
            value={form.reason}
            onChange={(e) => setForm((s) => ({ ...s, reason: e.target.value }))}
            style={{ marginBottom: '1rem', width: '100%' }}
            required
          >
            {REASONS.map((r) => (
              <option key={r.value} value={r.value}>
                {t(r.key)}
              </option>
            ))}
          </select>

          <label style={labelStyle} htmlFor="dispute-description">
            {t('dispute.details')}
          </label>
          <textarea
            id="dispute-description"
            value={form.description}
            onChange={(e) => setForm((s) => ({ ...s, description: e.target.value }))}
            rows={4}
            placeholder={t('dispute.detailsPlaceholder')}
            required
            style={{ marginBottom: '1rem', width: '100%' }}
          />

          <label style={labelStyle} htmlFor="dispute-evidence">
            {t('dispute.evidence')}
          </label>
          <input
            id="dispute-evidence"
            type="url"
            value={form.evidence_url}
            onChange={(e) => setForm((s) => ({ ...s, evidence_url: e.target.value }))}
            placeholder="https://..."
            style={{ marginBottom: '1.25rem', width: '100%' }}
          />

          {error && (
            <p className="alert alert--error" style={{ marginBottom: '1rem' }}>
              {error}
            </p>
          )}

          <div style={{ display: 'flex', gap: '0.75rem', justifyContent: 'flex-end' }}>
            <button type="button" className="btn-secondary" onClick={onClose} disabled={busy}>
              {t('common.cancel')}
            </button>
            <button type="submit" className="btn-primary" disabled={busy}>
              {busy ? t('dispute.submitting') : t('dispute.submit')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

const overlay = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,0.45)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 1000,
};
const modal = {
  background: 'var(--color-bg)',
  borderRadius: '12px',
  padding: '1.75rem',
  width: '100%',
  maxWidth: '480px',
  maxHeight: '90vh',
  overflowY: 'auto',
};
const closeBtn = {
  background: 'transparent',
  border: 'none',
  fontSize: '1.1rem',
  cursor: 'pointer',
  color: 'var(--color-text-hint)',
  padding: '0.25rem',
};
const labelStyle = {
  display: 'block',
  fontWeight: 600,
  fontSize: '0.9rem',
  marginBottom: '0.35rem',
};
