import { Component, type ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { AlertTriangle, ArrowLeft, RefreshCw } from 'lucide-react';
import { Card, CardBody, CardHeader } from './ui/Card';

interface BoundaryProps { children: ReactNode; onDashboard: () => void }

class PageErrorBoundary extends Component<BoundaryProps, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() { return { failed: true }; }

  render() {
    if (!this.state.failed) return this.props.children;
    return <Card>
      <CardHeader title={<span className="flex items-center gap-2"><AlertTriangle size={16} />This page could not load</span>} />
      <CardBody className="space-y-4">
        <p role="alert" className="text-sm text-[var(--w3-text-muted)]">Reload this page to try again, or return to the dashboard.</p>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}><RefreshCw size={14} />Reload page</button>
          <button type="button" className="btn" onClick={this.props.onDashboard}><ArrowLeft size={14} />Back to dashboard</button>
        </div>
      </CardBody>
    </Card>;
  }
}

/** Keep route failures inside the console. A rejected lazy import needs an explicit reload. */
export function RouteErrorBoundary({ children }: { children: ReactNode }) {
  const location = useLocation();
  const navigate = useNavigate();
  // Navigation remounts the boundary; failed pages never enter an automatic retry loop.
  return <PageErrorBoundary key={location.key} onDashboard={() => navigate('/', { replace: true })}>{children}</PageErrorBoundary>;
}
