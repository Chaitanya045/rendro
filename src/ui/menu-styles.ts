/** Shared popup surface for selection lists and action menus. Their keyboard
 * semantics remain distinct: listbox options are not navigation/menu actions. */
export const menuSurfaceStyles = String.raw`
:root{--rd-menu-surface:#fff;--rd-menu-border:#e4e4e7;--rd-menu-shadow:0 8px 24px rgb(0 0 0 / .12),0 2px 4px rgb(0 0 0 / .06)}
html.dark{--rd-menu-surface:#09090b;--rd-menu-border:#27272a;--rd-menu-shadow:0 8px 24px rgb(0 0 0 / .4),0 2px 4px rgb(0 0 0 / .2)}
.rd-select-popup,.cp-account-menu,.cp-org-menu,.avatar-menu,.mobile-more-menu{padding:4px;border:1px solid var(--rd-menu-border);border-radius:8px;background:var(--rd-menu-surface);box-shadow:var(--rd-menu-shadow)}
html.dark :is(.rd-select-popup,.cp-account-menu,.cp-org-menu,.avatar-menu,.mobile-more-menu){background:var(--rd-menu-surface);border-color:var(--rd-menu-border);box-shadow:var(--rd-menu-shadow)}
.cp-account-menu a,.avatar-menu-item{min-height:36px;border-radius:4px}
@media(max-width:760px){.cp-account-menu a,.avatar-menu-item{min-height:44px}}
`;
