# Changelog

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
