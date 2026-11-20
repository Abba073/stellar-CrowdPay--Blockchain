import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import React, { useEffect } from 'react';
import { ToastProvider, useToast } from './ToastContext';

function Trigger({ tick }) {
  const show = useToast();
  useEffect(() => {
    show('Saved');
  }, [show]);
  return <span>{tick}</span>;
}

describe('ToastProvider', () => {
  afterEach(() => vi.useRealTimers());

  it('dismisses after 4s even when the provider re-renders', () => {
    vi.useFakeTimers();
    const { rerender } = render(
      <ToastProvider>
        <Trigger tick={0} />
      </ToastProvider>
    );
    expect(screen.getByText('Saved')).toBeInTheDocument();

    act(() => vi.advanceTimersByTime(3000));
    rerender(
      <ToastProvider>
        <Trigger tick={1} />
      </ToastProvider>
    );
    act(() => vi.advanceTimersByTime(1000));

    expect(screen.queryByText('Saved')).not.toBeInTheDocument();
  });
});
