import { ComponentType } from 'react';
import type { TileDensity } from '../../lib/tileDensity';

// Widget registry contract.
// v0.5.1 introduces Customize Mode (visibility + reorder) backed by
// localStorage. Drag-and-drop is intentionally deferred — the editor
// surfaces explicit move-up / move-down controls instead.
//
// v0.5.3.1: widgets now accept an optional `density` prop driven by the
// dashboard grid's current tile size. Widgets that don't care can ignore it.

export interface WidgetRenderProps {
  density?: TileDensity;
}

export interface WidgetDef {
  /** Stable identifier; never change once a release is shipped. */
  key: string;
  /** Short human-readable label shown in the dashboard editor UI. */
  label: string;
  /** Optional one-line description for tooltips/help. */
  description?: string;
  /** Default column span on the dashboard grid (1, 2, or 3 of 3). */
  defaultSpan: 1 | 2 | 3;
  /** Component that renders the widget body inside a Card. */
  component: ComponentType<WidgetRenderProps>;
}

// On-disk schema for the persisted layout.
export interface PersistedWidget {
  id: string;
  visible: boolean;
  order: number;
}

export interface PersistedLayout {
  version: 1;
  widgets: PersistedWidget[];
}

// In-memory shape used by the dashboard view.
export interface DashboardLayout {
  version: 1;
  widgets: PersistedWidget[];
}

export const DEFAULT_LAYOUT_VERSION = 1 as const;
