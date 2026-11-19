import React from 'react';
import ReactDOM from 'react-dom/client';
import CampaignEmbed from './pages/CampaignEmbed';
import ErrorBoundary from './components/ErrorBoundary';
import './index.css';
import './i18n';

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <ErrorBoundary>
    <CampaignEmbed />
  </ErrorBoundary>
);
