/**
 * Beige theme bridge for the embedded OpenCode web UI.
 *
 * The embedded page is a separate document, so CSS inside the VS Code webview
 * cannot style it. The local proxy injects a style element and a tiny script
 * into the OpenCode HTML document. The script applies a data attribute to
 * <html>; the style uses that attribute to override OpenCode's own CSS custom
 * properties without replacing OpenCode's theme engine, routes, or storage.
 *
 * The palette mirrors the user's `ryjs.gfy-theme` VS Code theme so the iframe
 * blends into the sidebar instead of showing OpenCode's white OC-2 surfaces.
 *
 * This module intentionally has no `vscode` import so it can be unit tested
 * outside an extension host and reused by the proxy.
 */

export type SidebarThemePreference = 'beige' | 'native';
export type SidebarThemeMode = 'light' | 'dark';

export const SIDEBAR_THEME_QUERY = '__oc_sidebar_theme';
export const SIDEBAR_THEME_MODE_QUERY = '__oc_sidebar_mode';

export function normalizeSidebarTheme(value: unknown): SidebarThemePreference {
  return value === 'native' ? 'native' : 'beige';
}

export function normalizeSidebarThemeMode(value: unknown): SidebarThemeMode {
  return value === 'dark' ? 'dark' : 'light';
}

/**
 * Attach the initial theme hint to the iframe URL so the first paint already
 * uses the beige palette (the alternative, postMessage on load, flashes white).
 *
 * Other query parameters (draft IDs, restore hints) are preserved. `native`
 * removes stale hints instead of adding one, leaving OpenCode's own theme
 * untouched.
 */
export function withSidebarTheme(
  url: string,
  preference: SidebarThemePreference,
  mode: SidebarThemeMode,
): string {
  if (!url) {
    return url;
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }

  parsed.searchParams.delete(SIDEBAR_THEME_QUERY);
  parsed.searchParams.delete(SIDEBAR_THEME_MODE_QUERY);

  if (preference === 'beige') {
    parsed.searchParams.set(SIDEBAR_THEME_QUERY, 'beige');
    parsed.searchParams.set(SIDEBAR_THEME_MODE_QUERY, normalizeSidebarThemeMode(mode));
  }

  return parsed.toString();
}

const ALPHA_DARK_LIGHT = `
  --v2-alpha-dark-100:#2f2b26;
  --v2-alpha-dark-90:#2f2b26e6;
  --v2-alpha-dark-80:#2f2b26cc;
  --v2-alpha-dark-70:#2f2b26b3;
  --v2-alpha-dark-60:#2f2b2699;
  --v2-alpha-dark-50:#2f2b2680;
  --v2-alpha-dark-40:#2f2b2666;
  --v2-alpha-dark-30:#2f2b264d;
  --v2-alpha-dark-24:#2f2b263d;
  --v2-alpha-dark-20:#2f2b2633;
  --v2-alpha-dark-16:#2f2b2629;
  --v2-alpha-dark-14:#2f2b2624;
  --v2-alpha-dark-12:#2f2b261f;
  --v2-alpha-dark-10:#2f2b261a;
  --v2-alpha-dark-8:#2f2b2614;
  --v2-alpha-dark-6:#2f2b260f;
  --v2-alpha-dark-4:#2f2b260a;
  --v2-alpha-dark-2:#2f2b2605;
  --v2-alpha-dark-0:#2f2b2600;
  --v2-alpha-light-100:#faf9f2;
  --v2-alpha-light-90:#faf9f2e6;
  --v2-alpha-light-80:#faf9f2cc;
  --v2-alpha-light-70:#faf9f2b3;
  --v2-alpha-light-60:#faf9f299;
  --v2-alpha-light-50:#faf9f280;
  --v2-alpha-light-40:#faf9f266;
  --v2-alpha-light-30:#faf9f24d;
  --v2-alpha-light-24:#faf9f23d;
  --v2-alpha-light-20:#faf9f233;
  --v2-alpha-light-16:#faf9f229;
  --v2-alpha-light-14:#faf9f224;
  --v2-alpha-light-12:#faf9f21f;
  --v2-alpha-light-10:#faf9f21a;
  --v2-alpha-light-8:#faf9f214;
  --v2-alpha-light-6:#faf9f20f;
  --v2-alpha-light-4:#faf9f20a;
  --v2-alpha-light-2:#faf9f205;
  --v2-alpha-light-0:#faf9f200;
`;

const ALPHA_DARK_DARK = `
  --v2-alpha-dark-100:#151411;
  --v2-alpha-dark-90:#151411e6;
  --v2-alpha-dark-80:#151411cc;
  --v2-alpha-dark-70:#151411b3;
  --v2-alpha-dark-60:#15141199;
  --v2-alpha-dark-50:#15141180;
  --v2-alpha-dark-40:#15141166;
  --v2-alpha-dark-30:#1514114d;
  --v2-alpha-dark-24:#1514113d;
  --v2-alpha-dark-20:#15141133;
  --v2-alpha-dark-16:#15141129;
  --v2-alpha-dark-14:#15141124;
  --v2-alpha-dark-12:#1514111f;
  --v2-alpha-dark-10:#1514111a;
  --v2-alpha-dark-8:#15141114;
  --v2-alpha-dark-6:#1514110f;
  --v2-alpha-dark-4:#1514110a;
  --v2-alpha-dark-2:#15141105;
  --v2-alpha-dark-0:#15141100;
  --v2-alpha-light-100:#f2f1ea;
  --v2-alpha-light-90:#f2f1eae6;
  --v2-alpha-light-80:#f2f1eacc;
  --v2-alpha-light-70:#f2f1eab3;
  --v2-alpha-light-60:#f2f1ea99;
  --v2-alpha-light-50:#f2f1ea80;
  --v2-alpha-light-40:#f2f1ea66;
  --v2-alpha-light-30:#f2f1ea4d;
  --v2-alpha-light-24:#f2f1ea3d;
  --v2-alpha-light-20:#f2f1ea33;
  --v2-alpha-light-16:#f2f1ea29;
  --v2-alpha-light-14:#f2f1ea24;
  --v2-alpha-light-12:#f2f1ea1f;
  --v2-alpha-light-10:#f2f1ea1a;
  --v2-alpha-light-8:#f2f1ea14;
  --v2-alpha-light-6:#f2f1ea0f;
  --v2-alpha-light-4:#f2f1ea0a;
  --v2-alpha-light-2:#f2f1ea05;
  --v2-alpha-light-0:#f2f1ea00;
`;

const LIGHT_THEME = `
  color-scheme: light !important;
  background-color: #f2f1ea !important;
  --text-mix-blend-mode: multiply;

  /* Neutral ramp: 100 = lightest, 1200 = darkest. */
  --v2-grey-50:#faf9f2;
  --v2-grey-100:#f8f7f0;
  --v2-grey-200:#f2f1ea;
  --v2-grey-300:#ecebe4;
  --v2-grey-400:#e3e2dc;
  --v2-grey-500:#d9d8d2;
  --v2-grey-600:#c6c3b9;
  --v2-grey-700:#a8a49a;
  --v2-grey-800:#817a71;
  --v2-grey-900:#6b655d;
  --v2-grey-1000:#57564f;
  --v2-grey-1100:#2f2b26;
  --v2-grey-1200:#24211d;

  /* Backgrounds */
  --v2-background-bg-base:#faf9f2;
  --v2-background-bg-deep:#f2f1ea;
  --v2-background-bg-layer-01:#f4f3ec;
  --v2-background-bg-layer-02:#ecebe4;
  --v2-background-bg-layer-03:#e3e2dc;
  --v2-background-bg-layer-04:#d9d8d2;
  --v2-background-bg-inverse:#2f2b26;
  --v2-background-bg-contrast:#423e31;
  --v2-background-bg-icon-button-contrast:#423e31;
  --v2-background-bg-button-neutral:#faf9f2;
  --v2-background-bg-accent:#423e31;
  --v2-background-bg-code-path:#f1efe4;

  /* Text */
  --v2-text-text-base:#2f2b26;
  --v2-text-text-muted:#6b655d;
  --v2-text-text-faint:#8a8478;
  --v2-text-text-inverse:#faf9f2;
  --v2-text-text-contrast:#faf9f2;
  --v2-text-text-accent:#3f618c;
  --v2-text-text-accent-hover:#2f4e73;
  --v2-text-text-code-accent:#3f5f80;
  --v2-text-text-code-path:#3f5f80;

  /* Icons */
  --v2-icon-icon-base:#514f48;
  --v2-icon-icon-muted:#7e7a70;
  --v2-icon-icon-faint:#a8a49a;
  --v2-icon-icon-inverse:#faf9f2;
  --v2-icon-icon-contrast:#faf9f2;
  --v2-icon-icon-accent:#4a6785;
  --v2-icon-icon-accent-hover:#3f618c;

  /* Borders */
  --v2-border-border-muted:rgba(47,43,38,.08);
  --v2-border-border-base:rgba(47,43,38,.14);
  --v2-border-border-strong:rgba(47,43,38,.26);
  --v2-border-border-inverse:#423e31;
  --v2-border-border-focus:#7e97bc;

  /* Overlays */
  --v2-overlay-simple-overlay-hover:rgba(47,43,38,.045);
  --v2-overlay-simple-overlay-pressed:rgba(47,43,38,.08);
  --v2-overlay-simple-overlay-contrast-hover:rgba(250,249,242,.14);
  --v2-overlay-simple-overlay-contrast-pressed:rgba(250,249,242,.22);
  --v2-overlay-simple-overlay-scrim:rgba(47,43,38,.32);
  --v2-overlay-gradient-depth-overlay-depth-top:#faf9f2;
  --v2-overlay-gradient-depth-overlay-depth-bot:#faf9f200;
  --v2-overlay-simple-tab-active-scrim:#faf9f200;
  --v2-overlay-simple-tab-hover-scrim:#ecebe400;
  --v2-overlay-simple-tab-scrim:#f2f1ea00;

  /* State */
  --v2-state-bg-success:#edf1e6;
  --v2-state-fg-success:#3f6b3c;
  --v2-state-border-success:#cbd8c2;
  --v2-state-bg-warning:#f7eed4;
  --v2-state-fg-warning:#7a6221;
  --v2-state-border-warning:#e3d3a7;
  --v2-state-bg-danger:#f5e4df;
  --v2-state-fg-danger:#973f34;
  --v2-state-border-danger:#e2c6bd;
  --v2-state-bg-info:#e8edf3;
  --v2-state-fg-info:#3f5f80;
  --v2-state-border-info:#c9d4e0;

  --v2-illustration-illustration-layer-01:#ecebe4;
  --v2-illustration-illustration-layer-02:#e3e2dc;
  --v2-illustration-illustration-layer-03:#d9d8d2;

  /* Legacy (OpenCode v1) tokens. V2 reads the --v2-* tokens above. */
  --background-base:#f2f1ea;
  --background-weak:#f8f7f0;
  --background-strong:#faf9f2;
  --background-stronger:#faf9f2;
  --surface-base:rgba(47,43,38,.04);
  --surface-base-hover:rgba(47,43,38,.07);
  --surface-base-active:rgba(47,43,38,.09);
  --surface-raised-base:rgba(47,43,38,.04);
  --surface-raised-base-hover:rgba(47,43,38,.07);
  --surface-raised-base-active:rgba(47,43,38,.09);
  --surface-raised-strong:#faf9f2;
  --surface-raised-strong-hover:#fffdf7;
  --surface-raised-stronger:#fffdf7;
  --surface-raised-stronger-non-alpha:#fffdf7;
  --surface-float-base:#faf9f2;
  --surface-float-base-hover:#fffdf7;
  --surface-strong:#fffdf7;
  --surface-brand-base:#423e31;
  --surface-brand-hover:#514f48;
  --surface-interactive-base:#e7ecf3;
  --surface-interactive-hover:#dce4ee;
  --surface-success-base:#edf1e6;
  --surface-warning-base:#f7eed4;
  --surface-critical-base:#f5e4df;
  --surface-info-base:#e8edf3;
  --text-base:#2f2b26;
  --text-weak:#6b655d;
  --text-weaker:#8a8478;
  --text-strong:#24211d;
  --text-invert-base:#faf9f2;
  --text-invert-weak:#f2f1ea;
  --text-invert-weaker:#e3e2dc;
  --text-interactive-base:#3f618c;
  --text-on-brand-base:#faf9f2;
  --text-on-interactive-base:#faf9f2;
  --text-on-success-base:#2f3d2a;
  --text-on-critical-base:#41201b;
  --text-on-warning-base:#3b3015;
  --text-on-info-base:#24384f;
  --border-base:rgba(47,43,38,.16);
  --border-hover:rgba(47,43,38,.22);
  --border-active:rgba(47,43,38,.28);
  --border-selected:#7e97bc;
  --border-focus:#7e97bc;
  --border-color:#dad9d2;
  --border-weak-base:rgba(47,43,38,.10);
  --border-weak-hover:rgba(47,43,38,.14);
  --border-weak-active:rgba(47,43,38,.18);
  --border-weak-selected:rgba(126,151,188,.5);
  --border-weak-focus:#7e97bc;
  --border-strong-base:rgba(47,43,38,.28);
  --border-strong-hover:rgba(47,43,38,.34);
  --border-strong-active:rgba(47,43,38,.40);
  --border-strong-selected:rgba(126,151,188,.6);
  --border-weaker-base:rgba(47,43,38,.05);
  --border-interactive-base:#7e97bc;
  --icon-base:#514f48;
  --icon-hover:#2f2b26;
  --icon-active:#24211d;
  --icon-selected:#24211d;
  --icon-disabled:#a8a49a;
  --icon-weak-base:#817a71;
  --icon-weak-hover:#514f48;
  --icon-strong-base:#24211d;
  --icon-invert-base:#faf9f2;
  --icon-brand-base:#423e31;
  --icon-interactive-base:#4a6785;
  --button-primary-base:#423e31;
  --button-secondary-base:#faf9f2;
  --button-secondary-hover:#f2f1ea;
  --button-ghost-hover:rgba(47,43,38,.05);
  --button-ghost-hover2:rgba(47,43,38,.08);
  --input-base:#faf9f2;
  --input-hover:#f8f7f0;
  --input-active:#f2f1ea;
  --input-selected:#e3e2dc;
  --input-focus:#faf9f2;
  --input-disabled:#ecebe4;
  --input-border:rgba(47,43,38,.18);
` + ALPHA_DARK_LIGHT;

const DARK_THEME = `
  color-scheme: dark !important;
  background-color: #1b1916 !important;
  --text-mix-blend-mode: plus-lighter;

  /* Neutral ramp: 100 = lightest, 1200 = darkest. */
  --v2-grey-50:#faf9f2;
  --v2-grey-100:#f2f1ea;
  --v2-grey-200:#e3e2dc;
  --v2-grey-300:#c6c2b4;
  --v2-grey-400:#a8a49a;
  --v2-grey-500:#817a71;
  --v2-grey-600:#5c584f;
  --v2-grey-700:#3e3b34;
  --v2-grey-800:#302e28;
  --v2-grey-900:#2a2823;
  --v2-grey-1000:#24221e;
  --v2-grey-1100:#1b1916;
  --v2-grey-1200:#151411;

  /* Backgrounds */
  --v2-background-bg-base:#24221e;
  --v2-background-bg-deep:#1b1916;
  --v2-background-bg-layer-01:#2a2823;
  --v2-background-bg-layer-02:#33312b;
  --v2-background-bg-layer-03:#3d3a33;
  --v2-background-bg-layer-04:#4a463d;
  --v2-background-bg-inverse:#f2f1ea;
  --v2-background-bg-contrast:#3e3b34;
  --v2-background-bg-icon-button-contrast:#c6c2b4;
  --v2-background-bg-button-neutral:rgba(242,241,234,.06);
  --v2-background-bg-accent:#4a6785;
  --v2-background-bg-code-path:#2c2a24;

  /* Text */
  --v2-text-text-base:#f2f1ea;
  --v2-text-text-muted:#c6c2b4;
  --v2-text-text-faint:#a8a49a;
  --v2-text-text-inverse:#24221e;
  --v2-text-text-contrast:#faf9f2;
  --v2-text-text-accent:#b9cbe2;
  --v2-text-text-accent-hover:#d5e0ec;
  --v2-text-text-code-accent:#c3d3e6;
  --v2-text-text-code-path:#c3d3e6;

  /* Icons */
  --v2-icon-icon-base:#e3e2dc;
  --v2-icon-icon-muted:#b0ab9e;
  --v2-icon-icon-faint:#877f73;
  --v2-icon-icon-inverse:#24221e;
  --v2-icon-icon-contrast:#faf9f2;
  --v2-icon-icon-accent:#a9bfd8;
  --v2-icon-icon-accent-hover:#c3d3e6;

  /* Borders */
  --v2-border-border-muted:rgba(242,241,234,.08);
  --v2-border-border-base:rgba(242,241,234,.13);
  --v2-border-border-strong:rgba(242,241,234,.26);
  --v2-border-border-inverse:#f2f1ea;
  --v2-border-border-focus:#8fa9c9;

  /* Overlays */
  --v2-overlay-simple-overlay-hover:rgba(242,241,234,.06);
  --v2-overlay-simple-overlay-pressed:rgba(242,241,234,.10);
  --v2-overlay-simple-overlay-contrast-hover:rgba(21,20,17,.24);
  --v2-overlay-simple-overlay-contrast-pressed:rgba(21,20,17,.40);
  --v2-overlay-simple-overlay-scrim:rgba(0,0,0,.55);
  --v2-overlay-gradient-depth-overlay-depth-top:rgba(242,241,234,.10);
  --v2-overlay-gradient-depth-overlay-depth-bot:rgba(242,241,234,0);
  --v2-overlay-simple-tab-active-scrim:#24221e00;
  --v2-overlay-simple-tab-hover-scrim:#3d3a3300;
  --v2-overlay-simple-tab-scrim:#1b191600;

  /* State */
  --v2-state-bg-success:#26301f;
  --v2-state-fg-success:#9fd08f;
  --v2-state-border-success:#3c5233;
  --v2-state-bg-warning:#332d1e;
  --v2-state-fg-warning:#e2c56e;
  --v2-state-border-warning:#5a4d2b;
  --v2-state-bg-danger:#35231f;
  --v2-state-fg-danger:#e39a8e;
  --v2-state-border-danger:#613b33;
  --v2-state-bg-info:#1f2a33;
  --v2-state-fg-info:#9dbad6;
  --v2-state-border-info:#34495b;

  --v2-illustration-illustration-layer-01:#3d3a33;
  --v2-illustration-illustration-layer-02:#4a463d;
  --v2-illustration-illustration-layer-03:#5c584f;

  /* Legacy (OpenCode v1) tokens. */
  --background-base:#1b1916;
  --background-weak:#24221e;
  --background-strong:#2a2823;
  --background-stronger:#302e28;
  --surface-base:rgba(242,241,234,.04);
  --surface-base-hover:rgba(242,241,234,.07);
  --surface-base-active:rgba(242,241,234,.09);
  --surface-raised-base:rgba(242,241,234,.04);
  --surface-raised-base-hover:rgba(242,241,234,.07);
  --surface-raised-base-active:rgba(242,241,234,.09);
  --surface-raised-strong:#2a2823;
  --surface-raised-strong-hover:#33312b;
  --surface-raised-stronger:#33312b;
  --surface-raised-stronger-non-alpha:#33312b;
  --surface-float-base:#302e28;
  --surface-float-base-hover:#3d3a33;
  --surface-strong:#33312b;
  --surface-brand-base:#a9bfd8;
  --surface-brand-hover:#c3d3e6;
  --surface-interactive-base:#26303a;
  --surface-interactive-hover:#2f3d4a;
  --surface-success-base:#26301f;
  --surface-warning-base:#332d1e;
  --surface-critical-base:#35231f;
  --surface-info-base:#1f2a33;
  --text-base:#f2f1ea;
  --text-weak:#c6c2b4;
  --text-weaker:#a8a49a;
  --text-strong:#faf9f2;
  --text-invert-base:#24221e;
  --text-invert-weak:#2a2823;
  --text-invert-weaker:#3d3a33;
  --text-interactive-base:#b9cbe2;
  --text-on-brand-base:#24221e;
  --text-on-interactive-base:#faf9f2;
  --text-on-success-base:#dfe9d8;
  --text-on-critical-base:#f3ddd8;
  --text-on-warning-base:#f3e8c8;
  --text-on-info-base:#dbe6ef;
  --border-base:rgba(242,241,234,.16);
  --border-hover:rgba(242,241,234,.22);
  --border-active:rgba(242,241,234,.28);
  --border-selected:#8fa9c9;
  --border-focus:#8fa9c9;
  --border-color:#3e3b34;
  --border-weak-base:rgba(242,241,234,.10);
  --border-weak-hover:rgba(242,241,234,.14);
  --border-weak-active:rgba(242,241,234,.18);
  --border-weak-selected:rgba(143,169,201,.5);
  --border-weak-focus:#8fa9c9;
  --border-strong-base:rgba(242,241,234,.28);
  --border-strong-hover:rgba(242,241,234,.34);
  --border-strong-active:rgba(242,241,234,.40);
  --border-strong-selected:rgba(143,169,201,.6);
  --border-weaker-base:rgba(242,241,234,.05);
  --border-interactive-base:#8fa9c9;
  --icon-base:#e3e2dc;
  --icon-hover:#f2f1ea;
  --icon-active:#faf9f2;
  --icon-selected:#faf9f2;
  --icon-disabled:#877f73;
  --icon-weak-base:#b0ab9e;
  --icon-weak-hover:#e3e2dc;
  --icon-strong-base:#faf9f2;
  --icon-invert-base:#24221e;
  --icon-brand-base:#a9bfd8;
  --icon-interactive-base:#a9bfd8;
  --button-primary-base:#a9bfd8;
  --button-secondary-base:#2a2823;
  --button-secondary-hover:#33312b;
  --button-ghost-hover:rgba(242,241,234,.05);
  --button-ghost-hover2:rgba(242,241,234,.08);
  --input-base:#24221e;
  --input-hover:#2a2823;
  --input-active:#33312b;
  --input-selected:#3d3a33;
  --input-focus:#24221e;
  --input-disabled:#2a2823;
  --input-border:rgba(242,241,234,.18);
` + ALPHA_DARK_DARK;

/**
 * Injected at the very start of <head>. It is intentionally unlayered: the
 * OpenCode defaults live in `@layer theme`, so an unlayered attribute selector
 * wins regardless of stylesheet order, including the style element OpenCode
 * writes later.
 */
export const SIDEBAR_THEME_STYLE = `<style id="__ocWebSidebarTheme">
html[data-oc-sidebar-theme="beige"][data-oc-sidebar-mode="light"] {${LIGHT_THEME}}
html[data-oc-sidebar-theme="beige"][data-oc-sidebar-mode="dark"] {${DARK_THEME}}
html[data-oc-sidebar-theme="beige"] body {
  color: var(--v2-text-text-base);
}
html[data-oc-sidebar-theme="beige"] ::selection {
  background: rgba(126,151,188,.28);
  color: #2f2b26;
}
html[data-oc-sidebar-theme="beige"][data-oc-sidebar-mode="dark"] ::selection {
  background: rgba(143,169,201,.34);
  color: #faf9f2;
}
</style>`;

/**
 * Applies the initial query hint (before first paint) and listens for live
 * theme changes from the VS Code webview. It only touches data attributes and
 * a meta tag, never OpenCode routes, storage keys, auth, or application state.
 */
export const SIDEBAR_THEME_SCRIPT = `<script id="__ocWebSidebarThemeScript">
(function () {
  var THEME_KEY = '${SIDEBAR_THEME_QUERY}';
  var MODE_KEY = '${SIDEBAR_THEME_MODE_QUERY}';
  var root = document.documentElement;

  function theme(value) {
    return value === 'beige' || value === 'native' ? value : '';
  }

  function mode(value) {
    return value === 'light' || value === 'dark' ? value : '';
  }

  function apply(value, scheme) {
    var nextTheme = theme(value);
    var nextMode = mode(scheme);
    if (!nextTheme) return;
    root.setAttribute('data-oc-sidebar-theme', nextTheme);
    if (nextTheme === 'native') {
      root.removeAttribute('data-oc-sidebar-mode');
      setMeta(nextMode === 'dark' ? '#080808' : '#fafafa');
      return;
    }
    if (!nextMode) return;
    root.setAttribute('data-oc-sidebar-mode', nextMode);
    setMeta(nextMode === 'dark' ? '#1b1916' : '#f2f1ea');
  }

  function setMeta(color) {
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', color);
  }

  var initialTheme = '';
  var initialMode = '';
  try {
    var url = new URL(location.href);
    initialTheme = theme(url.searchParams.get(THEME_KEY));
    initialMode = mode(url.searchParams.get(MODE_KEY));
    if (url.searchParams.has(THEME_KEY) || url.searchParams.has(MODE_KEY)) {
      url.searchParams.delete(THEME_KEY);
      url.searchParams.delete(MODE_KEY);
      var query = url.searchParams.toString();
      history.replaceState(history.state, '', url.pathname + (query ? '?' + query : '') + url.hash);
    }
  } catch (error) {
    // A malformed or opaque URL must not prevent OpenCode from starting.
  }

  if (initialTheme) apply(initialTheme, initialMode);

  window.addEventListener('message', function (event) {
    if (event.source !== window.parent) return;
    var data = event.data;
    if (!data || data.type !== 'ocSidebarTheme') return;
    apply(data.theme, data.mode);
  });
})();
</script>`;
