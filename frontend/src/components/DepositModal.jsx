import React, { useEffect, useRef, useState } from 'react';
import { api } from '../services/api';

export default function DepositModal({ onClose, onSuccess }) {
  const [amount, setAmount] = useState('');
  const [anchorInfo, setAnchorInfo] = useState({ anchors: [] });
  const [selectedAnchorId, setSelectedAnchorId] = useState('');
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loadingLabel, setLoadingLabel] = useState('Submitting…');
  const [error, setError] = useState('');
  const [phase, setPhase] = useState('form');
  const [balance, setBalance] = useState(null);
  const popupRef = useRef(null);
  const modalRef = useRef(null);

  const selectedAnchor = anchorInfo.anchors.find((a) => a.id === selectedAnchorId) || null;

  useEffect(() => {
    api
      .getMyBalance()
      .then((d) => setBalance(d.balance))
      .catch(() => {});
    api
      .getSep24Assets()
      .then((info) => {
        setAnchorInfo(info || { anchors: [] });
        const first = (info?.anchors || []).find((a) => a.available);
        if (first) setSelectedAnchorId(first.id);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') handleClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    if (phase !== 'anchor' || !session?.id) return;
    let stopped = false;

    const poll = async () => {
      try {
        const next = await api.getAnchorDepositStatus(session.id);
        if (stopped) return;
        setSession(next);
        if (next.status === 'completed') {
          setPhase('success');
          if (popupRef.current && !popupRef.current.closed) popupRef.current.close();
          onSuccess();
          return;
        }
        if (next.status === 'failed') {
          setError(next.last_error || 'The deposit could not be completed.');
          setPhase('failed');
          if (popupRef.current && !popupRef.current.closed) popupRef.current.close();
        }
      } catch (err) {
        if (!stopped) setError(err.message || 'Could not refresh deposit status.');
      }
    };

    poll();
    const id = window.setInterval(poll, 4000);
    return () => {
      stopped = true;
      window.clearInterval(id);
    };
  }, [session?.id, onSuccess, phase]);

  useEffect(() => {
    const prevActive = document.activeElement;
    const modal = modalRef.current;
    if (!modal) return;
    const focusable = modal.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    first?.focus();
    function trapTab(e) {
      if (e.key !== 'Tab') return;
      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    }
    modal.addEventListener('keydown', trapTab);
    return () => {
      modal.removeEventListener('keydown', trapTab);
      prevActive?.focus?.();
    };
  }, [phase]);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!amount || Number(amount) <= 0) {
      setError('Enter an amount greater than zero.');
      return;
    }
    if (!selectedAnchorId) {
      setError('No deposit anchor is available.');
      return;
    }

    setLoading(true);
    setLoadingLabel('Preparing deposit…');
    setError('');
    try {
      const popup = window.open('', 'crowdpay-wallet-deposit', 'popup,width=520,height=780');
      popupRef.current = popup;

      const result = await api.startWalletDeposit({
        amount: String(amount),
        anchor_id: selectedAnchorId,
      });

      if (popup && !popup.closed) {
        popup.location.href = result.interactive_url;
      } else {
        window.open(result.interactive_url, '_blank', 'noopener,noreferrer');
      }

      setSession(result);
      setPhase('anchor');
    } catch (err) {
      if (popupRef.current && !popupRef.current.closed) popupRef.current.close();
      setError(err.message || 'Could not start the deposit flow.');
    } finally {
      setLoading(false);
      setLoadingLabel('Submitting…');
    }
  }

  function handleClose() {
    if (popupRef.current && !popupRef.current.closed) popupRef.current.close();
    onClose();
  }

  return (
    <div className="modal-overlay" style={styles.overlay} onClick={handleClose} role="presentation">
      <div
        className="modal-shell"
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="deposit-title"
        onClick={(e) => e.stopPropagation()}
      >
        {phase === 'form' ? (
          <>
            <h2 id="deposit-title" style={styles.title}>
              Add Funds
            </h2>
            <p style={styles.subtitle}>
              Deposit fiat currency into your CrowdPay wallet via a supported anchor.
            </p>

            {balance && (
              <div
                className="alert alert--info"
                style={{ marginBottom: '1rem', fontSize: '0.85rem' }}
                role="status"
              >
                <strong>Current wallet balance:</strong>{' '}
                {Object.entries(balance)
                  .filter(([, v]) => Number(v) > 0)
                  .map(([code, val]) => `${Number(val).toLocaleString()} ${code}`)
                  .join(' · ') || 'Empty'}
              </div>
            )}

            <form noValidate onSubmit={handleSubmit}>
              <fieldset style={{ border: 'none', margin: '0 0 1rem', padding: 0 }}>
                <legend className="label-strong" style={{ marginBottom: '0.45rem' }}>
                  Deposit partner
                </legend>
                <div className="asset-picker" role="radiogroup" aria-label="Anchor selection">
                  {anchorInfo.anchors
                    .filter((a) => a.available)
                    .map((a) => (
                      <label
                        key={a.id}
                        className={`asset-picker__option${selectedAnchorId === a.id ? ' asset-picker__option--selected' : ''}`}
                      >
                        <input
                          type="radio"
                          name="anchor_id"
                          value={a.id}
                          checked={selectedAnchorId === a.id}
                          onChange={() => setSelectedAnchorId(a.id)}
                        />
                        <div className="asset-picker__code">{a.name}</div>
                        <div className="asset-picker__hint">
                          {a.asset.code} · {a.rails?.join(', ') || 'deposit'} · {a.environment}
                        </div>
                      </label>
                    ))}
                </div>
              </fieldset>

              {selectedAnchor && (
                <div className="alert alert--info" style={{ marginBottom: '1rem' }} role="status">
                  <strong>{selectedAnchor.name}.</strong> CrowdPay will open the anchor’s hosted
                  flow. Once the deposit completes, the funds will appear in your custodial wallet.
                </div>
              )}

              <div className="form-stack" style={{ marginBottom: '1rem' }}>
                <label className="label-strong" htmlFor="deposit-amount">
                  Amount ({selectedAnchor?.asset?.code || 'USDC'})
                </label>
                <input
                  id="deposit-amount"
                  type="number"
                  inputMode="decimal"
                  min="0.0000001"
                  step="any"
                  placeholder="0.00"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
              </div>

              {error && (
                <p className="alert alert--error" style={{ marginTop: '0.85rem' }} role="alert">
                  {error}
                </p>
              )}

              <div style={styles.actions}>
                <button type="button" className="btn-secondary" onClick={handleClose}>
                  Cancel
                </button>
                <button type="submit" className="btn-primary" disabled={loading}>
                  {loading ? loadingLabel : 'Continue'}
                </button>
              </div>
            </form>
          </>
        ) : phase === 'anchor' ? (
          <div>
            <h2 id="deposit-title" style={styles.title}>
              Complete your deposit
            </h2>
            <p className="alert alert--info" style={{ marginBottom: '1rem' }} role="status">
              Finish the hosted deposit flow in the popup window. CrowdPay is polling the anchor and
              will update your wallet balance automatically when the funds arrive.
            </p>
            {session?.anchor_transaction_id && (
              <p style={{ fontSize: '0.875rem', marginBottom: '0.75rem' }}>
                <strong>Anchor transaction:</strong> {session.anchor_transaction_id}
              </p>
            )}
            {session?.interactive_url && (
              <button
                type="button"
                className="btn-secondary"
                style={{ width: '100%', marginBottom: '0.75rem' }}
                onClick={() =>
                  window.open(session.interactive_url, '_blank', 'noopener,noreferrer')
                }
              >
                Reopen deposit window
              </button>
            )}
            <button
              type="button"
              className="btn-primary"
              style={{ width: '100%' }}
              onClick={handleClose}
            >
              Close
            </button>
          </div>
        ) : phase === 'failed' ? (
          <div>
            <h2 id="deposit-title" style={styles.title}>
              Deposit failed
            </h2>
            {error && (
              <p className="alert alert--error" style={{ marginBottom: '1rem' }} role="alert">
                {error}
              </p>
            )}
            <p style={{ marginBottom: '1rem', fontSize: '0.875rem', color: 'var(--color-text-secondary)' }}>
              The deposit could not be completed. You can try again with a different anchor or amount.
            </p>
            <button type="button" className="btn-primary" style={{ width: '100%' }} onClick={() => {
              setPhase('form');
              setError('');
            }}>
              Try Again
            </button>
          </div>
        ) : (
          <div>
            <h2 id="deposit-title" style={styles.title}>
              Deposit submitted
            </h2>
            <p className="alert alert--success" style={{ marginBottom: '1rem' }} role="status">
              Your deposit has been completed. The funds should now be available in your wallet.
            </p>
            {session?.anchor_transaction_id && (
              <p style={{ fontSize: '0.875rem', marginBottom: '0.75rem' }}>
                <strong>Anchor reference:</strong> {session.anchor_transaction_id}
              </p>
            )}
            {error && (
              <p className="alert alert--error" style={{ marginBottom: '1rem' }} role="alert">
                {error}
              </p>
            )}
            <button
              type="button"
              className="btn-primary"
              style={{ width: '100%', marginTop: '0.5rem' }}
              onClick={handleClose}
            >
              Done
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

const styles = {
  overlay: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(15, 23, 42, 0.55)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 100,
    padding: '0.75rem',
  },
  title: {
    fontSize: '1.2rem',
    fontWeight: 800,
    marginBottom: '0.5rem',
    color: 'var(--color-text-primary)',
  },
  subtitle: {
    color: 'var(--color-text-secondary)',
    fontSize: '0.875rem',
    lineHeight: 1.55,
    marginBottom: '1.1rem',
  },
  actions: {
    display: 'flex',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: '0.65rem',
    justifyContent: 'stretch',
    marginTop: '1.1rem',
  },
};
