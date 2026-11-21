import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { useRelativeTime } from '../hooks/useRelativeTime';
import RelativeTime from '../components/RelativeTime';

// Helper component to test useRelativeTime hook
function HookTestComponent({ date }) {
  const label = useRelativeTime(date);
  return <span data-testid="hook-label">{label}</span>;
}

describe('useRelativeTime Hook & RelativeTime Component', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders relative time for recent events', () => {
    const now = Date.now();
    vi.setSystemTime(now);

    // 10 seconds ago
    const tenSecsAgo = new Date(now - 10000).toISOString();
    render(<RelativeTime date={tenSecsAgo} />);

    const el = screen.getByRole('time');
    expect(el).toBeInTheDocument();

    const expected = new Intl.RelativeTimeFormat('en', { numeric: 'auto' }).format(-10, 'second');
    expect(el.textContent).toBe(expected);
    expect(el.getAttribute('title')).toBe(new Date(tenSecsAgo).toLocaleString());
  });

  it('renders relative time in minutes/hours/days', () => {
    const now = Date.now();
    vi.setSystemTime(now);

    // 5 minutes ago
    const fiveMinAgo = new Date(now - 5 * 60 * 1000).toISOString();
    const { rerender } = render(<RelativeTime date={fiveMinAgo} />);

    const expectedMin = new Intl.RelativeTimeFormat('en', { numeric: 'auto' }).format(-5, 'minute');
    expect(screen.getByRole('time').textContent).toBe(expectedMin);

    // 3 hours ago
    const threeHoursAgo = new Date(now - 3 * 3600 * 1000).toISOString();
    rerender(<RelativeTime date={threeHoursAgo} />);

    const expectedHour = new Intl.RelativeTimeFormat('en', { numeric: 'auto' }).format(-3, 'hour');
    expect(screen.getByRole('time').textContent).toBe(expectedHour);

    // 2 days ago
    const twoDaysAgo = new Date(now - 2 * 24 * 3600 * 1000).toISOString();
    rerender(<RelativeTime date={twoDaysAgo} />);

    const expectedDay = new Intl.RelativeTimeFormat('en', { numeric: 'auto' }).format(-2, 'day');
    expect(screen.getByRole('time').textContent).toBe(expectedDay);
  });

  it('falls back to absolute short date for events older than 7 days', () => {
    const now = Date.now();
    vi.setSystemTime(now);

    // 8 days ago
    const eightDaysAgo = new Date(now - 8 * 24 * 3600 * 1000).toISOString();
    render(<RelativeTime date={eightDaysAgo} />);
    const el = screen.getByRole('time');
    expect(el.textContent).toBe(
      new Date(eightDaysAgo).toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      })
    );
  });

  it('updates the time label automatically every 30 seconds', () => {
    const now = Date.now();
    vi.setSystemTime(now);

    const date = new Date(now).toISOString();
    render(<RelativeTime date={date} />);
    const el = screen.getByRole('time');

    const expectedNow = new Intl.RelativeTimeFormat('en', { numeric: 'auto' }).format(0, 'second');
    expect(el.textContent).toBe(expectedNow);

    // Advance time by 30 seconds
    act(() => {
      vi.advanceTimersByTime(30000);
    });

    const expected30sAgo = new Intl.RelativeTimeFormat('en', { numeric: 'auto' }).format(
      -30,
      'second'
    );
    expect(el.textContent).toBe(expected30sAgo);
  });

  it('shares a single interval across multiple instances', () => {
    const now = Date.now();
    vi.setSystemTime(now);
    const date = new Date(now - 10000).toISOString();

    const { unmount } = render(
      <div>
        <RelativeTime date={date} />
        <RelativeTime date={date} />
        <RelativeTime date={date} />
      </div>
    );

    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('handles invalid or empty dates gracefully', () => {
    const { container: container1 } = render(<RelativeTime date="" />);
    expect(container1.firstChild).toBeNull();

    const { container: container2 } = render(<RelativeTime date="invalid-date" />);
    expect(container2.firstChild).toBeNull();
  });
});
