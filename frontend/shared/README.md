# W3 UI System — `frontend/shared/` (v0.10.7)

The shared W3 UI System foundation. Promoted from the Admin Operations Console
(`frontend/admin/`), which is the visual authority for W3 BuildCost. Both `/admin`
and `/command-center` consume this layer so the two consoles render as one
product instead of two parallel visual systems.

## Layout

```
frontend/shared/
  styles/
    tokens.css       Canonical W3 UI tokens (color, spacing, border, radius,
                     shadow, --w3-mono). Promoted verbatim from the Admin
                     Console tokens.css.
    primitives.css   Canonical primitive classes in @layer components:
                     .card*, .badge*, .btn*, .input, .stat-*, native <select>
                     dark safety net, .console, .table-dark, .w3-nav-link
                     (sidebar nav row hover/active treatment). Promoted from
                     the Admin Console styles.css.
  components/
    W3Layout.tsx     App shell (desktop sidebar + mobile drawer). Accepts a
                     sidebar/nav testId, a versionTone, and an optional section
                     label so consumers can thread through their own markers.
    W3Sidebar.tsx    SidebarBrand + SidebarNav + SidebarSectionLabel +
                     SidebarFooter. Nav rows render the .w3-nav-link primitive
                     and support optional icons, disabled rows, and per-item
                     test ids.
    W3PageHeader.tsx Eyebrow + active page title header.
    W3Card.tsx       Card / CardHeader / CardBody / CardFooter.
    W3Badge.tsx      Badge with tone variants.
    W3Button.tsx     Button with default / primary / ghost variants.
    W3Table.tsx      Dark data table (.table-dark).
  lib/
    cn.ts            Dependency-free className joiner.
```

## Rules Going Forward

1. `frontend/shared/styles/tokens.css` is the canonical W3 UI token source.
2. No app maintains its own duplicate W3 token file unless explicitly approved.
3. No app duplicates a primitive already in `shared/styles/primitives.css`.
4. App-specific CSS handles only layouts unique to that app
   (e.g. the Command Center keeps `.cc-grid`, `.cc-detail-panel`,
   `.cc-relationship-map`, `.cc-registry-toolbar`).
5. No new large `style={{ ... }}` inline blocks in layout shell components.
   The Command Center shell (`CommandCenterLayout.tsx`) renders the shared
   `W3Layout`/`W3Sidebar`/`W3PageHeader` and supplies only data + test markers.
6. The Admin Console visual system is the authority — changes to shared
   tokens/primitives must keep `/admin` rendering identical.
7. The Command Center must look and feel like the same W3 BuildCost product as the
   Admin Console.

### Test-mandated mirrors (transitional)

The v0.8.x release-gate asserts that `command-center/src/styles.css` still
defines `--w3-mono` and a `.cc-nav-link` rule. Both now live canonically in the
shared layer (`tokens.css` `--w3-mono`; `primitives.css` `.w3-nav-link`). The
Command Center keeps a thin mirror of each purely to satisfy those locked
assertions; neither carries independent styling. When the v0.8.x assertions are
relaxed, delete the mirrors in favor of the shared definitions alone.
