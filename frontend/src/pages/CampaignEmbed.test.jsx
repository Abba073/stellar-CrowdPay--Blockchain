import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import CampaignEmbed from './CampaignEmbed';

const fetchMock = vi.fn();
const eventSourceInstances = [];

class MockEventSource {
  constructor(url) {
    this.url = url;
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.closed = false;
    eventSourceInstances.push(this);
  }
  close() {
    this.closed = true;
  }
}

const campaignPayload = {
  id: 7,
  title: 'Community Garden',
  description: 'Rebuild the neighborhood garden.',
  raised_amount: '1500',
  target_amount: '3000',
  asset_type: 'USDC',
  progress_percentage: 50,
  backer_count: 42,
  contribution_url: 'https://crowdpay.example.com/campaigns/7/contribute',
};

function setPath(pathname) {
  window.history.pushState({}, '', pathname);
}

describe('CampaignEmbed', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('EventSource', MockEventSource);
    fetchMock.mockReset();
    eventSourceInstances.length = 0;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setPath('/');
  });

  it('renders a skeleton while loading', () => {
    fetchMock.mockImplementation(() => new Promise(() => {}));
    setPath('/embed/campaigns/7');
    const { container } = render(<CampaignEmbed />);
    expect(container.querySelector('div')).toBeInTheDocument();
    expect(screen.queryByText('Community Garden')).not.toBeInTheDocument();
  });

  it('fetches and renders the campaign embed', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => campaignPayload });
    setPath('/embed/campaigns/7');
    render(<CampaignEmbed />);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(expect.stringContaining('/api/campaigns/7/embed'));
    });

    expect(await screen.findByText('Community Garden')).toBeInTheDocument();
    expect(screen.getByText('Rebuild the neighborhood garden.')).toBeInTheDocument();
    expect(screen.getByText('1,500')).toBeInTheDocument();
    expect(screen.getByText('USDC')).toBeInTheDocument();
    expect(screen.getByText('50.0%')).toBeInTheDocument();
    expect(screen.getByText(/42 backers/i)).toBeInTheDocument();
    expect(screen.getByText(/Goal: 3,000 USDC/i)).toBeInTheDocument();
  });

  it('shows an error when the campaign is not found', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404 });
    setPath('/embed/campaigns/999');
    render(<CampaignEmbed />);
    expect(await screen.findByText('Campaign not found')).toBeInTheDocument();
  });

  it('shows an error when the campaign id is missing from the path', () => {
    setPath('/embed/campaigns/');
    render(<CampaignEmbed />);
    expect(screen.getByText('Invalid campaign ID')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('links to the contribution page', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => campaignPayload });
    setPath('/embed/campaigns/7');
    render(<CampaignEmbed />);

    const cta = await screen.findByRole('link', { name: /back this campaign/i });
    expect(cta).toHaveAttribute('href', campaignPayload.contribution_url);
    expect(cta).toHaveAttribute('target', '_blank');
  });

  it('connects to the event stream and shows the live indicator', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => campaignPayload });
    setPath('/embed/campaigns/7');
    render(<CampaignEmbed />);

    await screen.findByText('Community Garden');
    await waitFor(() => {
      expect(eventSourceInstances.length).toBe(1);
    });
    const es = eventSourceInstances[0];
    expect(es.url).toContain('/api/campaigns/7/stream');

    act(() => es.onopen?.());
    expect(await screen.findByTitle('Live updates active')).toBeInTheDocument();
  });

  it('applies live contribution updates to the raised amount', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => campaignPayload });
    setPath('/embed/campaigns/7');
    render(<CampaignEmbed />);

    await screen.findByText('Community Garden');
    const es = await vi.waitFor(() => {
      expect(eventSourceInstances.length).toBe(1);
      return eventSourceInstances[0];
    });

    act(() => {
      es.onmessage?.({ data: JSON.stringify({ type: 'contribution', raised_amount: '2250' }) });
    });

    expect(await screen.findByText('2,250')).toBeInTheDocument();
  });

  it('ignores malformed stream messages', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => campaignPayload });
    setPath('/embed/campaigns/7');
    render(<CampaignEmbed />);

    await screen.findByText('Community Garden');
    const es = await vi.waitFor(() => {
      expect(eventSourceInstances.length).toBe(1);
      return eventSourceInstances[0];
    });

    act(() => {
      es.onopen?.();
      es.onmessage?.({ data: 'not-json' });
    });

    expect(screen.getByTitle('Live updates active')).toBeInTheDocument();
    expect(screen.getByText('1,500')).toBeInTheDocument();
  });

  it('closes the stream and hides the live indicator on error', async () => {
    fetchMock.mockResolvedValue({ ok: true, json: async () => campaignPayload });
    setPath('/embed/campaigns/7');
    render(<CampaignEmbed />);

    await screen.findByText('Community Garden');
    const es = await vi.waitFor(() => {
      expect(eventSourceInstances.length).toBe(1);
      return eventSourceInstances[0];
    });

    act(() => es.onopen?.());
    expect(screen.getByTitle('Live updates active')).toBeInTheDocument();

    act(() => es.onerror?.());
    expect(screen.queryByTitle('Live updates active')).not.toBeInTheDocument();
    expect(es.closed).toBe(true);
  });

  it('does not connect to the stream when EventSource is unavailable', async () => {
    vi.stubGlobal('EventSource', undefined);
    fetchMock.mockResolvedValue({ ok: true, json: async () => campaignPayload });
    setPath('/embed/campaigns/7');
    render(<CampaignEmbed />);

    expect(await screen.findByText('Community Garden')).toBeInTheDocument();
    expect(eventSourceInstances.length).toBe(0);
  });
});
