import { strictEqual, match, ok, deepStrictEqual } from 'node:assert';
import { test } from 'node:test';
import {
  buildVscodeSeeds,
  normalizeSidebarTheme,
  normalizeSidebarThemeMode,
  withSidebarTheme,
  SEED_KEY_NAMES,
  SIDEBAR_THEME_QUERY,
  SIDEBAR_THEME_MODE_QUERY,
  SIDEBAR_THEME_SCRIPT,
  SIDEBAR_THEME_STYLE,
} from './SidebarTheme';

test('theme preference accepts the three modes and migrates beige to codex', () => {
  strictEqual(normalizeSidebarTheme('codex'), 'codex');
  strictEqual(normalizeSidebarTheme('vscode'), 'vscode');
  strictEqual(normalizeSidebarTheme('native'), 'native');
  // The previous default keeps working instead of producing a settings error.
  strictEqual(normalizeSidebarTheme('beige'), 'codex');
  strictEqual(normalizeSidebarTheme('dark'), 'codex');
  strictEqual(normalizeSidebarTheme(undefined), 'codex');
  strictEqual(normalizeSidebarTheme(null), 'codex');
});

test('theme mode only accepts dark as an alternative', () => {
  strictEqual(normalizeSidebarThemeMode('dark'), 'dark');
  strictEqual(normalizeSidebarThemeMode('light'), 'light');
  strictEqual(normalizeSidebarThemeMode('system'), 'light');
  strictEqual(normalizeSidebarThemeMode(undefined), 'light');
});

test('themed modes append hints and keep existing bootstrap parameters', () => {
  const codex = new URL(withSidebarTheme(
    'http://127.0.0.1:4109/?_ocWorkspace=%2Ftmp%2Fmy%20project&_ocRestore=%2F',
    'codex',
    'light',
  ));
  strictEqual(codex.searchParams.get(SIDEBAR_THEME_QUERY), 'codex');
  strictEqual(codex.searchParams.get(SIDEBAR_THEME_MODE_QUERY), 'light');
  strictEqual(codex.searchParams.get('_ocWorkspace'), '/tmp/my project');
  strictEqual(codex.searchParams.get('_ocRestore'), '/');

  const vscode = new URL(withSidebarTheme('http://127.0.0.1:4109/session/abc', 'vscode', 'dark'));
  strictEqual(vscode.searchParams.get(SIDEBAR_THEME_QUERY), 'vscode');
  strictEqual(vscode.searchParams.get(SIDEBAR_THEME_MODE_QUERY), 'dark');
});

test('a legacy beige caller is normalized before it reaches the URL', () => {
  const url = new URL(withSidebarTheme('http://127.0.0.1:4109/', 'beige' as never, 'light'));
  strictEqual(url.searchParams.get(SIDEBAR_THEME_QUERY), 'codex');
});

test('choosing native removes stale hints instead of adding them', () => {
  const url = withSidebarTheme(
    'http://127.0.0.1:4109/session/abc?__oc_sidebar_theme=codex&__oc_sidebar_mode=dark',
    'native',
    'dark',
  );
  const parsed = new URL(url);
  strictEqual(parsed.searchParams.has(SIDEBAR_THEME_QUERY), false);
  strictEqual(parsed.searchParams.has(SIDEBAR_THEME_MODE_QUERY), false);
  strictEqual(parsed.pathname, '/session/abc');
});

test('theme hints survive an empty or malformed iframe URL unchanged', () => {
  strictEqual(withSidebarTheme('', 'codex', 'light'), '');
  strictEqual(withSidebarTheme('not a url', 'codex', 'light'), 'not a url');
});

test('injected stylesheet spans codex and vscode modes with the Codex palette', () => {
  match(SIDEBAR_THEME_STYLE, /html\[data-oc-sidebar-theme="codex"\]\[data-oc-sidebar-mode="light"\]/);
  match(SIDEBAR_THEME_STYLE, /html\[data-oc-sidebar-theme="codex"\]\[data-oc-sidebar-mode="dark"\]/);
  match(SIDEBAR_THEME_STYLE, /html\[data-oc-sidebar-theme="vscode"\]\[data-oc-sidebar-mode="light"\]/);
  match(SIDEBAR_THEME_STYLE, /html\[data-oc-sidebar-theme="vscode"\]\[data-oc-sidebar-mode="dark"\]/);
  // Codex anchors: beige page, white composer, neutral text, light auxiliary.
  ok(SIDEBAR_THEME_STYLE.includes('--ocsw-canvas:#F2F1EA'));
  ok(SIDEBAR_THEME_STYLE.includes('--ocsw-input:#FFFFFF'));
  ok(SIDEBAR_THEME_STYLE.includes('--ocsw-text:#292929'));
  ok(SIDEBAR_THEME_STYLE.includes('--ocsw-textMuted:#656563'));
  ok(SIDEBAR_THEME_STYLE.includes('--ocsw-elev2:#ECEBE4'));
  // The dark variant keeps the same hierarchy.
  ok(SIDEBAR_THEME_STYLE.includes('--ocsw-canvas:#1B1916'));
  // Seeds are mapped through one shared block; the composer gets the input tone.
  ok(SIDEBAR_THEME_STYLE.includes('--v2-background-bg-deep:var(--ocsw-canvas)'));
  ok(SIDEBAR_THEME_STYLE.includes('--v2-background-bg-base:var(--ocsw-surface)'));
  ok(SIDEBAR_THEME_STYLE.includes('[data-component="composer"]'));
  ok(SIDEBAR_THEME_STYLE.includes('background-color: var(--ocsw-input)'));
  // The palette must not leak into the page without the opt-in attribute.
  ok(!/^\s*html\s*\{/m.test(SIDEBAR_THEME_STYLE));
});

test('buildVscodeSeeds maps gfy-theme style colors onto the Codex palette', () => {
  const seeds = buildVscodeSeeds({
    'sideBar-background': '#F2F1EA',
    'editor-background': '#FAF9F2',
    'foreground': '#292929',
    'descriptionForeground': '#656563',
    'input-background': '#FFFFFF',
    'menu-background': '#FAF9F2',
    'sideBarSectionHeader-background': '#ECEBE4',
    'list-hoverBackground': '#E3E2DC',
    'list-activeSelectionBackground': '#D9D8D2',
    'focusBorder': '#7E97BC',
    'button-background': '#423E31',
    'button-foreground': '#FAF9F2',
    'icon-foreground': '#514F48',
  });
  strictEqual(seeds.canvas, '#F2F1EA');
  strictEqual(seeds.surface, '#F2F1EA');
  strictEqual(seeds.input, '#FFFFFF');
  strictEqual(seeds.text, '#292929');
  strictEqual(seeds.textMuted, '#656563');
  strictEqual(seeds.elev1, '#FAF9F2');
  strictEqual(seeds.elev2, '#ECEBE4');
  strictEqual(seeds.elev3, '#E3E2DC');
  strictEqual(seeds.elev4, '#D9D8D2');
  strictEqual(seeds.accent, '#423E31');
  strictEqual(seeds.accentFg, '#FAF9F2');
  strictEqual(seeds.focus, '#7E97BC');
  // No textLink color in the snapshot: focusBorder is the fallback link tone.
  strictEqual(seeds.link, '#7E97BC');
  // User-message bubbles follow the neutral auxiliary tone, not OpenCode blue.
  strictEqual(seeds.blue100, '#ECEBE4');
  strictEqual(seeds.blue700, '#292929');
  for (const key of Object.keys(seeds)) {
    ok(SEED_KEY_NAMES.includes(key), 'unknown seed ' + key);
  }
});

test('buildVscodeSeeds rejects malformed values and keeps the static fallback', () => {
  const seeds = buildVscodeSeeds({
    'sideBar-background': 'url(javascript:alert(1))',
    'foreground': 'expression(alert(1))',
    'input-background': 'red;} html{background:black',
  });
  strictEqual(seeds.canvas, undefined);
  strictEqual(seeds.text, undefined);
  strictEqual(seeds.input, undefined);

  const rgb = buildVscodeSeeds({ 'sideBar-background': 'rgba(242, 241, 234, 0.9)' });
  strictEqual(rgb.canvas, 'rgba(242, 241, 234, 0.9)');

  deepStrictEqual(buildVscodeSeeds({}), {});
});

test('injected script embeds the self-contained seed mapper', () => {
  // The exact source is executed inside the page, so it must be reproducible.
  ok(SIDEBAR_THEME_SCRIPT.includes(buildVscodeSeeds.toString()));
  match(SIDEBAR_THEME_SCRIPT, /var SEED_KEYS = \[/);
  match(SIDEBAR_THEME_SCRIPT, /--ocsw-/);
});

test('injected script consumes the URL hint before the app starts and reacts to parent messages', () => {
  ok(SIDEBAR_THEME_SCRIPT.includes(SIDEBAR_THEME_QUERY));
  ok(SIDEBAR_THEME_SCRIPT.includes(SIDEBAR_THEME_MODE_QUERY));
  match(SIDEBAR_THEME_SCRIPT, /history\.replaceState/);
  match(SIDEBAR_THEME_SCRIPT, /event\.source !== window\.parent/);
  match(SIDEBAR_THEME_SCRIPT, /data\.type !== 'ocSidebarTheme'/);
  match(SIDEBAR_THEME_SCRIPT, /root\.setAttribute\('data-oc-sidebar-theme', nextTheme\)/);
  // Legacy 'beige' messages are transparently migrated to 'codex'.
  match(SIDEBAR_THEME_SCRIPT, /value === 'beige'\) return 'codex'/);
  match(SIDEBAR_THEME_SCRIPT, /data\.colors/);
  // Exactly the wrapper's own close tag: no theme data may break out of the script.
  strictEqual((SIDEBAR_THEME_SCRIPT.match(/<\/script>/g) || []).length, 1);
  strictEqual((SIDEBAR_THEME_STYLE.match(/<\/style>/g) || []).length, 1);
});
