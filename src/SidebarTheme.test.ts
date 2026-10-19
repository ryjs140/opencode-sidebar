import { strictEqual, match, ok } from 'node:assert';
import { test } from 'node:test';
import {
  normalizeSidebarTheme,
  normalizeSidebarThemeMode,
  withSidebarTheme,
  SIDEBAR_THEME_QUERY,
  SIDEBAR_THEME_MODE_QUERY,
  SIDEBAR_THEME_SCRIPT,
  SIDEBAR_THEME_STYLE,
} from './SidebarTheme';

test('theme preference defaults to beige and only accepts native as an alternative', () => {
  strictEqual(normalizeSidebarTheme('beige'), 'beige');
  strictEqual(normalizeSidebarTheme('native'), 'native');
  strictEqual(normalizeSidebarTheme('dark'), 'beige');
  strictEqual(normalizeSidebarTheme(undefined), 'beige');
  strictEqual(normalizeSidebarTheme(null), 'beige');
});

test('theme mode only accepts dark as an alternative', () => {
  strictEqual(normalizeSidebarThemeMode('dark'), 'dark');
  strictEqual(normalizeSidebarThemeMode('light'), 'light');
  strictEqual(normalizeSidebarThemeMode('system'), 'light');
  strictEqual(normalizeSidebarThemeMode(undefined), 'light');
});

test('beige theme appends both hints and keeps existing bootstrap parameters', () => {
  const url = withSidebarTheme(
    'http://127.0.0.1:4109/?_ocWorkspace=%2Ftmp%2Fmy%20project&_ocRestore=%2F',
    'beige',
    'light',
  );
  const parsed = new URL(url);
  strictEqual(parsed.searchParams.get(SIDEBAR_THEME_QUERY), 'beige');
  strictEqual(parsed.searchParams.get(SIDEBAR_THEME_MODE_QUERY), 'light');
  strictEqual(parsed.searchParams.get('_ocWorkspace'), '/tmp/my project');
  strictEqual(parsed.searchParams.get('_ocRestore'), '/');
});

test('choosing native removes stale hints instead of adding them', () => {
  const url = withSidebarTheme(
    'http://127.0.0.1:4109/session/abc?__oc_sidebar_theme=beige&__oc_sidebar_mode=dark',
    'native',
    'dark',
  );
  const parsed = new URL(url);
  strictEqual(parsed.searchParams.has(SIDEBAR_THEME_QUERY), false);
  strictEqual(parsed.searchParams.has(SIDEBAR_THEME_MODE_QUERY), false);
  strictEqual(parsed.pathname, '/session/abc');
});

test('theme hints survive an empty or malformed iframe URL unchanged', () => {
  strictEqual(withSidebarTheme('', 'beige', 'light'), '');
  strictEqual(withSidebarTheme('not a url', 'beige', 'light'), 'not a url');
});

test('injected stylesheet targets both beige modes with the sepia palette', () => {
  match(SIDEBAR_THEME_STYLE, /html\[data-oc-sidebar-theme="beige"\]\[data-oc-sidebar-mode="light"\]/);
  match(SIDEBAR_THEME_STYLE, /html\[data-oc-sidebar-theme="beige"\]\[data-oc-sidebar-mode="dark"\]/);
  ok(SIDEBAR_THEME_STYLE.includes('--v2-background-bg-deep:#f2f1ea'));
  ok(SIDEBAR_THEME_STYLE.includes('--v2-text-text-base:#2f2b26'));
  ok(SIDEBAR_THEME_STYLE.includes('--v2-grey-1200:#24211d'));
  ok(SIDEBAR_THEME_STYLE.includes('--v2-background-bg-deep:#1b1916'));
  // The palette must not leak into the page without the opt-in attribute.
  ok(!/^\s*html\s*\{/m.test(SIDEBAR_THEME_STYLE));
});

test('injected script consumes the URL hint before the app starts and reacts to parent messages', () => {
  ok(SIDEBAR_THEME_SCRIPT.includes(SIDEBAR_THEME_QUERY));
  ok(SIDEBAR_THEME_SCRIPT.includes(SIDEBAR_THEME_MODE_QUERY));
  match(SIDEBAR_THEME_SCRIPT, /history\.replaceState/);
  match(SIDEBAR_THEME_SCRIPT, /event\.source !== window\.parent/);
  match(SIDEBAR_THEME_SCRIPT, /data\.type !== 'ocSidebarTheme'/);
  match(SIDEBAR_THEME_SCRIPT, /root\.setAttribute\('data-oc-sidebar-theme', nextTheme\)/);
  // Exactly the wrapper's own close tag: no theme data may break out of the script.
  strictEqual((SIDEBAR_THEME_SCRIPT.match(/<\/script>/g) || []).length, 1);
  strictEqual((SIDEBAR_THEME_STYLE.match(/<\/style>/g) || []).length, 1);
});
