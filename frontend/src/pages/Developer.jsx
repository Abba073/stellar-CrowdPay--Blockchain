import React, { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { api } from '../services/api';

const EVENT_OPTIONS = [
  'campaign.funded',
  'contribution.received',
  'milestone.approved',
  'withdrawal.completed',
];

const SCOPE_OPTIONS = ['read', 'write', 'withdrawals', 'developer', 'full'];

export default function Developer() {
  const { user } = useAuth();
  const location = useLocation();
  const [keys, setKeys] = useState([]);
  const [hooks, setHooks] = useState([]);
  const [deliveries, setDeliveries] = useState([]);
  const [error, setError] = useState('');
  const [newKeyLabel, setNewKeyLabel] = useState('Integration');
  const [newKeyScopes, setNewKeyScopes] = useState(['read', 'write', 'withdrawals']);
  const [revealedKey, setRevealedKey] = useState('');
  const [hookUrl, setHookUrl] = useState('');
  const [hookEvents, setHookEvents] = useState(['contribution.received']);
  const [revealedSecret, setRevealedSecret] = useState('');
  const [loading, setLoading] = useState(true);

  async function refresh() {
    setError('');
    try {
      const [k, h, d] = await Promise.all([
        api.listApiKeys(),
        api.listWebhooks(),
        api.listWebhookDeliveries({ limit: 80 }),
      ]);
      setKeys(k);
      setHooks(h);
      setDeliveries(d);
    } catch (e) {
      setError(e.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  if (!user) {
    return (
      <main className="container" style={{ paddingTop: '4rem', maxWidth: '720px' }}>
        <p>
          <Link to="/login" state={{ from: location.pathname + location.search }}>
            Log in
          </Link>{' '}
          to manage API keys and webhooks.
        </p>
      </main>
    );
  }

  async function createKey(e) {
    e.preventDefault();
    setRevealedKey('');
    setError('');
    try {
      const res = await api.createApiKey({ label: newKeyLabel, scopes: newKeyScopes });
      setRevealedKey(res.api_key);
      await refresh();
    } catch (err) {
      setError(err.message);
    }
  }

  async function revokeKey(id) {
    if (!confirm('Revoke this API key?')) return;
    setError('');
    try {
      await api.deleteApiKey(id);
      await refresh();
    } catch (err) {
      setError(err.message);
    }
  }

  async function createHook(e) {
    e.preventDefault();
    setRevealedSecret('');
    setError('');
    try {
      const res = await api.createWebhook({ url: hookUrl, events: hookEvents });
      setRevealedSecret(res.secret);
      setHookUrl('');
      await refresh();
    } catch (err) {
      setError(err.message);
    }
  }

  async function revokeHook(id) {
    if (!confirm('Remove this webhook endpoint?')) return;
    setError('');
    try {
      await api.deleteWebhook(id);
      await refresh();
    } catch (err) {
      setError(err.message);
    }
  }

  function toggleEvent(ev) {
    setHookEvents((cur) => (cur.includes(ev) ? cur.filter((x) => x !== ev) : [...cur, ev]));
  }

  function toggleScope(sc) {
    setNewKeyScopes((cur) => (cur.includes(sc) ? cur.filter((x) => x !== sc) : [...cur, sc]));
  }

  return (
    <main
      className="container"
      style={{ paddingTop: '3rem', paddingBottom: '4rem', maxWidth: '900px' }}
    >
      <h1 style={{ fontSize: '1.75rem', fontWeight: 800, marginBottom: '0.35rem' }}>Developer</h1>
      <p style={{ color: 'var(--color-text-hint)', marginBottom: '2rem', fontSize: '0.95rem' }}>
        API keys and webhooks for integrating CrowdPay as a funding backend. See{' '}
        <code style={{ fontSize: '0.85rem' }}>backend/docs/webhooks-integration.md</code> for HMAC
        verification.
      </p>
      {error && <p style={{ color: 'var(--color-status-error)', marginBottom: '1rem' }}>{error}</p>}
      {loading && <p style={{ color: 'var(--color-text-hint)' }}>Loading…</p>}

      <section style={{ marginBottom: '2.5rem' }}>
        <h2 style={{ fontSize: '1.15rem', fontWeight: 700, marginBottom: '0.75rem' }}>API keys</h2>
        {revealedKey && (
          <div
            style={{
              background: 'var(--color-warning-bg)',
              border: '1px solid var(--color-warning-border)',
              padding: '0.85rem',
              borderRadius: 8,
              marginBottom: '1rem',
            }}
          >
            <strong>Copy now:</strong>
            <pre style={{ margin: '0.5rem 0 0', wordBreak: 'break-all', fontSize: '0.8rem' }}>
              {revealedKey}
            </pre>
          </div>
        )}
        <form
          onSubmit={createKey}
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: '0.5rem',
            alignItems: 'center',
            marginBottom: '1rem',
          }}
        >
          <input
            value={newKeyLabel}
            onChange={(e) => setNewKeyLabel(e.target.value)}
            placeholder="Label"
            style={{ minWidth: '160px' }}
          />
          <span style={{ fontSize: '0.85rem', color: 'var(--color-text-secondary)' }}>Scopes:</span>
          {SCOPE_OPTIONS.map((sc) => (
            <label
              key={sc}
              style={{ fontSize: '0.85rem', display: 'flex', alignItems: 'center', gap: '0.25rem' }}
            >
              <input
                type="checkbox"
                checked={newKeyScopes.includes(sc)}
                onChange={() => toggleScope(sc)}
              />
              {sc}
            </label>
          ))}
          <button type="submit" className="btn-primary" style={{ padding: '0.45rem 0.9rem' }}>
            Create key
          </button>
        </form>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' }}>
          <thead>
            <tr style={{ textAlign: 'left', borderBottom: '1px solid var(--color-border-light)' }}>
              <th style={{ padding: '0.4rem' }}>Label</th>
              <th>Prefix</th>
              <th>Scopes</th>
              <th>Last used</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {keys
              .filter((k) => !k.revoked_at)
              .map((k) => (
                <tr key={k.id} style={{ borderBottom: '1px solid var(--color-border-lighter)' }}>
                  <td style={{ padding: '0.45rem' }}>{k.label}</td>
                  <td>
                    <code>{k.key_prefix}</code>
                  </td>
                  <td>{(k.scopes || []).join(', ')}</td>
                  <td style={{ color: 'var(--color-text-hint)' }}>
                    {k.last_used_at ? new Date(k.last_used_at).toLocaleString() : '—'}
                  </td>
                  <td>
                    <button
                      type="button"
                      className="btn-secondary"
                      style={{ padding: '0.25rem 0.5rem', fontSize: '0.8rem' }}
                      onClick={() => revokeKey(k.id)}
                    >
                      Revoke
                    </button>
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </section>

      <section style={{ marginBottom: '2.5rem' }}>
        <h2 style={{ fontSize: '1.15rem', fontWeight: 700, marginBottom: '0.75rem' }}>Webhooks</h2>
        {revealedSecret && (
          <div
            style={{
              background: 'var(--color-warning-bg)',
              border: '1px solid var(--color-warning-border)',
              padding: '0.85rem',
              borderRadius: 8,
              marginBottom: '1rem',
            }}
          >
            <strong>Signing secret (copy once):</strong>
            <pre style={{ margin: '0.5rem 0 0', wordBreak: 'break-all', fontSize: '0.8rem' }}>
              {revealedSecret}
            </pre>
          </div>
        )}
        <form
          onSubmit={createHook}
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '0.65rem',
            maxWidth: '520px',
            marginBottom: '1rem',
          }}
        >
          <input
            value={hookUrl}
            onChange={(e) => setHookUrl(e.target.value)}
            placeholder="https://example.com/crowdpay-webhook"
            required
          />
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem' }}>
            {EVENT_OPTIONS.map((ev) => (
              <label
                key={ev}
                style={{
                  fontSize: '0.85rem',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '0.25rem',
                }}
              >
                <input
                  type="checkbox"
                  checked={hookEvents.includes(ev)}
                  onChange={() => toggleEvent(ev)}
                />
                {ev}
              </label>
            ))}
          </div>
          <button
            type="submit"
            className="btn-primary"
            style={{ padding: '0.5rem 1rem', alignSelf: 'flex-start' }}
          >
            Add endpoint
          </button>
        </form>
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {hooks
            .filter((h) => !h.revoked_at)
            .map((h) => (
              <li
                key={h.id}
                style={{
                  padding: '0.5rem 0',
                  borderBottom: '1px solid var(--color-border-lighter)',
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: '1rem',
                  flexWrap: 'wrap',
                }}
              >
                <div>
                  <div style={{ fontWeight: 600 }}>{h.url}</div>
                  <div style={{ fontSize: '0.8rem', color: 'var(--color-text-hint)' }}>
                    {(h.events || []).join(', ')} · {h.secret_hint}
                  </div>
                </div>
                <button
                  type="button"
                  className="btn-secondary"
                  style={{ padding: '0.25rem 0.5rem', fontSize: '0.8rem' }}
                  onClick={() => revokeHook(h.id)}
                >
                  Remove
                </button>
              </li>
            ))}
        </ul>
      </section>

      <section>
        <h2 style={{ fontSize: '1.15rem', fontWeight: 700, marginBottom: '0.75rem' }}>
          Webhook delivery log
        </h2>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.82rem' }}>
            <thead>
              <tr
                style={{ textAlign: 'left', borderBottom: '1px solid var(--color-border-light)' }}
              >
                <th style={{ padding: '0.35rem' }}>Time</th>
                <th>Event</th>
                <th>Status</th>
                <th>HTTP</th>
                <th>Attempts</th>
                <th>Error</th>
              </tr>
            </thead>
            <tbody>
              {deliveries.map((d) => (
                <tr key={d.id} style={{ borderBottom: '1px solid var(--color-border-lightest)' }}>
                  <td style={{ padding: '0.35rem', whiteSpace: 'nowrap' }}>
                    {new Date(d.created_at).toLocaleString()}
                  </td>
                  <td>{d.event_type}</td>
                  <td>{d.status}</td>
                  <td>{d.response_status ?? '—'}</td>
                  <td>{d.attempt_count}</td>
                  <td
                    style={{ maxWidth: '220px', overflow: 'hidden', textOverflow: 'ellipsis' }}
                    title={d.last_error || ''}
                  >
                    {d.last_error || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
