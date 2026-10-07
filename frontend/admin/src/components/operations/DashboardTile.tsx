import { ReactNode } from 'react';
import { GripVertical } from 'lucide-react';
import { Card, CardBody, CardFooter, CardHeader } from '../ui/Card';
import { StatusPill, StatusTone } from '../ui/StatusPill';
import { LoadingState, ErrorState, EmptyState } from '../ui/States';
import { cn } from '../../lib/utils';

// =============================================================================
// DashboardTile — v0.5.3 reusable tile wrapper.
// =============================================================================
//
// A thin wrapper over Card that gives every dashboard / system-status tile a
// consistent shell:
//
//   - Icon + Title + optional Subtitle in a uniform header
//   - Optional status pill rendered on the right of the header
//   - Optional header actions (e.g. "Open Details", buttons) to the right of
//     the status pill
//   - Body slot for the real widget content
//   - Optional footer
//   - Standardized loading / error / empty states (so every tile speaks the
//     same visual language for these cases)
//   - Drag handle styling driven by `editMode` prop. The drag handle uses
//     the CSS class `w3-tile-drag-handle` so react-grid-layout can target
//     it via `draggableHandle=".w3-tile-drag-handle"`.
//
// Visual standard (v0.5.3):
//   - Dark navy panel via .card token (var(--w3-card))
//   - W3 gold accent ring while in edit mode
//   - Consistent header height and body padding
//   - Title Case labels (caller's responsibility)
//
// IMPORTANT: existing v0.5.2 widgets render their own <Card> already.
// They keep working unchanged. New tiles (System Status detail tiles, future
// dashboard tiles) should adopt this wrapper to get the consistent shell.

export interface DashboardTileStatus {
  tone: StatusTone;
  label: string;
  pulse?: boolean;
}

export interface DashboardTileProps {
  /** Stable tile id — should match the react-grid-layout `i` key. */
  id?: string;
  /** Icon shown at the leading edge of the header (e.g. <Activity size={14} />). */
  icon?: ReactNode;
  /** Title shown in the header (Title Case). */
  title: ReactNode;
  /** Optional secondary line under the title. */
  subtitle?: ReactNode;
  /** Right-aligned status pill rendered in the header. */
  status?: DashboardTileStatus;
  /** Right-aligned action area (buttons / extra badges). Rendered after status. */
  headerActions?: ReactNode;
  /** Main body slot. */
  children?: ReactNode;
  /** Optional footer rendered below the body. */
  footer?: ReactNode;
  /** When true, body renders a centered LoadingState. */
  loading?: boolean;
  /** When set, body renders an ErrorState with this message. */
  error?: unknown;
  /** When true (and no loading/error), body renders an EmptyState. */
  empty?: boolean;
  /** EmptyState content (defaults to "No Data Available."). */
  emptyContent?: ReactNode;
  /** Adds the edit-mode chrome (drag handle visible, gold ring, etc.). */
  editMode?: boolean;
  /** Optional compact label like "4 × 3" displayed in the corner while editing. */
  sizeIndicator?: string;
  /** Optional class hook on the outer card. */
  className?: string;
  /** Optional class hook on the body. */
  bodyClassName?: string;
  /** When true, the body element gets !p-0 (callers manage their own padding). */
  noBodyPadding?: boolean;
}

export function DashboardTile({
  id,
  icon,
  title,
  subtitle,
  status,
  headerActions,
  children,
  footer,
  loading,
  error,
  empty,
  emptyContent,
  editMode,
  sizeIndicator,
  className,
  bodyClassName,
  noBodyPadding
}: DashboardTileProps) {
  const right = (
    <>
      {editMode ? (
        // Drag handle — react-grid-layout binds drag to this exact class.
        // We render it first (left of status) so it's easy to grab without
        // accidentally hitting action buttons.
        <button
          type="button"
          className="w3-tile-drag-handle"
          aria-label="Drag To Move Tile"
          title="Drag To Move Tile"
        >
          <GripVertical size={14} />
        </button>
      ) : null}
      {status ? (
        <StatusPill tone={status.tone} pulse={status.pulse}>
          {status.label}
        </StatusPill>
      ) : null}
      {headerActions}
    </>
  );

  // Body precedence: loading > error > empty > children.
  let body: ReactNode;
  if (loading) {
    body = <LoadingState />;
  } else if (error) {
    body = <ErrorState error={error} />;
  } else if (empty) {
    body = <EmptyState>{emptyContent ?? 'No Data Available.'}</EmptyState>;
  } else {
    body = children;
  }

  const headerTitle = icon ? (
    <span className="flex items-center gap-1.5">
      {icon}
      <span>{title}</span>
    </span>
  ) : (
    title
  );

  return (
    <Card
      className={cn(
        'w3-tile',
        editMode && 'w3-tile--editing',
        className
      )}
    >
      <CardHeader title={headerTitle} subtitle={subtitle} right={right} />
      <CardBody className={cn(noBodyPadding && '!p-0', bodyClassName)}>{body}</CardBody>
      {footer ? <CardFooter>{footer}</CardFooter> : null}
      {editMode && sizeIndicator ? (
        <span className="w3-tile-size-indicator" aria-hidden>
          {sizeIndicator}
        </span>
      ) : null}
      {/* react-grid-layout injects its resize handle as a child .react-resizable-handle.
          When editMode is false the .w3-tile rule hides it. */}
      {/* Hidden span used by tests / a11y to expose tile id. */}
      {id ? <span data-tile-id={id} className="sr-only">{`Tile ${id}`}</span> : null}
    </Card>
  );
}
