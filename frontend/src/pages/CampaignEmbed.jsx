import React, { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/+$/, '');
const BASE_URL = import.meta.env.VITE_API_URL || `${API_BASE_URL}/api`;

// Only post to the embedding host's origin (never '*'); skip when it can't be determined.
export function getParentOrigin() {
  try {
    return document.referrer ? new URL(document.referrer).origin : null;
  } catch {
    return null;
  }
}

function postToParent(message) {
  const origin = getParentOrigin();
  if (origin && window.parent !== window) {
    window.parent.postMessage(message, origin);
  }
}

export default function CampaignEmbed() {
  const params = useParams();
  const [campaign, setCampaign] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [isLive, setIsLive] = useState(false);

  // Extract campaign ID from useParams or URL path fallback: /embed/campaigns/:id
  const pathParts =
    typeof window !== 'undefined' && window.location?.pathname
      ? window.location.pathname.split('/').filter(Boolean)
      : [];
  const campaignId = params?.id || pathParts[pathParts.length - 1];

  useEffect(() => {
    if (!campaignId) {
      setError('Invalid campaign ID');
      setLoading(false);
      return;
    }

    // Fetch initial campaign data
    fetch(`${BASE_URL}/campaigns/${campaignId}/embed`)
      .then((res) => {
        if (!res.ok) throw new Error('Campaign not found');
        return res.json();
      })
      .then((data) => {
        setCampaign(data);
        setLoading(false);
      })
      .catch((err) => {
        setError(err.message || 'Failed to load campaign');
        setLoading(false);
      });
  }, [campaignId]);

  // Connect to SSE for live updates with auto-reconnect and stabilized deps
  useEffect(() => {
    if (!campaignId) return;
    if (!window.EventSource) return;

    let es = null;
    let reconnectTimer = null;
    let retryDelay = 1000;
    const maxRetryDelay = 30000;
    let isMounted = true;

    function connect() {
      if (!isMounted) return;
      if (es) {
        try {
          es.close();
        } catch {}
        es = null;
      }

      try {
        es = new EventSource(`${BASE_URL}/campaigns/${campaignId}/stream`);
      } catch {
        scheduleReconnect();
        return;
      }

      es.onopen = () => {
        if (!isMounted) return;
        setIsLive(true);
        retryDelay = 1000;
      };

      es.onmessage = (e) => {
        if (!isMounted) return;
        let msg;
        try {
          msg = JSON.parse(e.data);
        } catch {
          return;
        }

        if (msg.type === 'contribution') {
          setCampaign((prev) => {
            if (!prev) return prev;
            const newRaised = msg.raised_amount ?? prev.raised_amount;
            const target = Number(prev.target_amount) || 0;
            const newPct = target > 0 ? Math.min(100, (Number(newRaised) / target) * 100) : 0;
            return {
              ...prev,
              raised_amount: newRaised,
              progress_percentage: newPct,
              backer_count: msg.contribution
                ? (Number(prev.backer_count) || 0) + 1
                : prev.backer_count,
            };
          });
        }
      };

      es.onerror = () => {
        if (!isMounted) return;
        setIsLive(false);
        if (es) {
          try {
            es.close();
          } catch {}
          es = null;
        }
        scheduleReconnect();
      };
    }

    function scheduleReconnect() {
      if (!isMounted) return;
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => {
        connect();
      }, retryDelay);
      retryDelay = Math.min(retryDelay * 2, maxRetryDelay);
    }

    connect();

    return () => {
      isMounted = false;
      clearTimeout(reconnectTimer);
      if (es) {
        try {
          es.close();
        } catch {}
        es = null;
      }
      setIsLive(false);
    };
  }, [campaignId]);

  // Auto-resize iframe via postMessage
  useEffect(() => {
    const notifyHeight = () => {
      const height = document.documentElement.scrollHeight;
      postToParent({ type: 'resize', height });
    };

    notifyHeight();
    const interval = setInterval(notifyHeight, 500);

    return () => clearInterval(interval);
  }, [campaign]);

  if (loading) {
    return (
      <div style={styles.container}>
        <div style={styles.skeleton} />
        <div style={styles.skeletonShort} />
        <div style={styles.skeletonBar} />
      </div>
    );
  }

  if (error || !campaign) {
    return (
      <div style={styles.container}>
        <p style={styles.error}>{error || 'Campaign not found'}</p>
      </div>
    );
  }

  const raisedAmount = Number(campaign.raised_amount) || 0;
  const targetAmount = Number(campaign.target_amount) || 0;
  const computedPct = targetAmount > 0 ? (raisedAmount / targetAmount) * 100 : 0;
  const rawPct = Number(campaign.progress_percentage);
  const validPct = !Number.isNaN(rawPct) && Number.isFinite(rawPct) ? rawPct : computedPct;
  const progressPct = Math.max(0, Math.min(100, Number.isFinite(validPct) ? validPct : 0));
  const backerCount = Number(campaign.backer_count) || 0;

  return (
    <div style={styles.container}>
      {isLive && <span style={styles.liveIndicator} title="Live updates active" />}

      <h1 style={styles.title}>{campaign.title}</h1>

      {campaign.description && <p style={styles.description}>{campaign.description}</p>}

      <div style={styles.progressSection}>
        <div style={styles.amounts}>
          <div>
            <span style={styles.raisedAmount}>{raisedAmount.toLocaleString()}</span>
            <span style={styles.asset}>{campaign.asset_type}</span>
            <span style={styles.label}> raised</span>
          </div>
          <div style={styles.target}>{progressPct.toFixed(1)}%</div>
        </div>

        <div style={styles.progressBar}>
          <div
            style={{
              ...styles.progressFill,
              width: `${progressPct}%`,
            }}
          />
        </div>

        <div style={styles.stats}>
          <span>
            <strong>{backerCount}</strong> backer{backerCount !== 1 ? 's' : ''}
          </span>
          <span>
            Goal: <strong>{targetAmount.toLocaleString()}</strong> {campaign.asset_type}
          </span>
        </div>
      </div>

      <a
        href={campaign.contribution_url}
        target="_blank"
        rel="noopener noreferrer"
        style={styles.ctaButton}
        onClick={() => {
          // Notify parent that user clicked (for analytics tracking)
          postToParent({ type: 'cta_click', campaignId: campaign.id });
        }}
      >
        Back this campaign
      </a>
    </div>
  );
}

const styles = {
  container: {
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    padding: '1rem',
    maxWidth: '600px',
    margin: '0 auto',
    background: 'var(--color-bg)',
    borderRadius: '8px',
    position: 'relative',
  },
  liveIndicator: {
    position: 'absolute',
    top: '12px',
    right: '12px',
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    background: 'var(--color-success-text)',
    display: 'block',
    animation: 'pulse 2s infinite',
  },
  title: {
    fontSize: '1.1rem',
    fontWeight: 700,
    color: 'var(--color-text-primary)',
    marginBottom: '0.5rem',
    lineHeight: 1.3,
  },
  description: {
    fontSize: '0.85rem',
    color: 'var(--color-text-secondary)',
    lineHeight: 1.5,
    marginBottom: '1rem',
  },
  progressSection: {
    marginBottom: '1rem',
  },
  amounts: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    marginBottom: '0.5rem',
  },
  raisedAmount: {
    fontSize: '1.25rem',
    fontWeight: 800,
    color: 'var(--color-text-primary)',
  },
  asset: {
    fontSize: '0.85rem',
    fontWeight: 600,
    color: 'var(--color-accent)',
    marginLeft: '0.25rem',
  },
  label: {
    fontSize: '0.85rem',
    color: 'var(--color-text-hint)',
  },
  target: {
    fontSize: '0.9rem',
    fontWeight: 700,
    color: 'var(--color-accent)',
  },
  progressBar: {
    background: 'var(--color-surface)',
    borderRadius: '99px',
    height: '8px',
    marginBottom: '0.75rem',
    overflow: 'hidden',
  },
  progressFill: {
    background: 'linear-gradient(90deg, var(--color-accent) 0%, var(--color-accent-light) 100%)',
    height: '100%',
    borderRadius: '99px',
    transition: 'width 0.5s ease',
  },
  stats: {
    display: 'flex',
    justifyContent: 'space-between',
    fontSize: '0.8rem',
    color: 'var(--color-text-hint)',
  },
  ctaButton: {
    display: 'block',
    width: '100%',
    padding: '0.75rem',
    background: 'var(--color-accent)',
    color: '#fff',
    textAlign: 'center',
    borderRadius: '6px',
    fontWeight: 600,
    fontSize: '0.95rem',
    textDecoration: 'none',
    transition: 'opacity 0.15s',
  },
  skeleton: {
    height: '20px',
    width: '70%',
    background: 'var(--color-border)',
    borderRadius: '4px',
    marginBottom: '0.5rem',
    animation: 'pulse 1.5s infinite',
  },
  skeletonShort: {
    height: '14px',
    width: '90%',
    background: 'var(--color-border)',
    borderRadius: '4px',
    marginBottom: '1rem',
    animation: 'pulse 1.5s infinite',
  },
  skeletonBar: {
    height: '8px',
    width: '100%',
    background: 'var(--color-border)',
    borderRadius: '99px',
    animation: 'pulse 1.5s infinite',
  },
  error: {
    color: 'var(--color-status-error)',
    fontSize: '0.85rem',
    textAlign: 'center',
    padding: '1rem',
  },
};

// Add pulse animation
const styleSheet = document.createElement('style');
styleSheet.textContent = `
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.5; }
  }
`;
document.head.appendChild(styleSheet);
