import React from 'react';

export default function VerificationBadge({ status, compact = false }) {
  if (status === 'verified') {
    return (
      <span style={compact ? styles.verifiedCompact : styles.verified}>✓ Verified Creator</span>
    );
  }

  return <span style={compact ? styles.warningCompact : styles.warning}>Unverified creator</span>;
}

const base = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  borderRadius: '99px',
  fontWeight: 700,
  lineHeight: 1.2,
  whiteSpace: 'nowrap',
};

const styles = {
  verified: {
    ...base,
    background: 'var(--color-success-bg)',
    color: 'var(--color-success-text)',
    border: '1px solid var(--color-success-border)',
    fontSize: '0.78rem',
    padding: '0.24rem 0.55rem',
  },
  verifiedCompact: {
    ...base,
    background: 'var(--color-success-bg)',
    color: 'var(--color-success-text)',
    border: '1px solid var(--color-success-border)',
    fontSize: '0.72rem',
    padding: '0.18rem 0.45rem',
  },
  warning: {
    ...base,
    background: 'var(--color-warning-bg)',
    color: 'var(--color-warning-text)',
    border: '1px solid var(--color-warning-border)',
    fontSize: '0.78rem',
    padding: '0.24rem 0.55rem',
  },
  warningCompact: {
    ...base,
    background: 'var(--color-warning-bg)',
    color: 'var(--color-warning-text)',
    border: '1px solid var(--color-warning-border)',
    fontSize: '0.72rem',
    padding: '0.18rem 0.45rem',
  },
};
