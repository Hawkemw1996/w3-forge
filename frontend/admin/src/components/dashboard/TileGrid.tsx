import { useMemo, useState } from 'react';
import { Responsive, WidthProvider, Layout, Layouts } from 'react-grid-layout';
import type { BreakpointKey, LayoutItem } from '../../hooks/useDashboardLayout';
import { getTileDensity, TileDensity } from '../../lib/tileDensity';

// =============================================================================
// TileGrid — v0.5.3 reusable wrapper around react-grid-layout.
// =============================================================================
//
// Renders dashboard tiles from a layout object. Two modes:
//
//   - Normal:    locked. No dragging, no resizing. Hidden tiles are filtered
//                out before render.
//   - Editing:   draggable + resizable via the .w3-tile-drag-handle. Hidden
//                tiles are still hidden (the edit toolbar provides Add Tile
//                to unhide). Updates pipe through onLayoutChange so the
//                parent's draft state stays in sync as the user drags.
//
// Each tile child must accept `editMode` and a stable `id` matching the
// LayoutItem.i. The parent passes a render function (renderTile) so this
// grid does not need to know about widgets directly — keeps the file
// reusable for the System Status page too.
//
// Breakpoints (px and cols):
//   lg: 1200+   12 cols
//   md:  996+   10 cols
//   sm:  768+    6 cols
//   xs:    0+    2 cols

const ResponsiveGridLayout = WidthProvider(Responsive);

export interface TileGridProps {
  /** Layouts for each breakpoint (lg/md/sm/xs). */
  layouts: Record<BreakpointKey, LayoutItem[]>;
  /** Tile ids that should be hidden in the current render. */
  hiddenTiles: string[];
  /** Edit mode toggles drag/resize and changes visual chrome. */
  editMode: boolean;
  /**
   * Per-tile renderer. Must return the body inside a <DashboardTile/> (or
   * compatible Card). v0.5.3.1: receives `density` (compact / standard /
   * expanded) derived from the current layout item's w/h so widgets can
   * adapt their internal layout to the tile size.
   */
  renderTile: (id: string, editMode: boolean, density: TileDensity, size: { w: number; h: number }) => React.ReactNode;
  /** Called whenever the user drags or resizes (edit mode only). */
  onLayoutChange?: (bp: BreakpointKey, items: LayoutItem[]) => void;
  /** Row height in px. Defaults to 64 (matches 80px snap grid lines visually). */
  rowHeight?: number;
  /** Margin (x, y) in px. */
  margin?: [number, number];
}

const BREAKPOINTS = { lg: 1200, md: 996, sm: 768, xs: 0 } as const;
const COLS = { lg: 12, md: 10, sm: 6, xs: 2 } as const;

export function TileGrid({
  layouts,
  hiddenTiles,
  editMode,
  renderTile,
  onLayoutChange,
  rowHeight = 64,
  margin = [12, 12]
}: TileGridProps) {
  // Track current breakpoint so onLayoutChange knows which slice to update.
  const [currentBp, setCurrentBp] = useState<BreakpointKey>('lg');

  // Filter hidden tiles BEFORE handing layouts to react-grid-layout, but
  // keep the unfiltered layout in the draft store. This lets the user toggle
  // visibility without losing each tile's saved size/position.
  const filteredLayouts: Layouts = useMemo(() => {
    const out: Layouts = { lg: [], md: [], sm: [], xs: [] };
    for (const bp of ['lg', 'md', 'sm', 'xs'] as BreakpointKey[]) {
      out[bp] = layouts[bp]
        .filter((it) => !hiddenTiles.includes(it.i))
        .map((it) => ({ ...it, static: !editMode }));
    }
    return out;
  }, [layouts, hiddenTiles, editMode]);

  // Build the list of children matching the filtered layout. v0.5.3.1 also
  // forwards a TileDensity derived from the current layout item's w/h so
  // each widget can pick a compact / standard / expanded internal layout.
  const children = useMemo(() => {
    const items = filteredLayouts[currentBp] ?? [];
    return items.map((item) => {
      const size = { w: item.w, h: item.h };
      const density = getTileDensity(size);
      return (
        <div key={item.i} data-tile-id={item.i}>
          {renderTile(item.i, editMode, density, size)}
        </div>
      );
    });
  }, [filteredLayouts, currentBp, renderTile, editMode]);

  return (
    <ResponsiveGridLayout
      className={`w3-dashboard-grid ${editMode ? 'w3-dashboard-grid--editing' : ''}`}
      layouts={filteredLayouts}
      breakpoints={BREAKPOINTS}
      cols={COLS}
      rowHeight={rowHeight}
      margin={margin}
      containerPadding={[0, 0]}
      isDraggable={editMode}
      isResizable={editMode}
      draggableHandle=".w3-tile-drag-handle"
      compactType="vertical"
      preventCollision={false}
      useCSSTransforms
      onBreakpointChange={(bp) => setCurrentBp(bp as BreakpointKey)}
      onLayoutChange={(currentLayout: Layout[]) => {
        if (!editMode || !onLayoutChange) return;
        const merged = mergeChangedItems(layouts[currentBp], currentLayout, hiddenTiles);
        onLayoutChange(currentBp, merged);
      }}
    >
      {children}
    </ResponsiveGridLayout>
  );
}

// react-grid-layout reports only the visible items. We must preserve the
// stored x/y/w/h for hidden tiles so visibility toggles don't lose data.
// v0.5.3.1: we also preserve each item's minW/minH/maxW/maxH constraints,
// which RGL strips from its own onLayoutChange payload — without this merge
// the per-tile resize floor would be lost on the first drag/resize.
function mergeChangedItems(
  existing: LayoutItem[],
  changed: Layout[],
  hidden: string[]
): LayoutItem[] {
  const byId = new Map<string, LayoutItem>();
  for (const it of existing) byId.set(it.i, it);
  for (const c of changed) {
    const prev = byId.get(c.i);
    byId.set(c.i, {
      i: c.i,
      x: c.x,
      y: c.y,
      w: c.w,
      h: c.h,
      ...(prev?.minW !== undefined ? { minW: prev.minW } : {}),
      ...(prev?.minH !== undefined ? { minH: prev.minH } : {}),
      ...(prev?.maxW !== undefined ? { maxW: prev.maxW } : {}),
      ...(prev?.maxH !== undefined ? { maxH: prev.maxH } : {})
    });
  }
  // Preserve order: visible items in their new order, then hidden tiles last.
  const visibleInOrder = changed.map((c) => byId.get(c.i)!).filter(Boolean);
  const hiddenInOrder = existing
    .filter((it) => hidden.includes(it.i) && !changed.find((c) => c.i === it.i))
    .map((it) => byId.get(it.i)!)
    .filter(Boolean);
  return [...visibleInOrder, ...hiddenInOrder];
}
