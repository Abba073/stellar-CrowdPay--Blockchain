import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import SimpleMDE from 'react-simplemde-editor';
import 'easymde/dist/easymde.min.css';
import { api } from '../services/api';
import { useAuth } from '../context/AuthContext';
import OnboardingCallout from '../components/OnboardingCallout';
import KycPrompt from '../components/KycPrompt';
import { isCreatorOnboardingVisible, dismissCreatorOnboarding } from '../lib/onboarding';
import { CATEGORY_KEYS } from '../lib/categories';

const ASSETS = [
  {
    value: 'USDC',
    label: 'USDC',
    hint: 'Stable dollar value on Stellar. Best when backers think in USD.',
  },
  {
    value: 'XLM',
    label: 'XLM',
    hint: 'Native Stellar asset. Simple for contributors who already hold XLM.',
  },
];

function emptyMilestone() {
  return { title: '', description: '', release_percentage: '' };
}

function milestonePercentTotal(milestones) {
  return milestones.reduce(
    (sum, milestone) => sum + (Number(milestone.release_percentage) || 0),
    0
  );
}

export default function CreateCampaign() {
  const { t } = useTranslation();
  const { user, ready, updateUser, token } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [step, setStep] = useState(1);
  const prefill = location.state?.prefill || {};
  const [form, setForm] = useState({
    title: prefill.title || '',
    description: prefill.description || '',
    target_amount: prefill.target_amount || '',
    asset_type: prefill.asset_type || 'USDC',
    deadline: '',
    milestones: [],
    min_contribution: prefill.min_contribution || '',
    max_contribution: prefill.max_contribution || '',
    max_per_user: prefill.max_per_user || '',
    show_backer_amounts: prefill.show_backer_amounts ?? true,
    category: prefill.category || '',
  });
  const [coverImageFile, setCoverImageFile] = useState(null);
  const [coverImagePreview, setCoverImagePreview] = useState('');
  const [isDragOverCover, setIsDragOverCover] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const today = new Date().toISOString().split('T')[0];
  const [showCreatorTips, setShowCreatorTips] = useState(isCreatorOnboardingVisible);

  useEffect(() => {
    if (ready && !user) {
      navigate('/login', { replace: true, state: { from: '/campaigns/new' } });
    }
  }, [ready, user, navigate]);

  useEffect(() => {
    if (!user) return;
    api.getMe().then(updateUser).catch(() => {});
  }, [user?.id, updateUser]);

  function setField(field) {
    return (e) => setForm((f) => ({ ...f, [field]: e.target.value }));
  }

  function setDescription(value) {
    setForm((f) => ({ ...f, description: value }));
  }

  function selectAsset(value) {
    setForm((f) => ({ ...f, asset_type: value }));
  }

  function setCoverImage(file) {
    if (!file) {
      setCoverImageFile(null);
      setCoverImagePreview('');
      return;
    }
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      setError('Cover image must be JPG, PNG, or WEBP.');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setError('Cover image must be smaller than 5MB.');
      return;
    }
    setCoverImageFile(file);
    setError('');
    const reader = new FileReader();
    reader.onload = () => setCoverImagePreview(reader.result || '');
    reader.readAsDataURL(file);
  }

  function handleCoverImageChange(e) {
    setCoverImage(e.target.files?.[0] || null);
  }

  function handleCoverImageDrop(e) {
    e.preventDefault();
    setIsDragOverCover(false);
    const file = e.dataTransfer?.files?.[0] || null;
    setCoverImage(file);
  }

  function dismissTips() {
    dismissCreatorOnboarding();
    setShowCreatorTips(false);
  }

  function setMilestoneField(index, field, value) {
    setForm((f) => ({
      ...f,
      milestones: f.milestones.map((milestone, milestoneIndex) =>
        milestoneIndex === index ? { ...milestone, [field]: value } : milestone
      ),
    }));
  }

  function addMilestone() {
    setForm((f) => {
      if (f.milestones.length >= 5) return f;
      return { ...f, milestones: [...f.milestones, emptyMilestone()] };
    });
  }

  function removeMilestone(index) {
    setForm((f) => ({
      ...f,
      milestones: f.milestones.filter((_, milestoneIndex) => milestoneIndex !== index),
    }));
  }

  function validateStep1() {
    if (!form.title.trim()) {
      setError('Please enter a campaign title.');
      return false;
    }
    if (!form.target_amount || Number(form.target_amount) <= 0) {
      setError('Enter a fundraising goal greater than zero.');
      return false;
    }
    setError('');
    return true;
  }

  function validateStep2() {
    if (form.deadline && form.deadline < today) {
      setError('Deadline must be today or in the future.');
      return false;
    }
    if (form.min_contribution && Number(form.min_contribution) <= 0) {
      setError('Minimum contribution must be greater than zero.');
      return false;
    }
    if (form.max_contribution) {
      if (Number(form.max_contribution) <= 0) {
        setError('Maximum contribution must be greater than zero.');
        return false;
      }
      if (form.min_contribution && Number(form.max_contribution) <= Number(form.min_contribution)) {
        setError('Maximum contribution must be greater than minimum contribution.');
        return false;
      }
      if (form.target_amount && Number(form.max_contribution) > Number(form.target_amount)) {
        setError('Maximum contribution cannot exceed the target amount.');
        return false;
      }
    }
    if (form.max_per_user) {
      if (Number(form.max_per_user) <= 0) {
        setError('Per-contributor cap must be greater than zero.');
        return false;
      }
      if (form.min_contribution && Number(form.max_per_user) <= Number(form.min_contribution)) {
        setError('Per-contributor cap must be greater than minimum contribution.');
        return false;
      }
    }

    setError('');
    return true;
  }

  function validateMilestones() {
    if (form.milestones.length === 0) {
      setError('');
      return true;
    }
    if (form.milestones.length > 5) {
      setError('Campaigns can define at most 5 milestones.');
      return false;
    }

    for (let index = 0; index < form.milestones.length; index += 1) {
      const milestone = form.milestones[index];
      if (!milestone.title.trim()) {
        setError(`Milestone ${index + 1} needs a title.`);
        return false;
      }
      if (!milestone.description.trim()) {
        setError(`Milestone ${index + 1} needs a description.`);
        return false;
      }
      if (!milestone.release_percentage || Number(milestone.release_percentage) <= 0) {
        setError(`Milestone ${index + 1} needs a release percentage greater than zero.`);
        return false;
      }
    }

    const total = milestonePercentTotal(form.milestones);
    if (Math.abs(total - 100) > 0.0001) {
      setError('Milestone percentages must sum to exactly 100%.');
      return false;
    }

    setError('');
    return true;
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!validateStep1() || !validateStep2() || !validateMilestones()) return;
    setLoading(true);
    setError('');
    try {
      const campaign = await api.createCampaign({
        title: form.title.trim(),
        description: form.description.trim() || undefined,
        target_amount: form.target_amount,
        asset_type: form.asset_type,
        deadline: form.deadline || undefined,
        category: form.category || undefined,
        min_contribution: form.min_contribution ? Number(form.min_contribution) : undefined,
        max_contribution: form.max_contribution ? Number(form.max_contribution) : undefined,
        max_per_user: form.max_per_user ? Number(form.max_per_user) : undefined,
        milestones: form.milestones.length
          ? form.milestones.map((milestone) => ({
              title: milestone.title.trim(),
              description: milestone.description.trim(),
              release_percentage: Number(milestone.release_percentage),
            }))
          : undefined,
      });

      let coverUploadError = '';
      if (coverImageFile) {
        try {
          await api.uploadCampaignCoverImage(campaign.id, coverImageFile);
        } catch (uploadError) {
          coverUploadError =
            uploadError.message || 'Campaign created, but cover image upload failed.';
        }
      }

      navigate(`/campaigns/${campaign.id}`, {
        state: { created: true, coverUploadError: coverUploadError || undefined },
      });
    } catch (err) {
      if (err.status === 401) {
        setError('Your session expired. Please log in again.');
        navigate('/login', { state: { from: '/campaigns/new' } });
      } else {
        setError(err.message || 'Could not create campaign. Try again.');
      }
      setLoading(false);
    }
  }

  if (!ready) {
    return (
      <main className="container page-narrow" style={{ paddingTop: '3rem' }}>
        <p className="alert alert--info">Restoring your session…</p>
      </main>
    );
  }

  if (!user) {
    return (
      <main className="container page-narrow" style={{ paddingTop: '3rem' }}>
        <p className="alert alert--info">Redirecting to sign in…</p>
      </main>
    );
  }

  if (user?.role !== 'creator' && user?.role !== 'admin') {
    return (
      <main className="container page-narrow" style={{ paddingTop: '3rem' }}>
        <p className="alert alert--info">Only creator or admin accounts can start campaigns.</p>
      </main>
    );
  }

  const kycRequired =
    user?.kyc_required_for_campaigns ??
    String(import.meta.env.VITE_KYC_REQUIRED_FOR_CAMPAIGNS ?? 'true').toLowerCase() !== 'false';

  if (kycRequired && user?.kyc_status !== 'verified') {
    return (
      <main className="container page-narrow" style={{ paddingTop: '3rem', paddingBottom: '3rem' }}>
        <KycPrompt token={token} onUserUpdate={updateUser} title="Verify your identity first" />
        <p style={{ marginTop: '1rem', fontSize: '0.9rem', color: 'var(--color-text-hint)' }}>
          Current verification status: <strong>{user?.kyc_status || 'unverified'}</strong>.
        </p>
      </main>
    );
  }

  const milestoneTotal = milestonePercentTotal(form.milestones);

  return (
    <main className="container page-mid" style={{ paddingTop: '1.75rem', paddingBottom: '3rem' }}>
      <nav aria-label="Progress" style={{ marginBottom: '1.25rem' }}>
        <ol
          style={{
            listStyle: 'none',
            display: 'flex',
            gap: '0.5rem',
            flexWrap: 'wrap',
            fontSize: '0.8rem',
            fontWeight: 600,
            color: 'var(--color-text-hint)',
          }}
        >
          <li aria-current={step === 1 ? 'step' : undefined}>
            <span style={{ color: step === 1 ? '#7c3aed' : '#999' }}>
              {t('createCampaign.steps.goalAsset')}
            </span>
          </li>
          <li aria-hidden="true">→</li>
          <li aria-current={step === 2 ? 'step' : undefined}>
            <span style={{ color: step === 2 ? '#7c3aed' : '#999' }}>
              {t('createCampaign.steps.detailsLaunch')}
            </span>
          </li>
        </ol>
      </nav>

      <h1
        style={{
          fontSize: 'clamp(1.5rem, 4vw, 1.85rem)',
          fontWeight: 800,
          marginBottom: '0.35rem',
        }}
      >
        {t('createCampaign.title')}
      </h1>
      <p
        style={{
          color: 'var(--color-text-secondary)',
          marginBottom: '1.25rem',
          fontSize: '0.95rem',
          lineHeight: 1.55,
        }}
      >
        {t('createCampaign.subtitle')}
      </p>

      {showCreatorTips && (
        <OnboardingCallout title={t('createCampaign.tipsTitle')} onDismiss={dismissTips}>
          <ul>
            <li>{t('createCampaign.tip1')}</li>
            <li>{t('createCampaign.tip2')}</li>
            <li>{t('createCampaign.tip3')}</li>
          </ul>
        </OnboardingCallout>
      )}

      <form onSubmit={handleSubmit}>
        {location.state?.prefill && (
          <div className="alert alert--info" style={{ marginBottom: '1.25rem' }}>
            Pre-filled from an existing campaign. Review and adjust before launching.
          </div>
        )}
        {step === 1 && (
          <>
            <div className="form-stack">
              <label className="label-strong" htmlFor="cc-title">
                {t('createCampaign.campaignTitle')}
              </label>
              <input
                id="cc-title"
                value={form.title}
                onChange={setField('title')}
                placeholder={t('createCampaign.campaignTitlePlaceholder')}
                required
                aria-required="true"
                autoComplete="off"
              />
            </div>

            <div className="form-stack" style={{ marginTop: '1rem' }}>
              <label className="label-strong" htmlFor="cc-target">
                {t('createCampaign.fundraisingGoal')}
              </label>
              <input
                id="cc-target"
                type="number"
                inputMode="decimal"
                min="0.0000001"
                step="any"
                value={form.target_amount}
                onChange={setField('target_amount')}
                placeholder="0.00"
                required
                aria-required="true"
              />
            </div>

            <div
              style={{
                marginTop: '1.25rem',
                border: '1px dashed var(--color-border)',
                padding: '1rem',
                borderRadius: '8px',
              }}
            >
              <h3 style={{ fontSize: '1rem', fontWeight: 700, marginBottom: '0.5rem' }}>
                {t('createCampaign.contributionLimits')}
              </h3>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem' }}>
                <div className="form-stack">
                  <label className="label-strong" htmlFor="cc-min-contrib">
                    {t('createCampaign.minContribution')}
                  </label>
                  <input
                    id="cc-min-contrib"
                    type="number"
                    inputMode="decimal"
                    min="0.0000001"
                    step="any"
                    value={form.min_contribution}
                    onChange={setField('min_contribution')}
                    placeholder="e.g. 5"
                  />
                </div>
                <div className="form-stack">
                  <label className="label-strong" htmlFor="cc-max-contrib">
                    {t('createCampaign.maxContribution')}
                  </label>
                  <input
                    id="cc-max-contrib"
                    type="number"
                    inputMode="decimal"
                    min="0.0000001"
                    step="any"
                    value={form.max_contribution}
                    onChange={setField('max_contribution')}
                    placeholder="e.g. 500"
                  />
                </div>
              </div>
            </div>

            <fieldset style={{ border: 'none', margin: '1.25rem 0 0', padding: 0 }}>
              <legend className="label-strong" style={{ marginBottom: '0.5rem' }}>
                {t('createCampaign.settlementAsset')}
              </legend>
              <p
                style={{
                  fontSize: '0.8rem',
                  color: 'var(--color-text-hint)',
                  marginBottom: '0.65rem',
                }}
              >
                {t('createCampaign.settlementAssetHelp')}
              </p>
              <div className="asset-picker" role="radiogroup" aria-label="Settlement asset">
                {ASSETS.map((a) => (
                  <label
                    key={a.value}
                    className={`asset-picker__option${form.asset_type === a.value ? ' asset-picker__option--selected' : ''}`}
                  >
                    <input
                      type="radio"
                      name="asset_type"
                      value={a.value}
                      checked={form.asset_type === a.value}
                      onChange={() => selectAsset(a.value)}
                    />
                    <div className="asset-picker__code">{a.label}</div>
                    <div className="asset-picker__hint">{a.hint}</div>
                  </label>
                ))}
              </div>
            </fieldset>

            <div className="form-stack" style={{ marginTop: '1rem' }}>
              <label className="label-strong" htmlFor="cc-category">
                {t('categories.label')}{' '}
                <span style={{ fontWeight: 500, color: 'var(--color-text-muted)' }}>
                  {t('categories.optional')}
                </span>
              </label>
              <select id="cc-category" value={form.category} onChange={setField('category')}>
                <option value="">{t('categories.selectPlaceholder')}</option>
                {CATEGORY_KEYS.map((key) => (
                  <option key={key} value={key}>
                    {t(`categories.${key}`)}
                  </option>
                ))}
              </select>
            </div>

            {error && (
              <p className="alert alert--error" style={{ marginTop: '1rem' }} role="alert">
                {error}
              </p>
            )}

            <button
              type="button"
              className="btn-primary"
              style={{ width: '100%', marginTop: '1.25rem' }}
              onClick={() => {
                if (validateStep1()) setStep(2);
              }}
            >
              {t('createCampaign.continueToDetails')}
            </button>
          </>
        )}

        {step === 2 && (
          <>
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                alignItems: 'center',
                gap: '0.75rem',
                background: '#f8fafc',
                border: '1px solid #d1d5db',
                borderRadius: '12px',
                padding: '1rem',
                marginBottom: '1rem',
              }}
            >
              <button
                type="button"
                onClick={() => {
                  setError('');
                  setStep(1);
                }}
                style={{
                  border: 'none',
                  background: 'transparent',
                  color: 'var(--color-accent)',
                  padding: 0,
                  cursor: 'pointer',
                  fontWeight: 600,
                }}
              >
                ← Edit
              </button>
              <span style={{ fontWeight: 700 }}>{form.title || 'Untitled campaign'}</span>
              <span style={{ color: 'var(--color-text-muted)' }}>
                Goal: {form.target_amount || '—'} {form.asset_type || ''}
              </span>
            </div>
            <div className="form-stack">
              <label className="label-strong" htmlFor="cc-desc">
                {t('createCampaign.description')}{' '}
                <span style={{ fontWeight: 500, color: 'var(--color-text-muted)' }}>
                  {t('createCampaign.optional')}
                </span>
              </label>
              <SimpleMDE
                id="cc-desc"
                value={form.description}
                onChange={setDescription}
                options={{
                  spellChecker: false,
                  placeholder: t('createCampaign.descriptionPlaceholder'),
                }}
              />
            </div>

            <div className="form-stack" style={{ marginTop: '1rem' }}>
              <label className="label-strong" htmlFor="cc-cover">
                {t('createCampaign.coverImage')}{' '}
                <span style={{ fontWeight: 500, color: 'var(--color-text-muted)' }}>
                  {t('createCampaign.optional')}
                </span>
              </label>
              <div
                onDragOver={(e) => {
                  e.preventDefault();
                  setIsDragOverCover(true);
                }}
                onDragLeave={() => setIsDragOverCover(false)}
                onDrop={handleCoverImageDrop}
                style={{
                  border: `2px dashed ${isDragOverCover ? '#7c3aed' : '#d4d4d8'}`,
                  borderRadius: '12px',
                  padding: '0.9rem',
                  background: isDragOverCover ? '#f5f3ff' : '#fafafa',
                }}
              >
                <input
                  id="cc-cover"
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  onChange={handleCoverImageChange}
                />
                <p
                  style={{
                    marginTop: '0.45rem',
                    marginBottom: 0,
                    color: '#666',
                    fontSize: '0.8rem',
                  }}
                >
                  {t('createCampaign.coverImageHelp')}
                </p>
              </div>
              {coverImagePreview && (
                <img
                  src={coverImagePreview}
                  alt="Cover preview"
                  style={{
                    marginTop: '0.75rem',
                    width: '100%',
                    borderRadius: '12px',
                    maxHeight: '220px',
                    objectFit: 'cover',
                  }}
                />
              )}
            </div>

            <div className="form-stack" style={{ marginTop: '1rem' }}>
              <label className="label-strong" htmlFor="cc-deadline">
                {t('createCampaign.deadline')}{' '}
                <span style={{ fontWeight: 500, color: 'var(--color-text-muted)' }}>
                  {t('createCampaign.optional')}
                </span>
              </label>
              <input
                id="cc-deadline"
                type="date"
                min={today}
                value={form.deadline}
                onChange={setField('deadline')}
              />
            </div>

            <div
              className="form-stack"
              style={{
                marginTop: '1.25rem',
                flexDirection: 'row',
                alignItems: 'center',
                gap: '0.5rem',
              }}
            >
              <input
                id="cc-show-backers"
                type="checkbox"
                style={{ width: 'auto', margin: 0 }}
                checked={form.show_backer_amounts}
                onChange={(e) => setForm((f) => ({ ...f, show_backer_amounts: e.target.checked }))}
              />
              <label
                htmlFor="cc-show-backers"
                style={{ fontWeight: 600, fontSize: '0.9rem', cursor: 'pointer' }}
              >
                {t('createCampaign.showAmounts')}
              </label>
            </div>
            <p
              style={{ fontSize: '0.8rem', color: 'var(--color-text-hint)', marginTop: '0.35rem' }}
            >
              {t('createCampaign.showAmountsHelp')}
            </p>

            <details style={{ marginTop: '1rem' }}>
              <summary style={{ cursor: 'pointer', fontWeight: 600, fontSize: '0.9rem' }}>
                Contribution limits (optional)
              </summary>
              <div
                style={{
                  marginTop: '0.75rem',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: '0.75rem',
                }}
              >
                <div className="form-stack">
                  <label htmlFor="cc-min">Minimum per contribution ({form.asset_type})</label>
                  <input
                    id="cc-min"
                    type="number"
                    min="0"
                    step="any"
                    value={form.min_contribution}
                    onChange={setField('min_contribution')}
                    placeholder="No minimum"
                  />
                </div>
                <div className="form-stack">
                  <label htmlFor="cc-max">Maximum per contribution ({form.asset_type})</label>
                  <input
                    id="cc-max"
                    type="number"
                    min="0"
                    step="any"
                    value={form.max_contribution}
                    onChange={setField('max_contribution')}
                    placeholder="No maximum"
                  />
                </div>
                <div className="form-stack">
                  <label htmlFor="cc-maxuser">Per-contributor cap ({form.asset_type})</label>
                  <input
                    id="cc-maxuser"
                    type="number"
                    min="0"
                    step="any"
                    value={form.max_per_user}
                    onChange={setField('max_per_user')}
                    placeholder="No cap"
                  />
                </div>
              </div>
            </details>

            {error && (
              <p className="alert alert--error" style={{ marginTop: '1rem' }} role="alert">
                {error}
              </p>
            )}

            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '0.65rem',
                marginTop: '1.25rem',
              }}
            >
              <button
                type="button"
                className="btn-primary"
                style={{ width: '100%' }}
                onClick={() => {
                  if (validateStep2()) setStep(3);
                }}
              >
                {t('createCampaign.continueToMilestones')}
              </button>
              <button
                type="button"
                className="btn-secondary"
                style={{ width: '100%' }}
                onClick={() => {
                  setError('');
                  setStep(1);
                }}
              >
                {t('createCampaign.back')}
              </button>
            </div>
          </>
        )}

        {step === 3 && (
          <>
            <div className="campaign-card" style={{ marginBottom: '1rem' }}>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: '0.75rem',
                  flexWrap: 'wrap',
                  marginBottom: '0.5rem',
                }}
              >
                <strong>{t('createCampaign.milestonePlan')}</strong>
                <span
                  style={{
                    fontSize: '0.85rem',
                    color:
                      milestoneTotal === 100 || form.milestones.length === 0
                        ? 'var(--color-success-text)'
                        : 'var(--color-warning-text)',
                  }}
                >
                  {t('createCampaign.milestoneTotal', { count: milestoneTotal.toLocaleString() })}
                </span>
              </div>
              <p
                style={{
                  color: 'var(--color-text-secondary)',
                  fontSize: '0.88rem',
                  lineHeight: 1.5,
                }}
              >
                {t('createCampaign.milestoneHelp')}
              </p>
            </div>

            {form.milestones.length === 0 ? (
              <div className="alert alert--info" style={{ marginBottom: '1rem' }}>
                {t('createCampaign.noMilestones')}
              </div>
            ) : (
              <div style={{ display: 'grid', gap: '0.85rem' }}>
                {form.milestones.map((milestone, index) => (
                  <div key={index} className="campaign-card">
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        gap: '0.75rem',
                        alignItems: 'center',
                        marginBottom: '0.5rem',
                      }}
                    >
                      <strong>{t('createCampaign.milestone', { count: index + 1 })}</strong>
                      <button
                        type="button"
                        className="btn-secondary"
                        onClick={() => removeMilestone(index)}
                        style={{ fontSize: '0.8rem' }}
                      >
                        Remove
                      </button>
                    </div>
                    <div className="form-stack">
                      <label className="label-strong">{t('createCampaign.milestoneTitle')}</label>
                      <input
                        value={milestone.title}
                        onChange={(e) => setMilestoneField(index, 'title', e.target.value)}
                        placeholder="e.g. Deliver prototype"
                      />
                    </div>
                    <div className="form-stack" style={{ marginTop: '0.75rem' }}>
                      <label className="label-strong">
                        {t('createCampaign.milestoneDescription')}
                      </label>
                      <textarea
                        value={milestone.description}
                        onChange={(e) => setMilestoneField(index, 'description', e.target.value)}
                        rows={3}
                        placeholder="Explain what contributors should expect before this release unlocks."
                      />
                    </div>
                    <div className="form-stack" style={{ marginTop: '0.75rem' }}>
                      <label className="label-strong">{t('createCampaign.milestoneRelease')}</label>
                      <input
                        type="number"
                        inputMode="decimal"
                        min="0.01"
                        step="0.01"
                        value={milestone.release_percentage}
                        onChange={(e) =>
                          setMilestoneField(index, 'release_percentage', e.target.value)
                        }
                        placeholder="25"
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}

            {form.milestones.length < 5 && (
              <button
                type="button"
                className="btn-secondary"
                style={{ width: '100%', marginTop: '1rem' }}
                onClick={addMilestone}
              >
                {t('createCampaign.addMilestone')}
              </button>
            )}

            <div className="alert alert--info" style={{ marginTop: '1.25rem' }} role="status">
              <strong>{t('createCampaign.launchSummary')}</strong> {form.title || 'Untitled'} with a
              goal of {form.target_amount || '—'} {form.asset_type}
              {form.min_contribution && ` (Min: ${form.min_contribution} ${form.asset_type})`}
              {form.max_contribution && ` (Max: ${form.max_contribution} ${form.asset_type})`}
              {form.max_per_user && ` (Cap: ${form.max_per_user} ${form.asset_type})`}
              {form.milestones.length
                ? ` and ${form.milestones.length} milestone release${form.milestones.length > 1 ? 's' : ''}.`
                : ' and no milestone plan.'}
            </div>

            {error && (
              <p className="alert alert--error" style={{ marginTop: '1rem' }} role="alert">
                {error}
              </p>
            )}

            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: '0.65rem',
                marginTop: '1.25rem',
              }}
            >
              <button
                type="submit"
                className="btn-primary"
                disabled={loading}
                style={{ width: '100%' }}
              >
                {loading ? t('createCampaign.creatingWallet') : t('createCampaign.launchCampaign')}
              </button>
              <button
                type="button"
                className="btn-secondary"
                style={{ width: '100%' }}
                disabled={loading}
                onClick={() => {
                  setError('');
                  setStep(2);
                }}
              >
                Back
              </button>
            </div>
          </>
        )}
      </form>

      <p style={{ marginTop: '1.5rem', fontSize: '0.85rem', color: 'var(--color-text-hint)' }}>
        <Link to="/" style={{ color: 'var(--color-accent)', fontWeight: 600 }}>
          {t('createCampaign.backToCampaigns')}
        </Link>
      </p>
    </main>
  );
}
