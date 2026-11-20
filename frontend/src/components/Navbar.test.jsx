import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import Navbar from './Navbar';
import CampaignQRCode from './CampaignQRCode';

vi.mock('../services/api', () => ({
  api: { getNotifications: vi.fn(() => Promise.resolve([])) },
}));
vi.mock('qrcode', () => ({ default: { toCanvas: vi.fn() } }));

const mockNavigate = vi.fn();
const mockLogout = vi.fn();

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

vi.mock('../context/AuthContext', () => ({
  useAuth: vi.fn(),
}));

import { useAuth } from '../context/AuthContext';

function renderNavbar() {
  return render(
    <MemoryRouter>
      <Navbar />
    </MemoryRouter>
  );
}

describe('Navbar', () => {
  beforeEach(() => {
    mockNavigate.mockClear();
    mockLogout.mockClear();
  });

  it('shows login and sign up when unauthenticated', () => {
    useAuth.mockReturnValue({ user: null, logout: mockLogout });
    renderNavbar();
    expect(screen.getByRole('link', { name: /log in/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /sign up/i })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: /select language/i })).toBeInTheDocument();
  });

  it('shows start campaign and logout when authenticated', () => {
    useAuth.mockReturnValue({
      user: { name: 'Bola', role: 'creator' },
      logout: mockLogout,
    });
    renderNavbar();
    expect(screen.getByRole('link', { name: /start campaign/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /logout/i })).toBeInTheDocument();
    expect(screen.getByText('Bola')).toBeInTheDocument();
  });

  it('calls logout and navigates home', async () => {
    useAuth.mockReturnValue({
      user: { name: 'Alice', role: 'contributor' },
      logout: mockLogout,
    });
    const user = userEvent.setup();
    renderNavbar();
    await user.click(screen.getByRole('button', { name: /logout/i }));
    expect(mockLogout).toHaveBeenCalled();
    expect(mockNavigate).toHaveBeenCalledWith('/');
  });

  it('notification dropdown is a keyboard-operable menu that closes on Escape', async () => {
    useAuth.mockReturnValue({ user: { name: 'Alice', role: 'contributor' }, logout: mockLogout });
    const user = userEvent.setup();
    renderNavbar();
    const bell = screen.getByRole('button', { name: /unread notifications/i });
    expect(bell).toHaveAttribute('aria-haspopup', 'menu');
    expect(bell).toHaveAttribute('aria-expanded', 'false');
    await user.click(bell);
    expect(bell).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('menu', { name: /notifications/i })).toBeInTheDocument();
    expect(screen.getByRole('menuitem', { name: /mark all as read/i })).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(bell).toHaveFocus();
  });

  it('QR code widget exposes labeled, focusable controls', () => {
    render(<CampaignQRCode url="https://example.com/campaigns/1" size={100} />);
    expect(screen.getByRole('img', { name: /qr code for/i })).toBeInTheDocument();
    const download = screen.getByRole('link', { name: /download qr code image/i });
    download.focus();
    expect(download).toHaveFocus();
  });
});
