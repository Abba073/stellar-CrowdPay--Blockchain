import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../services/api';
import { stellarExpertTxUrl } from '../config/stellar';
import RelativeTime from './RelativeTime';

const PAGE_SIZE = 10;

function KindBadge({ kind }) {
  const isContribution = kind === 'contribution';
  return (
    <span
      style={{
        display: 'inline-block',
        fontSize: '0.72rem',
        fontWeight: 700,
        padding: '2px 8px',
        borderRadius: '99px',
        background: isContribution ? 'var(--color-accent-lightest)' : '#fef3c7',
        color: isContribution ? 'var(--color-accent)' : '#92400e',
        textTransform: 'capitalize',
      }}
    >
      {isContribution ? 'Contribution' : 'Withdrawal'}
    </span>
  );
}

const STATUS_LABEL_KEYS = {
  indexed: 'transactionStatus.indexed',
  submitted: 'transactionStatus.submitted',
  failed: 'transactionStatus.failed',
  pending_signatures: 'transactionStatus.pendingSignatures',
};

function StatusPill({ status }) {
  const { t } = useTranslation();
  if (!status) return null;
  const map = {
    indexed: { bg: '#dcfce7', color: '#166534' },
    submitted: { bg: '#dbeafe', color: '#1e40af' },
    failed: { bg: '#fee2e2', color: '#991b1b' },
    pending_signatures: { bg: '#fef3c7', color: '#92400e' },
  };
  const style = map[status] || { bg: 'var(--color-surface)', color: 'var(--color-text-hint)' };
  const label = STATUS_LABEL_KEYS[status]
    ? t(STATUS_LABEL_KEYS[status])
    : status.charAt(0).toUpperCase() + status.slice(1);
  return (
    <span
      style={{
        display: 'inline-block',
        fontSize: '0.72rem',
        fontWeight: 700,
        padding: '2px 8px',
        borderRadius: '99px',
        background: style.bg,
        color: style.color,
      }}
    >
      {label}
    </span>
  );
}

export default function TransactionHistory({ campaignId, isCreator }) {
  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [hasMore, setHasMore] = useState(false);

  useEffect(() => {
    if (!isCreator) return;
    setLoading(true);
    setError('');
    api
      .getStellarTransactions({ campaignId, limit: limit + 1 })
      .then((data) => {
        const rows = Array.isArray(data) ? data : data.transactions || [];
        setHasMore(rows.length > limit);
        setRecords(rows.slice(0, limit));
      })
      .catch((err) => setError(err.message || 'Could not load transaction history.'))
      .finally(() => setLoading(false));
  }, [campaignId, isCreator, limit]);

  if (!isCreator) return null;

  return (
    <section style={styles.section} aria-label="Transaction history">
      <h2 style={styles.h2}>Transaction history</h2>
      <p style={styles.intro}>
        Every on-chain event for this campaign — contributions, withdrawals, and failures — recorded
        directly from the Stellar network.
      </p>

      {error && (
        <p className="alert alert--error" role="alert">
          {error}
        </p>
      )}

      {loading && records.length === 0 ? (
        <p style={{ color: 'var(--color-text-muted)', fontSize: '0.9rem' }}>Loading…</p>
      ) : !loading && records.length === 0 ? (
        <p style={{ color: 'var(--color-text-muted)', fontSize: '0.9rem' }}>
          No on-chain transactions recorded yet.
        </p>
      ) : (
        <>
          <ul style={styles.list}>
            {records.map((tx) => (
              <li key={tx.id} style={styles.row}>
                <div style={styles.rowTop}>
                  <div style={styles.badges}>
                    <KindBadge kind={tx.kind} />
                    <StatusPill status={tx.status} />
                  </div>
                  <span style={styles.time}>
                    <RelativeTime date={tx.created_at} />
                  </span>
                </div>

                {tx.tx_hash && (
                  <div style={styles.hashRow}>
                    <code style={styles.code}>
                      {tx.tx_hash.slice(0, 8)}…{tx.tx_hash.slice(-6)}
                    </code>
                    <a
                      href={stellarExpertTxUrl(tx.tx_hash)}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={styles.link}
                    >
                      View on Stellar Expert ↗
                    </a>
                  </div>
                )}

                {tx.status === 'failed' && tx.failure_reason && (
                  <div className="alert alert--error" style={styles.failureReason} role="alert">
                    <strong>Failure reason:</strong> {tx.failure_reason}
                  </div>
                )}
              </li>
            ))}
          </ul>

          {hasMore && (
            <div style={{ display: 'flex', justifyContent: 'center', marginTop: '1rem' }}>
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setLimit((prev) => prev + PAGE_SIZE)}
                disabled={loading}
                style={{ padding: '0.5rem 1.5rem', fontSize: '0.9rem' }}
              >
                {loading ? 'Loading…' : 'Load more'}
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}

const styles = {
  section: {
    marginTop: '2rem',
    paddingTop: '1.5rem',
    borderTop: '1px solid var(--color-border-light)',
  },
  h2: { fontSize: '1.15rem', fontWeight: 800, marginBottom: '0.5rem' },
  intro: {
    color: 'var(--color-text-secondary)',
    fontSize: '0.9rem',
    lineHeight: 1.55,
    marginBottom: '1rem',
  },
  list: {
    listStyle: 'none',
    display: 'flex',
    flexDirection: 'column',
    gap: '0.75rem',
    margin: 0,
    padding: 0,
  },
  row: {
    display: 'flex',
    flexDirection: 'column',
    gap: '0.5rem',
    background: 'var(--color-bg)',
    border: '1px solid var(--color-border-lighter)',
    borderRadius: '10px',
    padding: '0.85rem 1rem',
  },
  rowTop: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: '0.5rem',
  },
  badges: { display: 'flex', gap: '0.4rem', flexWrap: 'wrap', alignItems: 'center' },
  time: { fontSize: '0.78rem', color: 'var(--color-text-hint)' },
  hashRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '0.75rem',
    flexWrap: 'wrap',
  },
  code: { fontSize: '0.78rem', color: 'var(--color-text-secondary)' },
  link: {
    fontSize: '0.82rem',
    color: 'var(--color-accent)',
    fontWeight: 600,
    textDecoration: 'none',
  },
  failureReason: {
    fontSize: '0.82rem',
    marginTop: '0.25rem',
    marginBottom: 0,
  },
};
