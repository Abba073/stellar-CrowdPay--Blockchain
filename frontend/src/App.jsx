import React from 'react';
import { Routes, Route, Navigate, useLocation } from 'react-router-dom';
import Navbar from './components/Navbar';
import Home from './pages/Home';
import CreateCampaign from './pages/CreateCampaign';
import Campaign from './pages/Campaign';
import CampaignEmbed from './pages/CampaignEmbed';
import Widget from './pages/Widget';
import Login from './pages/Login';
import Register from './pages/Register';
import ForgotPassword from './pages/ForgotPassword';
import ResetPassword from './pages/ResetPassword';
import AdminDashboard from './pages/AdminDashboard';
import AcceptInvite from './pages/AcceptInvite';
import Developer from './pages/Developer';
import Dashboard from './pages/Dashboard';
import Profile from './pages/Profile';
import NotFound from './pages/NotFound';
import { AuthProvider } from './context/AuthContext';
import { ThemeProvider } from './context/ThemeContext';
import { ToastProvider } from './context/ToastContext';
import { DialogProvider } from './context/DialogContext';

export default function App() {
  const location = useLocation();
  const hideNavbar = location.pathname.startsWith('/widget/');

  return (
    <ThemeProvider>
      <AuthProvider>
        <DialogProvider>
        <ToastProvider>
        <DialogProvider>
        {!hideNavbar && <Navbar />}
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/campaigns/new" element={<CreateCampaign />} />
          <Route path="/campaigns/:id" element={<Campaign />} />
          <Route path="/campaigns/:id/invite/:token" element={<AcceptInvite />} />
          <Route path="/embed/campaigns/:id" element={<CampaignEmbed />} />
          <Route path="/widget/campaigns/:id" element={<Widget />} />
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<Register />} />
          <Route path="/forgot-password" element={<ForgotPassword />} />
          <Route path="/reset-password" element={<ResetPassword />} />
          <Route path="/admin" element={<AdminDashboard />} />
          <Route path="/developer" element={<Developer />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/profile" element={<Profile />} />
          <Route path="/my-contributions" element={<Navigate to="/dashboard?tab=contributions" replace />} />
          <Route path="*" element={<NotFound />} />
        </Routes>
        </DialogProvider>
        </ToastProvider>
        </DialogProvider>
      </AuthProvider>
    </ThemeProvider>
  );
}
