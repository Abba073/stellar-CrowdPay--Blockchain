import { describe, it, expect } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import MilestoneTracker from './MilestoneTracker';

const milestones = [
  {
    id: 'm1',
    title: 'Prototype',
    description: 'Ship the prototype.',
    release_percentage: '25.0000',
    status: 'released',
    evidence_url: 'https://example.com/proof',
    on_chain: true,
  },
  {
    id: 'm2',
    title: 'Pilot',
    description: '',
    release_percentage: '35',
    status: 'approved',
    review_note: 'Looks good, releasing next.',
  },
  {
    id: 'm3',
    title: 'Launch',
    release_percentage: '40',
    status: 'submitted',
  },
];

function card(title) {
  return screen.getByText(title).closest('article');
}

describe('MilestoneTracker', () => {
  it('renders nothing without milestones', () => {
    const { container } = render(<MilestoneTracker milestones={[]} assetType="USDC" />);
    expect(container).toBeEmptyDOMElement();
  });

  it('lists milestones in order with their release share of funds', () => {
    render(<MilestoneTracker milestones={milestones} assetType="USDC" />);
    const articles = screen.getAllByRole('article');
    expect(articles).toHaveLength(3);
    expect(within(articles[0]).getByText('Milestone 1')).toBeInTheDocument();
    expect(within(articles[2]).getByText('Milestone 3')).toBeInTheDocument();
    expect(
      within(card('Prototype')).getByText(/releases 25% of campaign funds in USDC/i)
    ).toBeInTheDocument();
    expect(
      within(card('Pilot')).getByText(/releases 35% of campaign funds in USDC/i)
    ).toBeInTheDocument();
  });

  it('maps release status to Released / Approved / Pending badges', () => {
    render(<MilestoneTracker milestones={milestones} assetType="USDC" />);
    expect(within(card('Prototype')).getByText('Released')).toBeInTheDocument();
    expect(within(card('Pilot')).getByText('Approved')).toBeInTheDocument();
    expect(within(card('Launch')).getByText('Pending')).toBeInTheDocument();
  });

  it('shows evidence, review notes and the on-chain badge only when present', () => {
    render(<MilestoneTracker milestones={milestones} assetType="USDC" />);
    expect(within(card('Prototype')).getByRole('link', { name: /view proof/i })).toHaveAttribute(
      'href',
      'https://example.com/proof'
    );
    expect(within(card('Prototype')).getByText(/on-chain/i)).toBeInTheDocument();
    expect(within(card('Pilot')).queryByText(/on-chain/i)).not.toBeInTheDocument();
    expect(within(card('Pilot')).getByText('Looks good, releasing next.')).toBeInTheDocument();
    expect(within(card('Pilot')).getByText(/no description provided yet/i)).toBeInTheDocument();
    expect(within(card('Launch')).queryByRole('link')).not.toBeInTheDocument();
  });
});
