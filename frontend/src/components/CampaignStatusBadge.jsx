import React from 'react';
import { useTranslation } from 'react-i18next';

const LABELS = {
  funded: {
    key: 'campaignStatus.goalReached',
    bg: 'var(--color-success-bg)',
    color: 'var(--color-success-text)',
  },
  failed: {
    key: 'campaignStatus.campaignEnded',
    bg: 'var(--color-error-bg)',
    color: 'var(--color-error-text)',
  },
  closed: {
    key: 'campaignStatus.campaignClosed',
    bg: 'var(--color-surface)',
    color: 'var(--color-text-secondary)',
  },
  refunded: {
    key: 'campaignStatus.refunded',
    bg: 'var(--color-surface)',
    color: 'var(--color-text-secondary)',
  },
};

export default function CampaignStatusBadge({ status }) {
  const { t } = useTranslation();
  if (!status || status === 'active') return null;
  const style = LABELS[status];
  if (!style) return null;

  return (
    <span
      style={{
        background: style.bg,
        color: style.color,
        fontSize: '0.72rem',
        fontWeight: 700,
        padding: '2px 8px',
        borderRadius: '99px',
        whiteSpace: 'nowrap',
      }}
    >
      {t(style.key)}
    </span>
  );
}
