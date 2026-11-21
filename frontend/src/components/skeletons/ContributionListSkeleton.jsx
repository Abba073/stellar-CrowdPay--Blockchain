import React from 'react';

export default function ContributionListSkeleton({ rows = 4 }) {
  const widths = [78, 62, 71, 55, 68];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }} aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <div
          key={i}
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            background: 'var(--color-bg)',
            border: '1px solid var(--color-border-lighter)',
            borderRadius: '6px',
            padding: '0.6rem 0.85rem',
            alignItems: 'center',
          }}
        >
          <div>
            <div
              className="skeleton"
              style={{
                height: '13px',
                width: `${widths[i % widths.length]}px`,
                marginBottom: '0.25rem',
              }}
            />
            <div
              className="skeleton"
              style={{ height: '11px', width: `${widths[(i + 2) % widths.length] - 10}px` }}
            />
          </div>
          <div
            className="skeleton"
            style={{ height: '13px', width: '52px', flexShrink: 0, marginLeft: '1rem' }}
          />
        </div>
      ))}
    </div>
  );
}
