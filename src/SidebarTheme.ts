/**
 * Theme bridge for the embedded OpenCode web UI.
 *
 * The embedded page is a separate document, so CSS inside the VS Code webview
 * cannot style it. The local proxy injects a style element and a tiny script
 * into the OpenCode HTML document. The script applies data attributes to
 * <html>; the style uses those attributes to override OpenCode's own CSS
 * custom properties without replacing OpenCode's theme engine, routes, or
 * storage.
 *
 * Three modes are supported:
 *
 * - `codex`  A fixed palette that mirrors the Codex sidebar on top of the
 *            `ryjs.gfy-theme` VS Code theme: one unified beige page
 *            (#F2F1EA), a white composer (#FFFFFF), neutral text
 *            (#292929 / #656563) and a light auxiliary tone (#ECEBE4).
 *            `beige` (the previous preference value) is an alias for it.
 * - `vscode` The same semantic hierarchy, but every token that has a VS Code
 *            counterpart is resolved at runtime from the webview's live
 *            `--vscode-*` variables, so any color theme is followed. The
 *            Codex values are the first-paint fallback until the colors
 *            arrive, which keeps the frame from flashing white.
 * - `native` OpenCode's own theme, completely untouched.
 *
 * Internally the palette is expressed as semantic seed tokens (`--ocsw-*`);
 * one shared mapping block translates them into OpenCode's `--v2-*` variables
 * (and the legacy v1 tokens). Declaring the seeds per mode keeps the mapping
 * identical for `codex` and `vscode`, and lets the runtime updater simply
 * override individual seeds inline.
 *
 * This module intentionally has no `vscode` import so it can be unit tested
 * outside an extension host and reused by the proxy.
 */

export type SidebarThemePreference = 'codex' | 'vscode' | 'native';
export type SidebarThemeMode = 'light' | 'dark';

export const SIDEBAR_THEME_QUERY = '__oc_sidebar_theme';
export const SIDEBAR_THEME_MODE_QUERY = '__oc_sidebar_mode';

/**
 * `beige` was the previous default and is migrated to `codex`; unknown or
 * missing values also fall back to `codex` so a typo in settings must never
 * break the panel.
 */
export function normalizeSidebarTheme(value: unknown): SidebarThemePreference {
  if (value === 'native') {
    return 'native';
  }
  if (value === 'vscode') {
    return 'vscode';
  }
  return 'codex';
}

export function normalizeSidebarThemeMode(value: unknown): SidebarThemeMode {
  return value === 'dark' ? 'dark' : 'light';
}

/**
 * Attach the initial theme hint to the iframe URL so the first paint already
 * uses the themed palette (the alternative, postMessage on load, flashes
 * white). Other query parameters (draft IDs, restore hints) are preserved.
 *
 * `native` removes stale hints instead of adding one, leaving OpenCode's own
 * theme untouched. Legacy `beige` values are normalized, so an old caller can
 * never write a stale alias into the URL.
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

  const normalized = normalizeSidebarTheme(preference);
  if (normalized !== 'native') {
    parsed.searchParams.set(SIDEBAR_THEME_QUERY, normalized);
    parsed.searchParams.set(SIDEBAR_THEME_MODE_QUERY, normalizeSidebarThemeMode(mode));
  }

  return parsed.toString();
}

/**
 * Semantic palette seeds. Every value that differs between light and dark
 * lives here; the shared mapping below only references these names.
 *
 * Light mode mirrors the Codex sidebar / gfy-theme palette:
 * page #F2F1EA, composer #FFFFFF, text #292929 / #656563, auxiliary #ECEBE4.
 * Dark mode keeps the established warm ramp with the same hierarchy.
 */
interface SeedTable {
  canvas: string;
  surface: string;
  elev1: string;
  elev2: string;
  elev3: string;
  elev4: string;
  input: string;
  button: string;
  codePath: string;
  text: string;
  textStrong: string;
  textMuted: string;
  textFaint: string;
  textInverse: string;
  iconBase: string;
  iconMuted: string;
  iconFaint: string;
  link: string;
  linkHover: string;
  focus: string;
  accent: string;
  accentFg: string;
  iconContrast: string;
  brand: string;
  brandFg: string;
  scrim: string;
  depthTop: string;
  overlayHover: string;
  overlayPressed: string;
  contrastHover: string;
  contrastPressed: string;
  blue100: string;
  blue300: string;
  blue500: string;
  blue700: string;
  blue1200: string;
  grey50: string;
  grey100: string;
  grey200: string;
  grey300: string;
  grey400: string;
  grey500: string;
  grey600: string;
  grey700: string;
  grey800: string;
  grey900: string;
  grey1000: string;
  grey1100: string;
  grey1200: string;
  successBg: string;
  successFg: string;
  successBorder: string;
  warningBg: string;
  warningFg: string;
  warningBorder: string;
  dangerBg: string;
  dangerFg: string;
  dangerBorder: string;
  infoBg: string;
  infoFg: string;
  infoBorder: string;
}

const CODEX_SEEDS: Record<SidebarThemeMode, SeedTable> = {
  light: {
    canvas: '#F2F1EA',
    surface: '#F2F1EA',
    elev1: '#FAF9F2',
    elev2: '#ECEBE4',
    elev3: '#E3E2DC',
    elev4: '#D9D8D2',
    input: '#FFFFFF',
    button: '#FFFFFF',
    codePath: '#ECEBE4',
    text: '#292929',
    textStrong: '#232323',
    textMuted: '#656563',
    textFaint: '#8C8C8A',
    textInverse: '#F2F1EA',
    iconBase: '#3F3F3D',
    iconMuted: '#6B6B69',
    iconFaint: '#9C9C9A',
    link: '#3F618C',
    linkHover: '#2F4E73',
    focus: '#7E97BC',
    accent: '#423E31',
    accentFg: '#FAF9F2',
    iconContrast: '#423E31',
    brand: '#423E31',
    brandFg: '#FAF9F2',
    scrim: 'rgba(41,41,41,.32)',
    depthTop: '#FAF9F2',
    overlayHover: 'rgba(41,41,41,.045)',
    overlayPressed: 'rgba(41,41,41,.08)',
    contrastHover: 'rgba(250,249,242,.14)',
    contrastPressed: 'rgba(250,249,242,.22)',
    blue100: '#ECEBE4',
    blue300: '#C6C3B9',
    blue500: '#3F618C',
    blue700: '#292929',
    blue1200: '#232323',
    grey50: '#faf9f2',
    grey100: '#f8f7f0',
    grey200: '#f2f1ea',
    grey300: '#ecebe4',
    grey400: '#e3e2dc',
    grey500: '#d9d8d2',
    grey600: '#c6c3b9',
    grey700: '#a8a49a',
    grey800: '#817a71',
    grey900: '#656563',
    grey1000: '#575654',
    grey1100: '#292929',
    grey1200: '#232323',
    successBg: '#edf1e6',
    successFg: '#3f6b3c',
    successBorder: '#cbd8c2',
    warningBg: '#f7eed4',
    warningFg: '#7a6221',
    warningBorder: '#e3d3a7',
    dangerBg: '#f5e4df',
    dangerFg: '#973f34',
    dangerBorder: '#e2c6bd',
    infoBg: '#e8edf3',
    infoFg: '#3f5f80',
    infoBorder: '#c9d4e0',
  },
  dark: {
    canvas: '#1B1916',
    surface: '#1B1916',
    elev1: '#2A2823',
    elev2: '#33312B',
    elev3: '#3D3A33',
    elev4: '#4A463D',
    input: '#24221E',
    button: 'rgba(242,241,234,.06)',
    codePath: '#2C2A24',
    text: '#F2F1EA',
    textStrong: '#FAF9F2',
    textMuted: '#C6C2B4',
    textFaint: '#A8A49A',
    textInverse: '#24221E',
    iconBase: '#E3E2DC',
    iconMuted: '#B0AB9E',
    iconFaint: '#877F73',
    link: '#B9CBE2',
    linkHover: '#D5E0EC',
    focus: '#8FA9C9',
    accent: '#4A6785',
    accentFg: '#F2F1EA',
    iconContrast: '#C6C2B4',
    brand: '#A9BFD8',
    brandFg: '#24221E',
    scrim: 'rgba(0,0,0,.55)',
    depthTop: 'rgba(242,241,234,.10)',
    overlayHover: 'rgba(242,241,234,.06)',
    overlayPressed: 'rgba(242,241,234,.10)',
    contrastHover: 'rgba(21,20,17,.24)',
    contrastPressed: 'rgba(21,20,17,.40)',
    blue100: '#33312B',
    blue300: '#F2F1EA',
    blue500: '#B9CBE2',
    blue700: '#F2F1EA',
    blue1200: '#33312B',
    grey50: '#faf9f2',
    grey100: '#f2f1ea',
    grey200: '#e3e2dc',
    grey300: '#c6c2b4',
    grey400: '#a8a49a',
    grey500: '#817a71',
    grey600: '#5c584f',
    grey700: '#3e3b34',
    grey800: '#302e28',
    grey900: '#2a2823',
    grey1000: '#24221e',
    grey1100: '#1b1916',
    grey1200: '#151411',
    successBg: '#26301f',
    successFg: '#9fd08f',
    successBorder: '#3c5233',
    warningBg: '#332d1e',
    warningFg: '#e2c56e',
    warningBorder: '#5a4d2b',
    dangerBg: '#35231f',
    dangerFg: '#e39a8e',
    dangerBorder: '#613b33',
    infoBg: '#1f2a33',
    infoFg: '#9dbad6',
    infoBorder: '#34495b',
  },
};

const ALPHA_BASES: Record<SidebarThemeMode, { dark: string; light: string }> = {
  light: { dark: '#292929', light: '#faf9f2' },
  dark: { dark: '#151411', light: '#f2f1ea' },
};

const ALPHA_STEPS: Array<[number, string]> = [
  [100, 'ff'], [90, 'e6'], [80, 'cc'], [70, 'b3'], [60, '99'], [50, '80'],
  [40, '66'], [30, '4d'], [24, '3d'], [20, '33'], [16, '29'], [14, '24'],
  [12, '1f'], [10, '1a'], [8, '14'], [6, '0f'], [4, '0a'], [2, '05'], [0, '00'],
];

function alphaRamp(name: 'dark' | 'light', base: string): string {
  return ALPHA_STEPS
    .map(([step, alpha]) => `--v2-alpha-${name}-${step}:${base}${alpha};`)
    .join('');
}

function seedDeclarations(seeds: SeedTable): string {
  const names = Object.keys(seeds) as Array<keyof SeedTable>;
  return names.map(name => `--ocsw-${name}:${seeds[name]};`).join('');
}

function themeBlock(theme: 'codex' | 'vscode', mode: SidebarThemeMode): string {
  const seeds = CODEX_SEEDS[mode];
  const scheme = mode === 'dark' ? 'plus-lighter' : 'multiply';
  return `html[data-oc-sidebar-theme="${theme}"][data-oc-sidebar-mode="${mode}"] {`
    + `color-scheme:${mode} !important;`
    + `background-color:${seeds.canvas} !important;`
    + `--text-mix-blend-mode:${scheme};`
    + seedDeclarations(seeds)
    + alphaRamp('dark', ALPHA_BASES[mode].dark)
    + alphaRamp('light', ALPHA_BASES[mode].light)
    + '}';
}

export const SEED_KEY_NAMES: string[] = Object.keys(CODEX_SEEDS.light);

/**
 * Maps a snapshot of VS Code webview theme colors to palette seeds.
 *
 * This function is embedded verbatim into the injected page script via
 * `Function.prototype.toString()`, therefore it must stay completely
 * self-contained: no imports, no references to module scope, and ES2019-safe
 * syntax. Unknown or malformed values are skipped so the static CSS fallback
 * (the Codex palette for the current mode) stays in charge.
 */
export function buildVscodeSeeds(colors: Record<string, string>): Record<string, string> {
  const valid = (value: string): boolean => {
    return /^#[0-9a-f]{3,8}$/i.test(value)
      || /^rgba?\([0-9.,\s%/]+\)$/i.test(value)
      || /^hsla?\([0-9.,\s%/deg]+\)$/i.test(value);
  };
  const pick = (names: string[]): string => {
    for (const name of names) {
      const value = colors[name];
      if (typeof value === 'string' && valid(value.trim())) {
        return value.trim();
      }
    }
    return '';
  };

  const canvas = pick(['sideBar-background', 'editor-background']);
  const text = pick(['foreground']);
  const elev1 = pick(['menu-background', 'editorWidget-background', 'editor-background']);
  const elev2 = pick(['sideBarSectionHeader-background', 'list-hoverBackground', 'menu-background']);
  const elev3 = pick(['list-hoverBackground', 'sideBarSectionHeader-background']);
  const elev4 = pick(['list-activeSelectionBackground', 'list-hoverBackground']);
  const input = pick(['input-background', 'editor-background']);
  const button = pick(['button-secondaryBackground', 'input-background', 'editor-background']);
  const link = pick(['textLink-foreground', 'focusBorder']);
  const linkHover = pick(['textLink-activeForeground', 'textLink-foreground', 'focusBorder']);
  const focus = pick(['focusBorder', 'textLink-foreground']);
  const accent = pick(['button-background', 'badge-background']);
  const accentFg = pick(['button-foreground', 'badge-foreground']);
  const textMuted = pick(['descriptionForeground', 'foreground']);
  const textFaint = pick(['input-placeholderForeground', 'descriptionForeground', 'foreground']);
  const iconBase = pick(['icon-foreground', 'foreground']);
  const iconMuted = pick(['descriptionForeground', 'icon-foreground']);
  const iconFaint = pick(['input-placeholderForeground', 'icon-foreground']);

  const seeds: Record<string, string> = {};
  const set = (key: string, value: string): void => {
    if (value) {
      seeds[key] = value;
    }
  };

  // Page surfaces stay on one canvas tone (surface === canvas === elev1
  // fallback), matching the codex palette; the composer is the input tone.
  set('canvas', canvas);
  set('surface', canvas);
  set('elev1', elev1);
  set('elev2', elev2);
  set('elev3', elev3);
  set('elev4', elev4);
  set('input', input);
  set('button', button);
  set('codePath', elev2 || elev1);
  set('text', text);
  set('textMuted', textMuted);
  set('textFaint', textFaint);
  set('textInverse', canvas);
  set('iconBase', iconBase || text);
  set('iconMuted', iconMuted || textMuted);
  set('iconFaint', iconFaint || textFaint);
  set('link', link);
  set('linkHover', linkHover || link);
  set('focus', focus || link);
  set('accent', accent);
  set('accentFg', accentFg);
  set('iconContrast', accent || iconBase);
  set('brand', accent);
  set('brandFg', accentFg);
  // OpenCode paints user-message bubbles with its blue ramp; keep them on the
  // neutral auxiliary tone instead of an out-of-place blue.
  set('blue100', elev2 || elev1);
  set('blue300', text);
  set('blue500', linkHover || link);
  set('blue700', text);
  set('blue1200', elev2 || elev1);
  return seeds;
}

/**
 * The shared mapping: one unlayered rule translates the `--ocsw-*` seeds into
 * OpenCode's `--v2-*` variables (plus the legacy v1 tokens). It is identical
 * for both themed modes; only the seeds differ.
 */
const TOKEN_MAPPING = `
  /* Neutral ramp */
  --v2-grey-50:var(--ocsw-grey50);
  --v2-grey-100:var(--ocsw-grey100);
  --v2-grey-200:var(--ocsw-grey200);
  --v2-grey-300:var(--ocsw-grey300);
  --v2-grey-400:var(--ocsw-grey400);
  --v2-grey-500:var(--ocsw-grey500);
  --v2-grey-600:var(--ocsw-grey600);
  --v2-grey-700:var(--ocsw-grey700);
  --v2-grey-800:var(--ocsw-grey800);
  --v2-grey-900:var(--ocsw-grey900);
  --v2-grey-1000:var(--ocsw-grey1000);
  --v2-grey-1100:var(--ocsw-grey1100);
  --v2-grey-1200:var(--ocsw-grey1200);

  /* Backgrounds */
  --v2-background-bg-base:var(--ocsw-surface);
  --v2-background-bg-deep:var(--ocsw-canvas);
  --v2-background-bg-layer-01:var(--ocsw-elev1);
  --v2-background-bg-layer-02:var(--ocsw-elev2);
  --v2-background-bg-layer-03:var(--ocsw-elev3);
  --v2-background-bg-layer-04:var(--ocsw-elev4);
  --v2-background-bg-inverse:var(--ocsw-text);
  --v2-background-bg-contrast:var(--ocsw-accent);
  --v2-background-bg-icon-button-contrast:var(--ocsw-iconContrast);
  --v2-background-bg-button-neutral:var(--ocsw-button);
  --v2-background-bg-accent:var(--ocsw-accent);
  --v2-background-bg-code-path:var(--ocsw-codePath);

  /* Text */
  --v2-text-text-base:var(--ocsw-text);
  --v2-text-text-muted:var(--ocsw-textMuted);
  --v2-text-text-faint:var(--ocsw-textFaint);
  --v2-text-text-inverse:var(--ocsw-textInverse);
  --v2-text-text-contrast:var(--ocsw-accentFg);
  --v2-text-text-accent:var(--ocsw-link);
  --v2-text-text-accent-hover:var(--ocsw-linkHover);
  --v2-text-text-code-accent:var(--ocsw-link);
  --v2-text-text-code-path:var(--ocsw-link);

  /* Icons */
  --v2-icon-icon-base:var(--ocsw-iconBase);
  --v2-icon-icon-muted:var(--ocsw-iconMuted);
  --v2-icon-icon-faint:var(--ocsw-iconFaint);
  --v2-icon-icon-inverse:var(--ocsw-textInverse);
  --v2-icon-icon-contrast:var(--ocsw-accentFg);
  --v2-icon-icon-accent:var(--ocsw-link);
  --v2-icon-icon-accent-hover:var(--ocsw-linkHover);

  /* Borders */
  --v2-border-border-muted:color-mix(in srgb, var(--ocsw-text) 8%, transparent);
  --v2-border-border-base:color-mix(in srgb, var(--ocsw-text) 14%, transparent);
  --v2-border-border-strong:color-mix(in srgb, var(--ocsw-text) 26%, transparent);
  --v2-border-border-inverse:var(--ocsw-accent);
  --v2-border-border-focus:var(--ocsw-focus);

  /* Overlays */
  --v2-overlay-simple-overlay-hover:var(--ocsw-overlayHover);
  --v2-overlay-simple-overlay-pressed:var(--ocsw-overlayPressed);
  --v2-overlay-simple-overlay-contrast-hover:var(--ocsw-contrastHover);
  --v2-overlay-simple-overlay-contrast-pressed:var(--ocsw-contrastPressed);
  --v2-overlay-simple-overlay-scrim:var(--ocsw-scrim);
  --v2-overlay-gradient-depth-overlay-depth-top:var(--ocsw-depthTop);
  --v2-overlay-gradient-depth-overlay-depth-bot:transparent;
  --v2-overlay-simple-tab-active-scrim:transparent;
  --v2-overlay-simple-tab-hover-scrim:transparent;
  --v2-overlay-simple-tab-scrim:transparent;

  /* State */
  --v2-state-bg-success:var(--ocsw-successBg);
  --v2-state-fg-success:var(--ocsw-successFg);
  --v2-state-border-success:var(--ocsw-successBorder);
  --v2-state-bg-warning:var(--ocsw-warningBg);
  --v2-state-fg-warning:var(--ocsw-warningFg);
  --v2-state-border-warning:var(--ocsw-warningBorder);
  --v2-state-bg-danger:var(--ocsw-dangerBg);
  --v2-state-fg-danger:var(--ocsw-dangerFg);
  --v2-state-border-danger:var(--ocsw-dangerBorder);
  --v2-state-bg-info:var(--ocsw-infoBg);
  --v2-state-fg-info:var(--ocsw-infoFg);
  --v2-state-border-info:var(--ocsw-infoBorder);

  --v2-illustration-illustration-layer-01:var(--ocsw-elev2);
  --v2-illustration-illustration-layer-02:var(--ocsw-elev3);
  --v2-illustration-illustration-layer-03:var(--ocsw-elev4);

  /* User-message accents (OpenCode's blue ramp) */
  --v2-blue-100:var(--ocsw-blue100);
  --v2-blue-300:var(--ocsw-blue300);
  --v2-blue-500:var(--ocsw-blue500);
  --v2-blue-700:var(--ocsw-blue700);
  --v2-blue-1200:var(--ocsw-blue1200);

  /* Legacy (OpenCode v1) tokens. V2 reads the --v2-* tokens above. */
  --background-base:var(--ocsw-canvas);
  --background-weak:var(--ocsw-elev1);
  --background-strong:var(--ocsw-elev1);
  --background-stronger:var(--ocsw-elev1);
  --surface-base:color-mix(in srgb, var(--ocsw-text) 4%, transparent);
  --surface-base-hover:color-mix(in srgb, var(--ocsw-text) 7%, transparent);
  --surface-base-active:color-mix(in srgb, var(--ocsw-text) 9%, transparent);
  --surface-raised-base:color-mix(in srgb, var(--ocsw-text) 4%, transparent);
  --surface-raised-base-hover:color-mix(in srgb, var(--ocsw-text) 7%, transparent);
  --surface-raised-base-active:color-mix(in srgb, var(--ocsw-text) 9%, transparent);
  --surface-raised-strong:var(--ocsw-elev1);
  --surface-raised-strong-hover:var(--ocsw-elev1);
  --surface-raised-stronger:var(--ocsw-elev1);
  --surface-raised-stronger-non-alpha:var(--ocsw-elev1);
  --surface-float-base:var(--ocsw-elev1);
  --surface-float-base-hover:var(--ocsw-elev1);
  --surface-strong:var(--ocsw-elev1);
  --surface-brand-base:var(--ocsw-brand);
  --surface-brand-hover:var(--ocsw-brand);
  --surface-interactive-base:var(--ocsw-infoBg);
  --surface-interactive-hover:color-mix(in srgb, var(--ocsw-infoBg) 90%, var(--ocsw-text));
  --surface-success-base:var(--ocsw-successBg);
  --surface-warning-base:var(--ocsw-warningBg);
  --surface-critical-base:var(--ocsw-dangerBg);
  --surface-info-base:var(--ocsw-infoBg);
  --text-base:var(--ocsw-text);
  --text-weak:var(--ocsw-textMuted);
  --text-weaker:var(--ocsw-textFaint);
  --text-strong:var(--ocsw-textStrong);
  --text-invert-base:var(--ocsw-textInverse);
  --text-invert-weak:var(--ocsw-textInverse);
  --text-invert-weaker:var(--ocsw-textInverse);
  --text-interactive-base:var(--ocsw-link);
  --text-on-brand-base:var(--ocsw-brandFg);
  --text-on-interactive-base:var(--ocsw-accentFg);
  --text-on-success-base:var(--ocsw-successFg);
  --text-on-critical-base:var(--ocsw-dangerFg);
  --text-on-warning-base:var(--ocsw-warningFg);
  --text-on-info-base:var(--ocsw-infoFg);
  --border-base:color-mix(in srgb, var(--ocsw-text) 16%, transparent);
  --border-hover:color-mix(in srgb, var(--ocsw-text) 22%, transparent);
  --border-active:color-mix(in srgb, var(--ocsw-text) 28%, transparent);
  --border-selected:var(--ocsw-focus);
  --border-focus:var(--ocsw-focus);
  --border-color:color-mix(in srgb, var(--ocsw-text) 14%, transparent);
  --border-weak-base:color-mix(in srgb, var(--ocsw-text) 10%, transparent);
  --border-weak-hover:color-mix(in srgb, var(--ocsw-text) 14%, transparent);
  --border-weak-active:color-mix(in srgb, var(--ocsw-text) 18%, transparent);
  --border-weak-selected:color-mix(in srgb, var(--ocsw-focus) 50%, transparent);
  --border-weak-focus:var(--ocsw-focus);
  --border-strong-base:color-mix(in srgb, var(--ocsw-text) 28%, transparent);
  --border-strong-hover:color-mix(in srgb, var(--ocsw-text) 34%, transparent);
  --border-strong-active:color-mix(in srgb, var(--ocsw-text) 40%, transparent);
  --border-strong-selected:color-mix(in srgb, var(--ocsw-focus) 60%, transparent);
  --border-weaker-base:color-mix(in srgb, var(--ocsw-text) 5%, transparent);
  --border-interactive-base:var(--ocsw-focus);
  --icon-base:var(--ocsw-iconBase);
  --icon-hover:var(--ocsw-text);
  --icon-active:var(--ocsw-text);
  --icon-selected:var(--ocsw-text);
  --icon-disabled:var(--ocsw-iconFaint);
  --icon-weak-base:var(--ocsw-iconMuted);
  --icon-weak-hover:var(--ocsw-iconBase);
  --icon-strong-base:var(--ocsw-text);
  --icon-invert-base:var(--ocsw-textInverse);
  --icon-brand-base:var(--ocsw-brand);
  --icon-interactive-base:var(--ocsw-link);
  --button-primary-base:var(--ocsw-brand);
  --button-secondary-base:var(--ocsw-elev1);
  --button-secondary-hover:var(--ocsw-elev2);
  --button-ghost-hover:color-mix(in srgb, var(--ocsw-text) 5%, transparent);
  --button-ghost-hover2:color-mix(in srgb, var(--ocsw-text) 8%, transparent);
  --input-base:var(--ocsw-input);
  --input-hover:color-mix(in srgb, var(--ocsw-input) 94%, var(--ocsw-text));
  --input-active:color-mix(in srgb, var(--ocsw-input) 90%, var(--ocsw-text));
  --input-selected:var(--ocsw-elev2);
  --input-focus:var(--ocsw-input);
  --input-disabled:var(--ocsw-elev2);
  --input-border:color-mix(in srgb, var(--ocsw-text) 18%, transparent);
`;

/**
 * Injected at the very start of <head>. It is intentionally unlayered: the
 * OpenCode defaults live in `@layer theme`, so an unlayered attribute selector
 * wins regardless of stylesheet order, including the style element OpenCode
 * writes later.
 */
export const SIDEBAR_THEME_STYLE = `<style id="__ocWebSidebarTheme">
${themeBlock('codex', 'light')}
${themeBlock('codex', 'dark')}
/* The vscode blocks seed the same values as a first-paint fallback; the live
   colors are written inline on <html> as soon as the webview sends them. */
${themeBlock('vscode', 'light')}
${themeBlock('vscode', 'dark')}
html[data-oc-sidebar-theme="codex"], html[data-oc-sidebar-theme="vscode"] {${TOKEN_MAPPING}}
html[data-oc-sidebar-theme="codex"] body, html[data-oc-sidebar-theme="vscode"] body {
  color: var(--ocsw-text);
}
html[data-oc-sidebar-theme="codex"] [data-component="composer"], html[data-oc-sidebar-theme="vscode"] [data-component="composer"] {
  background-color: var(--ocsw-input);
}
html[data-oc-sidebar-theme="codex"] ::selection, html[data-oc-sidebar-theme="vscode"] ::selection {
  background: color-mix(in srgb, var(--ocsw-focus) 30%, transparent);
  color: var(--ocsw-text);
}
</style>`;

/**
 * Applies the initial query hint (before first paint) and listens for live
 * theme changes from the VS Code webview. It only touches data attributes,
 * inline `--ocsw-*` seeds and a meta tag, never OpenCode routes, storage keys,
 * auth, or application state.
 */
export const SIDEBAR_THEME_SCRIPT = `<script id="__ocWebSidebarThemeScript">
(function () {
  var THEME_KEY = '${SIDEBAR_THEME_QUERY}';
  var MODE_KEY = '${SIDEBAR_THEME_MODE_QUERY}';
  var root = document.documentElement;
  var SEED_KEYS = ${JSON.stringify(SEED_KEY_NAMES)};
  var buildSeeds = ${buildVscodeSeeds.toString()};

  function theme(value) {
    if (value === 'beige') return 'codex';
    return value === 'codex' || value === 'vscode' || value === 'native' ? value : '';
  }

  function mode(value) {
    return value === 'light' || value === 'dark' ? value : '';
  }

  function clearSeeds() {
    for (var i = 0; i < SEED_KEYS.length; i++) {
      root.style.removeProperty('--ocsw-' + SEED_KEYS[i]);
    }
  }

  function applySeeds(values) {
    clearSeeds();
    if (!values) return;
    for (var key in values) {
      if (Object.prototype.hasOwnProperty.call(values, key) && typeof values[key] === 'string') {
        root.style.setProperty('--ocsw-' + key, values[key]);
      }
    }
  }

  function setMeta(color) {
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', color);
  }

  function apply(value, scheme, colors) {
    var nextTheme = theme(value);
    var nextMode = mode(scheme);
    if (!nextTheme) return;
    if (nextTheme === 'native') {
      root.setAttribute('data-oc-sidebar-theme', 'native');
      root.removeAttribute('data-oc-sidebar-mode');
      clearSeeds();
      setMeta(nextMode === 'dark' ? '#080808' : '#fafafa');
      return;
    }
    if (!nextMode) return;
    root.setAttribute('data-oc-sidebar-theme', nextTheme);
    root.setAttribute('data-oc-sidebar-mode', nextMode);
    var canvas = nextMode === 'dark' ? '#1b1916' : '#f2f1ea';
    if (nextTheme === 'vscode' && colors) {
      var seedValues = {};
      try { seedValues = buildSeeds(colors); } catch (error) { seedValues = {}; }
      applySeeds(seedValues);
      canvas = seedValues.canvas || canvas;
    } else {
      applySeeds(null);
    }
    setMeta(canvas);
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

  if (initialTheme) apply(initialTheme, initialMode, null);

  window.addEventListener('message', function (event) {
    if (event.source !== window.parent) return;
    var data = event.data;
    if (!data || data.type !== 'ocSidebarTheme') return;
    apply(data.theme, data.mode, data.colors);
  });
})();
</script>`;
