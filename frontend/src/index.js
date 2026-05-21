import React from 'react';
import ReactDOM from 'react-dom/client';
import * as Sentry from '@sentry/react';
import './index.css';
import App from './App';
import reportWebVitals from './reportWebVitals';

Sentry.init({
  dsn: process.env.REACT_APP_SENTRY_DSN,
  enabled: !!process.env.REACT_APP_SENTRY_DSN,
  environment: process.env.NODE_ENV || 'production',
  integrations: [
    Sentry.browserTracingIntegration(),
    Sentry.replayIntegration({
      maskAllText: false,
      blockAllMedia: false,
    }),
  ],
  // Capture 10% of transactions for performance monitoring
  tracesSampleRate: 0.1,
  // No session replays in normal usage, full replay on errors
  replaysSessionSampleRate: 0,
  replaysOnErrorSampleRate: 1.0,
  // Filter out noise
  ignoreErrors: [
    'ResizeObserver loop limit exceeded',
    'ResizeObserver loop completed with undelivered notifications',
    /^Network Error$/,
    /^Failed to fetch$/,
    /^Load failed$/,
  ],
});

function ErrorFallback() {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', minHeight: '100vh', padding: '2rem', textAlign: 'center',
    }}>
      <div style={{ fontSize: 40, marginBottom: 16 }}>⚠️</div>
      <h2 style={{ fontSize: 20, fontWeight: 600, marginBottom: 8, color: '#1E3A5F' }}>
        Something went wrong
      </h2>
      <p style={{ fontSize: 14, color: '#64748B', marginBottom: 24, maxWidth: 340 }}>
        An unexpected error occurred. Our team has been notified. Please refresh to try again.
      </p>
      <button
        onClick={() => window.location.reload()}
        style={{
          background: '#3B82F6', color: '#fff', border: 'none',
          padding: '10px 24px', borderRadius: 8, fontSize: 14,
          fontWeight: 500, cursor: 'pointer',
        }}
      >
        Refresh page
      </button>
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById('root'));
root.render(
  <React.StrictMode>
    <Sentry.ErrorBoundary fallback={<ErrorFallback />}>
      <App />
    </Sentry.ErrorBoundary>
  </React.StrictMode>
);

reportWebVitals();
