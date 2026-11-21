import React, { useEffect, useState } from 'react';
import { Link, Navigate, useLocation, useSearchParams } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { api } from '../services/api';
import KycPrompt from '../components/KycPrompt';
import VerificationBadge from '../components/VerificationBadge';
import CampaignStatusBadge from '../components/CampaignStatusBadge';
import DepositModal from '../components/DepositModal';
import { stellarExpertTxUrl, stellarExpertAccountUrl } from '../config/stellar';

const TABS = [
  { id: 'campaigns', label: 'My Campaigns' },
  { id: 'contributions', label: 'My Contributions' },
];

function progressPct(campaign) {
  if (!Number(campaign.target_amount)) return 0;
  return Math.min(100, (Number(campaign.raised_amount) / Number(campaign.target_amount)) * 100);
}

function formatConversionRate(row) {
  if (row.conversion_rate == null) return null;
  const rate = Number(row.conversion_rate);
  if (!Number.isFinite(rate)) return null;
  if (row.source_asset && row.source_amount != null) {
    return `1 ${row.source_asset} ≈ ${rate.toLocaleString(undefined, { maximumFractionDigits: 6 })} ${row.asset}`;
  }
  return rate.toLocaleString(undefined, { maximumFractionDigits: 6 });
}

export default function Dashboard() {
  const { user, token, ready, updateUser } = useAuth();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get('tab');
  const activeTab = tabParam === 'contributions' ? 'contributions' : 'campaigns';

  const [stats, setStats] = useState(null);
  const [campaigns, setCampaigns] = useState([]);
  const [contributions, setContributions] = useState([]);
  const [loadingCampaigns, setLoadingCampaigns] = useState(true);
  const [loadingContributions, setLoadingContributions] = useState(true);
  const [error, setError] = useState('');
  const [balance, setBalance] = useState(null);
  const [balanceLoading, setBalanceLoading] = useState(true);
  const [showDepositModal, setShowDepositModal] = useState(false);

  const isCreator = user?.role === 'creator' || user?.role === 'admin';
  const kycRequired =
    user?.kyc_required_for_campaigns ??
    String(import.meta.env.VITE_KYC_REQUIRED_FOR_CAMPAIGNS ?? 'true').toLowerCase() !== 'false';

  useEffect(() => {
    if (!user) return;
    setLoadingCampaigns(true);
    setError('');

    api
      .getMyBalance()
      .then((d) => setBalance(d.balance))
      .catch(() => {})
      .finally(() => setBalanceLoading(false));

    const requests = [api.getMyContributions()];
    if (isCreator) {
      requests.unshift(api.getMe(), api.getMyStats(), api.getMyCampaigns());
    }

    Promise.all(requests)
      .then((results) => {
        if (isCreator) {
          const [me, s, c, contrib] = results;
          updateUser(me);
          setStats(s);
          setCampaigns(c);
          setContributions(contrib);
        } else {
          setContributions(results[0]);
        }
      })
      .catch((err) => setError(err.message || 'Could not load dashboard'))
      .finally(() => {
        setLoadingCampaigns(false);
        setLoadingContributions(false);
      });
  }, [user?.role, updateUser]);

  function setTab(tabId) {
    if (tabId === 'contributions') {
      setSearchParams({ tab: 'contributions' });
    } else {
      setSearchParams({});
    }
  }

  function handleTablistKeyDown(e) {
    const currentIndex = TABS.findIndex((tab) => tab.id === activeTab);
    let nextIndex = currentIndex;
    if (e.key === 'ArrowRight') {
      nextIndex = (currentIndex + 1) % TABS.length;
    } else if (e.key === 'ArrowLeft') {
      nextIndex = (currentIndex - 1 + TABS.length) % TABS.length;
    } else if (e.key === 'Home') {
      nextIndex = 0;
    } else if (e.key === 'End') {
      nextIndex = TABS.length - 1;
    } else {
      return;
    }
    e.preventDefault();
    const nextTab = TABS[nextIndex];
    if (nextTab.id !== activeTab) setTab(nextTab.id);
    document.getElementById(`tab-${nextTab.id}`)?.focus();
  }

  if (!ready) {
    return (
      <main className="container" style={{ paddingTop: '2rem', paddingBottom: '3rem' }}>
        <p style={{ color: 'var(--color-text-hint)' }}>Restoring your session...</p>
      </main>
    );
  }
  if (!user) {
    return (
      <Navigate
        to="/login"
        replace
        state={{ from: location.pathname + location.search }}
      />
    );
  }

  const loading = activeTab === 'campaigns' ? loadingCampaigns : loadingContributions;

  return (
    <main className="container" style={{ paddingTop: '2rem', paddingBottom: '3rem' }}>
      <h1 style={{ fontSize: '1.6rem', fontWeight: 800, marginBottom: '1rem' }}>Dashboard</h1>

      <div className="campaign-card" style={{ marginBottom: '1rem', minHeight: 'auto' }}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            gap: '0.75rem',
            flexWrap: 'wrap',
            alignItems: 'center',
          }}
        >
          <div>
            <strong>Wallet balance</strong>
            <div
              style={{ color: 'var(--color-text-hint)', fontSize: '0.88rem', marginTop: '0.2rem' }}
            >
              {balanceLoading
                ? 'Loading…'
                : balance
                  ? Object.entries(balance)
                      .filter(([, v]) => Number(v) > 0)
                      .map(([code, val]) => `${Number(val).toLocaleString()} ${code}`)
                      .join(' · ') || 'No funds'
                  : 'No funds'}
              {user?.wallet_public_key && (
                <span style={{ marginLeft: '0.5rem' }}>
                  ·{' '}
                  <a
                    href={stellarExpertAccountUrl(user.wallet_public_key)}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: 'var(--color-accent)' }}
                  >
                    View on Stellar Expert ↗
                  </a>
                </span>
              )}
            </div>
          </div>
          <button type="button" className="btn-primary" onClick={() => setShowDepositModal(true)}>
            Add Funds
          </button>
        </div>
      </div>

      <div
        role="tablist"
        aria-label="Dashboard sections"
        onKeyDown={handleTablistKeyDown}
        style={{
          display: 'flex',
          gap: '0.5rem',
          marginBottom: '1.25rem',
          borderBottom: '1px solid var(--color-border)',
          paddingBottom: '0.5rem',
        }}
      >
        {TABS.map((tab) => (
          <button
            key={tab.id}
            id={`tab-${tab.id}`}
            type="button"
            role="tab"
            aria-selected={activeTab === tab.id}
            aria-controls={`panel-${tab.id}`}
            tabIndex={activeTab === tab.id ? 0 : -1}
            onClick={() => setTab(tab.id)}
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

      {error && <p className="alert alert--error">{error}</p>}

      {activeTab === 'campaigns' && (
        <section
          id="panel-campaigns"
          role="tabpanel"
          aria-labelledby="tab-campaigns"
          tabIndex={0}
        >
          {loading ? (
            <p style={{ color: 'var(--color-text-hint)' }}>Loading your campaigns...</p>
          ) : !isCreator ? (
            <p className="alert alert--info">
              You have not created any campaigns.{' '}
              <Link to="/campaigns/new" style={{ color: 'var(--color-accent)', fontWeight: 600 }}>
                Start a campaign
              </Link>{' '}
              or view your backing history in My Contributions.
            </p>
          ) : (
            <>
              <div className="campaign-card" style={{ marginBottom: '1rem', minHeight: 'auto' }}>
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    gap: '0.75rem',
                    flexWrap: 'wrap',
                    alignItems: 'center',
                  }}
                >
                  <div>
                    <strong>Identity verification</strong>
                    <div
                      style={{
                        color: 'var(--color-text-hint)',
                        fontSize: '0.88rem',
                        marginTop: '0.2rem',
                      }}
                    >
                      Status: {user?.kyc_status || 'unverified'}
                      {user?.kyc_completed_at
                        ? ` • Completed ${new Date(user.kyc_completed_at).toLocaleDateString()}`
                        : ''}
                    </div>
                  </div>
                  <VerificationBadge status={user?.kyc_status} />
                </div>
                {kycRequired && user?.kyc_status !== 'verified' && (
                  <div style={{ marginTop: '0.85rem' }}>
                    <KycPrompt token={token} onUserUpdate={updateUser} />
                  </div>
                )}
              </div>

              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))',
                  gap: '0.75rem',
                  marginBottom: '1rem',
                }}
              >
                <div className="campaign-card">
                  <strong>{stats?.total_campaigns || 0}</strong>
                  <div>Total campaigns</div>
                </div>
                <div className="campaign-card">
                  <strong>{Number(stats?.total_raised || 0).toLocaleString()}</strong>
                  <div>Total raised</div>
                </div>
                <div className="campaign-card">
                  <strong>{stats?.active_campaigns || 0}</strong>
                  <div>Active</div>
                </div>
                <div className="campaign-card">
                  <strong>{stats?.funded_campaigns || 0}</strong>
                  <div>Funded</div>
                </div>
              </div>

              <div style={{ marginBottom: '1rem' }}>
                <Link to="/campaigns/new" style={{ color: 'var(--color-accent)', fontWeight: 600 }}>
                  + Create new campaign
                </Link>
              </div>

              {campaigns.length === 0 ? (
                <p className="alert alert--info">
                  No campaigns yet. Create your first campaign to get started.
                </p>
              ) : (
                <div style={{ display: 'grid', gap: '0.75rem' }}>
                  {campaigns.map((campaign) => {
                    const pct = progressPct(campaign).toFixed(1);
                    return (
                      <div key={campaign.id} className="campaign-card">
                        <div
                          style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            gap: '0.5rem',
                            flexWrap: 'wrap',
                            alignItems: 'center',
                          }}
                        >
                          <strong>{campaign.title}</strong>
                          <CampaignStatusBadge status={campaign.status} />
                        </div>
                        <div style={{ marginTop: '0.35rem', fontSize: '0.9rem' }}>
                          {Number(campaign.raised_amount).toLocaleString()} /{' '}
                          {Number(campaign.target_amount).toLocaleString()} {campaign.asset_type}
                        </div>
                        <div
                          style={{
                            background: 'var(--color-surface)',
                            borderRadius: '99px',
                            height: '6px',
                            marginTop: '0.35rem',
                          }}
                        >
                          <div
                            style={{
                              background: 'var(--color-accent)',
                              height: '6px',
                              borderRadius: '99px',
                              width: `${pct}%`,
                            }}
                          />
                        </div>
                        <div
                          style={{
                            marginTop: '0.35rem',
                            color: 'var(--color-text-hint)',
                            fontSize: '0.85rem',
                          }}
                        >
                          {campaign.contributor_count} contributors
                          {campaign.deadline
                            ? ` • Deadline ${new Date(campaign.deadline).toLocaleDateString()}`
                            : ''}
                        </div>
                        <div
                          style={{
                            marginTop: '0.6rem',
                            display: 'flex',
                            gap: '0.75rem',
                            flexWrap: 'wrap',
                          }}
                        >
                          <Link
                            to={`/campaigns/${campaign.id}`}
                            style={{ color: 'var(--color-accent)', fontWeight: 600 }}
                          >
                            View campaign
                          </Link>
                          {campaign.status === 'funded' && (
                            <Link
                              to={`/campaigns/${campaign.id}#withdrawals`}
                              style={{ color: 'var(--color-accent)', fontWeight: 600 }}
                            >
                              {campaign.has_milestones
                                ? 'Manage milestone releases'
                                : 'Request withdrawal'}
                            </Link>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </section>
      )}

      {activeTab === 'contributions' && (
        <section
          id="panel-contributions"
          role="tabpanel"
          aria-labelledby="tab-contributions"
          tabIndex={0}
        >
          {loading ? (
            <p style={{ color: 'var(--color-text-hint)' }}>Loading your contributions...</p>
          ) : contributions.length === 0 ? (
            <p className="alert alert--info">
              You have not backed any campaigns yet.{' '}
              <Link to="/" style={{ color: 'var(--color-accent)', fontWeight: 600 }}>
                Browse campaigns
              </Link>
              .
            </p>
          ) : (
            <div style={{ display: 'grid', gap: '0.75rem' }}>
              {contributions.map((row) => {
                const conversionLabel = formatConversionRate(row);
                return (
                  <div key={row.id} className="campaign-card">
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        gap: '0.5rem',
                        flexWrap: 'wrap',
                        alignItems: 'center',
                      }}
                    >
                      <Link
                        to={`/campaigns/${row.campaign_id}`}
                        style={{ color: 'var(--color-accent)', fontWeight: 700 }}
                      >
                        {row.campaign_title}
                      </Link>
                      <CampaignStatusBadge status={row.campaign_status} />
                    </div>
                    <div style={{ marginTop: '0.35rem', fontSize: '0.9rem' }}>
                      {Number(row.amount).toLocaleString()} {row.asset}
                      {' • '}
                      {new Date(row.created_at).toLocaleString()}
                    </div>
                    {conversionLabel && (
                      <div
                        style={{
                          marginTop: '0.25rem',
                          fontSize: '0.85rem',
                          color: 'var(--color-text-hint)',
                        }}
                      >
                        Conversion rate: {conversionLabel}
                      </div>
                    )}
                    <a
                      href={stellarExpertTxUrl(row.tx_hash)}
                      target="_blank"
                      rel="noopener noreferrer"
                      style={{
                        marginTop: '0.35rem',
                        display: 'inline-block',
                        color: 'var(--color-accent)',
                        fontSize: '0.9rem',
                      }}
                    >
                      View transaction
                    </a>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      )}

      {showDepositModal && (
        <DepositModal
          onClose={() => setShowDepositModal(false)}
          onSuccess={() => {
            api
              .getMyBalance()
              .then((d) => setBalance(d.balance))
              .catch(() => {});
          }}
        />
      )}
    </main>
  );
}
