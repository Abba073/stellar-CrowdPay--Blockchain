import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Home from './Home';

vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ user: null }) }));
vi.mock('../components/CampaignCard', () => ({
  default: ({ campaign }) => <div data-testid="campaign">{campaign.title}</div>,
}));
vi.mock('../services/api', () => ({
  api: {
    getCampaigns: vi.fn(),
    getCampaignCategories: vi.fn(() => Promise.resolve([])),
    getFeaturedCampaigns: vi.fn(() => Promise.resolve([])),
  },
}));

import { api } from '../services/api';

function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

describe('Home campaign fetching', () => {
  it('ignores stale responses that resolve after a newer filter', async () => {
    const first = deferred();
    const second = deferred();
    api.getCampaigns.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    render(
      <MemoryRouter>
        <Home />
      </MemoryRouter>
    );

    const sortButtons = document.querySelectorAll('button.pill');
    fireEvent.click(sortButtons[0]);
    expect(api.getCampaigns).toHaveBeenCalledTimes(2);

    await act(async () => {
      second.resolve({ campaigns: [{ id: 2, title: 'Fresh result' }], total: 1 });
    });
    await act(async () => {
      first.resolve({ campaigns: [{ id: 1, title: 'Stale result' }], total: 1 });
    });

    expect(screen.getByText('Fresh result')).toBeInTheDocument();
    expect(screen.queryByText('Stale result')).not.toBeInTheDocument();
  });
});
