import { Routes, Route, Navigate } from 'react-router-dom';
import { AdminLayout } from './components/AdminLayout';
import { DashboardPage } from './pages/DashboardPage';
import { SystemStatusPage } from './pages/SystemStatusPage';
import { LogsPage } from './pages/LogsPage';
import { FileBrowserPage } from './pages/FileBrowserPage';
import { ControlsPage } from './pages/ControlsPage';
import { SettingsPage } from './pages/SettingsPage';

// W3 Forge Admin Console — v0.4.0 foundation.
// READ-ONLY shell + a narrow controls-execution surface that only runs
// Forge-safe scripts via safeRunner. No deploy/release/package routes.
export default function App() {
  return (
    <AdminLayout>
      <Routes>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/system" element={<SystemStatusPage />} />
        <Route path="/logs" element={<LogsPage />} />
        <Route path="/files" element={<FileBrowserPage />} />
        <Route path="/controls" element={<ControlsPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AdminLayout>
  );
}
