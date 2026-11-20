import React from 'react';

export default function CampaignDetailSkeleton() {
  return (
    <main
      className="container"
      style={{ paddingTop: '2.5rem', paddingBottom: '4rem', maxWidth: '760px' }}
      aria-hidden="true"
    >
      {/* Header */}
      <div style={{ marginBottom: '1.5rem' }}>
        <div
          className="skeleton"
          style={{ width: '48px', height: '20px', borderRadius: '99px', marginBottom: '0.6rem' }}
        />
        <div
          className="skeleton"
          style={{ height: '32px', width: '65%', marginBottom: '0.6rem' }}
        />
        <div
          className="skeleton"
          style={{ height: '16px', width: '100%', marginBottom: '0.3rem' }}
        />
        <div className="skeleton" style={{ height: '16px', width: '80%' }} />
      </div>

      {/* Progress card */}
      <div
        style={{
          background: 'var(--color-bg)',
          border: '1px solid var(--color-border-light)',
          borderRadius: '10px',
          padding: '1.5rem',
          marginBottom: '1rem',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '1rem' }}>
          <div>
            <div
              className="skeleton"
              style={{ height: '28px', width: '120px', marginBottom: '0.4rem' }}
            />
            <div className="skeleton" style={{ height: '14px', width: '90px' }} />
          </div>
          <div style={{ textAlign: 'right' }}>
            <div
              className="skeleton"
              style={{ height: '28px', width: '60px', marginBottom: '0.4rem' }}
            />
            <div className="skeleton" style={{ height: '14px', width: '44px' }} />
          </div>
        </div>
        <div
          className="skeleton"
          style={{ height: '8px', borderRadius: '99px', marginBottom: '1.25rem' }}
        />
        <div className="skeleton" style={{ height: '44px', borderRadius: '6px' }} />
      </div>

      {/* Wallet info */}
      <div
        style={{
          background: 'var(--color-surface)',
          borderRadius: '8px',
          padding: '0.75rem 1rem',
          marginBottom: '1.75rem',
        }}
      >
        <div
          className="skeleton"
          style={{ height: '11px', width: '100px', marginBottom: '0.4rem' }}
        />
        <div className="skeleton" style={{ height: '14px', width: '85%' }} />
      </div>

      {/* Contributions section */}
      <div
        className="skeleton"
        style={{ height: '20px', width: '160px', marginBottom: '0.75rem' }}
      />
      <ContributionListSkeleton />
    </main>
  );
}

function ContributionListSkeleton() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
      {[80, 65, 72].map((w, i) => (
        <div
          key={i}
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            background: 'var(--color-bg)',
            border: '1px solid var(--color-border-lighter)',
            borderRadius: '6px',
            padding: '0.6rem 0.85rem',
          }}
        >
          <div className="skeleton" style={{ height: '14px', width: `${w}%` }} />
          <div
            className="skeleton"
            style={{ height: '14px', width: '50px', flexShrink: 0, marginLeft: '1rem' }}
          />
        </div>
      ))}
    </div>
  );
}
