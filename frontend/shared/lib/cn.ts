// W3 BuildCost — shared className joiner (v0.10.7).
//
// Tiny dependency-free `cn` helper shared by the W3 UI System components. Both
// the Admin Operations Console and the Command Center already ship a local
// copy; this is the canonical version the shared/components/ tree imports so
// the shared components carry no app-specific dependency.

export function cn(
  ...classes: Array<string | false | null | undefined>
): string {
  return classes.filter(Boolean).join(' ');
}
