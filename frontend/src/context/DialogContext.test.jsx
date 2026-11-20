import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DialogProvider, useDialog } from './DialogContext';

function TestBed({ onResult }) {
  const dialog = useDialog();
  return (
    <div>
      <button
        type="button"
        onClick={async () => {
          const ok = await dialog.confirm({
            title: 'Release funds?',
            message: 'This is irreversible.',
            summary: [{ label: 'Amount', value: '100 XLM' }],
            danger: true,
            confirmLabel: 'Approve & submit',
            cancelLabel: 'Back',
          });
          onResult(ok);
        }}
      >
        Trigger
      </button>
    </div>
  );
}

describe('DialogContext confirm', () => {
  it('resolves true when the user confirms', async () => {
    const user = userEvent.setup();
    const onResult = vi.fn();
    render(
      <DialogProvider>
        <TestBed onResult={onResult} />
      </DialogProvider>
    );

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Trigger' }));

    const dialogEl = screen.getByRole('dialog');
    expect(dialogEl).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByText('This is irreversible.')).toBeInTheDocument();
    expect(screen.getByText('100 XLM')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Approve & submit' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(onResult).toHaveBeenCalledWith(true);
  });

  it('resolves false when the user cancels', async () => {
    const user = userEvent.setup();
    const onResult = vi.fn();
    render(
      <DialogProvider>
        <TestBed onResult={onResult} />
      </DialogProvider>
    );

    await user.click(screen.getByRole('button', { name: 'Trigger' }));
    await user.click(screen.getByRole('button', { name: 'Back' }));

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(onResult).toHaveBeenCalledWith(false);
  });

  it('resolves false and closes on Escape', async () => {
    const user = userEvent.setup();
    const onResult = vi.fn();
    render(
      <DialogProvider>
        <TestBed onResult={onResult} />
      </DialogProvider>
    );

    await user.click(screen.getByRole('button', { name: 'Trigger' }));
    await user.keyboard('{Escape}');

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(onResult).toHaveBeenCalledWith(false);
  });
});
