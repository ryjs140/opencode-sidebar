# Sidebar theme notes

The `opencode-web-sidebar.theme` setting controls how the embedded OpenCode
page is themed:

| Value | Behavior |
|-------|----------|
| `codex` (default) | Fixed Codex-style palette: one unified beige page, a white composer, neutral text colors and a light auxiliary tone. When VS Code is dark, a matching warm dark variant is used. |
| `vscode` | The same semantic hierarchy, but every token with a VS Code counterpart is resolved from the webview's live `--vscode-*` colors, so any color theme is followed and theme changes apply live. |
| `native` | OpenCode's own theme and color scheme, completely untouched. |
| `beige` | Deprecated alias for `codex`; existing settings keep working and are shown as `codex` behavior. A typo or an unknown value also falls back to `codex` instead of producing an error. |

`codex` is what the Codex sidebar looks like on top of the author's
`ryjs.gfy-theme` VS Code theme; `vscode` reproduces the same look from the live
theme colors and generalizes it to any VS Code theme.

## How it works

- `src/SidebarTheme.ts` owns the palette, the seed-to-variable mapping, and the
  injected payload.
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
- While a themed mode is active, VS Code light/dark changes are forwarded from
  the webview with `postMessage({ type: 'ocSidebarTheme' })`; the injected
  script switches palettes without reloading.

### Following VS Code colors

A webview cannot read CSS from the embedded (proxied) document and the iframe
cannot read the webview's variables, so the panel webview forwards a small
snapshot of its own `--vscode-*` custom properties with the same postMessage.
The snapshot only leaves the webview if it comes from those variables; nothing
is hardcoded:

| Seed | VS Code source (first available wins) |
|------|----------------------------------------|
| page canvas / surfaces | `sideBar.background` → `editor.background` |
| elevated menus/popovers | `menu.background` → `editorWidget.background` |
| auxiliary tone (`#ECEBE4` in gfy) | `sideBarSectionHeader.background` → `list.hoverBackground` |
| hover/selection surfaces | `list.hoverBackground` / `list.activeSelectionBackground` |
| composer / input | `input.background` |
| primary text | `foreground` |
| secondary text | `descriptionForeground` |
| placeholder | `input.placeholderForeground` → `descriptionForeground` |
| links / focus | `textLink.foreground`, `focusBorder` |
| accents / brand | `button.background` / `button.foreground`, `badge.background` |

Values are validated as CSS colors before they are used, so a malformed value
can never reach the page; the static Codex palette for the current mode stays
as the fallback (first paint and rejected values). The webview re-reads the
snapshot when the theme kind or the injected style changes, so edits to
`colorCustomizations`, theme switches, and light/dark flips all apply live.

## Palette

`codex` main values (dark mode keeps the same hierarchy):

| Role | Light | Dark |
|------|-------|------|
| Page canvas (`--v2-background-bg-deep`) | `#F2F1EA` | `#1B1916` |
| Page surfaces/cards (`--v2-background-bg-base`) | `#F2F1EA` | `#1B1916` |
| Elevated menus/toasts (`--v2-background-bg-layer-01`) | `#FAF9F2` | `#2A2823` |
| Auxiliary tone / tool cards (`--v2-background-bg-layer-02`) | `#ECEBE4` | `#33312B` |
| Hover / selected (`--v2-background-bg-layer-03/04`) | `#E3E2DC` / `#D9D8D2` | `#3D3A33` / `#4A463D` |
| Composer / input (`[data-component="composer"]`) | `#FFFFFF` | `#24221E` |
| Base text (`--v2-text-text-base`) | `#292929` | `#F2F1EA` |
| Muted text (`--v2-text-text-muted`) | `#656563` | `#C6C2B4` |
| Solid buttons/switches (`--v2-background-bg-accent`) | `#423E31` | `#4A6785` |
| Borders (`--v2-border-border-base`) | `rgba(41,41,41,.14)` | `rgba(242,241,234,.14)` |
| Focus ring (`--v2-border-border-focus`) | `#7E97BC` | `#8FA9C9` |

The page background is intentionally one tone: the draft/session cards no
longer paint a second cream surface, and the composer is the only white
surface. User-message bubbles use the auxiliary tone (`#ECEBE4` light) instead
of OpenCode's blue.

## Changing the palette

Edit the `CODEX_SEEDS` table (and `buildVscodeSeeds` when the VS Code mapping
should change) in `src/SidebarTheme.ts`, rebuild, and reload the extension
host. Bump `PROXY_FEATURE_KEY` in `src/ProxyServer.ts` whenever the injected
payload changes so open windows reconnect to a proxy serving the new script.
Run `npm test` and, when possible, `scripts/verify-theme.cjs`.

## Scope and limits

- Only the V2 web UI reads the `--v2-*` variables; the legacy UI keeps its own
  styles (the legacy v1 tokens are mapped for completeness).
- `vscode` mode follows the colors VS Code exposes to webviews. Colors that a
  theme does not define (e.g. `input.background` in some themes) fall back to
  VS Code's own defaults, and a few VS-Code-less tokens (scrims, neutral ramp,
  state colors) intentionally keep the Codex values for the current kind.
- Verified in headless Chromium against OpenCode 2.0.32 through the real proxy
  (`scripts/verify-theme.cjs`), including the live palette swap without a
  reload. The full panel is also verified end-to-end in a real VS Code Web
  session (Playwright against a running `serve-web`): the real `--vscode-*`
  theme colors are read from the webview and forwarded into the page, live
  workbench theme and `workbench.colorCustomizations` changes apply without
  reloading the embedded UI, and all three modes plus the legacy `beige`
  alias behave as documented.
