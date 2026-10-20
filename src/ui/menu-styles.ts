/** Shared popup surface for the repository shell's menus. */
export const menuSurfaceStyles = String.raw`
:root{--rd-menu-surface:#fff;--rd-menu-border:#e4e4e7;--rd-menu-shadow:0 8px 24px rgb(0 0 0 / .12),0 2px 4px rgb(0 0 0 / .06)}
html.dark{--rd-menu-surface:#09090b;--rd-menu-border:#27272a;--rd-menu-shadow:0 8px 24px rgb(0 0 0 / .4),0 2px 4px rgb(0 0 0 / .2)}
.mobile-more-menu{padding:4px;border:1px solid var(--rd-menu-border);border-radius:8px;background:var(--rd-menu-surface);box-shadow:var(--rd-menu-shadow)}
html.dark .mobile-more-menu{background:var(--rd-menu-surface);border-color:var(--rd-menu-border);box-shadow:var(--rd-menu-shadow)}
`;
