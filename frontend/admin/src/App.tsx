import { lazy, Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { CoreAuthGate } from './components/CoreAuthGate';
import { GitHubValidationPage } from './pages/GitHubValidationPage';
import { AdminLayout } from './components/AdminLayout';
import { ProductionReadinessPage } from './pages/ProductionReadinessPage';
import { DashboardPage } from './pages/DashboardPage';
import { SystemStatusPage } from './pages/SystemStatusPage';
import { LogsPage } from './pages/LogsPage';
import { FileBrowserPage } from './pages/FileBrowserPage';
import { ControlsPage } from './pages/ControlsPage';
import { SettingsPage } from './pages/SettingsPage';
import { LoadingState } from './components/ui/States';

const TerminalPage = lazy(() => import('./pages/TerminalPage').then(module => ({ default: module.TerminalPage })));

// Forge's engineering console uses Core-owned sign-in and app-admin access.
export default function App() {
  return (
    <CoreAuthGate><AdminLayout>
      <Routes>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/system" element={<SystemStatusPage />} />
        <Route path="/logs" element={<LogsPage />} />
        <Route path="/files" element={<FileBrowserPage />} />
        <Route path="/github" element={<GitHubValidationPage />} />
        <Route path="/controls" element={<ControlsPage />} />
        <Route path="/terminal" element={<Suspense fallback={<LoadingState label="Loading terminal…" />}><TerminalPage /></Suspense>} />
        <Route path="/production-readiness" element={<ProductionReadinessPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AdminLayout></CoreAuthGate>
  );
}
