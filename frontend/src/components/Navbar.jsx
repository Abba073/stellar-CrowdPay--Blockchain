import React, { useState, useEffect, useRef } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useAuth } from '../context/AuthContext';
import { api } from '../services/api';
import NotificationDropdown from './NotificationDropdown';

export default function Navbar() {
  const { user, logout } = useAuth();
  const location = useLocation();
  const { pathname } = location;
  const navigate = useNavigate();
  const { t, i18n } = useTranslation();
  const language = (i18n.resolvedLanguage || i18n.language || 'en').split('-')[0];

  const [notifications, setNotifications] = useState([]);
  const [showDropdown, setShowDropdown] = useState(false);
  const bellRef = useRef(null);
  const bellBtnRef = useRef(null);

  const unread = notifications.filter((n) => !n.read_at).length;

  useEffect(() => {
    if (!user) {
      setNotifications([]);
      return;
    }

    let intervalId = null;
    const fetchNotifs = () => api.getNotifications().then(setNotifications).catch(() => {});

    const startPolling = () => {
      if (intervalId !== null) return;
      fetchNotifs();
      intervalId = setInterval(fetchNotifs, 30_000);
    };

    const stopPolling = () => {
      if (intervalId === null) return;
      clearInterval(intervalId);
      intervalId = null;
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        startPolling();
      } else {
        stopPolling();
      }
    };

    if (document.visibilityState === 'visible') {
      startPolling();
    }
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      stopPolling();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [user]);

  // Close dropdown when clicking outside
  useEffect(() => {
    if (!showDropdown) return;
    function handleOutside(e) {
      if (bellRef.current && !bellRef.current.contains(e.target)) {
        setShowDropdown(false);
      }
    }
    function handleKey(e) {
      if (e.key === 'Escape') {
        setShowDropdown(false);
        bellBtnRef.current?.focus();
      }
    }
    document.addEventListener('mousedown', handleOutside);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleOutside);
      document.removeEventListener('keydown', handleKey);
    };
  }, [showDropdown]);

  function handleMarkRead(id) {
    setNotifications((prev) =>
      prev.map((n) => (n.id === id ? { ...n, read_at: new Date().toISOString() } : n))
    );
  }

  async function handleMarkAllRead() {
    await api.markAllNotificationsRead().catch(() => {});
    setNotifications((prev) =>
      prev.map((n) => ({ ...n, read_at: n.read_at || new Date().toISOString() }))
    );
  }

  function handleLogout() {
    logout();
    navigate('/');
  }

  function handleMarkRead(id) {
    setNotifications((prev) => prev.map((n) => (n.id === id ? { ...n, read_at: new Date().toISOString() } : n)));
  }

  async function handleMarkAllRead() {
    await api.markAllNotificationsRead().catch(() => {});
    setNotifications((prev) => prev.map((n) => ({ ...n, read_at: n.read_at || new Date().toISOString() })));
  }

  return (
    <nav style={styles.nav} data-no-print>
      <div className="container nav-inner-wrap">
        <Link
          to="/"
          style={styles.logo}
          aria-label={t('nav.homeAria')}
          aria-current={pathname === '/' ? 'page' : undefined}
        >
          CrowdPay
        </Link>
        <div className="nav-links">
          <select
            value={language}
            onChange={(e) => i18n.changeLanguage(e.target.value)}
            aria-label={t('nav.selectLanguage')}
            style={styles.languageSelect}
          >
            <option value="en">EN</option>
            <option value="fr">FR</option>
          </select>
          {user ? (
            <>
              <Link
                to="/campaigns/new"
                style={styles.link}
                aria-current={pathname === '/campaigns/new' ? 'page' : undefined}
              >
                {t('nav.startCampaign')}
              </Link>
              <Link
                to="/dashboard"
                style={styles.link}
                aria-current={pathname === '/dashboard' ? 'page' : undefined}
              >
                Dashboard
              </Link>
              <Link
                to="/developer"
                style={styles.link}
                aria-current={pathname === '/developer' ? 'page' : undefined}
              >
                Developer
              </Link>
              <Link
                to="/profile"
                style={styles.link}
                aria-current={pathname === '/profile' ? 'page' : undefined}
              >
                Settings
              </Link>
              {(user.role === 'admin' || user.is_admin) && (
                <Link
                  to="/admin"
                  style={styles.link}
                  aria-current={pathname === '/admin' ? 'page' : undefined}
                >
                  Admin
                </Link>
              )}
              <span style={styles.name} aria-hidden="true">
                {user.name}
              </span>
              <div style={styles.bellWrap} ref={bellRef}>
                <button
                  ref={bellBtnRef}
                  onClick={() => setShowDropdown((v) => !v)}
                  aria-haspopup="menu"
                  aria-expanded={showDropdown}
                  aria-controls="notification-menu"
                  style={styles.bellBtn}
                  aria-label={t('nav.notificationsAria', { count: unread })}
                >
                  🔔
                  {unread > 0 && <span style={styles.badge}>{unread}</span>}
                </button>
                {showDropdown && (
                  <NotificationDropdown
                    notifications={notifications}
                    onMarkRead={handleMarkRead}
                    onMarkAllRead={handleMarkAllRead}
                    onClose={() => setShowDropdown(false)}
                  />
                )}
              </div>
              <button
                onClick={handleLogout}
                className="btn-secondary"
                style={{ padding: '0.4rem 0.9rem' }}
              >
                {t('nav.logout')}
              </button>
            </>
          ) : (
            <>
              <Link
                to="/login"
                state={{ from: location.pathname + location.search }}
                style={styles.link}
                aria-current={pathname === '/login' ? 'page' : undefined}
              >
                {t('nav.login')}
              </Link>
              <Link to="/register" aria-current={pathname === '/register' ? 'page' : undefined}>
                <button className="btn-primary" style={{ padding: '0.4rem 0.9rem' }}>
                  {t('nav.signup')}
                </button>
              </Link>
            </>
          )}
        </div>
      </div>
    </nav>
  );
}

const styles = {
  nav: {
    background: 'var(--color-bg)',
    borderBottom: '1px solid var(--color-border)',
    position: 'sticky',
    top: 0,
    zIndex: 10,
  },
  logo: { fontWeight: 800, fontSize: '1.15rem', color: 'var(--color-accent)' },
  link: { color: 'var(--color-text-secondary)', fontWeight: 500, fontSize: '0.9rem' },
  name: {
    color: 'var(--color-text-secondary)',
    fontSize: '0.85rem',
    maxWidth: '140px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  languageSelect: {
    background: 'transparent',
    border: '1px solid var(--color-border)',
    borderRadius: '8px',
    padding: '0.35rem 0.55rem',
    color: 'var(--color-text-secondary)',
    fontSize: '0.85rem',
  },
  bellWrap: { position: 'relative' },
  bellBtn: {
    position: 'relative',
    background: 'transparent',
    border: 'none',
    fontSize: '1.15rem',
    lineHeight: '1',
    cursor: 'pointer',
    padding: '0.35rem',
  },
  badge: {
    position: 'absolute',
    top: '-2px',
    right: '-4px',
    background: 'var(--color-accent)',
    color: '#fff',
    borderRadius: '999px',
    fontSize: '0.65rem',
    fontWeight: 700,
    padding: '1px 5px',
  },
};
