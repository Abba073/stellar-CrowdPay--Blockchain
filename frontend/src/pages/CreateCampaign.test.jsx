import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import CreateCampaign from './CreateCampaign';

const api = {
  getMe: vi.fn(),
  createCampaign: vi.fn(),
  uploadCampaignCoverImage: vi.fn(),
};

const updateUser = vi.fn();
const mockNavigate = vi.fn();
const authState = {
  user: { id: '1', name: 'Ada', email: 'ada@example.com', role: 'creator', kyc_status: 'verified' },
  ready: true,
  updateUser,
  token: 'jwt-token',
};

vi.mock('../services/api', () => ({ api }));
vi.mock('../context/AuthContext', () => ({ useAuth: () => authState }));
vi.mock('../components/OnboardingCallout', () => ({
  default: ({ title, onDismiss, children }) => (
    <div data-testid="onboarding-callout">
      <span>{title}</span>
      <button type="button" onClick={onDismiss}>
        Got it
      </button>
      {children}
    </div>
  ),
}));
vi.mock('../components/KycPrompt', () => ({
  default: ({ title }) => <div data-testid="kyc-prompt">{title}</div>,
}));
vi.mock('react-simplemde-editor', () => ({
  default: ({ value, onChange, id }) => (
    <textarea
      data-testid="description-editor"
      id={id}
      value={value || ''}
      onChange={(e) => onChange(e.target.value)}
    />
  ),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key, opts) =>
      key === 'createCampaign.milestoneTotal' && opts?.count !== undefined
        ? `Total: ${opts.count}`
        : key,
  }),
}));
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

// Translation keys rendered as text by the mocked i18n.
const T = {
  title: 'createCampaign.title',
  campaignTitle: 'createCampaign.campaignTitle',
  fundraisingGoal: 'createCampaign.fundraisingGoal',
  continueToDetails: 'createCampaign.continueToDetails',
  description: 'createCampaign.description',
  deadline: 'createCampaign.deadline',
  coverImage: 'createCampaign.coverImage',
  continueToMilestones: 'createCampaign.continueToMilestones',
  milestonePlan: 'createCampaign.milestonePlan',
  addMilestone: 'createCampaign.addMilestone',
  launchCampaign: 'createCampaign.launchCampaign',
};

async function fillStep1(user, { title = 'Community Garden', target = '1000' } = {}) {
  if (title !== null) {
    await user.type(screen.getByLabelText(T.campaignTitle), title);
  }
  if (target !== null) {
    await user.type(screen.getByLabelText(T.fundraisingGoal), target);
  }
}

async function advanceToStep2(user) {
  await fillStep1(user);
  await user.click(screen.getByRole('button', { name: T.continueToDetails }));
  await screen.findByText(/createCampaign\.description/);
}

async function advanceToStep3(user) {
  await advanceToStep2(user);
  await user.click(screen.getByRole('button', { name: T.continueToMilestones }));
  await screen.findByText(T.milestonePlan);
}

function addMilestone(user, { title, description, percentage }) {
  return user.click(screen.getByRole('button', { name: T.addMilestone }));
}

describe('CreateCampaign', () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('cp_onboarding_creator_dismissed', '1');
    api.getMe.mockReset().mockResolvedValue(authState.user);
    api.createCampaign.mockReset();
    api.uploadCampaignCoverImage.mockReset();
    updateUser.mockReset();
    mockNavigate.mockReset();
    authState.user = {
      id: '1',
      name: 'Ada',
      email: 'ada@example.com',
      role: 'creator',
      kyc_status: 'verified',
    };
    authState.ready = true;
  });

  it('redirects unauthenticated users to login', async () => {
    authState.user = null;
    render(
      <MemoryRouter>
        <CreateCampaign />
      </MemoryRouter>
    );
    expect(await screen.findByText(/redirecting to sign in/i)).toBeInTheDocument();
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/login', {
        replace: true,
        state: { from: '/campaigns/new' },
      });
    });
  });

  it('blocks non-creator accounts', () => {
    authState.user = { ...authState.user, role: 'contributor' };
    render(
      <MemoryRouter>
        <CreateCampaign />
      </MemoryRouter>
    );
    expect(
      screen.getByText(/only creator or admin accounts can start campaigns/i)
    ).toBeInTheDocument();
    expect(api.createCampaign).not.toHaveBeenCalled();
  });

  it('requires identity verification before creating a campaign', () => {
    authState.user = { ...authState.user, kyc_status: 'unverified' };
    render(
      <MemoryRouter>
        <CreateCampaign />
      </MemoryRouter>
    );
    expect(screen.getByTestId('kyc-prompt')).toHaveTextContent('Verify your identity first');
    expect(screen.getByText(/current verification status: unverified/i)).toBeInTheDocument();
  });

  it('renders the first step with title, goal, and asset picker', () => {
    render(
      <MemoryRouter>
        <CreateCampaign />
      </MemoryRouter>
    );
    expect(screen.getByText(T.title)).toBeInTheDocument();
    expect(screen.getByLabelText(T.campaignTitle)).toBeInTheDocument();
    expect(screen.getByLabelText(T.fundraisingGoal)).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /^USDC/ })).toBeChecked();
    expect(screen.getByRole('radio', { name: /^XLM/ })).not.toBeChecked();
  });

  it('shows the creator onboarding callout when not previously dismissed', () => {
    localStorage.removeItem('cp_onboarding_creator_dismissed');
    render(
      <MemoryRouter>
        <CreateCampaign />
      </MemoryRouter>
    );
    expect(screen.getByTestId('onboarding-callout')).toBeInTheDocument();
  });

  it('validates that a title is required', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <CreateCampaign />
      </MemoryRouter>
    );
    await fillStep1(user, { title: null });
    await user.click(screen.getByRole('button', { name: T.continueToDetails }));

    expect(await screen.findByText(/please enter a campaign title/i)).toBeInTheDocument();
  });

  it('validates that the fundraising goal is greater than zero', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <CreateCampaign />
      </MemoryRouter>
    );
    await fillStep1(user, { target: '0' });
    await user.click(screen.getByRole('button', { name: T.continueToDetails }));

    expect(await screen.findByText(/fundraising goal greater than zero/i)).toBeInTheDocument();
  });

  it('advances to step 2 with a valid goal and asset selection', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <CreateCampaign />
      </MemoryRouter>
    );
    await fillStep1(user);
    await user.click(screen.getByRole('radio', { name: /^XLM/ }));
    await user.click(screen.getByRole('button', { name: T.continueToDetails }));

    expect(await screen.findByText(/createCampaign\.description/)).toBeInTheDocument();
    expect(screen.getByLabelText(/createCampaign\.deadline/)).toBeInTheDocument();
  });

  it('rejects a deadline in the past', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <CreateCampaign />
      </MemoryRouter>
    );
    await advanceToStep2(user);

    fireEvent.change(screen.getByLabelText(/createCampaign\.deadline/), {
      target: { value: '2020-01-01' },
    });
    await user.click(screen.getByRole('button', { name: T.continueToMilestones }));

    expect(await screen.findByText(/deadline must be today or in the future/i)).toBeInTheDocument();
  });

  it('rejects a maximum contribution below the minimum', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <CreateCampaign />
      </MemoryRouter>
    );
    await advanceToStep2(user);

    await user.type(screen.getByLabelText(/minimum per contribution/i), '100');
    await user.type(screen.getByLabelText(/maximum per contribution/i), '50');
    await user.click(screen.getByRole('button', { name: T.continueToMilestones }));

    expect(
      await screen.findByText(/maximum contribution must be greater than minimum contribution/i)
    ).toBeInTheDocument();
  });

  it('rejects a maximum contribution above the target amount', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <CreateCampaign />
      </MemoryRouter>
    );
    await advanceToStep2(user);

    await user.type(screen.getByLabelText(/maximum per contribution/i), '5000');
    await user.click(screen.getByRole('button', { name: T.continueToMilestones }));

    expect(
      await screen.findByText(/maximum contribution cannot exceed the target amount/i)
    ).toBeInTheDocument();
  });

  it('advances to the milestone step with valid details', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <CreateCampaign />
      </MemoryRouter>
    );
    await advanceToStep3(user);
    expect(screen.getByText(T.milestonePlan)).toBeInTheDocument();
  });

  it('requires milestone percentages to sum to 100%', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <CreateCampaign />
      </MemoryRouter>
    );
    await advanceToStep3(user);

    await addMilestone(user);
    await user.type(screen.getAllByPlaceholderText('e.g. Deliver prototype')[0], 'Prototype');
    await user.type(screen.getAllByPlaceholderText(/explain what contributors/i)[0], 'Build it');
    await user.type(screen.getAllByPlaceholderText('25')[0], '60');
    await addMilestone(user);
    await user.type(screen.getAllByPlaceholderText('e.g. Deliver prototype')[1], 'Launch');
    await user.type(screen.getAllByPlaceholderText(/explain what contributors/i)[1], 'Ship it');
    await user.type(screen.getAllByPlaceholderText('25')[1], '30');

    await user.click(screen.getByRole('button', { name: T.launchCampaign }));
    expect(
      await screen.findByText(/milestone percentages must sum to exactly 100%/i)
    ).toBeInTheDocument();
    expect(api.createCampaign).not.toHaveBeenCalled();
  });

  it('requires milestone titles and descriptions', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <CreateCampaign />
      </MemoryRouter>
    );
    await advanceToStep3(user);

    await addMilestone(user);
    await user.click(screen.getByRole('button', { name: T.launchCampaign }));

    expect(await screen.findByText(/milestone 1 needs a title/i)).toBeInTheDocument();
  });

  it('creates a campaign and navigates to it on success', async () => {
    api.createCampaign.mockResolvedValue({ id: 55, title: 'Community Garden' });
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <CreateCampaign />
      </MemoryRouter>
    );
    await advanceToStep3(user);

    await user.click(screen.getByRole('button', { name: T.launchCampaign }));

    await waitFor(() => {
      expect(api.createCampaign).toHaveBeenCalledWith(
        expect.objectContaining({
          title: 'Community Garden',
          target_amount: '1000',
          asset_type: 'USDC',
        })
      );
    });
    expect(mockNavigate).toHaveBeenCalledWith(
      '/campaigns/55',
      expect.objectContaining({ state: expect.objectContaining({ created: true }) })
    );
  });

  it('creates a campaign with milestones when they sum to 100%', async () => {
    api.createCampaign.mockResolvedValue({ id: 56 });
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <CreateCampaign />
      </MemoryRouter>
    );
    await advanceToStep3(user);

    await addMilestone(user);
    await user.type(screen.getAllByPlaceholderText('e.g. Deliver prototype')[0], 'Prototype');
    await user.type(screen.getAllByPlaceholderText(/explain what contributors/i)[0], 'Build it');
    await user.type(screen.getAllByPlaceholderText('25')[0], '100');

    await user.click(screen.getByRole('button', { name: T.launchCampaign }));

    await waitFor(() => {
      expect(api.createCampaign).toHaveBeenCalledWith(
        expect.objectContaining({
          milestones: [{ title: 'Prototype', description: 'Build it', release_percentage: 100 }],
        })
      );
    });
  });

  it('shows an error when campaign creation fails', async () => {
    api.createCampaign.mockRejectedValue(new Error('Stellar network error'));
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <CreateCampaign />
      </MemoryRouter>
    );
    await advanceToStep3(user);

    await user.click(screen.getByRole('button', { name: T.launchCampaign }));

    expect(await screen.findByText('Stellar network error')).toBeInTheDocument();
    expect(mockNavigate).not.toHaveBeenCalledWith('/campaigns/56', expect.anything());
  });

  it('rejects invalid cover image types', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <CreateCampaign />
      </MemoryRouter>
    );
    await advanceToStep2(user);

    const file = new File(['x'], 'cover.gif', { type: 'image/gif' });
    await user.upload(screen.getByLabelText(/createCampaign\.coverImage/), file);

    expect(await screen.findByText(/cover image must be jpg, png, or webp/i)).toBeInTheDocument();
  });

  it('rejects cover images larger than 5MB', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <CreateCampaign />
      </MemoryRouter>
    );
    await advanceToStep2(user);

    const big = new File([new Uint8Array(5 * 1024 * 1024 + 1)], 'big.png', { type: 'image/png' });
    await user.upload(screen.getByLabelText(/createCampaign\.coverImage/), big);

    expect(await screen.findByText(/cover image must be smaller than 5mb/i)).toBeInTheDocument();
  });

  it('uploads a valid cover image after creating the campaign', async () => {
    api.createCampaign.mockResolvedValue({ id: 57 });
    api.uploadCampaignCoverImage.mockResolvedValue({});
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <CreateCampaign />
      </MemoryRouter>
    );
    await advanceToStep2(user);

    const file = new File(['img'], 'cover.png', { type: 'image/png' });
    await user.upload(screen.getByLabelText(/createCampaign\.coverImage/), file);
    expect(await screen.findByAltText('Cover preview')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: T.continueToMilestones }));
    await screen.findByText(T.milestonePlan);
    await user.click(screen.getByRole('button', { name: T.launchCampaign }));

    await waitFor(() => {
      expect(api.uploadCampaignCoverImage).toHaveBeenCalledWith(57, file);
    });
  });

  it('removes a milestone from the plan', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <CreateCampaign />
      </MemoryRouter>
    );
    await advanceToStep3(user);

    await addMilestone(user);
    expect(screen.getAllByRole('button', { name: /remove/i })).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: /remove/i }));
    expect(screen.queryByRole('button', { name: /remove/i })).not.toBeInTheDocument();
  });

  it('limits the plan to five milestones', async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <CreateCampaign />
      </MemoryRouter>
    );
    await advanceToStep3(user);

    for (let i = 0; i < 5; i += 1) {
      await addMilestone(user);
    }
    expect(screen.getAllByRole('button', { name: /remove/i })).toHaveLength(5);
    expect(screen.queryByRole('button', { name: T.addMilestone })).not.toBeInTheDocument();
  });

  it('pre-fills the form from router location state', () => {
    render(
      <MemoryRouter
        initialEntries={[
          { pathname: '/campaigns/new', state: { prefill: { title: 'Prefilled' } } },
        ]}
      >
        <CreateCampaign />
      </MemoryRouter>
    );
    expect(screen.getByLabelText(T.campaignTitle)).toHaveValue('Prefilled');
  });
});
