import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import Developer from './Developer';

const api = {
  listApiKeys: vi.fn(),
  listWebhooks: vi.fn(),
  listWebhookDeliveries: vi.fn(),
  createApiKey: vi.fn(),
  deleteApiKey: vi.fn(),
  createWebhook: vi.fn(),
  deleteWebhook: vi.fn(),
};

const authState = { user: { id: '1', name: 'Dev', email: 'dev@example.com', role: 'creator' } };

vi.mock('../services/api', () => ({ api }));
vi.mock('../context/AuthContext', () => ({ useAuth: () => authState }));

const confirmSpy = vi.spyOn(window, 'confirm');

const KEYS = [
  {
    id: 'k1',
    label: 'Backend',
    key_prefix: 'cpk_live_12',
    scopes: ['read', 'write'],
    revoked_at: null,
    last_used_at: null,
  },
  {
    id: 'k2',
    label: 'Old',
    key_prefix: 'cpk_live_99',
    scopes: ['read'],
    revoked_at: '2024-01-01',
    last_used_at: null,
  },
];
const HOOKS = [
  {
    id: 'h1',
    url: 'https://example.com/hook',
    events: ['contribution.received'],
    secret_hint: 'sec_***',
    revoked_at: null,
  },
  {
    id: 'h2',
    url: 'https://old.example.com',
    events: [],
    secret_hint: 'sec_***',
    revoked_at: '2024-01-01',
  },
];
const DELIVERIES = [
  {
    id: 'd1',
    created_at: '2024-06-01T10:00:00Z',
    event_type: 'contribution.received',
    status: 'success',
    response_status: 200,
    attempt_count: 1,
    last_error: null,
  },
];

function mockInitialData() {
  api.listApiKeys.mockResolvedValue(KEYS);
  api.listWebhooks.mockResolvedValue(HOOKS);
  api.listWebhookDeliveries.mockResolvedValue(DELIVERIES);
}

describe('Developer', () => {
  beforeEach(() => {
    api.listApiKeys.mockReset().mockResolvedValue([]);
    api.listWebhooks.mockReset().mockResolvedValue([]);
    api.listWebhookDeliveries.mockReset().mockResolvedValue([]);
    api.createApiKey.mockReset();
    api.deleteApiKey.mockReset();
    api.createWebhook.mockReset();
    api.deleteWebhook.mockReset();
    confirmSpy.mockReset().mockReturnValue(true);
    authState.user = { id: '1', name: 'Dev', email: 'dev@example.com', role: 'creator' };
  });

  it('prompts to log in when there is no user', async () => {
    authState.user = null;
    render(
      <MemoryRouter>
        <Developer />
      </MemoryRouter>
    );
    expect(await screen.findByText(/log in/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /log in/i })).toHaveAttribute('href', '/login');
    expect(api.listApiKeys).not.toHaveBeenCalled();
  });

  it('loads and lists active API keys', async () => {
    mockInitialData();
    render(
      <MemoryRouter>
        <Developer />
      </MemoryRouter>
    );

    expect(await screen.findByText('Backend')).toBeInTheDocument();
    expect(screen.getByText('cpk_live_12')).toBeInTheDocument();
    expect(screen.getByText('read, write')).toBeInTheDocument();
    expect(screen.queryByText('Old')).not.toBeInTheDocument();
  });

  it('loads and lists active webhooks and the delivery log', async () => {
    mockInitialData();
    render(
      <MemoryRouter>
        <Developer />
      </MemoryRouter>
    );

    expect(await screen.findByText('https://example.com/hook')).toBeInTheDocument();
    expect(screen.getByText('contribution.received · sec_***')).toBeInTheDocument();
    expect(screen.queryByText('https://old.example.com')).not.toBeInTheDocument();
    expect(await screen.findByText('Webhook delivery log')).toBeInTheDocument();
    expect(screen.getByText('contribution.received', { selector: 'td' })).toBeInTheDocument();
  });

  it('shows an error message when loading fails', async () => {
    api.listApiKeys.mockRejectedValue(new Error('boom'));
    render(
      <MemoryRouter>
        <Developer />
      </MemoryRouter>
    );
    expect(await screen.findByText('boom')).toBeInTheDocument();
  });

  it('creates an API key and reveals it once', async () => {
    mockInitialData();
    api.createApiKey.mockResolvedValue({ api_key: 'cpk_live_supersecret' });
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <Developer />
      </MemoryRouter>
    );
    await screen.findByText('Backend');

    const labelInput = screen.getByPlaceholderText('Label');
    await user.clear(labelInput);
    await user.type(labelInput, 'CI Pipeline');
    await user.click(screen.getByRole('button', { name: /create key/i }));

    await waitFor(() => {
      expect(api.createApiKey).toHaveBeenCalledWith(
        expect.objectContaining({ label: 'CI Pipeline', scopes: expect.arrayContaining(['read']) })
      );
    });
    expect(await screen.findByText('cpk_live_supersecret')).toBeInTheDocument();
  });

  it('toggles additional scopes when creating a key', async () => {
    mockInitialData();
    api.createApiKey.mockResolvedValue({ api_key: 'cpk_live_xyz' });
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <Developer />
      </MemoryRouter>
    );
    await screen.findByText('Backend');

    const withdrawals = screen.getByLabelText('withdrawals');
    if (!withdrawals.checked) await user.click(withdrawals);
    const full = screen.getByLabelText('full');
    if (!full.checked) await user.click(full);
    await user.click(screen.getByRole('button', { name: /create key/i }));

    await waitFor(() => {
      expect(api.createApiKey).toHaveBeenCalledWith(
        expect.objectContaining({ scopes: expect.arrayContaining(['read', 'withdrawals', 'full']) })
      );
    });
  });

  it('revokes an API key after confirmation', async () => {
    mockInitialData();
    api.deleteApiKey.mockResolvedValue({});
    api.listApiKeys.mockResolvedValueOnce(KEYS).mockResolvedValueOnce([]);
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <Developer />
      </MemoryRouter>
    );
    await screen.findByText('Backend');

    const revokeButton = within(screen.getByText('Backend').closest('tr')).getByRole('button', {
      name: /revoke/i,
    });
    await user.click(revokeButton);

    expect(confirmSpy).toHaveBeenCalled();
    await waitFor(() => {
      expect(api.deleteApiKey).toHaveBeenCalledWith('k1');
    });
  });

  it('cancels revocation when the user dismisses the confirm dialog', async () => {
    mockInitialData();
    confirmSpy.mockReturnValue(false);
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <Developer />
      </MemoryRouter>
    );
    await screen.findByText('Backend');

    const revokeButton = within(screen.getByText('Backend').closest('tr')).getByRole('button', {
      name: /revoke/i,
    });
    await user.click(revokeButton);

    expect(api.deleteApiKey).not.toHaveBeenCalled();
  });

  it('creates a webhook and reveals the signing secret once', async () => {
    mockInitialData();
    api.createWebhook.mockResolvedValue({ secret: 'whsec_supersecret' });
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <Developer />
      </MemoryRouter>
    );
    await screen.findByText('Backend');

    await user.type(
      screen.getByPlaceholderText(/crowdpay-webhook/i),
      'https://new.example.com/hook'
    );
    await user.click(screen.getByRole('button', { name: /add endpoint/i }));

    await waitFor(() => {
      expect(api.createWebhook).toHaveBeenCalledWith(
        expect.objectContaining({
          url: 'https://new.example.com/hook',
          events: expect.arrayContaining(['contribution.received']),
        })
      );
    });
    expect(await screen.findByText('whsec_supersecret')).toBeInTheDocument();
  });

  it('removes a webhook after confirmation', async () => {
    mockInitialData();
    api.deleteWebhook.mockResolvedValue({});
    api.listWebhooks.mockResolvedValueOnce(HOOKS).mockResolvedValueOnce([]);
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <Developer />
      </MemoryRouter>
    );
    await screen.findByText('https://example.com/hook');

    const removeButton = within(
      screen.getByText('https://example.com/hook').closest('li')
    ).getByRole('button', { name: /remove/i });
    await user.click(removeButton);

    expect(confirmSpy).toHaveBeenCalled();
    await waitFor(() => {
      expect(api.deleteWebhook).toHaveBeenCalledWith('h1');
    });
  });

  it('shows an error when webhook creation fails', async () => {
    mockInitialData();
    api.createWebhook.mockRejectedValue(new Error('Invalid URL'));
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <Developer />
      </MemoryRouter>
    );
    await screen.findByText('Backend');

    await user.type(screen.getByPlaceholderText(/crowdpay-webhook/i), 'not-a-url');
    await user.click(screen.getByRole('button', { name: /add endpoint/i }));

    expect(await screen.findByText('Invalid URL')).toBeInTheDocument();
  });
});
