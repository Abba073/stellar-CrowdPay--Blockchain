import React, { useEffect, useState, useCallback } from 'react';
import { api } from '../services/api';
import { getNetwork, signTransaction } from '@stellar/freighter-api';
import { stellarExpertTxUrl } from '../config/stellar';
import { useToast } from '../context/ToastContext';
import { useDialog } from '../context/DialogContext';
import RelativeTime from './RelativeTime';

const ELIGIBLE = ['active', 'funded'];

function statusLabel(row, isExpired) {
  if (isExpired) return 'Expired — please re-request';
  if (row.status === 'pending') {
    if (!row.creator_signed) return 'Awaiting creator signature';
    if (!row.platform_signed) return 'Awaiting platform release';
  }
  if (row.status === 'submitted') return 'Released on-chain';
  if (row.status === 'denied') return 'Denied / cancelled';
  if (row.status === 'failed') return 'Failed (see audit)';
  return row.status;
}

export default function WithdrawalsSection({ campaign, milestones = [], user, onReleased }) {
  const toast = useToast();
  const dialog = useDialog();
  const [forbidden, setForbidden] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [cap, setCap] = useState({ can_approve_platform: false });
  const [rows, setRows] = useState([]);
  const [form, setForm] = useState({ destination_key: '', amount: '' });
  const [busyId, setBusyId] = useState(null);
  const [eventsById, setEventsById] = useState({});
  const [openAudit, setOpenAudit] = useState(null);
  const [milestoneForms, setMilestoneForms] = useState({});
  const [expiredIds, setExpiredIds] = useState(() => new Set());
  const [liveBalance, setLiveBalance] = useState(null);
  const [loadingBalance, setLoadingBalance] = useState(false);
  const [rejectingId, setRejectingId] = useState(null);
  const [rejectReason, setRejectReason] = useState('');

  const isCreator = user?.id && campaign.creator_id === user.id;
  const isAdmin = user?.role === 'admin';
  const hasMilestonePlan = milestones.length > 0;
  const canView = !forbidden && (isCreator || cap.can_approve_platform);
  const hasPending = rows.some((r) => r.status === 'pending');
  const canOpenRequest =
    isCreator && !hasMilestonePlan && ELIGIBLE.includes(campaign.status) && !hasPending;
  const pendingMilestones = milestones.filter((milestone) => milestone.status !== 'released');

  useEffect(() => {
    setMilestoneForms((current) => {
      const next = { ...current };
      let changed = false;
      for (const milestone of pendingMilestones) {
        if (!next[milestone.id]) {
          next[milestone.id] = {
            evidence_url: milestone.evidence_url || '',
            destination_key: milestone.destination_key || '',
          };
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [pendingMilestones]);

  useEffect(() => {
    if (!canOpenRequest) {
      setLiveBalance(null);
      return;
    }
    setLoadingBalance(true);
    api
      .getCampaignBalance(campaign.id)
      .then((b) => {
        setLiveBalance(parseFloat(b[campaign.asset_type] || '0'));
        setLoadingBalance(false);
      })
      .catch(() => setLoadingBalance(false));
  }, [canOpenRequest, campaign.id, campaign.asset_type]);

  const refresh = useCallback(async () => {
    if (!user) return;
    setError('');
    try {
      const caps = await api.getWithdrawalCapabilities();
      setCap(caps);
      const list = await api.listWithdrawals(campaign.id);
      setRows(list);
      setForbidden(false);
    } catch (e) {
      if (e.status === 403) {
        setForbidden(true);
        setRows([]);
      } else {
        setError(e.message || 'Could not load withdrawals.');
      }
    } finally {
      setLoading(false);
    }
  }, [campaign.id, user]);

  useEffect(() => {
    if (!user) {
      setLoading(false);
      return;
    }
    setLoading(true);
    refresh();
  }, [user, refresh]);

  async function loadEvents(id) {
    if (openAudit === id) {
      setOpenAudit(null);
      return;
    }
    if (eventsById[id]) {
      setOpenAudit(id);
      return;
    }
    try {
      const ev = await api.getWithdrawalEvents(id);
      setEventsById((m) => ({ ...m, [id]: ev }));
      setOpenAudit(id);
    } catch (e) {
      setError(e.message || 'Could not load audit trail.');
    }
  }

  async function handleRequest(e) {
    e.preventDefault();
    setBusyId('new');
    setError('');
    try {
      await api.requestWithdrawal({
        campaign_id: campaign.id,
        destination_key: form.destination_key.trim(),
        amount: form.amount.trim(),
      });
      setForm({ destination_key: '', amount: '' });
      await refresh();
      onReleased?.();
    } catch (err) {
      setError(err.message || 'Request failed.');
    } finally {
      setBusyId(null);
    }
  }

  async function runAction(id, fn, successMessage) {
    setBusyId(id);
    setError('');
    try {
      await fn();
      await refresh();
      onReleased?.();
      if (successMessage) toast?.(successMessage, 'success');
    } catch (err) {
      if (err.status === 410) {
        setExpiredIds((prev) => new Set([...prev, id]));
      } else {
        setError(err.message || 'Action failed.');
      }
    } finally {
      setBusyId(null);
    }
  }

  async function signAsFreighter(id) {
    setBusyId(id);
    setError('');
    try {
      const wr = await api.getWithdrawal(id);
      const unsignedXdr = wr.unsigned_xdr;
      if (!unsignedXdr) throw new Error('Missing unsigned transaction');

      const network = await getNetwork();
      if (network?.error) throw new Error('Could not read Freighter network');

      const signed = await signTransaction(unsignedXdr, {
        networkPassphrase: network?.networkPassphrase,
        address: user?.wallet_public_key,
      });
      if (signed?.error) throw new Error(signed.error?.message || 'Freighter signing failed');
      if (!signed?.signedTxXdr) throw new Error('Freighter did not return a signed transaction');

      await api.approveWithdrawalCreator(id, { signed_xdr: signed.signedTxXdr });
      await refresh();
    } catch (err) {
      setError(err.message || 'Could not sign with Freighter');
    } finally {
      setBusyId(null);
    }
  }

  function setMilestoneField(milestoneId, field, value) {
    setMilestoneForms((current) => ({
      ...current,
      [milestoneId]: { ...(current[milestoneId] || {}), [field]: value },
    }));
  }

  async function requestMilestoneRelease(milestoneId) {
    const payload = milestoneForms[milestoneId] || {};
    if (!payload.evidence_url?.trim() || !payload.destination_key?.trim()) {
      setError('Milestone evidence and payout destination are both required.');
      return;
    }
    setBusyId(`milestone-${milestoneId}`);
    setError('');
    try {
      await api.submitMilestoneEvidence(milestoneId, {
        evidence_url: payload.evidence_url.trim(),
        destination_key: payload.destination_key.trim(),
      });
      onReleased?.();
    } catch (err) {
      setError(err.message || 'Milestone release request failed.');
    } finally {
      setBusyId(null);
    }
  }

  if (!user || forbidden) return null;
  if (loading) {
    return (
      <section style={styles.section} aria-label="Fund release">
        <h2 style={styles.h2}>Manual fund release</h2>
        <p style={{ color: 'var(--color-text-muted)', fontSize: '0.9rem' }}>Loading…</p>
      </section>
    );
  }
  if (!canView) return null;

  return (
    <section style={styles.section} aria-label="Fund release" data-no-print>
      <h2 style={styles.h2}>Manual fund release</h2>
      <p style={styles.intro}>
        Funds leave the campaign wallet only after <strong>you</strong> (creator) and{' '}
        <strong>CrowdPay</strong> (platform) both approve the same transaction. Every step is logged
        for review.
      </p>

      {hasMilestonePlan && (
        <p className="alert alert--info" role="status">
          This campaign uses milestone-based releases. Manual one-shot withdrawal requests are
          disabled; approvals happen through milestone review.
        </p>
      )}

      {hasMilestonePlan && isCreator && (
        <div style={{ display: 'grid', gap: '0.75rem', marginBottom: '1rem' }}>
          {pendingMilestones.map((milestone) => (
            <div key={milestone.id} style={styles.card}>
              <h3 style={styles.h3}>Request milestone release</h3>
              <p style={styles.hint}>
                {milestone.title} · {Number(milestone.release_percentage).toLocaleString()}% of
                raised funds
              </p>
              {milestone.review_note && (
                <div className="alert alert--info" style={{ marginBottom: '0.55rem' }}>
                  {milestone.review_note}
                </div>
              )}
              <label className="label-strong" htmlFor={`milestone-evidence-${milestone.id}`}>
                Evidence URL
              </label>
              <input
                id={`milestone-evidence-${milestone.id}`}
                value={milestoneForms[milestone.id]?.evidence_url || ''}
                onChange={(e) => setMilestoneField(milestone.id, 'evidence_url', e.target.value)}
                placeholder="https://"
                style={{ marginBottom: '0.65rem' }}
              />
              <label className="label-strong" htmlFor={`milestone-destination-${milestone.id}`}>
                Destination address
              </label>
              <input
                id={`milestone-destination-${milestone.id}`}
                value={milestoneForms[milestone.id]?.destination_key || ''}
                onChange={(e) => setMilestoneField(milestone.id, 'destination_key', e.target.value)}
                placeholder="G..."
                style={{ marginBottom: '0.65rem' }}
              />
              <button
                type="button"
                className="btn-primary"
                disabled={busyId === `milestone-${milestone.id}` || milestone.status === 'released'}
                onClick={() => requestMilestoneRelease(milestone.id)}
                style={{ width: '100%' }}
              >
                {busyId === `milestone-${milestone.id}`
                  ? 'Submitting…'
                  : 'Request milestone release'}
              </button>
            </div>
          ))}
        </div>
      )}

      {!ELIGIBLE.includes(campaign.status) && (
        <p className="alert alert--info" role="status">
          New withdrawal requests are disabled while campaign status is{' '}
          <strong>{campaign.status}</strong>.
        </p>
      )}

      {error && (
        <p className="alert alert--error" role="alert">
          {error}
        </p>
      )}

      {canOpenRequest && (
        <form onSubmit={handleRequest} style={styles.card}>
          <h3 style={styles.h3}>Request a release</h3>
          <p style={styles.hint}>
            Destination must be a valid Stellar public key. Amount is in {campaign.asset_type}.
          </p>
          {liveBalance !== null && (
            <p
              style={{
                fontSize: '0.82rem',
                color: 'var(--color-text-secondary)',
                marginBottom: '0.5rem',
              }}
            >
              Available on-chain:{' '}
              <strong>
                {liveBalance.toLocaleString()} {campaign.asset_type}
              </strong>{' '}
              <button
                type="button"
                style={{
                  fontSize: '0.8rem',
                  color: 'var(--color-accent)',
                  background: 'none',
                  padding: 0,
                  border: 'none',
                  cursor: 'pointer',
                  textDecoration: 'underline',
                }}
                onClick={() => setForm((f) => ({ ...f, amount: String(liveBalance) }))}
              >
                Use max
              </button>
            </p>
          )}
          {loadingBalance && (
            <p
              style={{
                fontSize: '0.82rem',
                color: 'var(--color-text-hint)',
                marginBottom: '0.5rem',
              }}
            >
              Loading balance…
            </p>
          )}
          <label className="label-strong" htmlFor="wd-dest">
            Destination address
          </label>
          <input
            id="wd-dest"
            value={form.destination_key}
            onChange={(e) => setForm((f) => ({ ...f, destination_key: e.target.value }))}
            placeholder="G…"
            required
            style={{ marginBottom: '0.75rem' }}
            autoComplete="off"
          />
          <label className="label-strong" htmlFor="wd-amt">
            Amount ({campaign.asset_type})
          </label>
          <input
            id="wd-amt"
            type="number"
            inputMode="decimal"
            min="0.0000001"
            step="any"
            value={form.amount}
            onChange={(e) => setForm((f) => ({ ...f, amount: e.target.value }))}
            required
            style={{ marginBottom: '0.75rem' }}
          />
          {liveBalance !== null && Number(form.amount) > liveBalance && (
            <p
              className="alert alert--error"
              style={{ fontSize: '0.82rem', marginBottom: '0.75rem' }}
              role="alert"
            >
              Amount exceeds available balance
            </p>
          )}
          <button
            type="submit"
            className="btn-primary"
            disabled={
              busyId === 'new' || (liveBalance !== null && Number(form.amount) > liveBalance)
            }
            style={{ width: '100%' }}
          >
            {liveBalance !== null && Number(form.amount) > liveBalance
              ? 'Amount exceeds balance'
              : busyId === 'new'
                ? 'Submitting…'
                : 'Submit request'}
          </button>
        </form>
      )}

      {isCreator && hasPending && (
        <p className="alert alert--info" style={{ marginTop: '1rem' }} role="status">
          You have a pending release. Complete signatures, cancel before you sign, or wait for
          platform decision.
        </p>
      )}

      <h3 style={{ ...styles.h3, marginTop: '1.5rem' }}>Requests & audit</h3>
      {rows.length === 0 ? (
        <p style={{ color: 'var(--color-text-muted)', fontSize: '0.9rem' }}>
          No withdrawal activity yet.
        </p>
      ) : (
        <ul style={styles.list}>
          {rows.map((row) => (
            <li key={row.id} style={styles.row}>
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={styles.rowTitle}>
                  {Number(row.amount).toLocaleString()} {campaign.asset_type} →{' '}
                  <code style={styles.code}>
                    {row.destination_key.slice(0, 6)}…{row.destination_key.slice(-4)}
                  </code>
                </div>
                <div style={styles.meta}>{statusLabel(row, expiredIds.has(row.id))}</div>
                {expiredIds.has(row.id) && (
                  <div
                    className="alert alert--warning"
                    style={{ marginTop: '0.5rem', fontSize: '0.8rem' }}
                    role="alert"
                  >
                    This withdrawal XDR has expired. Please cancel this request and submit a new
                    one.
                  </div>
                )}
                {row.denial_reason && (
                  <div
                    className="alert alert--error"
                    style={{ marginTop: '0.5rem', fontSize: '0.8rem' }}
                  >
                    {row.denial_reason}
                  </div>
                )}
                {row.tx_hash && (
                  <a
                    href={stellarExpertTxUrl(row.tx_hash)}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ fontSize: '0.82rem', color: 'var(--color-accent)', fontWeight: 600 }}
                  >
                    View transaction
                  </a>
                )}
                {openAudit === row.id && eventsById[row.id] && (
                  <ol style={styles.audit}>
                    {eventsById[row.id].map((ev) => (
                      <li key={ev.id}>
                        <strong>{ev.action}</strong>
                        {ev.note ? ` — ${ev.note}` : ''}
                        <span style={{ color: 'var(--color-text-muted)' }}>
                          {' '}
                          (<RelativeTime date={ev.created_at} />)
                        </span>
                      </li>
                    ))}
                  </ol>
                )}
              </div>

              <div style={styles.actions}>
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => loadEvents(row.id)}
                  style={{ fontSize: '0.8rem' }}
                >
                  {openAudit === row.id ? 'Hide audit' : 'Audit trail'}
                </button>

                {/* Creator actions — before signing */}
                {row.status === 'pending' && !row.creator_signed && isCreator && (
                  <>
                    <button
                      type="button"
                      className="btn-secondary"
                      disabled={busyId === row.id}
                      onClick={async () => {
                        const ok = await dialog.confirm({
                          title: 'Cancel this withdrawal request?',
                          danger: true,
                          message:
                            'The pending request will be cancelled and the unsigned transaction discarded. Nothing has been released yet; you can submit a new request afterwards.',
                          summary: [
                            {
                              label: 'Amount',
                              value: `${Number(row.amount).toLocaleString()} ${campaign.asset_type}`,
                            },
                            { label: 'Destination', value: row.destination_key, monospace: true },
                          ],
                          confirmLabel: 'Cancel request',
                          cancelLabel: 'Keep request',
                        });
                        if (!ok) return;
                        runAction(
                          row.id,
                          () => api.cancelWithdrawal(row.id, { reason: 'Cancelled by creator' }),
                          'Withdrawal cancelled',
                        );
                      }}
                      style={{ fontSize: '0.8rem' }}
                    >
                      Cancel
                    </button>
                    {user?.wallet_type === 'freighter' ? (
                      <button
                        type="button"
                        className="btn-primary"
                        disabled={busyId === row.id}
                        onClick={() => signAsFreighter(row.id)}
                        style={{ fontSize: '0.8rem' }}
                      >
                        {busyId === row.id ? 'Signing…' : 'Sign in Freighter'}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="btn-primary"
                        disabled={busyId === row.id}
                        onClick={() =>
                          runAction(
                            row.id,
                            () => api.approveWithdrawalCreator(row.id),
                            'Withdrawal signed'
                          )
                        }
                        style={{ fontSize: '0.8rem' }}
                      >
                        {busyId === row.id ? 'Signing…' : 'Sign as creator'}
                      </button>
                    )}
                  </>
                )}

                {/* Platform admin actions — after creator signed */}
                {row.status === 'pending' &&
                  row.creator_signed &&
                  !row.platform_signed &&
                  cap.can_approve_platform &&
                  !expiredIds.has(row.id) && (
                    <>
                      {rejectingId === row.id ? (
                        <div
                          style={{
                            marginTop: '0.5rem',
                            display: 'flex',
                            flexDirection: 'column',
                            gap: '0.4rem',
                            width: '100%',
                          }}
                        >
                          <textarea
                            value={rejectReason}
                            onChange={(e) => setRejectReason(e.target.value)}
                            placeholder="Reason for rejection (saved to audit log)"
                            rows={2}
                            style={{
                              fontSize: '0.85rem',
                              resize: 'vertical',
                              padding: '0.5rem',
                              borderRadius: '6px',
                              border: '1px solid var(--color-border-light)',
                              fontFamily: 'inherit',
                            }}
                            autoFocus
                          />
                          <div style={{ display: 'flex', gap: '0.4rem' }}>
                            <button
                              type="button"
                              className="btn-primary"
                              style={{ fontSize: '0.8rem', flex: 1 }}
                              disabled={busyId === row.id}
                              onClick={() => {
                                runAction(
                                  row.id,
                                  () =>
                                    api.rejectWithdrawal(row.id, {
                                      reason: rejectReason || 'Rejected by platform',
                                    }),
                                  'Withdrawal rejected'
                                );
                                setRejectingId(null);
                                setRejectReason('');
                              }}
                            >
                              Confirm reject
                            </button>
                            <button
                              type="button"
                              className="btn-secondary"
                              style={{ fontSize: '0.8rem', flex: 1 }}
                              onClick={() => {
                                setRejectingId(null);
                                setRejectReason('');
                              }}
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <button
                            type="button"
                            className="btn-secondary"
                            disabled={busyId === row.id}
                            onClick={() => setRejectingId(row.id)}
                            style={{ fontSize: '0.8rem' }}
                          >
                            Reject
                          </button>
                          <button
                            type="button"
                            className="btn-primary"
                            disabled={busyId === row.id}
                            onClick={async () => {
                              const ok = await dialog.confirm({
                                title: 'Approve & release funds on-chain?',
                                danger: true,
                                message:
                                  'This signs the withdrawal with the platform key and submits the transaction to the Stellar network. Funds leave the campaign wallet immediately and the release is irreversible.',
                                summary: [
                                  {
                                    label: 'Amount',
                                    value: `${Number(row.amount).toLocaleString()} ${campaign.asset_type}`,
                                  },
                                  { label: 'Destination', value: row.destination_key, monospace: true },
                                  { label: 'Request ID', value: row.id },
                                ],
                                confirmLabel: 'Approve & submit',
                                cancelLabel: 'Back',
                              });
                              if (!ok) return;
                              runAction(
                                row.id,
                                () => api.approveWithdrawalPlatform(row.id),
                                'Withdrawal approved',
                              );
                            }}
                            style={{ fontSize: '0.8rem' }}
                          >
                            {busyId === row.id ? 'Approving…' : 'Admin approve & submit'}
                          </button>
                        </>
                      )}
                    </>
                  )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {cap.can_approve_platform && isAdmin && (
        <p style={{ ...styles.hint, marginTop: '1rem' }}>
          Admin actions sign using the platform server key after creator approval. Every transition
          is written to audit history.
        </p>
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
  h3: { fontSize: '1rem', fontWeight: 700, marginBottom: '0.5rem' },
  intro: {
    color: 'var(--color-text-secondary)',
    fontSize: '0.9rem',
    lineHeight: 1.55,
    marginBottom: '1rem',
  },
  hint: {
    color: 'var(--color-text-hint)',
    fontSize: '0.82rem',
    lineHeight: 1.45,
    marginBottom: '0.65rem',
  },
  card: {
    background: 'var(--color-bg)',
    border: '1px solid var(--color-border-light)',
    borderRadius: '10px',
    padding: '1.1rem',
    display: 'flex',
    flexDirection: 'column',
    gap: '0.25rem',
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
    gap: '0.65rem',
    background: 'var(--color-bg)',
    border: '1px solid var(--color-border-lighter)',
    borderRadius: '10px',
    padding: '0.85rem 1rem',
  },
  rowTitle: { fontSize: '0.9rem', fontWeight: 600, color: 'var(--color-text-primary)' },
  meta: { fontSize: '0.8rem', color: 'var(--color-text-hint)' },
  code: { fontSize: '0.78rem' },
  actions: { display: 'flex', flexWrap: 'wrap', gap: '0.45rem', alignItems: 'center' },
  audit: {
    marginTop: '0.5rem',
    paddingLeft: '1.1rem',
    fontSize: '0.78rem',
    color: 'var(--color-text-secondary)',
    lineHeight: 1.5,
  },
};
