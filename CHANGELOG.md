# Changelog

## 0.22.1 — 2026-10-19

Visual alignment with the Codex sidebar (no functional changes; OpenCode itself
is still untouched).

- Reworked the themed look: one unified beige page (`#F2F1EA`), a white
  composer (`#FFFFFF`), neutral text (`#292929` / `#656563`), light auxiliary
  tone (`#ECEBE4`) and matching warm dark variants. Draft/session cards no
  longer paint a second cream surface, and user-message bubbles use the
  auxiliary tone instead of blue.
- Added the **vscode** theme mode: follows the active VS Code color theme by
  reading the webview's live `--vscode-*` colors, applies changes live without
  a reload, and falls back to the Codex palette for values a theme does not
  define or when a color is malformed.
- **beige** is now a deprecated alias for the new default **codex**; existing
  settings keep working and unknown values fall back instead of erroring.
- The composer/input surface is pinned to the input tone explicitly, so the
  white input stays white on the beige page.
- Legacy `beige` theme hints are normalized to `codex` before they reach the
  iframe URL, and the proxy feature key is bumped to
  `web-sidebar-injection-v9` so open windows reconnect to the new payload.

## 0.22.0 — 2026-10-19

Theme release for the personal fork.

- Add the `opencode-web-sidebar.theme` setting: **beige** (default) applies a
  beige/sepia palette — light and warm dark variants — inside the embedded
  OpenCode page so it matches the author's VS Code theme; **native** leaves
  OpenCode's own theme and color scheme untouched.
- The palette is injected by the local proxy as CSS variable overrides plus a
  small pre-app script. OpenCode itself is not modified, and routes, storage,
  authentication, and session handling are unaffected.
- Shell colors now derive from VS Code theme variables instead of a fixed dark
  palette, so the panel follows the active VS Code theme.
- Shared proxy feature key bumped to `web-sidebar-injection-v8` so a running
  VS Code process hosting an older proxy is never reused.
- Reworked fork metadata (`ryjs` publisher), added this changelog, theme
  documentation, and unit tests for the theme module.

### Based on

The 0.21.1 V2 compatibility work included in this release (V2 detection through
`/api/info`, draft/workspace bootstrap before the app starts, persisted session
paths rebound across proxy ports, hardened proxy startup and health checks)
targets the V2 web UI of OpenCode 2.0.x.

## 0.21.0

Upstream release of
[bmpenuelas/opencode-web-sidebar](https://github.com/bmpenuelas/opencode-web-sidebar).
