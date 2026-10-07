import { useCallback, useEffect, useState } from 'react';
import {
  Check,
  Eye,
  EyeOff,
  PencilRuler,
  Plus,
  RotateCcw,
  Settings2,
  X
} from 'lucide-react';
import { SectionHeader } from '../components/ui/SectionHeader';
import { Card, CardBody } from '../components/ui/Card';
import { StatusPill } from '../components/ui/StatusPill';
import { Badge } from '../components/ui/Badge';
import { ErrorState, LoadingState } from '../components/ui/States';
import { TileGrid } from '../components/dashboard/TileGrid';
import { DashboardTile } from '../components/dashboard/DashboardTile';
import {
  DASHBOARD_TILES,
  getDashboardTile
} from '../config/dashboardTiles';
import { useDashboardLayout } from '../hooks/useDashboardLayout';
import { cn } from '../lib/utils';
import type { TileDensity } from '../lib/tileDensity';

// =============================================================================
// DashboardPage — v0.5.3
// =============================================================================
//
// Replaces the v0.5.2 explicit move-up/move-down editor with a true
// drag/resize tile grid powered by react-grid-layout. Backend-persisted via
// useDashboardLayout (which talks to /api/admin/dashboard/layout).
//
// Edit mode happens IN-PLACE on the dashboard. Customize → enter edit mode.
// Toolbar appears above the grid with: Add Tile, Reset Layout, Cancel, Save.
//
// Existing v0.5.2 widgets render unchanged inside the grid cells via the
// widget registry's component map — we did not rip out their internals.

interface ToastMessage {
  id: number;
  tone: 'success' | 'danger' | 'info';
  text: string;
}

export function DashboardPage() {
  const {
    draftLayouts,
    draftHidden,
    source,
    isLoading,
    isError,
    error,
    isSaving,
    isResetting,
    setDraftForBreakpoint,
    setDraftHidden,
    resetDraftToCurrent,
    applyDefaultsToDraft,
    saveLayout,
    resetLayout
  } = useDashboardLayout();

  const [editing, setEditing] = useState(false);
  const [showAddPanel, setShowAddPanel] = useState(false);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  // v0.5.4: Tile editing is intentionally disabled on small screens. Drag/resize
  // is unusable on phones, and the xs breakpoint (1 col) already gives a clean
  // single-column stack of tiles. We watch window width and exit edit mode if
  // the user shrinks the viewport while editing.
  const [isMobile, setIsMobile] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia('(max-width: 767px)').matches;
  });
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mq = window.matchMedia('(max-width: 767px)');
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);
  useEffect(() => {
    if (isMobile && editing) {
      setEditing(false);
      setShowAddPanel(false);
    }
  }, [isMobile, editing]);

  const pushToast = useCallback((tone: ToastMessage['tone'], text: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, tone, text }]);
    setTimeout(() => setToasts((t) => t.filter((m) => m.id !== id)), 3500);
  }, []);

  // Render a tile by id — wraps the v0.5.2 widget component inside a div
  // that handles the edit-mode chrome via wrapper class names.
  //
  // v0.5.3.1: TileGrid now passes the computed density (compact/standard/
  // expanded) and raw size so the widget body can adapt to the tile size.
  const renderTile = useCallback(
    (
      id: string,
      editMode: boolean,
      density: TileDensity,
      _size: { w: number; h: number }
    ) => {
      const meta = getDashboardTile(id);
      if (!meta) {
        return (
          <DashboardTile id={id} title={`Unknown Tile (${id})`} editMode={editMode}>
            <div className="text-xs text-[var(--w3-text-muted)]">
              This Tile Id Is Not In The Current Registry. It Will Be Removed On Save.
            </div>
          </DashboardTile>
        );
      }
      const Body = meta.component;
      // The widget itself renders its own Card chrome. In edit mode we render
      // a transparent overlay wrapper that adds the drag handle + gold ring.
      // The widget's Card stays inside.
      return (
        <div className={cn('w3-tile-frame', editMode && 'w3-tile-frame--editing')}>
          {editMode ? <EditOverlay id={id} title={meta.title} /> : null}
          <Body density={density} />
        </div>
      );
    },
    []
  );

  const handleSave = useCallback(async () => {
    try {
      await saveLayout();
      pushToast('success', 'Layout Saved.');
      setEditing(false);
      setShowAddPanel(false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      pushToast('danger', `Failed To Save Layout: ${msg}`);
    }
  }, [saveLayout, pushToast]);

  const handleCancel = useCallback(() => {
    resetDraftToCurrent();
    pushToast('info', 'Layout Changes Discarded.');
    setEditing(false);
    setShowAddPanel(false);
  }, [resetDraftToCurrent, pushToast]);

  const handleResetLayout = useCallback(async () => {
    try {
      // Reset on backend (deletes the file, returns default), THEN clear draft.
      await resetLayout();
      // Also clear local draft so the UI reflects the backend default immediately.
      applyDefaultsToDraft();
      // applyDefaultsToDraft set a draft equal to the defaults; the save
      // mutation already cleared the live cache and our draft, but we want
      // the user to be able to confirm the reset, so we leave them in edit
      // mode with the default layout staged.
      pushToast('success', 'Layout Reset To Default.');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      pushToast('danger', `Failed To Reset Layout: ${msg}`);
    }
  }, [resetLayout, applyDefaultsToDraft, pushToast]);

  const handleToggleHidden = useCallback(
    (id: string) => {
      const has = draftHidden.includes(id);
      const next = has ? draftHidden.filter((x) => x !== id) : [...draftHidden, id];
      setDraftHidden(next);
    },
    [draftHidden, setDraftHidden]
  );

  if (isLoading) {
    return (
      <div className="space-y-4">
        <SectionHeader title="Operations Overview" subtitle="Loading tile layout…" />
        <Card>
          <CardBody>
            <LoadingState label="Loading Dashboard Layout…" />
          </CardBody>
        </Card>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="space-y-4">
        <SectionHeader title="Operations Overview" subtitle="Failed to load layout." />
        <Card>
          <CardBody>
            <ErrorState error={error} title="Failed To Load Dashboard Layout" />
          </CardBody>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <SectionHeader
        title="Operations Overview"
        subtitle={
          editing
            ? 'Edit mode — drag to move, resize from the corner. Save or cancel to exit.'
            : source === 'default'
              ? 'Using the default layout. Customize to arrange your tiles.'
              : 'Custom dashboard layout loaded from server.'
        }
        actions={
          editing ? null : isMobile ? null : (
            <button
              type="button"
              className="btn"
              onClick={() => setEditing(true)}
              title="Enter Edit Mode To Rearrange Tiles"
            >
              <Settings2 size={14} />
              Customize
            </button>
          )
        }
      />

      {isMobile ? (
        <Card>
          <CardBody>
            <div className="body-muted">
              Tile editing is best on tablet or desktop. Open this dashboard on a larger screen to rearrange tiles.
            </div>
          </CardBody>
        </Card>
      ) : null}

      {editing ? (
        <EditToolbar
          isSaving={isSaving}
          isResetting={isResetting}
          showAddPanel={showAddPanel}
          onToggleAdd={() => setShowAddPanel((v) => !v)}
          onReset={handleResetLayout}
          onCancel={handleCancel}
          onSave={handleSave}
        />
      ) : null}

      {editing && showAddPanel ? (
        <AddTilePanel
          hiddenIds={draftHidden}
          onToggle={handleToggleHidden}
        />
      ) : null}

      <TileGrid
        layouts={draftLayouts}
        hiddenTiles={draftHidden}
        editMode={editing}
        renderTile={renderTile}
        onLayoutChange={(bp, items) => setDraftForBreakpoint(bp, items)}
      />

      {/* Toast stack */}
      <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={cn(
              'rounded-md border px-3 py-2 text-sm shadow-lg',
              t.tone === 'success' && 'border-[rgba(34,197,94,0.4)] bg-[var(--status-success-bg)] text-[var(--status-success)]',
              t.tone === 'danger' && 'border-[rgba(239,68,68,0.4)] bg-[var(--status-danger-bg)] text-[var(--status-danger)]',
              t.tone === 'info' && 'border-[rgba(59,130,246,0.4)] bg-[var(--status-info-bg)] text-[var(--status-info)]'
            )}
            role="status"
          >
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}

// -----------------------------------------------------------------------------
// Sub-components
// -----------------------------------------------------------------------------

function EditOverlay({ id: _id, title: _title }: { id: string; title: string }) {
  // Floating drag handle pinned to the top-right of the tile body. Since the
  // existing v0.5.2 widgets render their own Card with their own header, we
  // overlay this handle absolutely so it's visible without rewriting every
  // widget's header. The class .w3-tile-drag-handle is what react-grid-layout
  // listens to for dragging (set via draggableHandle in TileGrid).
  return (
    <div className="w3-tile-edit-overlay">
      <button
        type="button"
        className="w3-tile-drag-handle"
        aria-label="Drag To Move Tile"
        title="Drag To Move Tile"
      >
        <PencilRuler size={14} />
      </button>
    </div>
  );
}

interface EditToolbarProps {
  isSaving: boolean;
  isResetting: boolean;
  showAddPanel: boolean;
  onToggleAdd: () => void;
  onReset: () => void;
  onCancel: () => void;
  onSave: () => void;
}

function EditToolbar({
  isSaving,
  isResetting,
  showAddPanel,
  onToggleAdd,
  onReset,
  onCancel,
  onSave
}: EditToolbarProps) {
  return (
    <div className="w3-edit-toolbar">
      <div className="w3-edit-toolbar__title">
        <PencilRuler size={14} />
        Editing Dashboard Layout
        <Badge tone="gold">Edit Mode</Badge>
      </div>
      <div className="w3-edit-toolbar__actions">
        <button
          type="button"
          className={cn('btn', showAddPanel && 'btn-primary')}
          onClick={onToggleAdd}
          title="Show / Hide Tiles"
        >
          <Plus size={14} />
          Add Tile
        </button>
        <button
          type="button"
          className="btn"
          onClick={onReset}
          disabled={isResetting}
          title="Restore The Built-In Default Layout"
        >
          <RotateCcw size={14} />
          {isResetting ? 'Resetting…' : 'Reset Layout'}
        </button>
        <button
          type="button"
          className="btn"
          onClick={onCancel}
          disabled={isSaving}
          title="Discard Changes And Exit"
        >
          <X size={14} />
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={onSave}
          disabled={isSaving}
          title="Persist Changes To Server"
        >
          <Check size={14} />
          {isSaving ? 'Saving…' : 'Save Layout'}
        </button>
      </div>
    </div>
  );
}

interface AddTilePanelProps {
  hiddenIds: string[];
  onToggle: (id: string) => void;
}

function AddTilePanel({ hiddenIds, onToggle }: AddTilePanelProps) {
  return (
    <DashboardTile
      title="Available Tiles"
      icon={<Eye size={14} />}
      subtitle="Click a tile to show or hide it on the dashboard."
    >
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {DASHBOARD_TILES.map((t) => {
          const isHidden = hiddenIds.includes(t.id);
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => onToggle(t.id)}
              className={cn(
                'flex items-center justify-between gap-2 rounded-md border p-2 text-left text-xs transition-colors',
                isHidden
                  ? 'border-[var(--w3-border)] bg-[rgba(255,255,255,0.02)] text-[var(--w3-text-muted)]'
                  : 'border-[var(--w3-gold-500)] bg-[var(--w3-gold-bg)] text-[var(--w3-text)]'
              )}
              style={{ borderColor: isHidden ? 'var(--w3-border)' : 'var(--w3-gold-500)' }}
            >
              <span className="flex items-center gap-1.5 truncate">
                {t.icon}
                <span className="truncate font-medium">{t.title}</span>
              </span>
              {isHidden ? (
                <StatusPill tone="slate">
                  <EyeOff size={11} /> Hidden
                </StatusPill>
              ) : (
                <StatusPill tone="gold">
                  <Eye size={11} /> Visible
                </StatusPill>
              )}
            </button>
          );
        })}
      </div>
    </DashboardTile>
  );
}
