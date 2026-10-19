// Optional real-browser theme test. No project dependencies are added.
// OPENCODE_BINARY=/path/to/opencode PLAYWRIGHT_MODULE=/path/to/playwright node scripts/verify-theme.cjs
//
// Starts an isolated OpenCode V2 server, serves it through the extension's real
// proxy (including the injected theme style/script), and verifies the Codex
// palette, the live light/dark switch, the "follow VS Code" runtime palette,
// the untouched native mode, and the workspace/draft bootstrap.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sidebar-theme-smoke-'));
// Keep shared proxy metadata separate from the user's running extension.
os.homedir = () => root;
const { getOrCreateProxy } = require('../out/ProxyServer');
const { withSidebarTheme } = require('../out/SidebarTheme');
const directory = process.env.TEST_WORKSPACE || path.join(root, 'Traffic monitor');
if (!process.env.TEST_WORKSPACE) fs.mkdirSync(directory);
const env = { ...process.env, XDG_DATA_HOME: root + '/data', XDG_STATE_HOME: root + '/state', XDG_CACHE_HOME: root + '/cache', XDG_CONFIG_HOME: root + '/config' };
const service = spawn(process.env.OPENCODE_BINARY, ['serve', '--hostname', '127.0.0.1', '--port', '0'], { env, cwd: root });
console.log('Artifacts:', root);
let browser, proxy;
let output = '';
const ready = new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Test server startup timeout')), 30000);
  function consume(chunk) {
    output += chunk.toString();
    const address = /server listening on (http:\/\/[^\s]+)/.exec(output);
    const password = /server password ([^\s]+)/.exec(output);
    if (address && password) { clearTimeout(timer); resolve({ address: address[1], password: password[1] }); }
  }
  service.stdout.on('data', consume); service.stderr.on('data', consume);
  service.on('exit', code => { clearTimeout(timer); reject(new Error('Test server exited: ' + code)); });
});
const readPalette = page => page.evaluate(() => {
  const rootStyle = getComputedStyle(document.documentElement);
  const read = name => rootStyle.getPropertyValue(name).trim().toLowerCase();
  const background = selector => {
    const el = document.querySelector(selector);
    return el ? getComputedStyle(el).backgroundColor : null;
  };
  return {
    theme: document.documentElement.getAttribute('data-oc-sidebar-theme'),
    mode: document.documentElement.getAttribute('data-oc-sidebar-mode'),
    deep: read('--v2-background-bg-deep'),
    base: read('--v2-background-bg-base'),
    layer2: read('--v2-background-bg-layer-02'),
    text: read('--v2-text-text-base'),
    muted: read('--v2-text-text-muted'),
    borderBase: read('--v2-border-border-base'),
    inlineCanvas: document.documentElement.style.getPropertyValue('--ocsw-canvas').trim(),
    inlineText: document.documentElement.style.getPropertyValue('--ocsw-text').trim(),
    inlineInput: document.documentElement.style.getPropertyValue('--ocsw-input').trim(),
    pageBackground: rootStyle.backgroundColor,
    bodyBackground: getComputedStyle(document.body).backgroundColor,
    composerBackground: background('[data-component="composer"]'),
    cardBackground: background('[data-component="new-session"]'),
    loadId: window.__ocLoadId || null,
    stylePresent: !!document.getElementById('__ocWebSidebarTheme'),
    scriptPresent: !!document.getElementById('__ocWebSidebarThemeScript'),
  };
});
const postTheme = (page, theme, mode, colors) => page.evaluate(
  ({ theme, mode, colors }) => window.postMessage({ type: 'ocSidebarTheme', theme, mode, colors, source: 'vscode' }, '*'),
  { theme, mode, colors },
);
const markLoad = page => page.evaluate(() => { window.__ocLoadId = Math.random().toString(36).slice(2); });
const sameLoad = (before, after) => assert.equal(after.loadId, before.loadId, 'the live update must not reload the document');
const GFY = {
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
};
const DARK_SAMPLE = {
  'sideBar-background': '#202124',
  'editor-background': '#27282b',
  'foreground': '#e8eaed',
  'descriptionForeground': '#9aa0a6',
  'input-background': '#303134',
  'menu-background': '#292a2d',
  'sideBarSectionHeader-background': '#292a2d',
  'list-hoverBackground': '#2d2e31',
  'list-activeSelectionBackground': '#3c4043',
  'focusBorder': '#8ab4f8',
  'button-background': '#8ab4f8',
  'button-foreground': '#202124',
};
(async () => {
  const { address, password } = await ready;
  const info = await fetch(address + '/api/info', { headers: { Authorization: 'Basic ' + Buffer.from('opencode:' + password).toString('base64') } }).then(r => r.json());
  console.log('OpenCode version:', info.version, 'workspace:', directory);
  const target = new URL(address); target.username = 'opencode'; target.password = password;
  proxy = await getOrCreateProxy(target.href);
  const origin = 'http://127.0.0.1:' + proxy.port;
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 600, height: 900 }, serviceWorkers: 'block' });
  const page = await context.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));

  // 1. The first paint must already be the Codex palette: no postMessage involved yet.
  await page.goto(origin + '/?__oc_sidebar_theme=codex&__oc_sidebar_mode=light');
  await page.waitForFunction(() => document.getElementById('__ocWebSidebarTheme') && getComputedStyle(document.documentElement).getPropertyValue('--v2-background-bg-deep').trim().toLowerCase() === '#f2f1ea', { timeout: 30000 });
  await page.waitForTimeout(2000);
  await markLoad(page);
  let palette = await readPalette(page);
  assert.equal(palette.theme, 'codex');
  assert.equal(palette.mode, 'light');
  assert.equal(palette.deep, '#f2f1ea', 'page canvas is the beige anchor');
  assert.equal(palette.base, '#f2f1ea', 'page-level surfaces stay on the same beige');
  assert.equal(palette.layer2, '#ecebe4', 'auxiliary tone is the light beige anchor');
  assert.equal(palette.text, '#292929', 'primary text is the Codex anchor');
  assert.equal(palette.muted, '#656563', 'secondary text is the Codex anchor');
  assert.ok(palette.borderBase.includes('#292929'), 'light borders derive from the text tone: ' + palette.borderBase);
  assert.equal(palette.pageBackground, 'rgb(242, 241, 234)');
  assert.equal(palette.bodyBackground, 'rgb(242, 241, 234)');
  assert.equal(palette.stylePresent, true);
  assert.equal(palette.scriptPresent, true);
  assert.equal(new URL(page.url()).searchParams.has('__oc_sidebar_theme'), false, 'theme hint must be stripped from the app URL');
  assert.equal(new URL(page.url()).searchParams.has('__oc_sidebar_mode'), false, 'mode hint must be stripped from the app URL');
  await page.screenshot({ path: root + '/theme-codex-light.png' });
  console.log('PASS codex light is applied before app scripts and the hint is stripped');

  // 2. VS Code switching to dark re-themes the same document without reload.
  await postTheme(page, 'codex', 'dark');
  await page.waitForFunction(() => document.documentElement.getAttribute('data-oc-sidebar-mode') === 'dark' && getComputedStyle(document.documentElement).getPropertyValue('--v2-background-bg-deep').trim().toLowerCase() === '#1b1916', { timeout: 10000 });
  sameLoad(palette, await readPalette(page));
  palette = await readPalette(page);
  assert.equal(palette.pageBackground, 'rgb(27, 25, 22)');
  assert.equal(palette.text, '#f2f1ea');
  await page.screenshot({ path: root + '/theme-codex-dark.png' });
  console.log('PASS live dark switch re-themes in place');

  // 3. "Follow VS Code": the runtime palette reproduces the same anchors from a
  //    gfy-theme snapshot, then follows a different theme live without a reload.
  await postTheme(page, 'vscode', 'light', GFY);
  await page.waitForFunction(() => document.documentElement.getAttribute('data-oc-sidebar-theme') === 'vscode' && getComputedStyle(document.documentElement).getPropertyValue('--v2-background-bg-deep').trim().toLowerCase() === '#f2f1ea', { timeout: 10000 });
  palette = await readPalette(page);
  assert.equal(palette.deep, '#f2f1ea');
  assert.equal(palette.base, '#f2f1ea');
  assert.equal(palette.layer2, '#ecebe4');
  assert.equal(palette.text, '#292929');
  assert.equal(palette.muted, '#656563');
  assert.equal(palette.inlineCanvas, '#F2F1EA', 'seeds arrive as inline custom properties');
  sameLoad(palette, await readPalette(page));
  await page.screenshot({ path: root + '/theme-vscode-gfy.png' });
  console.log('PASS vscode mode reproduces the Codex anchors from the live colors');

  const beforeFollow = await readPalette(page);
  await postTheme(page, 'vscode', 'dark', DARK_SAMPLE);
  await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--v2-background-bg-deep').trim().toLowerCase() === '#202124', { timeout: 10000 });
  palette = await readPalette(page);
  assert.equal(palette.deep, '#202124', 'page follows the injected sidebar background');
  assert.equal(palette.text, '#e8eaed');
  assert.equal(palette.inlineCanvas, '#202124');
  sameLoad(beforeFollow, palette);
  await page.screenshot({ path: root + '/theme-vscode-live-dark.png' });
  console.log('PASS vscode mode follows a live theme change without reloading');

  // 4. Malformed colors never reach the page: the static fallback stays in charge.
  await postTheme(page, 'vscode', 'light', { 'sideBar-background': 'url(javascript:alert(1))', 'foreground': 'red;} html{background:black' });
  await page.waitForFunction(() => document.documentElement.getAttribute('data-oc-sidebar-theme') === 'vscode' && document.documentElement.getAttribute('data-oc-sidebar-mode') === 'light', { timeout: 10000 });
  await page.waitForTimeout(200);
  palette = await readPalette(page);
  assert.equal(palette.deep, '#f2f1ea', 'invalid colors fall back to the Codex palette');
  assert.equal(palette.text, '#292929');
  assert.equal(palette.inlineCanvas, '', 'no seed is written for malformed values');
  assert.equal(palette.inlineText, '');
  assert.equal(palette.inlineInput, '');
  console.log('PASS malformed colors are ignored and the fallback palette applies');

  // 5. Switching back to codex clears the inline seeds, switching to native
  //    removes the palette entirely. OpenCode serializes its own colours with
  //    an explicit alpha suffix (e.g. #fafafaff).
  await postTheme(page, 'codex', 'light');
  await page.waitForFunction(() => document.documentElement.getAttribute('data-oc-sidebar-theme') === 'codex' && document.documentElement.getAttribute('data-oc-sidebar-mode') === 'light', { timeout: 10000 });
  palette = await readPalette(page);
  assert.equal(palette.deep, '#f2f1ea');
  assert.equal(palette.inlineCanvas, '', 'codex mode keeps seeds in the stylesheet only');
  assert.equal(palette.inlineInput, '');

  await postTheme(page, 'native', 'light');
  await page.waitForFunction(() => ['#fafafa', '#fafafaff'].includes(getComputedStyle(document.documentElement).getPropertyValue('--v2-background-bg-deep').trim().toLowerCase()), { timeout: 10000 });
  palette = await readPalette(page);
  assert.equal(palette.theme, 'native');
  assert.equal(palette.mode, null);
  assert.notEqual(palette.pageBackground, 'rgb(242, 241, 234)');
  console.log('PASS native restores OpenCode\u2019s own palette');

  // 6. A fresh native load never applies the palette at all.
  await page.goto(origin + '/?__oc_sidebar_theme=native');
  await page.waitForFunction(() => document.querySelector('[data-color-scheme]'), { timeout: 30000 });
  await page.waitForTimeout(2000);
  palette = await readPalette(page);
  assert.equal(palette.theme, 'native');
  assert.equal(palette.mode, null);
  assert(['#fafafa', '#fafafaff'].includes(palette.deep));
  assert.notEqual(palette.pageBackground, 'rgb(242, 241, 234)');
  await page.screenshot({ path: root + '/theme-native.png' });
  console.log('PASS native first paint leaves OpenCode untouched');

  // 7. The workspace/draft bootstrap still works with theme hints attached, and
  //    the composer is a white rounded input on the unified beige page.
  const bootstrap = withSidebarTheme(
    origin + '/?_ocWorkspace=' + encodeURIComponent(directory),
    'codex',
    'light',
  );
  await page.goto(bootstrap);
  await page.waitForURL('**/new-session?draftId=*', { timeout: 30000 });
  await page.locator('[data-component="new-session"]').waitFor({ timeout: 30000 });
  await page.waitForTimeout(700);
  palette = await readPalette(page);
  assert.equal(palette.theme, 'codex');
  assert.equal(palette.deep, '#f2f1ea');
  assert.equal(palette.composerBackground, 'rgb(255, 255, 255)', 'the composer is the white input anchor');
  assert.equal(palette.cardBackground, 'rgb(242, 241, 234)', 'the draft surface stays on the beige canvas');
  assert.equal(palette.cardBackground, palette.bodyBackground, 'no second background band on the page');
  const draft = await page.evaluate(() => JSON.parse(localStorage.getItem('opencode.window.browser.dat:tabs')).find(t => t.type === 'draft'));
  assert.equal(draft.directory, directory);
  assert.equal(new URL(page.url()).searchParams.has('__oc_sidebar_theme'), false);
  await page.screenshot({ path: root + '/theme-draft.png' });
  console.log('PASS workspace bootstrap keeps working and the composer is white');

  assert.equal(errors.length, 0, errors.join('\n'));
  console.log('Artifacts:', root);
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (browser) await browser.close();
  if (proxy) await proxy.dispose();
  service.kill('SIGTERM');
});
