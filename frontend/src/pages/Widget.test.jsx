import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import Widget from './Widget';

const fetchMock = vi.fn();

function renderWidget() {
  return render(
    <MemoryRouter initialEntries={['/embed/campaigns/7']}>
      <Routes>
        <Route path="/embed/campaigns/:id" element={<Widget />} />
      </Routes>
    </MemoryRouter>
  );
}

const campaignPayload = {
  id: 7,
  title: 'Community Garden',
  raised_amount: '1500',
  target_amount: '3000',
  asset_type: 'USDC',
  contributor_count: 42,
};

describe('Widget', () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    document.dispatchEvent(new Event('visibilitychange'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('renders nothing while the campaign is loading', () => {
    fetchMock.mockImplementation(() => new Promise(() => {}));
    const { container } = renderWidget();
    expect(container).toBeEmptyDOMElement();
  });

  it('fetches and renders campaign fundraising progress', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => campaignPayload,
    });
    renderWidget();

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/api/campaigns/7/widget'),
        expect.objectContaining({ signal: expect.anything() })
      );
    });

    expect(await screen.findByText('Community Garden')).toBeInTheDocument();
    expect(screen.getByText(/1,500 USDC raised/i)).toBeInTheDocument();
    expect(screen.getByText(/42 contributors/i)).toBeInTheDocument();
    expect(screen.getByText('50.0%')).toBeInTheDocument();
  });

  it('shows an error when the campaign cannot be found', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404 });
    renderWidget();

    expect(await screen.findByText('Campaign not found')).toBeInTheDocument();
  });

  it('shows a generic error for non-404 failures', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 });
    renderWidget();

    expect(await screen.findByText('Could not load campaign')).toBeInTheDocument();
  });

  it('links back to the campaign page', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => campaignPayload });
    renderWidget();

    const link = await screen.findByRole('link', { name: /fund on crowdpay/i });
    expect(link).toHaveAttribute('href', expect.stringContaining('/campaigns/7'));
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('handles singular contributor counts', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ ...campaignPayload, contributor_count: 1 }),
    });
    renderWidget();

    expect(await screen.findByText(/1 contributor(?!s)/i)).toBeInTheDocument();
  });

  it('polls for updates on an interval while the document is visible', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => campaignPayload });
    renderWidget();

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not poll while the document is hidden', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => campaignPayload });
    renderWidget();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  });

  it('reloads immediately when the document becomes visible again', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => campaignPayload });
    renderWidget();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
