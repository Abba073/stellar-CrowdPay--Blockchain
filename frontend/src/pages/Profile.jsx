import React, { useState, useEffect } from 'react';
import { Navigate, Link } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { stellarExpertAccountUrl } from '../config/stellar';
import { api } from '../services/api';

const DEFAULT_NOTIFICATIONS = {
  contributions: true,
  milestones: true,
  campaignUpdates: true,
  securityAlerts: true,
};

export default function Profile() {
  const { user, ready, updateUser } = useAuth();
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [copied, setCopied] = useState(false);

  // Email change state
  const [newEmail, setNewEmail] = useState('');
  const [emailSaving, setEmailSaving] = useState(false);
  const [emailError, setEmailError] = useState('');
  const [emailSuccess, setEmailSuccess] = useState('');

  // Password change state
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [passwordSaving, setPasswordSaving] = useState(false);
  const [passwordError, setPasswordError] = useState('');
  const [passwordSuccess, setPasswordSuccess] = useState('');

  // Notification preferences
  const [notifications, setNotifications] = useState(() => {
    try {
      const stored = localStorage.getItem('cp_notification_preferences');
      return stored ? JSON.parse(stored) : DEFAULT_NOTIFICATIONS;
    } catch {
      return DEFAULT_NOTIFICATIONS;
    }
  });
  const [notifSuccess, setNotifSuccess] = useState('');

  useEffect(() => {
    if (user) {
      setName(user.name || '');
      setNewEmail(user.email || '');
    }
  }, [user]);

  if (!ready) {
    return (
      <main className="container page-narrow" style={{ paddingTop: '3rem' }}>
        <p className="alert alert--info">Loading session…</p>
      </main>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  const handleSaveName = async (e) => {
    e.preventDefault();
    if (!name.trim()) {
      setError('Display name is required');
      return;
    }
    setSaving(true);
    setError('');
    setSuccess('');
    try {
      const updatedUser = await api.updateMe({ name: name.trim() });
      if (updateUser) updateUser(updatedUser);
      setSuccess('Profile updated successfully');
      setTimeout(() => setSuccess(''), 3000);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleSaveEmail = async (e) => {
    e.preventDefault();
    if (!newEmail.trim() || !newEmail.includes('@')) {
      setEmailError('Please enter a valid email address');
      return;
    }
    setEmailSaving(true);
    setEmailError('');
    setEmailSuccess('');
    try {
      const updatedUser = await api.updateMe({ email: newEmail.trim() });
      if (updateUser) updateUser(updatedUser);
      setEmailSuccess('Email address updated successfully');
      setTimeout(() => setEmailSuccess(''), 3000);
    } catch (err) {
      setEmailError(err.message || 'Failed to update email address');
    } finally {
      setEmailSaving(false);
    }
  };

  const handleChangePassword = async (e) => {
    e.preventDefault();
    if (!currentPassword) {
      setPasswordError('Current password is required');
      return;
    }
    if (newPassword.length < 8) {
      setPasswordError('New password must be at least 8 characters long');
      return;
    }
    if (newPassword !== confirmPassword) {
      setPasswordError('New passwords do not match');
      return;
    }
    setPasswordSaving(true);
    setPasswordError('');
    setPasswordSuccess('');
    try {
      await api.updateMe({ current_password: currentPassword, password: newPassword });
      setPasswordSuccess('Password changed successfully');
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setTimeout(() => setPasswordSuccess(''), 3000);
    } catch (err) {
      setPasswordError(err.message || 'Failed to change password');
    } finally {
      setPasswordSaving(false);
    }
  };

  const handleToggleNotification = (key) => {
    const updated = { ...notifications, [key]: !notifications[key] };
    setNotifications(updated);
    try {
      localStorage.setItem('cp_notification_preferences', JSON.stringify(updated));
      setNotifSuccess('Notification preferences saved');
      setTimeout(() => setNotifSuccess(''), 2500);
    } catch {
      // ignore storage errors
    }
  };

  const handleCopy = () => {
    navigator.clipboard.writeText(user.wallet_public_key);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <main className="container page-narrow" style={{ paddingTop: '3rem', paddingBottom: '4rem' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem', flexWrap: 'wrap', gap: '0.75rem' }}>
        <h1 style={{ fontSize: '1.75rem', fontWeight: 800, margin: 0 }}>Account Settings</h1>
        <div style={{ display: 'flex', gap: '0.5rem' }}>
          <Link to="/developer" className="btn-secondary" style={{ fontSize: '0.85rem', padding: '0.4rem 0.8rem', minHeight: 'auto', textDecoration: 'none', display: 'inline-flex', alignItems: 'center' }}>
            Developer API
          </Link>
          <Link to="/dashboard" className="btn-secondary" style={{ fontSize: '0.85rem', padding: '0.4rem 0.8rem', minHeight: 'auto', textDecoration: 'none', display: 'inline-flex', alignItems: 'center' }}>
            Dashboard
          </Link>
        </div>
      </div>
      
      {/* Account Details */}
      <div className="campaign-card" style={{ marginBottom: '2rem' }}>
        <h2 style={{ fontSize: '1.15rem', fontWeight: 700, marginBottom: '1rem' }}>Display Profile</h2>
        
        {error && <p className="alert alert--error" style={{ marginBottom: '1rem' }}>{error}</p>}
        {success && <p className="alert alert--success" style={{ marginBottom: '1rem' }}>{success}</p>}
        
        <form onSubmit={handleSaveName}>
          <div className="form-stack" style={{ marginBottom: '1.25rem' }}>
            <label htmlFor="profile-name" className="label-strong">Display name</label>
            <input 
              id="profile-name" 
              value={name} 
              onChange={(e) => setName(e.target.value)} 
              placeholder="Your display name"
            />
          </div>
          
          <div className="form-stack" style={{ marginBottom: '1.5rem' }}>
            <label className="label-strong">Member since</label>
            <input 
              value={user.created_at ? new Date(user.created_at).toLocaleDateString() : '—'} 
              disabled 
              style={{ background: 'var(--color-surface)', color: 'var(--color-text-secondary)', cursor: 'not-allowed' }} 
            />
          </div>
          
          <button type="submit" className="btn-primary" disabled={saving || !name.trim() || name === user.name}>
            {saving ? 'Saving…' : 'Save display name'}
          </button>
        </form>
      </div>

      {/* Email Settings */}
      <div className="campaign-card" style={{ marginBottom: '2rem' }}>
        <h2 style={{ fontSize: '1.15rem', fontWeight: 700, marginBottom: '1rem' }}>Email Address</h2>
        {emailError && <p className="alert alert--error" style={{ marginBottom: '1rem' }}>{emailError}</p>}
        {emailSuccess && <p className="alert alert--success" style={{ marginBottom: '1rem' }}>{emailSuccess}</p>}

        <form onSubmit={handleSaveEmail}>
          <div className="form-stack" style={{ marginBottom: '1.25rem' }}>
            <label htmlFor="profile-email" className="label-strong">Account email</label>
            <input
              id="profile-email"
              type="email"
              value={newEmail}
              onChange={(e) => setNewEmail(e.target.value)}
              placeholder="your@email.com"
            />
          </div>
          <button type="submit" className="btn-primary" disabled={emailSaving || !newEmail.trim() || newEmail === user.email}>
            {emailSaving ? 'Updating…' : 'Update email address'}
          </button>
        </form>
      </div>

      {/* Change Password */}
      <div className="campaign-card" style={{ marginBottom: '2rem' }}>
        <h2 style={{ fontSize: '1.15rem', fontWeight: 700, marginBottom: '1rem' }}>Change Password</h2>
        {passwordError && <p className="alert alert--error" style={{ marginBottom: '1rem' }}>{passwordError}</p>}
        {passwordSuccess && <p className="alert alert--success" style={{ marginBottom: '1rem' }}>{passwordSuccess}</p>}

        <form onSubmit={handleChangePassword}>
          <div className="form-stack" style={{ marginBottom: '1rem' }}>
            <label htmlFor="current-password" className="label-strong">Current password</label>
            <input
              id="current-password"
              type="password"
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
              placeholder="••••••••"
            />
          </div>

          <div className="form-stack" style={{ marginBottom: '1rem' }}>
            <label htmlFor="new-password" className="label-strong">New password</label>
            <input
              id="new-password"
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="At least 8 characters"
            />
          </div>

          <div className="form-stack" style={{ marginBottom: '1.25rem' }}>
            <label htmlFor="confirm-password" className="label-strong">Confirm new password</label>
            <input
              id="confirm-password"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Re-enter new password"
            />
          </div>

          <button type="submit" className="btn-primary" disabled={passwordSaving || !currentPassword || !newPassword}>
            {passwordSaving ? 'Updating…' : 'Change password'}
          </button>
        </form>
      </div>

      {/* Notification Preferences */}
      <div className="campaign-card" style={{ marginBottom: '2rem' }}>
        <h2 style={{ fontSize: '1.15rem', fontWeight: 700, marginBottom: '0.5rem' }}>Notification Preferences</h2>
        <p style={{ color: 'var(--color-text-secondary)', fontSize: '0.9rem', marginBottom: '1rem' }}>
          Manage which email and platform notifications you receive.
        </p>

        {notifSuccess && <p className="alert alert--success" style={{ marginBottom: '1rem' }}>{notifSuccess}</p>}

        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={notifications.contributions}
              onChange={() => handleToggleNotification('contributions')}
            />
            <div>
              <div style={{ fontWeight: 600, fontSize: '0.95rem' }}>Contribution receipts</div>
              <div style={{ color: 'var(--color-text-hint)', fontSize: '0.8rem' }}>Receive email confirmations when you make or receive contributions.</div>
            </div>
          </label>

          <label style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={notifications.milestones}
              onChange={() => handleToggleNotification('milestones')}
            />
            <div>
              <div style={{ fontWeight: 600, fontSize: '0.95rem' }}>Milestone progress</div>
              <div style={{ color: 'var(--color-text-hint)', fontSize: '0.8rem' }}>Alerts when project milestones are submitted, approved, or released.</div>
            </div>
          </label>

          <label style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={notifications.campaignUpdates}
              onChange={() => handleToggleNotification('campaignUpdates')}
            />
            <div>
              <div style={{ fontWeight: 600, fontSize: '0.95rem' }}>Campaign updates</div>
              <div style={{ color: 'var(--color-text-hint)', fontSize: '0.8rem' }}>Newsletters and creator updates for campaigns you follow or back.</div>
            </div>
          </label>

          <label style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={notifications.securityAlerts}
              onChange={() => handleToggleNotification('securityAlerts')}
            />
            <div>
              <div style={{ fontWeight: 600, fontSize: '0.95rem' }}>Security alerts</div>
              <div style={{ color: 'var(--color-text-hint)', fontSize: '0.8rem' }}>Important notifications regarding your account access and keys.</div>
            </div>
          </label>
        </div>
      </div>

      {/* Stellar Wallet */}
      <div className="campaign-card">
        <h2 style={{ fontSize: '1.15rem', fontWeight: 700, marginBottom: '0.5rem' }}>Your Stellar wallet</h2>
        <p style={{ color: 'var(--color-text-secondary)', fontSize: '0.9rem', marginBottom: '1rem' }}>
          This is a custodial wallet managed by CrowdPay.
        </p>
        
        <div style={{ background: 'var(--color-surface)', padding: '1rem', borderRadius: '8px', marginBottom: '1rem' }}>
          <code style={{ wordBreak: 'break-all', color: 'var(--color-text-primary)' }}>
            {user.wallet_public_key}
          </code>
        </div>
        
        <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
          <button type="button" className="btn-secondary" onClick={handleCopy}>
            {copied ? 'Copied!' : 'Copy address'}
          </button>
          {typeof stellarExpertAccountUrl === 'function' && (
            <a href={stellarExpertAccountUrl(user.wallet_public_key)} target="_blank" rel="noopener noreferrer" className="btn-secondary" style={{ display: 'inline-flex', alignItems: 'center', textDecoration: 'none' }}>
              View on Stellar Expert ↗
            </a>
          )}
        </div>
      </div>
    </main>
  );
}
