import React from 'react';
import { Link, useNavigate } from 'react-router-dom';

export default function NotFound() {
  const navigate = useNavigate();

  const handleGoBack = () => {
    navigate(-1);
  };

  return (
    <main
      className="container page-narrow"
      style={{ paddingTop: '4rem', paddingBottom: '4rem', textAlign: 'center' }}
    >
      <div style={styles.code}>404</div>
      <h1 style={styles.heading}>Page not found</h1>
      <p style={styles.sub}>The page you're looking for doesn't exist or has been moved.</p>
      <div style={styles.suggestions}>
        <p style={styles.suggestionsTitle}>You might be looking for:</p>
        <div style={styles.suggestionsList}>
          <Link to="/" style={styles.suggestionLink}>
            Home
          </Link>
          <span style={styles.separator}>•</span>
          <Link to="/campaigns/new" style={styles.suggestionLink}>
            Create a campaign
          </Link>
          <span style={styles.separator}>•</span>
          <Link to="/dashboard" style={styles.suggestionLink}>
            Dashboard
          </Link>
        </div>
      </div>
      <div style={styles.actions}>
        <button type="button" className="btn-primary" onClick={handleGoBack}>
          ← Go back
        </button>
        <Link to="/">
          <button type="button" className="btn-secondary">
            Back to home
          </button>
        </Link>
      </div>
    </main>
  );
}

const styles = {
  code: {
    fontSize: '5rem',
    fontWeight: 800,
    color: 'var(--color-accent-lighter)',
    lineHeight: 1,
    marginBottom: '0.5rem',
  },
  heading: {
    fontSize: '1.5rem',
    fontWeight: 700,
    color: 'var(--color-text-primary)',
    marginBottom: '0.75rem',
  },
  sub: {
    color: 'var(--color-text-hint)',
    fontSize: '1rem',
    lineHeight: 1.55,
    marginBottom: '1.5rem',
  },
  suggestions: {
    marginBottom: '2rem',
    padding: '1rem',
    backgroundColor: 'var(--color-bg-secondary)',
    borderRadius: '8px',
  },
  suggestionsTitle: {
    fontSize: '0.9rem',
    fontWeight: 600,
    color: 'var(--color-text-primary)',
    marginBottom: '0.5rem',
  },
  suggestionsList: {
    display: 'flex',
    gap: '0.5rem',
    justifyContent: 'center',
    alignItems: 'center',
    flexWrap: 'wrap',
  },
  suggestionLink: {
    color: 'var(--color-accent)',
    textDecoration: 'none',
    fontSize: '0.9rem',
  },
  separator: { color: 'var(--color-text-hint)' },
  actions: {
    display: 'flex',
    gap: '0.75rem',
    justifyContent: 'center',
    flexWrap: 'wrap',
  },
};
