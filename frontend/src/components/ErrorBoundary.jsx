import React from 'react';

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error, info) {
    console.error('[ErrorBoundary] Uncaught error:', error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      return (
        <main style={styles.wrapper}>
          <div style={styles.box}>
            <h1 style={styles.heading}>Something went wrong</h1>
            <p style={styles.sub}>
              An unexpected error occurred. Your data is safe — try reloading the page.
            </p>
            <button type="button" className="btn-primary" onClick={() => window.location.reload()}>
              Reload page
            </button>
          </div>
        </main>
      );
    }

    return this.props.children;
  }
}

const styles = {
  wrapper: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: '60vh',
    padding: '2rem 1.25rem',
  },
  box: { maxWidth: '420px', textAlign: 'center' },
  heading: {
    fontSize: '1.4rem',
    fontWeight: 700,
    color: 'var(--color-text-primary)',
    marginBottom: '0.75rem',
  },
  sub: {
    color: 'var(--color-text-hint)',
    fontSize: '0.95rem',
    lineHeight: 1.55,
    marginBottom: '1.5rem',
  },
};
