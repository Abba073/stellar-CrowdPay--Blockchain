import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import DisputeModal from './DisputeModal';
import { api } from '../services/api';

vi.mock('../services/api', () => ({
  api: { raiseDispute: vi.fn() },
}));

const campaign = { id: 'camp-1', title: 'Solar Roofs' };
const onClose = vi.fn();
const onSubmitted = vi.fn();

function renderModal() {
  return render(<DisputeModal campaign={campaign} onClose={onClose} onSubmitted={onSubmitted} />);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('DisputeModal', () => {
  it('raises a dispute with trimmed fields and closes', async () => {
    api.raiseDispute.mockResolvedValue({ id: 'd1' });
    const user = userEvent.setup();
    renderModal();
    await user.selectOptions(screen.getByRole('combobox'), 'abandoned');
    await user.type(screen.getAllByRole('textbox')[0], '  Creator went silent  ');
    await user.click(screen.getByRole('button', { name: /submit/i }));
    await waitFor(() =>
      expect(api.raiseDispute).toHaveBeenCalledWith('camp-1', {
        reason: 'abandoned',
        description: 'Creator went silent',
        evidence_url: undefined,
      })
    );
    expect(api.raiseDispute.mock.calls[0]).toHaveLength(2);
    expect(onSubmitted).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('keeps the modal open and shows the API error on failure', async () => {
    api.raiseDispute.mockRejectedValue(new Error('You have already raised a dispute'));
    const user = userEvent.setup();
    renderModal();
    await user.type(screen.getAllByRole('textbox')[0], 'Not delivered');
    await user.click(screen.getByRole('button', { name: /submit/i }));
    expect(await screen.findByText('You have already raised a dispute')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
    expect(onSubmitted).not.toHaveBeenCalled();
  });
});
