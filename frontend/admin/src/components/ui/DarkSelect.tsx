// =============================================================================
// W3 Core v0.5.30 - DarkSelect.
// =============================================================================
//
// A small accessible single-select dropdown styled for the dark Admin Console
// theme. v0.5.30 ships this because the native <select> option list rendered
// with browser defaults (white background, light text) on several browsers
// even when the surrounding page declared color-scheme: dark, which made the
// branch / staged-package pickers on the GitHub / Releases page unreadable.
//
// The component intentionally mirrors the surface area of a native select
// so existing call-sites can swap in without restructuring their state:
//
//     <DarkSelect
//       value={branch}
//       onChange={setBranch}
//       options={[
//         { value: '', label: '— Select dev branch —' },
//         ...branchesQ.data.branches.map(b => ({
//           value: b.name,
//           label: `${b.name} (${b.sha.slice(0,7)})`
//         }))
//       ]}
//       disabled={loading}
//       placeholder="— Select dev branch —"
//       id="pipeline-branch"
//     />
//
// Behaviour:
//   * Closed state shows the currently selected option's label.
//   * Empty value renders the placeholder muted.
//   * Disabled state is non-interactive and visually dimmed.
//   * Click outside, Escape, or selecting an option closes the menu.
//   * Hover / focus states are explicit so keyboard users can see focus.
//   * Selected option highlighted with a thin gold rail.
//
// The component is intentionally self-contained (no portal, no popover lib)
// because the existing pipeline panel is short and the dropdown fits inline.
// If the dropdown ever needs to escape an overflow:hidden container, swap
// to a portal-based implementation.
// =============================================================================

import { useEffect, useId, useRef, useState, KeyboardEvent } from 'react';
import { ChevronDown, Check } from 'lucide-react';
import { cn } from '../../lib/utils';

export interface DarkSelectOption {
  value: string;
  label: string;
  // Optional secondary text shown muted after the label.
  hint?: string;
  // Optional disabled flag per option.
  disabled?: boolean;
}

export interface DarkSelectProps {
  value: string;
  onChange: (value: string) => void;
  options: DarkSelectOption[];
  // Placeholder shown when value === '' (or value not in options).
  placeholder?: string;
  // Overall disabled flag.
  disabled?: boolean;
  // Maps to the outer wrapper id (for label/htmlFor compatibility).
  id?: string;
  // Optional aria-label when there's no visible <label>.
  ariaLabel?: string;
  // Maximum visible options before the list scrolls.
  maxVisible?: number;
  className?: string;
  // Empty-state message when options has no usable entries.
  emptyMessage?: string;
}

export function DarkSelect({
  value,
  onChange,
  options,
  placeholder,
  disabled,
  id,
  ariaLabel,
  maxVisible = 8,
  className,
  emptyMessage
}: DarkSelectProps) {
  const reactId = useId();
  const wrapId = id ?? `darkselect-${reactId}`;
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState<number>(-1);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);

  // Selectable options (i.e. exclude options whose value is '' AND label
  // is the placeholder — those are placeholder rows, not selectable).
  const selectable = options.filter((o) => o.value !== '' && !o.disabled);
  const empty = selectable.length === 0;
  const selected = options.find((o) => o.value === value && o.value !== '');
  const displayLabel = selected
    ? selected.label
    : placeholder ?? '— Select —';

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (!wrapRef.current) return;
      if (!wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  // Reset active highlight when opening.
  useEffect(() => {
    if (open) {
      const idx = selectable.findIndex((o) => o.value === value);
      setActiveIndex(idx >= 0 ? idx : 0);
    } else {
      setActiveIndex(-1);
    }
    // We only want this on `open` transitions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function commit(idx: number) {
    const opt = selectable[idx];
    if (!opt) return;
    onChange(opt.value);
    setOpen(false);
  }

  function onTriggerKeyDown(e: KeyboardEvent<HTMLButtonElement>) {
    if (disabled) return;
    if (!open) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => Math.min((i < 0 ? -1 : i) + 1, selectable.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max((i < 0 ? selectable.length : i) - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (activeIndex >= 0) commit(activeIndex);
    } else if (e.key === 'Home') {
      e.preventDefault();
      setActiveIndex(0);
    } else if (e.key === 'End') {
      e.preventDefault();
      setActiveIndex(selectable.length - 1);
    }
  }

  const triggerColors = {
    background: disabled ? 'rgba(7,18,37,0.45)' : 'rgba(7,18,37,0.75)',
    borderColor: disabled
      ? 'rgba(154,168,194,0.20)'
      : open
        ? 'rgba(240,193,90,0.55)'
        : 'var(--w3-border)',
    color: selected ? 'var(--w3-text)' : 'var(--w3-text-muted)'
  };

  return (
    <div
      ref={wrapRef}
      id={wrapId}
      className={cn('relative', className)}
    >
      <button
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-disabled={disabled}
        aria-label={ariaLabel}
        disabled={disabled}
        onKeyDown={onTriggerKeyDown}
        onClick={() => {
          if (disabled) return;
          setOpen((o) => !o);
        }}
        className="flex w-full items-center justify-between gap-2 rounded-md border px-2 py-1.5 text-left font-mono text-xs transition-colors"
        style={triggerColors}
      >
        <span className="min-w-0 flex-1 truncate">{displayLabel}</span>
        <ChevronDown
          size={12}
          className={cn('flex-shrink-0 transition-transform', open ? 'rotate-180' : '')}
          style={{ color: 'var(--w3-text-muted)' }}
        />
      </button>

      {open && !disabled ? (
        <ul
          ref={listRef}
          role="listbox"
          aria-labelledby={wrapId}
          className="absolute left-0 right-0 z-30 mt-1 overflow-y-auto rounded-md border shadow-lg"
          style={{
            background: 'var(--w3-navy-800)',
            borderColor: 'var(--w3-border-strong, var(--w3-border))',
            color: 'var(--w3-text)',
            maxHeight: `${Math.min(maxVisible, 12) * 28 + 8}px`
          }}
        >
          {empty ? (
            <li
              role="option"
              aria-selected={false}
              aria-disabled
              className="px-2.5 py-1.5 text-[11px] italic"
              style={{ color: 'var(--w3-text-muted)' }}
            >
              {emptyMessage ?? 'No options available.'}
            </li>
          ) : (
            selectable.map((opt, idx) => {
              const active = idx === activeIndex;
              const isSelected = opt.value === value;
              return (
                <li
                  key={opt.value}
                  role="option"
                  aria-selected={isSelected}
                  onMouseEnter={() => setActiveIndex(idx)}
                  onMouseDown={(e) => {
                    // Use mousedown to commit before the button's blur closes the menu.
                    e.preventDefault();
                    commit(idx);
                  }}
                  className="flex cursor-pointer items-center gap-2 px-2.5 py-1.5 font-mono text-[11.5px]"
                  style={{
                    background: active
                      ? 'rgba(240,193,90,0.10)'
                      : isSelected
                        ? 'rgba(34,197,94,0.06)'
                        : 'transparent',
                    color: 'var(--w3-text)',
                    borderLeft: isSelected
                      ? '2px solid var(--w3-gold-400, #F0C15A)'
                      : '2px solid transparent'
                  }}
                >
                  <span className="flex-1 truncate">{opt.label}</span>
                  {opt.hint ? (
                    <span
                      className="flex-shrink-0 text-[10px]"
                      style={{ color: 'var(--w3-text-muted)' }}
                    >
                      {opt.hint}
                    </span>
                  ) : null}
                  {isSelected ? (
                    <Check
                      size={11}
                      style={{ color: 'var(--status-success, #4ade80)' }}
                    />
                  ) : null}
                </li>
              );
            })
          )}
        </ul>
      ) : null}
    </div>
  );
}
