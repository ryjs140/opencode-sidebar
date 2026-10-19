# Beige theme notes

The `opencode-web-sidebar.theme` setting (`beige` by default) restyles the
OpenCode page that runs inside the sidebar. `native` disables all theming so
OpenCode's own theme and color scheme are used.

## How it works

- `src/SidebarTheme.ts` owns the palette and the injection payload.
- The local proxy (`src/ProxyServer.ts`) inserts a `<style>` element and a small
  `<script>` at the start of the OpenCode document `<head>`.
- The panel appends one-time `__oc_sidebar_theme` / `__oc_sidebar_mode` query
  hints to the iframe URL. The script reads them synchronously (the first paint
  is already themed), applies `data-oc-sidebar-theme` / `data-oc-sidebar-mode`
  attributes to `<html>`, and strips the hints before the OpenCode app boots, so
  they never reach the router or the persisted tabs.
- The stylesheet keys off those attributes, so OpenCode's theme engine keeps
  running: its `:root` custom properties are simply overridden. The injected
  rules are unlayered while OpenCode's defaults live in `@layer theme`, so the
  injected stylesheet wins without `!important` and without touching app code.
- While `beige` is active, VS Code light/dark changes are forwarded from the
  webview with `postMessage({ type: 'ocSidebarTheme' })`; the injected script
  switches between the light and warm-dark palettes without reloading.

The theme never touches OpenCode code, routes, storage keys, authentication, or
session data. Choosing `native` removes the attributes and the stylesheet stays
inert.

## Palette

The palette mirrors `ryjs.gfy-theme`. Main values:

| Role | Light | Dark |
|------|-------|------|
| Page background (`--v2-background-bg-deep`) | `#f2f1ea` | `#1b1916` |
| Raised surface (`--v2-background-bg-base`) | `#faf9f2` | `#24221e` |
| Base text (`--v2-text-text-base`) | `#2f2b26` | `#f2f1ea` |
| Muted text (`--v2-text-text-muted`) | `#6b655d` | `#c6c2b4` |
| Solid buttons (`--v2-background-bg-accent`) | `#423e31` | `#4a6785` |
| Borders (`--v2-border-border-base`) | `rgba(47,43,38,.14)` | `rgba(242,241,234,.13)` |
| Focus ring (`--v2-border-border-focus`) | `#7e97bc` | `#8fa9c9` |

## Changing the palette

Edit the `LIGHT_THEME` / `DARK_THEME` blocks in `src/SidebarTheme.ts` (the
`--v2-*` variables are the ones the V2 web UI reads), rebuild, and reload the
extension host. Bump `PROXY_FEATURE_KEY` in `src/ProxyServer.ts` whenever the
injected payload changes so open windows reconnect to a proxy serving the new
script. Run `npm test` and, when possible, `scripts/verify-theme.cjs`.

## Scope and limits

- Only the V2 web UI reads the `--v2-*` variables; the legacy UI keeps its own
  styles.
- The theme has been verified in headless Chromium against OpenCode 2.0.31
  through the real proxy. Rendering inside a VS Code Remote SSH host still
  needs a manual check by the maintainer (`Developer: Reload Window` after
  installing the VSIX).
