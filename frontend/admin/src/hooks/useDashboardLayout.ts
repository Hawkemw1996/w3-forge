import { consoleText } from "../../../../shared/consoleApp";
import { useCallback, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { adminGet, adminPost, adminPut } from '../lib/api';
import { DASHBOARD_TILE_IDS, getDashboardTile } from '../config/dashboardTiles';

// =============================================================================
// useDashboardLayout — v0.5.3
// =============================================================================
//
// Backend-persisted dashboard tile layout. v0.5.2 used a localStorage shape
// with simple { id, visible, order }. v0.5.3 upgrades to a react-grid-layout
// shape with per-breakpoint x/y/w/h items + a hidden_tiles list, and stores
// the truth on the W3 BuildCost backend (see backend/src/services/dashboardLayoutStore.ts).
//
// The hook exposes:
//   - layouts:        Record<bp, LayoutItem[]>  — current displayed layout
//   - hiddenTiles:    string[]                  — tile ids hidden in normal mode
//   - source:         'file' | 'default'        — where backend pulled from
//   - draft state:    setDraft / commitDraft / discardDraft / applyResetDefault
//     so the dashboard page can stage edits and only persist on Save.
//   - mutations:      saveLayout(), resetLayout()
//
// The legacy storage key constant is preserved so SettingsPage's
// documentation card and any external references keep compiling.

export const DASHBOARD_LAYOUT_STORAGE_KEY = consoleText('w3buildcost.admin.dashboard.layout.v1');

export type BreakpointKey = 'lg' | 'md' | 'sm' | 'xs';

export interface LayoutItem {
  i: string;
  x: number;
  y: number;
  w: number;
  h: number;
  // v0.5.3.1: optional react-grid-layout native min/max constraints. When
  // present, the grid prevents the user from resizing below/above them.
  minW?: number;
  minH?: number;
  maxW?: number;
  maxH?: number;
}

export interface DashboardLayoutPayload {
  version: string;
  schema: number;
  updated_at: string;
  layouts: Record<BreakpointKey, LayoutItem[]>;
  hidden_tiles: string[];
  source: 'file' | 'default';
  path: string;
}

const QUERY_KEY = ['admin', 'dashboard', 'layout'] as const;

// -----------------------------------------------------------------------------
// Default layout (frontend fallback)
// -----------------------------------------------------------------------------
//
// Mirrors the backend default so the UI can render something sensible even if
// the GET fails (offline / backend down). The backend is authoritative — this
// is a soft floor only.

function buildDefaultLayouts(): Record<BreakpointKey, LayoutItem[]> {
  const out: Record<BreakpointKey, LayoutItem[]> = {
    lg: [],
    md: [],
    sm: [],
    xs: []
  };

  const widths: Record<BreakpointKey, number> = { lg: 12, md: 10, sm: 6, xs: 2 };

  const ids = DASHBOARD_TILE_IDS;
  for (const bp of ['lg', 'md', 'sm', 'xs'] as BreakpointKey[]) {
    const cols = widths[bp];
    let cursorX = 0;
    let cursorY = 0;
    let rowHeight = 0;
    for (const id of ids) {
      const meta = getDashboardTile(id);
      if (!meta) continue;
      // Scale the desktop default w against the breakpoint's column count.
      const desktopW = meta.defaultSize.w;
      const w = Math.max(1, Math.min(cols, Math.round((desktopW / 12) * cols)));
      const h = Math.max(2, meta.defaultSize.h);
      // v0.5.3.1: forward each tile's minSize so RGL enforces the floor.
      // Don't apply minW past the breakpoint's column count (sm/xs are narrow).
      const item: LayoutItem = { i: id, x: cursorX, y: cursorY, w, h };
      if (meta.minSize) {
        item.minW = Math.max(1, Math.min(cols, meta.minSize.w));
        item.minH = Math.max(1, meta.minSize.h);
      }
      out[bp].push(item);
      cursorX += w;
      rowHeight = Math.max(rowHeight, h);
    }
  }
  return out;
}

function defaultPayload(): DashboardLayoutPayload {
  return {
    version: '0.5.6',
    schema: 1,
    updated_at: new Date(0).toISOString(),
    layouts: buildDefaultLayouts(),
    hidden_tiles: [],
    source: 'default',
    path: ''
  };
}

// -----------------------------------------------------------------------------
// Hook
// -----------------------------------------------------------------------------

export interface UseDashboardLayoutResult {
  // Loaded backend layout (read-only display state when not editing).
  layouts: Record<BreakpointKey, LayoutItem[]>;
  hiddenTiles: string[];
  source: 'file' | 'default';
  path: string;
  // Async state.
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  isSaving: boolean;
  isResetting: boolean;
  // Draft + edit helpers (used by DashboardPage edit mode).
  draftLayouts: Record<BreakpointKey, LayoutItem[]>;
  draftHidden: string[];
  setDraftForBreakpoint: (bp: BreakpointKey, items: LayoutItem[]) => void;
  setDraftHidden: (ids: string[]) => void;
  resetDraftToCurrent: () => void;
  applyDefaultsToDraft: () => void;
  // Mutations.
  saveLayout: () => Promise<void>;
  resetLayout: () => Promise<void>;
  // Refresh.
  refetch: () => Promise<unknown>;
}

export function useDashboardLayout(): UseDashboardLayoutResult {
  const qc = useQueryClient();

  const q = useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => adminGet<DashboardLayoutPayload>('/dashboard/layout'),
    staleTime: 30_000
  });

  const current: DashboardLayoutPayload = useMemo(() => q.data ?? defaultPayload(), [q.data]);

  // Draft state — independent of the live layout so the user can drag tiles
  // around without immediately persisting. Initialized lazily; whenever the
  // saved layout changes we DO NOT clobber an in-progress draft (the user
  // explicitly Saves or Cancels).
  const [draftLayouts, setDraftLayouts] = useState<Record<BreakpointKey, LayoutItem[]> | null>(
    null
  );
  const [draftHidden, setDraftHiddenState] = useState<string[] | null>(null);

  const effectiveDraftLayouts = draftLayouts ?? current.layouts;
  const effectiveDraftHidden = draftHidden ?? current.hidden_tiles;

  const setDraftForBreakpoint = useCallback((bp: BreakpointKey, items: LayoutItem[]) => {
    setDraftLayouts((prev) => {
      const base = prev ?? null;
      const start = base ?? current.layouts;
      return { ...start, [bp]: items };
    });
  }, [current.layouts]);

  const setDraftHidden = useCallback((ids: string[]) => {
    setDraftHiddenState(Array.from(new Set(ids)));
  }, []);

  const resetDraftToCurrent = useCallback(() => {
    setDraftLayouts(null);
    setDraftHiddenState(null);
  }, []);

  const applyDefaultsToDraft = useCallback(() => {
    setDraftLayouts(buildDefaultLayouts());
    setDraftHiddenState([]);
  }, []);

  const saveMut = useMutation({
    mutationFn: async (): Promise<DashboardLayoutPayload> =>
      adminPut<DashboardLayoutPayload>('/dashboard/layout', {
        layouts: effectiveDraftLayouts,
        hidden_tiles: effectiveDraftHidden
      }),
    onSuccess: (data) => {
      qc.setQueryData(QUERY_KEY, data);
      setDraftLayouts(null);
      setDraftHiddenState(null);
    }
  });

  const resetMut = useMutation({
    mutationFn: async (): Promise<DashboardLayoutPayload> =>
      adminPost<DashboardLayoutPayload>('/dashboard/layout/reset'),
    onSuccess: (data) => {
      qc.setQueryData(QUERY_KEY, data);
      setDraftLayouts(null);
      setDraftHiddenState(null);
    }
  });

  return {
    layouts: current.layouts,
    hiddenTiles: current.hidden_tiles,
    source: current.source,
    path: current.path,
    isLoading: q.isLoading,
    isError: q.isError,
    error: q.error,
    isSaving: saveMut.isPending,
    isResetting: resetMut.isPending,
    draftLayouts: effectiveDraftLayouts,
    draftHidden: effectiveDraftHidden,
    setDraftForBreakpoint,
    setDraftHidden,
    resetDraftToCurrent,
    applyDefaultsToDraft,
    saveLayout: async () => {
      await saveMut.mutateAsync();
    },
    resetLayout: async () => {
      await resetMut.mutateAsync();
    },
    refetch: () => q.refetch()
  };
}
