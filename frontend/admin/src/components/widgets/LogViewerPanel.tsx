import { ReactNode } from 'react';
import { cn } from '../../lib/utils';

// =============================================================================
// LogViewerPanel — v0.5.9 shared log viewer shell.
// =============================================================================
//
// A dark terminal-style window that fills its parent's vertical space and
// keeps the scroll bar OUT of the surrounding tile/card. Used by:
//   - Dashboard "Recent Logs" tile (compact / standard / expanded densities)
//   - Future Logs-page detail panels that want the same look without
//     reaching for a viewport-based max-height.
//
// Layout contract (v0.5.9 — Recent Logs Tile Border Polish):
//
//   <LogViewerPanel>            <-- bordered SHELL.
//                                  Owns: border, rounded corners, dark bg,
//                                  overflow: hidden, height 100%.
//                                  Never scrolls itself, so the right and
//                                  bottom borders cannot be clipped or
//                                  thinned by a scrollbar.
//     <LogViewerScrollArea>     <-- the ONLY scroll container.
//                                   overflow-y: auto, scrollbar-gutter:
//                                   stable, internal padding. Does NOT own
//                                   the visible border.
//       <LogRows>               <-- caller's content (the actual log lines)
//     </LogViewerScrollArea>
//   </LogViewerPanel>
//
// The parent MUST give the panel a bounded height (typically via
// flex: 1 1 auto + min-height: 0 on its container). The panel does NOT set
// its own height in px so it adapts to compact / expanded tile sizes
// automatically.
//
// v0.5.9 visual notes:
//   - Border uses var(--w3-border) so the inner viewer matches the inner
//     frames inside the Disk Usage tile (Root Volume / Folder Usage). The
//     previous "strong + inset ring" combo made the right and bottom
//     borders read thinner than the top/left, because the scrollbar track
//     sat flush against the inner ring.
//   - scrollbar-gutter: stable reserves the gutter even when the content
//     does not currently scroll, so the right border keeps a constant
//     visual weight at every tile size.
//   - Background var(--w3-navy-950)-ish (#050d1c), 1 px var(--w3-border),
//     radius var(--w3-radius-sm), mono 12.5 px / 1.55.

export function LogViewerPanel({
  children,
  className,
  empty,
  emptyContent
}: {
  children?: ReactNode;
  className?: string;
  /** Render an empty-state message inside the panel (no scroll area). */
  empty?: boolean;
  emptyContent?: ReactNode;
}) {
  return (
    <div className={cn('log-viewer-panel', className)}>
      {empty ? (
        <div className="log-viewer-empty">{emptyContent ?? 'No Log Entries Available.'}</div>
      ) : (
        <div className="log-viewer-scroll">{children}</div>
      )}
    </div>
  );
}
