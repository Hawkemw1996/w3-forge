import { RouteErrorBoundary } from './components/RouteErrorBoundary';
import { lazy, Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { AdminLayout } from './components/AdminLayout';
import { AdminAuthGate } from './components/AdminAuthGate';
import { DashboardPage } from './pages/DashboardPage';
import { SystemStatusPage } from './pages/SystemStatusPage';
import { LogsPage } from './pages/LogsPage';
import { PackagesPage } from './pages/PackagesPage';
import { BackupsPage } from './pages/BackupsPage';
import { FileBrowserPage } from './pages/FileBrowserPage';
import { GitHubPage } from './pages/GitHubPage';
import { SettingsPage } from './pages/SettingsPage';
import { ControlsPage } from './pages/ControlsPage';
import { ProductionReadinessPage } from './pages/ProductionReadinessPage';

const TerminalPage = lazy(() => import('./pages/TerminalPage').then(module => ({ default: module.TerminalPage })));

// Admin Console root component.
// Mounted at /admin (basename set in main.tsx).
//
// AdminAuthGate wraps the entire app (W3 BuildCost: W3 Core identity via
// /api/auth/status; buildcost:admin permission required). There is no
// Command Center route and no local owner-setup page.
export default function App() {
  return (
    <AdminAuthGate>
      <AdminLayout>
        <RouteErrorBoundary><Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/system" element={<SystemStatusPage />} />
          <Route path="/logs" element={<LogsPage />} />
          <Route path="/packages" element={<PackagesPage />} />
          <Route path="/backups" element={<BackupsPage />} />
          <Route path="/files" element={<FileBrowserPage />} />
          <Route path="/github" element={<GitHubPage />} />
          <Route path="/terminal" element={<Suspense fallback={<div role="status">Loading Terminal…</div>}><TerminalPage /></Suspense>} />
          <Route path="/controls" element={<ControlsPage />} />
          <Route path="/production-readiness" element={<ProductionReadinessPage />} />
          <Route path="/settings" element={<SettingsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes></RouteErrorBoundary>
      </AdminLayout>
    </AdminAuthGate>
  );
}
