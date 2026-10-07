import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { loadConsoleConfiguration } from './bootstrap';
import { consoleApp } from '../../../shared/consoleApp';
import { ErrorState } from './components/ui/States';
// v0.5.3 dashboard tile system — react-grid-layout + react-resizable base
// stylesheets must be loaded BEFORE our theme stylesheet so our overrides in
// styles.css (under "react-grid-layout overrides") take precedence.
import 'react-grid-layout/css/styles.css';
import 'react-resizable/css/styles.css';
import './styles.css';

// React Query: short stale time, no refetch on window focus (admin tool).
// Each widget hook can opt into its own polling interval.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      refetchOnWindowFocus: false,
      retry: 1
    }
  }
});

const root = ReactDOM.createRoot(document.getElementById('root') as HTMLElement);
const admin = /^\/admin(?:[/?#]|$)/.test(window.location.pathname);
async function start() {
  if (admin) await loadConsoleConfiguration();
  const { default: App } = admin ? await import('./App') : await import('./PublicApp');
  root.render(<React.StrictMode><QueryClientProvider client={queryClient}>
    <BrowserRouter basename={admin ? '/admin' : consoleApp.productBase}><App /></BrowserRouter>
  </QueryClientProvider></React.StrictMode>);
}
void start().catch(error => root.render(<div className="flex min-h-screen items-center justify-center p-6"><div className="card max-w-md p-6 space-y-4">
  <ErrorState error={error} /><button className="btn" onClick={() => window.location.reload()}>Retry</button>
</div></div>));
