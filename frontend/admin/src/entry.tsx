// Forge's product sign-in surface is not part of the shared Admin Console.
if (/^\/admin(?:\/|$)/.test(window.location.pathname)) {
  void import('./main');
} else {
  void import('./forgeMain');
}
