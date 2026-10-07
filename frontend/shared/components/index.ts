// W3 BuildCost — shared W3 UI System component barrel (v0.10.7).
//
// Canonical React primitives promoted from the Admin Operations Console. Both
// /admin and the BuildCost app consume these so both surfaces render as one
// W3 BuildCost product. See frontend/shared/README.md for the rules.

export { W3Layout } from './W3Layout';
export {
  W3SidebarBrand,
  W3SidebarNav,
  W3SidebarSectionLabel,
  W3SidebarFooter,
  runtimeSidebarStatus
} from './W3Sidebar';
export type { W3NavItem, W3SidebarStatus } from './W3Sidebar';
export { W3PageHeader } from './W3PageHeader';
export { W3Card, W3CardHeader, W3CardBody, W3CardFooter } from './W3Card';
export { W3Badge } from './W3Badge';
export type { W3BadgeTone } from './W3Badge';
export { W3Button } from './W3Button';
export type { W3ButtonVariant } from './W3Button';
export { W3Table } from './W3Table';
