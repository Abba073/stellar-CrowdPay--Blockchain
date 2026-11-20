import React, { useEffect, useState } from 'react';
import { api } from '../services/api';
import { useAuth } from '../context/AuthContext';
import { useNavigate } from 'react-router-dom';

const DISPUTE_STATUSES = ['open', 'under_review', 'resolved_creator', 'resolved_contributor', 'closed'];

const ADMIN_TABS = [
  { id: 'campaigns', label: 'Campaigns' },
  { id: 'disputes', label: 'Dispute Queue' },
];

function DisputeQueue() {
  const [disputes, setDisputes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);

  useEffect(() => {
    // Load open/under_review disputes across all campaigns via admin endpoint
    api.getAdminCampaigns()
      .then(async (campaigns) => {
        const all = await Promise.all(
          campaigns.map((c) =>
            api.getCampaignDisputes(c.id)
              .then((ds) => ds.map((d) => ({ ...d, campaign_title: c.title })))
              .catch(() => [])
          )
        );
        setDisputes(all.flat().sort((a, b) => new Date(b.created_at) - new Date(a.created_at)));
      })
      .finally(() => setLoading(false));
  }, []);

  async function resolve(dispute, status) {
    const note = window.prompt(`Resolution note (${status}):`, '');
    if (note === null) return;
    setBusyId(dispute.id);
    try {
      const updated = await api.updateDispute(dispute.id, { status, resolution_note: note || undefined });
      setDisputes((prev) => prev.map((d) => (d.id === updated.id ? { ...d, ...updated } : d)));
    } catch (err) {
      alert(err.message || 'Could not update dispute');
    } finally {
      setBusyId(null);
    }
  }

  if (loading) return <p style={{ color: 'var(--color-text-hint)' }}>Loading disputes…</p>;
  if (!disputes.length) return <p style={{ color: 'var(--color-text-hint)', marginBottom: '2rem' }}>No disputes on record.</p>;

  return (
    <div style={{ display: 'grid', gap: '0.9rem', marginBottom: '2.5rem' }}>
      {disputes.map((d) => (
        <div
          key={d.id}
          style={{
            border: '1px solid var(--color-border-light)',
            borderRadius: '12px',
            padding: '1rem',
            background: 'var(--color-bg)',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.5rem', flexWrap: 'wrap' }}>
            <div>
              <strong>{d.campaign_title}</strong>
              <span style={{ marginLeft: '0.5rem', fontSize: '0.8rem', color: 'var(--color-text-hint)' }}>
                #{d.id}
              </span>
            </div>
            <span
              style={{
                fontSize: '0.75rem',
                padding: '0.2rem 0.6rem',
                borderRadius: '999px',
                background: 'var(--color-accent-soft)',
                color: 'var(--color-accent)',
              }}
            >
              {d.status}
            </span>
          </div>

          <p style={{ margin: '0.5rem 0', fontSize: '0.9rem' }}>{d.reason}</p>

          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginTop: '0.5rem' }}>
            {DISPUTE_STATUSES.filter((s) => s !== d.status).map((s) => (
              <button
                key={s}
                disabled={busyId === d.id}
                onClick={() => resolve(d, s)}
                style={{
                  fontSize: '0.75rem',
                  padding: '0.25rem 0.7rem',
                  borderRadius: '6px',
                  border: '1px solid var(--color-border-light)',
                  background: 'var(--color-bg-secondary)',
                  cursor: 'pointer',
                  opacity: busyId === d.id ? 0.5 : 1,
                }}
              >
                → {s}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function CampaignsQueue() {
  const [campaigns, setCampaigns] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    load();
  }, []);

  function load() {
    api.getAdminCampaigns()
      .then(setCampaigns)
      .finally(() => setLoading(false));
  }

  async function feature(id) {
    const note = window.prompt('Featured note (optional):', '');
    if (note === null) return;
    try {
      await api.adminFeatureCampaign(id, { note });
      load();
    } catch (err) {
      alert(err.message || 'Could not feature campaign');
    }
  }

  async function unfeature(id) {
    if (!window.confirm('Remove from featured?')) return;
    try {
      await api.adminUnfeatureCampaign(id);
      load();
    } catch (err) {
      alert(err.message || 'Could not unfeature campaign');
    }
  }

  if (loading) return <p style={{ color: 'var(--color-text-hint)' }}>Loading campaigns…</p>;

  return (
    <div style={{ display: 'grid', gap: '0.9rem', marginBottom: '2.5rem' }}>
      {campaigns.map((c) => (
        <div
          key={c.id}
          style={{
            border: '1px solid var(--color-border-light)',
            borderRadius: '12px',
            padding: '1rem',
            background: 'var(--color-bg)',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <strong>{c.title}</strong>
              <span style={{ marginLeft: '0.5rem', fontSize: '0.8rem', color: 'var(--color-text-hint)' }}>
                #{c.id}
              </span>
            </div>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button
                onClick={() => feature(c.id)}
                style={{
                  fontSize: '0.75rem', padding: '0.25rem 0.7rem', borderRadius: '6px',
                  border: '1px solid #fde047', background: '#fef9c3', color: '#854d0e', cursor: 'pointer'
                }}
              >
                ⭐️ Feature
              </button>
              <button
                onClick={() => unfeature(c.id)}
                style={{
                  fontSize: '0.75rem', padding: '0.25rem 0.7rem', borderRadius: '6px',
                  border: '1px solid var(--color-border-light)', background: 'var(--color-bg-secondary)', cursor: 'pointer'
                }}
              >
                Unfeature
              </button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}


export default function AdminDashboard() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState('campaigns');

  useEffect(() => {
    if (!user || user.role !== 'admin') {
      navigate('/');
    }
  }, [user, navigate]);

  function handleTablistKeyDown(e) {
    const currentIndex = ADMIN_TABS.findIndex((tab) => tab.id === activeTab);
    let nextIndex = currentIndex;
    if (e.key === 'ArrowRight') {
      nextIndex = (currentIndex + 1) % ADMIN_TABS.length;
    } else if (e.key === 'ArrowLeft') {
      nextIndex = (currentIndex - 1 + ADMIN_TABS.length) % ADMIN_TABS.length;
    } else if (e.key === 'Home') {
      nextIndex = 0;
    } else if (e.key === 'End') {
      nextIndex = ADMIN_TABS.length - 1;
    } else {
      return;
    }
    e.preventDefault();
    setActiveTab(ADMIN_TABS[nextIndex].id);
    document.getElementById(`tab-${ADMIN_TABS[nextIndex].id}`)?.focus();
  }

  return (
    <div style={{ maxWidth: '860px', margin: '2rem auto', padding: '0 1rem' }}>
      <h1 style={{ marginBottom: '1.5rem' }}>Admin Dashboard</h1>

      <div
        role="tablist"
        aria-label="Admin sections"
        onKeyDown={handleTablistKeyDown}
        style={{
          display: 'flex',
          gap: '0.5rem',
          marginBottom: '1.5rem',
          borderBottom: '1px solid var(--color-border)',
          paddingBottom: '0.5rem',
        }}
      >
        {ADMIN_TABS.map((tab) => (
          <button
            key={tab.id}
            id={`tab-${tab.id}`}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            aria-controls={`panel-${tab.id}`}
            tabIndex={activeTab === tab.id ? 0 : -1}
            onClick={() => setActiveTab(tab.id)}
            style={{
              padding: '0.5rem 1rem',
              borderRadius: '8px',
              border: 'none',
              cursor: 'pointer',
              fontWeight: 600,
              fontSize: '0.9rem',
              background: activeTab === tab.id ? 'var(--color-accent)' : 'transparent',
              color: activeTab === tab.id ? '#fff' : 'var(--color-text-secondary)',
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'campaigns' && (
        <section
          id="panel-campaigns"
          role="tabpanel"
          aria-labelledby="tab-campaigns"
          tabIndex={0}
        >
          <CampaignsQueue />
        </section>
      )}

      {activeTab === 'disputes' && (
        <section
          id="panel-disputes"
          role="tabpanel"
          aria-labelledby="tab-disputes"
          tabIndex={0}
        >
          <DisputeQueue />
        </section>
      )}
    </div>
  );
import React, { useEffect, useState } from 'react';
import { api } from '../services/api';
import { useAuth } from '../context/AuthContext';
import { useNavigate } from 'react-router-dom';
import { useDialog } from '../context/DialogContext';

const DISPUTE_STATUSES = [
  'open',
  'under_review',
  'resolved_creator',
  'resolved_contributor',
  'closed',
];

function DisputeQueue() {
  const [disputes, setDisputes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState(null);
  const dialog = useDialog();

  useEffect(() => {
    // Load open/under_review disputes across all campaigns via admin endpoint
    api
      .getAdminCampaigns()
      .then(async (campaigns) => {
        const all = await Promise.all(
          campaigns.map((c) =>
            api
              .getCampaignDisputes(c.id)
              .then((ds) => ds.map((d) => ({ ...d, campaign_title: c.title })))
              .catch(() => [])
          )
        );
        setDisputes(all.flat().sort((a, b) => new Date(b.created_at) - new Date(a.created_at)));
      })
      .finally(() => setLoading(false));
  }, []);

  async function resolve(dispute, status) {
    const note = await dialog.prompt(`Resolution note (${status}):`, { action: 'dispute.resolve' });
    if (note === null) return;
    setBusyId(dispute.id);
    try {
      const updated = await api.updateDispute(dispute.id, {
        status,
        resolution_note: note || undefined,
      });
      setDisputes((prev) => prev.map((d) => (d.id === updated.id ? { ...d, ...updated } : d)));
    } catch (err) {
      await dialog.alert(err.message || 'Could not update dispute');
    } finally {
      setBusyId(null);
    }
  }

  if (loading) return <p style={{ color: 'var(--color-text-hint)' }}>Loading disputes…</p>;
  if (!disputes.length)
    return (
      <p style={{ color: 'var(--color-text-hint)', marginBottom: '2rem' }}>
        No disputes on record.
      </p>
    );

  return (
    <div style={{ display: 'grid', gap: '0.9rem', marginBottom: '2.5rem' }}>
      {disputes.map((d) => (
        <div
          key={d.id}
          style={{
            border: '1px solid var(--color-border-light)',
            borderRadius: '12px',
            padding: '1rem',
            background: 'var(--color-bg)',
          }}
        >
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              gap: '0.5rem',
              flexWrap: 'wrap',
            }}
          >
            <div>
              <strong>{d.campaign_title}</strong>
              <span
                style={{
                  marginLeft: '0.5rem',
                  fontSize: '0.8rem',
                  color: 'var(--color-text-hint)',
                }}
              >
                #{d.id}
              </span>
            </div>
            <span
              style={{
                fontSize: '0.75rem',
                padding: '0.2rem 0.6rem',
                borderRadius: '999px',
                background: 'var(--color-accent-soft, #ede9fe)',
                color: 'var(--color-accent)',
              }}
            >
              {d.status}
            </span>
          </div>

          <p style={{ margin: '0.5rem 0', fontSize: '0.9rem' }}>{d.reason}</p>

          <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', marginTop: '0.5rem' }}>
            {DISPUTE_STATUSES.filter((s) => s !== d.status).map((s) => (
              <button
                key={s}
                disabled={busyId === d.id}
                onClick={() => resolve(d, s)}
                style={{
                  fontSize: '0.75rem',
                  padding: '0.25rem 0.7rem',
                  borderRadius: '6px',
                  border: '1px solid var(--color-border-light)',
                  background: 'var(--color-bg-secondary, var(--color-surface))',
                  cursor: 'pointer',
                  opacity: busyId === d.id ? 0.5 : 1,
                }}
              >
                → {s}
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function CampaignsQueue() {
  const [campaigns, setCampaigns] = useState([]);
  const [loading, setLoading] = useState(true);
  const dialog = useDialog();

  useEffect(() => {
    load();
  }, []);

  function load() {
    api
      .getAdminCampaigns()
      .then(setCampaigns)
      .finally(() => setLoading(false));
  }

  async function feature(id) {
    const note = await dialog.prompt('Featured note (optional):', { action: 'campaign.feature' });
    if (note === null) return;
    try {
      await api.adminFeatureCampaign(id, { note });
      load();
    } catch (err) {
      await dialog.alert(err.message || 'Could not feature campaign');
    }
  }

  async function unfeature(id) {
    if (!(await dialog.confirm('Remove from featured?', { action: 'campaign.unfeature' }))) return;
    try {
      await api.adminUnfeatureCampaign(id);
      load();
    } catch (err) {
      await dialog.alert(err.message || 'Could not unfeature campaign');
    }
  }

  if (loading) return <p style={{ color: 'var(--color-text-hint)' }}>Loading campaigns…</p>;

  return (
    <div style={{ display: 'grid', gap: '0.9rem', marginBottom: '2.5rem' }}>
      {campaigns.map((c) => (
        <div
          key={c.id}
          style={{
            border: '1px solid var(--color-border-light)',
            borderRadius: '12px',
            padding: '1rem',
            background: 'var(--color-bg)',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <strong>{c.title}</strong>
              <span
                style={{
                  marginLeft: '0.5rem',
                  fontSize: '0.8rem',
                  color: 'var(--color-text-hint)',
                }}
              >
                #{c.id}
              </span>
            </div>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <button
                onClick={() => feature(c.id)}
                style={{
                  fontSize: '0.75rem',
                  padding: '0.25rem 0.7rem',
                  borderRadius: '6px',
                  border: '1px solid #fde047',
                  background: '#fef9c3',
                  color: '#854d0e',
                  cursor: 'pointer',
                }}
              >
                ⭐️ Feature
              </button>
              <button
                onClick={() => unfeature(c.id)}
                style={{
                  fontSize: '0.75rem',
                  padding: '0.25rem 0.7rem',
                  borderRadius: '6px',
                  border: '1px solid var(--color-border-light)',
                  background: 'var(--color-bg-secondary, var(--color-surface))',
                  cursor: 'pointer',
                }}
              >
                Unfeature
              </button>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function UsersQueue() {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [includeBanned, setIncludeBanned] = useState(true);
  const [busyId, setBusyId] = useState(null);
  const dialog = useDialog();

  useEffect(() => {
    loadUsers();
  }, [includeBanned]);

  function loadUsers() {
    setLoading(true);
    api
      .getAdminUsers(includeBanned)
      .then(setUsers)
      .catch(() => setUsers([]))
      .finally(() => setLoading(false));
  }

  async function handleBan(user) {
    const reason = await dialog.prompt(`Reason for banning ${user.name || user.email}:`, {
      action: 'user.ban',
    });
    if (reason === null) return;
    setBusyId(user.id);
    try {
      await api.adminBanUser(user.id, { reason });
      loadUsers();
    } catch (err) {
      await dialog.alert(err.message || 'Could not ban user');
    } finally {
      setBusyId(null);
    }
  }

  async function handleUnban(user) {
    if (!(await dialog.confirm(`Unban ${user.name || user.email}?`, { action: 'user.unban' })))
      return;
    setBusyId(user.id);
    try {
      await api.adminUnbanUser(user.id);
      loadUsers();
    } catch (err) {
      await dialog.alert(err.message || 'Could not unban user');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div style={{ marginBottom: '2.5rem' }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: '1rem',
        }}
      >
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '0.5rem',
            fontSize: '0.875rem',
            cursor: 'pointer',
          }}
        >
          <input
            type="checkbox"
            checked={includeBanned}
            onChange={(e) => setIncludeBanned(e.target.checked)}
          />
          Show banned users
        </label>
        <button
          onClick={loadUsers}
          className="btn-secondary"
          style={{ fontSize: '0.8rem', padding: '0.3rem 0.6rem', minHeight: 'auto' }}
        >
          Refresh users
        </button>
      </div>

      {loading ? (
        <p style={{ color: 'var(--color-text-hint)' }}>Loading users…</p>
      ) : !users.length ? (
        <p style={{ color: 'var(--color-text-hint)' }}>No users found.</p>
      ) : (
        <div style={{ display: 'grid', gap: '0.75rem' }}>
          {users.map((u) => (
            <div
              key={u.id}
              style={{
                border: '1px solid var(--color-border-light)',
                borderRadius: '8px',
                padding: '1rem',
                background: 'var(--color-bg)',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                flexWrap: 'wrap',
                gap: '0.75rem',
              }}
            >
              <div>
                <div style={{ fontWeight: 700, fontSize: '0.95rem' }}>
                  {u.name || 'Unnamed User'}
                  {u.is_banned && (
                    <span
                      style={{
                        marginLeft: '0.5rem',
                        fontSize: '0.75rem',
                        padding: '0.15rem 0.5rem',
                        borderRadius: '4px',
                        background: 'var(--color-danger-bg, #fee2e2)',
                        color: 'var(--color-danger-text, #dc2626)',
                      }}
                    >
                      Banned
                    </span>
                  )}
                  {u.is_admin && (
                    <span
                      style={{
                        marginLeft: '0.5rem',
                        fontSize: '0.75rem',
                        padding: '0.15rem 0.5rem',
                        borderRadius: '4px',
                        background: 'var(--color-accent-soft, #ede9fe)',
                        color: 'var(--color-accent)',
                      }}
                    >
                      Admin
                    </span>
                  )}
                </div>
                <div style={{ color: 'var(--color-text-secondary)', fontSize: '0.85rem' }}>
                  {u.email} · Role: {u.role} · Campaigns: {u.campaign_count || 0} · Contributions:{' '}
                  {u.contribution_count || 0}
                </div>
                <div style={{ color: 'var(--color-text-hint)', fontSize: '0.75rem' }}>
                  Joined: {u.created_at ? new Date(u.created_at).toLocaleDateString() : '—'}
                </div>
              </div>

              <div>
                {u.is_banned ? (
                  <button
                    disabled={busyId === u.id}
                    onClick={() => handleUnban(u)}
                    className="btn-secondary"
                    style={{ fontSize: '0.8rem', padding: '0.3rem 0.7rem', minHeight: 'auto' }}
                  >
                    Unban user
                  </button>
                ) : (
                  <button
                    disabled={busyId === u.id || u.is_admin}
                    onClick={() => handleBan(u)}
                    className="btn-secondary"
                    style={{
                      fontSize: '0.8rem',
                      padding: '0.3rem 0.7rem',
                      minHeight: 'auto',
                      color: 'var(--color-danger-text, #dc2626)',
                      borderColor: 'var(--color-danger, #dc2626)',
                    }}
                  >
                    Ban user
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function MilestonesQueue() {
  const [milestones, setMilestones] = useState([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('');

  useEffect(() => {
    loadMilestones();
  }, [statusFilter]);

  function loadMilestones() {
    setLoading(true);
    const query = statusFilter ? { status: statusFilter } : {};
    api
      .getAdminMilestones(query)
      .then(setMilestones)
      .catch(() => setMilestones([]))
      .finally(() => setLoading(false));
  }

  return (
    <div style={{ marginBottom: '2.5rem' }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: '1rem',
          flexWrap: 'wrap',
          gap: '0.5rem',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <label
            htmlFor="milestone-status-filter"
            style={{ fontSize: '0.875rem', fontWeight: 600 }}
          >
            Status:
          </label>
          <select
            id="milestone-status-filter"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            style={{ width: 'auto', padding: '0.35rem 0.6rem', fontSize: '0.85rem' }}
          >
            <option value="">All statuses</option>
            <option value="pending">Pending</option>
            <option value="approved">Approved</option>
            <option value="released">Released</option>
          </select>
        </div>
        <button
          onClick={loadMilestones}
          className="btn-secondary"
          style={{ fontSize: '0.8rem', padding: '0.3rem 0.6rem', minHeight: 'auto' }}
        >
          Refresh milestones
        </button>
      </div>

      {loading ? (
        <p style={{ color: 'var(--color-text-hint)' }}>Loading milestones…</p>
      ) : !milestones.length ? (
        <p style={{ color: 'var(--color-text-hint)' }}>No milestones found.</p>
      ) : (
        <div style={{ display: 'grid', gap: '0.8rem' }}>
          {milestones.map((m) => (
            <div
              key={m.id}
              style={{
                border: '1px solid var(--color-border-light)',
                borderRadius: '8px',
                padding: '1rem',
                background: 'var(--color-bg)',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'flex-start',
                  flexWrap: 'wrap',
                  gap: '0.5rem',
                }}
              >
                <div>
                  <div style={{ fontWeight: 700, fontSize: '0.95rem' }}>{m.title}</div>
                  <div
                    style={{
                      fontSize: '0.85rem',
                      color: 'var(--color-text-secondary)',
                      marginTop: '0.2rem',
                    }}
                  >
                    Campaign: <strong>{m.campaign_title}</strong> · Creator:{' '}
                    {m.creator_email || m.creator_name || '—'}
                  </div>
                  {m.description && (
                    <div
                      style={{
                        fontSize: '0.85rem',
                        color: 'var(--color-text-secondary)',
                        marginTop: '0.35rem',
                      }}
                    >
                      {m.description}
                    </div>
                  )}
                </div>
                <div style={{ textAlign: 'right' }}>
                  <span
                    style={{
                      fontSize: '0.75rem',
                      padding: '0.2rem 0.6rem',
                      borderRadius: '999px',
                      background:
                        m.status === 'released'
                          ? 'var(--color-success-bg, #dcfce7)'
                          : m.status === 'approved'
                            ? 'var(--color-accent-soft, #ede9fe)'
                            : '#fef3c7',
                      color:
                        m.status === 'released'
                          ? 'var(--color-success-text, #16a34a)'
                          : m.status === 'approved'
                            ? 'var(--color-accent)'
                            : '#b45309',
                      fontWeight: 600,
                    }}
                  >
                    {m.status}
                  </span>
                  <div style={{ fontSize: '0.85rem', fontWeight: 700, marginTop: '0.35rem' }}>
                    {m.target_amount} {m.asset_type || 'USDC'}
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AuditLogQueue() {
  const [logs, setLogs] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadAudit();
  }, []);

  function loadAudit() {
    setLoading(true);
    api
      .getAdminAuditLog({ limit: 50, offset: 0 })
      .then((data) => {
        setLogs(data.actions || []);
        setTotal(data.pagination?.total || (data.actions ? data.actions.length : 0));
      })
      .catch(() => {
        setLogs([]);
        setTotal(0);
      })
      .finally(() => setLoading(false));
  }

  return (
    <div style={{ marginBottom: '2.5rem' }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: '1rem',
        }}
      >
        <span style={{ fontSize: '0.875rem', color: 'var(--color-text-secondary)' }}>
          Showing recent {logs.length} of {total} events
        </span>
        <button
          onClick={loadAudit}
          className="btn-secondary"
          style={{ fontSize: '0.8rem', padding: '0.3rem 0.6rem', minHeight: 'auto' }}
        >
          Refresh log
        </button>
      </div>

      {loading ? (
        <p style={{ color: 'var(--color-text-hint)' }}>Loading audit log…</p>
      ) : !logs.length ? (
        <p style={{ color: 'var(--color-text-hint)' }}>No audit log entries recorded.</p>
      ) : (
        <div style={{ display: 'grid', gap: '0.65rem' }}>
          {logs.map((log) => (
            <div
              key={log.id}
              style={{
                border: '1px solid var(--color-border-light)',
                borderRadius: '8px',
                padding: '0.85rem 1rem',
                background: 'var(--color-bg)',
                fontSize: '0.85rem',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  flexWrap: 'wrap',
                  gap: '0.5rem',
                  marginBottom: '0.25rem',
                }}
              >
                <span style={{ fontWeight: 700, color: 'var(--color-accent)' }}>
                  {log.action_type}
                </span>
                <span style={{ color: 'var(--color-text-hint)', fontSize: '0.75rem' }}>
                  {log.created_at ? new Date(log.created_at).toLocaleString() : '—'}
                </span>
              </div>
              <div style={{ color: 'var(--color-text-secondary)' }}>
                Admin: <strong>{log.admin_email || `#${log.admin_user_id}`}</strong> · Target:{' '}
                {log.target_type} {log.target_id ? `(#${log.target_id})` : ''}
              </div>
              {log.details && Object.keys(log.details).length > 0 && (
                <pre
                  style={{
                    marginTop: '0.4rem',
                    padding: '0.4rem',
                    background: 'var(--color-surface)',
                    borderRadius: '4px',
                    fontSize: '0.75rem',
                    overflowX: 'auto',
                  }}
                >
                  {typeof log.details === 'string'
                    ? log.details
                    : JSON.stringify(log.details, null, 2)}
                </pre>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function AdminDashboard() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState('campaigns');

  useEffect(() => {
    if (!user || user.role !== 'admin') {
      navigate('/');
    }
  }, [user, navigate]);

  return (
    <div style={{ maxWidth: '860px', margin: '2rem auto', padding: '0 1rem' }}>
      <h1 style={{ marginBottom: '1.5rem' }}>Admin Dashboard</h1>

      {/* Navigation Tabs */}
      <div
        style={{
          display: 'flex',
          gap: '0.5rem',
          marginBottom: '1.5rem',
          borderBottom: '1px solid var(--color-border-light)',
          paddingBottom: '0.75rem',
          overflowX: 'auto',
        }}
      >
        {[
          { id: 'campaigns', label: 'Campaigns' },
          { id: 'disputes', label: 'Disputes' },
          { id: 'users', label: 'Users' },
          { id: 'milestones', label: 'Milestones' },
          { id: 'audit', label: 'Audit Log' },
        ].map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={activeTab === tab.id ? 'btn-primary' : 'btn-secondary'}
            style={{
              fontSize: '0.85rem',
              padding: '0.4rem 0.85rem',
              minHeight: 'auto',
              whiteSpace: 'nowrap',
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {activeTab === 'campaigns' && (
        <>
          <h2 style={{ marginBottom: '1rem' }}>Campaign Moderation</h2>
          <CampaignsQueue />
        </>
      )}

      {activeTab === 'disputes' && (
        <>
          <h2 style={{ marginBottom: '1rem' }}>Dispute Queue</h2>
          <DisputeQueue />
        </>
      )}

      {activeTab === 'users' && (
        <>
          <h2 style={{ marginBottom: '1rem' }}>User Directory</h2>
          <UsersQueue />
        </>
      )}

      {activeTab === 'milestones' && (
        <>
          <h2 style={{ marginBottom: '1rem' }}>Milestone Oversight</h2>
          <MilestonesQueue />
        </>
      )}

      {activeTab === 'audit' && (
        <>
          <h2 style={{ marginBottom: '1rem' }}>System Audit Trail</h2>
          <AuditLogQueue />
        </>
      )}
    </div>
  );
}
