import { consoleText } from "../../../../shared/consoleApp";
import type { ComponentType, ReactNode } from 'react';
import type { WidgetRenderProps } from '../components/widgets/types';
import {
  Activity,
  Archive,
  Cpu,
  HardDrive,
  Package,
  PackageCheck,
  ShieldAlert,
  Tag,
  Terminal
} from 'lucide-react';
import { WIDGETS, WIDGET_KEYS } from '../components/widgets/widgets';

// =============================================================================
// Dashboard tile registry — v0.5.3
// =============================================================================
//
// Source of truth for tile metadata (id, label, icon, default size). The
// actual component is sourced from the existing v0.5.2 widget registry at
// frontend/admin/src/components/widgets/widgets.tsx so we do NOT duplicate
// data-fetching code — v0.5.3 changes the *layout shell*, not the widget
// internals.
//
// Tile ids are stable across releases. Each id maps 1:1 to a v0.5.2 widget
// `key` so the existing keys (`system-health`, `version`, `attention`,
// `recent-logs`, `memory-cpu`, `disk-usage`, `staged-packages`,
// `installed-packages`, `backup-summary`) carry over without a migration.

export interface DashboardTileMeta {
  id: string;
  title: string;
  description?: string;
  icon: ReactNode;
  /** Default size as react-grid-layout w/h units. */
  defaultSize: { w: number; h: number };
  /**
   * v0.5.3.1: minimum size as react-grid-layout w/h units. Enforced by RGL
   * during resize so the tile can never shrink below the size at which its
   * body still renders readable content.
   */
  minSize?: { w: number; h: number };
  /** Renders the tile's body. Wrapped externally in DashboardTile or Card. */
  component: ComponentType<WidgetRenderProps>;
}

// Icon factory keeps the JSX tiny inside the registry and avoids importing
// React at top-level just for createElement.
const icon = (Icon: typeof Activity) => <Icon size={14} />;

const META: Record<string, Omit<DashboardTileMeta, 'component'>> = {
  'system-health': {
    id: 'system-health',
    title: 'System Health',
    description: 'Service status, database, and uptime.',
    icon: icon(Activity),
    defaultSize: { w: 4, h: 3 },
    minSize: { w: 3, h: 3 }
  },
  version: {
    id: 'version',
    title: 'Version',
    description: consoleText('Current W3 BuildCost version and environment.'),
    icon: icon(Tag),
    defaultSize: { w: 4, h: 3 },
    minSize: { w: 3, h: 2 }
  },
  attention: {
    id: 'attention',
    title: 'Attention Required',
    description: 'Live + Future Detectors For Operator Attention.',
    icon: icon(ShieldAlert),
    defaultSize: { w: 4, h: 3 },
    minSize: { w: 3, h: 3 }
  },
  'recent-logs': {
    id: 'recent-logs',
    title: 'Recent Logs',
    description: 'Tail Of The Most Recent Operational Log Entries.',
    icon: icon(Terminal),
    defaultSize: { w: 8, h: 4 },
    minSize: { w: 4, h: 3 }
  },
  'memory-cpu': {
    id: 'memory-cpu',
    title: 'Memory / CPU',
    description: 'Process Memory Footprint And Host Load Averages.',
    icon: icon(Cpu),
    defaultSize: { w: 4, h: 4 },
    minSize: { w: 3, h: 3 }
  },
  'disk-usage': {
    id: 'disk-usage',
    title: 'Disk Usage',
    description: 'Root Volume And Monitored Path Disk Usage.',
    icon: icon(HardDrive),
    defaultSize: { w: 4, h: 4 },
    minSize: { w: 3, h: 3 }
  },
  'staged-packages': {
    id: 'staged-packages',
    title: 'Staged Packages',
    description: consoleText('Release Tarballs In /opt/w3buildcost-update-packages.'),
    icon: icon(Package),
    defaultSize: { w: 4, h: 4 },
    minSize: { w: 3, h: 2 }
  },
  'installed-packages': {
    id: 'installed-packages',
    title: 'Installed Packages',
    description: consoleText('Tarballs Previously Imported By deploy-w3buildcost.sh.'),
    icon: icon(PackageCheck),
    defaultSize: { w: 4, h: 4 },
    minSize: { w: 3, h: 2 }
  },
  'backup-summary': {
    id: 'backup-summary',
    title: 'Backup Summary',
    description: 'Most Recent App + Database Backup Pairs.',
    icon: icon(Archive),
    defaultSize: { w: 6, h: 4 },
    minSize: { w: 4, h: 3 }
  }
};

// Build the registry by joining the v0.5.2 widget components with v0.5.3 meta.
// If a v0.5.2 widget key is missing meta we still surface the tile with a
// minimal fallback so a stale meta map never silently drops a tile.
function fallbackMeta(key: string): Omit<DashboardTileMeta, 'component'> {
  return {
    id: key,
    title: key,
    icon: icon(Activity),
    defaultSize: { w: 4, h: 4 }
  };
}

export const DASHBOARD_TILES: DashboardTileMeta[] = WIDGETS.map((w) => {
  const m = META[w.key] ?? fallbackMeta(w.key);
  return { ...m, component: w.component };
});

export const DASHBOARD_TILE_IDS: string[] = WIDGET_KEYS.slice();

export function getDashboardTile(id: string): DashboardTileMeta | undefined {
  return DASHBOARD_TILES.find((t) => t.id === id);
}
