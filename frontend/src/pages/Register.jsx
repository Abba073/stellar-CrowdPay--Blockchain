import React, { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api } from '../services/api';
import { useAuth } from '../context/AuthContext';
import { markJustRegistered } from '../lib/onboarding';
import { isConnected as isFreighterConnected, getPublicKey, requestAccess } from '@stellar/freighter-api';

function passwordStrength(pw) {
  if (!pw) return null;
  let score = 0;
  if (pw.length >= 8) score++;
  if (pw.length >= 12) score++;
  if (/[A-Z]/.test(pw)) score++;
  if (/[0-9]/.test(pw)) score++;
  if (/[^A-Za-z0-9]/.test(pw)) score++;
  if (score <= 1) return { label: 'Weak', color: '#ef4444', width: '33%' };
  if (score <= 3) return { label: 'Fair', color: '#f59e0b', width: '66%' };
  return { label: 'Strong', color: '#10b981', width: '100%' };
}

export default function Register() {
  const { t } = useTranslation();
  const { login } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ name: '', email: '', password: '', confirmPassword: '', role: 'contributor' });
  const [freighterAvailable, setFreighterAvailable] = useState(false);
  const [usingFreighter, setUsingFreighter] = useState(false);
  const [freighterPublicKey, setFreighterPublicKey] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);

  function set(field) {
    return (e) => setForm((f) => ({ ...f, [field]: e.target.value }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!form.name.trim() || !form.email.trim() || !form.password.trim()) {
      setError(t('register.required'));
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) {
      setError(t('register.invalidEmail'));
      return;
    }
    if (form.password.length < 8) {
      setError(t('register.passwordLength'));
      return;
    }
    if (form.password !== form.confirmPassword) {
      setError(t('register.passwordsMismatch'));
      return;
    }
    setLoading(true);
    setError('');
    try {
      const payload = { ...form };
      if (usingFreighter) {
        payload.wallet_type = 'freighter';
        payload.wallet_public_key = freighterPublicKey;
      }
      const { user } = await api.register(payload);
      login(user);
      markJustRegistered();
      navigate(user.role === 'creator' ? '/dashboard' : '/');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const con = await isFreighterConnected();
        if (!active) return;
        setFreighterAvailable(Boolean(con?.isConnected));
      } catch {
        if (active) setFreighterAvailable(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  async function connectFreighter() {
    try {
      const access = await requestAccess();
      if (access?.error) throw new Error(access.error?.message || 'Could not connect to Freighter');
      const pk = access?.address || (await getPublicKey());
      if (!pk) throw new Error('Freighter did not return a public key');
      setFreighterPublicKey(pk);
      setUsingFreighter(true);
      setForm((f) => ({ ...f, password: f.password }));
    } catch (err) {
      setError(err.message || 'Could not connect to Freighter');
    }
  }

  return (
    <main className="container" style={{ paddingTop: '4rem', maxWidth: '400px' }}>
      <h1 style={{ fontSize: '1.6rem', fontWeight: 800, marginBottom: '0.5rem' }}>{t('register.title')}</h1>
      <p style={{ color: 'var(--color-text-hint)', marginBottom: '1.5rem', fontSize: '0.9rem' }}>
        {t('register.subtitle')}
      </p>
      <form noValidate onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
        <label className="label-strong" htmlFor="reg-name">{t('register.fullName')}</label>
        <input id="reg-name" placeholder={t('register.fullName')} value={form.name} onChange={set('name')} required />
        <label className="label-strong" htmlFor="reg-email">{t('register.email')}</label>
        <input
          id="reg-email"
          type="email"
          placeholder={t('register.email')}
          value={form.email}
          onChange={set('email')}
          required
        />
        <label className="label-strong" htmlFor="reg-password">{t('register.password')}</label>
        <div style={{ position: 'relative' }}>
          <input
            id="reg-password"
            type={showPassword ? 'text' : 'password'}
            placeholder={t('register.password')}
            value={form.password}
            onChange={set('password')}
            required
            minLength={8}
            autoComplete="new-password"
            style={{ paddingRight: '2.5rem', width: '100%' }}
          />
          <button
            type="button"
            aria-label={showPassword ? t('login.hidePassword') : t('login.showPassword')}
            onClick={() => setShowPassword((v) => !v)}
            style={{
              position: 'absolute',
              right: '0.6rem',
              top: '50%',
              transform: 'translateY(-50%)',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: '#888',
              padding: '0.2rem',
              minHeight: 'auto',
              fontSize: '0.85rem',
            }}
          >
            {showPassword ? t('common.hide') : t('common.show')}
          </button>
        </div>
        {form.password && (() => {
          const s = passwordStrength(form.password);
          return (
            <div style={{ marginTop: '-0.4rem' }}>
              <div style={{ height: '4px', borderRadius: '99px', background: '#e5e5e5', overflow: 'hidden' }}>
                <div style={{ height: '100%', width: s.width, background: s.color, transition: 'width 0.2s, background 0.2s', borderRadius: '99px' }} />
              </div>
              <span style={{ fontSize: '0.78rem', color: s.color, fontWeight: 600 }}>{s.label}</span>
            </div>
          );
        })()}
        <div className="form-stack" style={{ position: 'relative' }}>
          <label className="label-strong" htmlFor="reg-confirm">{t('register.confirmPassword')}</label>
          <input
            id="reg-confirm"
            type={showConfirmPassword ? 'text' : 'password'}
            value={form.confirmPassword}
            onChange={set('confirmPassword')}
            required
            autoComplete="new-password"
            style={{ paddingRight: '2.5rem' }}
          />
          <button
            type="button"
            aria-label={showConfirmPassword ? t('login.hidePassword') : t('login.showPassword')}
            onClick={() => setShowConfirmPassword((v) => !v)}
            style={{
              position: 'absolute',
              right: '0.6rem',
              top: '50%',
              transform: 'translateY(-50%)',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: '#888',
              padding: '0.2rem',
              minHeight: 'auto',
              fontSize: '0.85rem',
            }}
          >
            {showConfirmPassword ? t('common.hide') : t('common.show')}
          </button>
        </div>
        <select value={form.role} onChange={set('role')} aria-label={t('register.roleLabel')}>
          <option value="contributor">{t('register.contributor')}</option>
          <option value="creator">{t('register.creator')}</option>
        </select>
        {freighterAvailable && (
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
              <input type="checkbox" checked={usingFreighter} onChange={(e) => setUsingFreighter(e.target.checked)} />
              {t('register.useFreighter')}
            </label>
            {usingFreighter ? (
              <button type="button" className="btn-secondary" onClick={connectFreighter}>
                {freighterPublicKey ? t('register.connected') : t('register.connectFreighter')}
              </button>
            ) : null}
          </div>
        )}
        {error && <p role="alert" style={{ color: 'var(--color-status-error)', fontSize: '0.875rem' }}>{error}</p>}
        <button type="submit" className="btn-primary" data-testid="register-submit" disabled={loading} style={{ padding: '0.8rem' }}>
          {loading ? t('register.loading') : t('common.signUp')}
        </button>
      </form>
      <p style={{ marginTop: '1.25rem', color: 'var(--color-text-hint)', fontSize: '0.9rem' }}>
        {t('register.haveAccount')}{' '}
        <Link to="/login" style={{ color: 'var(--color-accent)', fontWeight: 600 }}>
          {t('register.logIn')}
        </Link>
      </p>
    </main>
  );
}
import React, { useState, useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { api } from '../services/api';
import { useAuth } from '../context/AuthContext';
import { markJustRegistered } from '../lib/onboarding';
import { isConnected as isFreighterConnected, getPublicKey, requestAccess } from '@stellar/freighter-api';

function passwordStrength(pw) {
  if (!pw) return null;
  let score = 0;
  if (pw.length >= 8) score++;
  if (pw.length >= 12) score++;
  if (/[A-Z]/.test(pw)) score++;
  if (/[0-9]/.test(pw)) score++;
  if (/[^A-Za-z0-9]/.test(pw)) score++;
  if (score <= 1) return { label: 'Weak', color: '#ef4444', width: '33%' };
  if (score <= 3) return { label: 'Fair', color: '#f59e0b', width: '66%' };
  return { label: 'Strong', color: '#10b981', width: '100%' };
}

export default function Register() {
  const { t } = useTranslation();
  const { login } = useAuth();
  const navigate = useNavigate();
  const [form, setForm] = useState({ name: '', email: '', password: '', confirmPassword: '', role: 'contributor' });
  const [freighterAvailable, setFreighterAvailable] = useState(false);
  const [usingFreighter, setUsingFreighter] = useState(false);
  const [freighterPublicKey, setFreighterPublicKey] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);

  function set(field) {
    return (e) => setForm((f) => ({ ...f, [field]: e.target.value }));
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!form.name.trim() || !form.email.trim() || !form.password.trim()) {
      setError(t('register.required'));
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) {
      setError(t('register.invalidEmail'));
      return;
    }
    if (form.password.length < 8) {
      setError(t('register.passwordLength'));
      return;
    }
    if (form.password !== form.confirmPassword) {
      setError(t('register.passwordsMismatch'));
      return;
    }
    if (usingFreighter && !freighterPublicKey) {
      setError(t('register.connectFreighter'));
      return;
    }
    setLoading(true);
    setError('');
    try {
      const payload = { ...form };
      if (usingFreighter) {
        payload.wallet_type = 'freighter';
        payload.wallet_public_key = freighterPublicKey;
      }
      const { user } = await api.register(payload);
      login(user);
      markJustRegistered();
      navigate(user.role === 'creator' ? '/dashboard' : '/');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const con = await isFreighterConnected();
        if (!active) return;
        setFreighterAvailable(Boolean(con?.isConnected));
      } catch {
        if (active) setFreighterAvailable(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  async function connectFreighter() {
    try {
      const access = await requestAccess();
      if (access?.error) throw new Error(access.error?.message || 'Could not connect to Freighter');
      const pk = access?.address || (await getPublicKey());
      if (!pk) throw new Error('Freighter did not return a public key');
      setFreighterPublicKey(pk);
      setUsingFreighter(true);
    } catch (err) {
      setError(err.message || 'Could not connect to Freighter');
    }
  }

  return (
    <main className="container" style={{ paddingTop: '4rem', maxWidth: '400px' }}>
      <h1 style={{ fontSize: '1.6rem', fontWeight: 800, marginBottom: '0.5rem' }}>{t('register.title')}</h1>
      <p style={{ color: 'var(--color-text-hint)', marginBottom: '1.5rem', fontSize: '0.9rem' }}>
        {t('register.subtitle')}
      </p>
      <form noValidate onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '0.85rem' }}>
        <input aria-label={t('register.fullName')} placeholder={t('register.fullName')} value={form.name} onChange={set('name')} required />
        <input aria-label={t('register.email')} type="email" placeholder={t('register.email')} value={form.email} onChange={set('email')} required />
        <div style={{ position: 'relative' }}>
          <input
            id="reg-password"
            aria-label={t('register.password')}
            type={showPassword ? 'text' : 'password'}
            placeholder={t('register.password')}
            value={form.password}
            onChange={set('password')}
            required
            minLength={8}
            autoComplete="new-password"
            style={{ paddingRight: '2.5rem', width: '100%' }}
          />
          <button
            type="button"
            aria-label={showPassword ? t('login.hidePassword') : t('login.showPassword')}
            onClick={() => setShowPassword((v) => !v)}
            style={{
              position: 'absolute',
              right: '0.6rem',
              top: '50%',
              transform: 'translateY(-50%)',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: '#888',
              padding: '0.2rem',
              minHeight: 'auto',
              fontSize: '0.85rem',
            }}
          >
            {showPassword ? t('common.hide') : t('common.show')}
          </button>
        </div>
        {form.password && (() => {
          const s = passwordStrength(form.password);
          return (
            <div style={{ marginTop: '-0.4rem' }}>
              <div style={{ height: '4px', borderRadius: '99px', background: '#e5e5e5', overflow: 'hidden' }}>
                <div style={{ height: '100%', width: s.width, background: s.color, transition: 'width 0.2s, background 0.2s', borderRadius: '99px' }} />
              </div>
              <span style={{ fontSize: '0.78rem', color: s.color, fontWeight: 600 }}>{s.label}</span>
            </div>
          );
        })()}
        <div className="form-stack" style={{ position: 'relative' }}>
          <label className="label-strong" htmlFor="reg-confirm">{t('register.confirmPassword')}</label>
          <input
            id="reg-confirm"
            type={showConfirmPassword ? 'text' : 'password'}
            value={form.confirmPassword}
            onChange={set('confirmPassword')}
            required
            autoComplete="new-password"
            style={{ paddingRight: '2.5rem' }}
          />
          <button
            type="button"
            aria-label={showConfirmPassword ? t('login.hidePassword') : t('login.showPassword')}
            onClick={() => setShowConfirmPassword((v) => !v)}
            style={{
              position: 'absolute',
              right: '0.6rem',
              top: '50%',
              transform: 'translateY(-50%)',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              color: '#888',
              padding: '0.2rem',
              minHeight: 'auto',
              fontSize: '0.85rem',
            }}
          >
            {showConfirmPassword ? t('common.hide') : t('common.show')}
          </button>
        </div>
        <select value={form.role} onChange={set('role')} aria-label={t('register.roleLabel')}>
          <option value="contributor">{t('register.contributor')}</option>
          <option value="creator">{t('register.creator')}</option>
        </select>
        {freighterAvailable && (
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.35rem' }}>
              <input type="checkbox" checked={usingFreighter} onChange={(e) => setUsingFreighter(e.target.checked)} />
              {t('register.useFreighter')}
            </label>
            {usingFreighter ? (
              <button type="button" className="btn-secondary" onClick={connectFreighter}>
                {freighterPublicKey ? t('register.connected') : t('register.connectFreighter')}
              </button>
            ) : null}
          </div>
        )}
        {error && <p style={{ color: 'var(--color-status-error)', fontSize: '0.875rem' }}>{error}</p>}
        <button type="submit" className="btn-primary" data-testid="register-submit" disabled={loading} style={{ padding: '0.8rem' }}>
          {loading ? t('register.loading') : t('common.signUp')}
        </button>
      </form>
      <p style={{ marginTop: '1.25rem', color: 'var(--color-text-hint)', fontSize: '0.9rem' }}>
        {t('register.haveAccount')}{' '}
        <Link to="/login" style={{ color: 'var(--color-accent)', fontWeight: 600 }}>
          {t('register.logIn')}
        </Link>
      </p>
    </main>
  );
}
