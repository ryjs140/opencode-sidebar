// Optional real-browser theme test. No project dependencies are added.
// OPENCODE_BINARY=/path/to/opencode PLAYWRIGHT_MODULE=/path/to/playwright node scripts/verify-theme.cjs
//
// Starts an isolated OpenCode V2 server, serves it through the extension's real
// proxy (including the injected theme style/script), and verifies the beige
// palette, the live light/dark switch, and the untouched native mode.
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
  return {
    theme: document.documentElement.getAttribute('data-oc-sidebar-theme'),
    mode: document.documentElement.getAttribute('data-oc-sidebar-mode'),
    background: rootStyle.getPropertyValue('--v2-background-bg-deep').trim(),
    text: rootStyle.getPropertyValue('--v2-text-text-base').trim(),
    pageBackground: rootStyle.backgroundColor,
    bodyBackground: getComputedStyle(document.body).backgroundColor,
    stylePresent: !!document.getElementById('__ocWebSidebarTheme'),
    scriptPresent: !!document.getElementById('__ocWebSidebarThemeScript'),
  };
});
const postTheme = (page, theme, mode) => page.evaluate(
  ({ theme, mode }) => window.postMessage({ type: 'ocSidebarTheme', theme, mode, source: 'vscode' }, '*'),
  { theme, mode },
);
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

  // 1. The first paint must already be beige: no postMessage involved yet.
  await page.goto(origin + '/?__oc_sidebar_theme=beige&__oc_sidebar_mode=light');
  await page.waitForFunction(() => document.getElementById('__ocWebSidebarTheme') && getComputedStyle(document.documentElement).getPropertyValue('--v2-background-bg-deep').trim() === '#f2f1ea', { timeout: 30000 });
  await page.waitForTimeout(2000);
  let palette = await readPalette(page);
  assert.equal(palette.theme, 'beige');
  assert.equal(palette.mode, 'light');
  assert.equal(palette.background, '#f2f1ea');
  assert.equal(palette.text, '#2f2b26');
  assert.equal(palette.pageBackground, 'rgb(242, 241, 234)');
  assert.equal(palette.bodyBackground, 'rgb(242, 241, 234)');
  assert.equal(palette.stylePresent, true);
  assert.equal(palette.scriptPresent, true);
  assert.equal(new URL(page.url()).searchParams.has('__oc_sidebar_theme'), false, 'theme hint must be stripped from the app URL');
  assert.equal(new URL(page.url()).searchParams.has('__oc_sidebar_mode'), false, 'mode hint must be stripped from the app URL');
  await page.screenshot({ path: root + '/theme-beige-light.png' });
  console.log('PASS beige light is applied before app scripts and the hint is stripped');

  // 2. VS Code switching to dark re-themes the same document without reload.
  const beforeDark = page.url();
  await postTheme(page, 'beige', 'dark');
  await page.waitForFunction(() => document.documentElement.getAttribute('data-oc-sidebar-mode') === 'dark' && getComputedStyle(document.documentElement).getPropertyValue('--v2-background-bg-deep').trim() === '#1b1916', { timeout: 10000 });
  palette = await readPalette(page);
  assert.equal(palette.pageBackground, 'rgb(27, 25, 22)');
  assert.equal(page.url(), beforeDark, 'the live switch must not navigate or reload');
  await page.screenshot({ path: root + '/theme-beige-dark.png' });
  console.log('PASS live dark switch re-themes in place');

  // 3. Choosing native removes the palette again. OpenCode serializes its own
  // colours with an explicit alpha suffix (e.g. #fafafaff).
  await postTheme(page, 'native', 'light');
  await page.waitForFunction(() => ['#fafafa', '#fafafaff'].includes(getComputedStyle(document.documentElement).getPropertyValue('--v2-background-bg-deep').trim()), { timeout: 10000 });
  palette = await readPalette(page);
  assert.equal(palette.theme, 'native');
  assert.equal(palette.mode, null);
  assert.notEqual(palette.pageBackground, 'rgb(242, 241, 234)');
  console.log('PASS native restores OpenCode\u2019s own palette');

  // 4. A fresh native load never applies beige at all.
  await page.goto(origin + '/?__oc_sidebar_theme=native');
  await page.waitForFunction(() => document.querySelector('[data-color-scheme]'), { timeout: 30000 });
  await page.waitForTimeout(2000);
  palette = await readPalette(page);
  assert.equal(palette.theme, 'native');
  assert.equal(palette.mode, null);
  assert(['#fafafa', '#fafafaff'].includes(palette.background));
  assert.notEqual(palette.pageBackground, 'rgb(242, 241, 234)');
  await page.screenshot({ path: root + '/theme-native.png' });
  console.log('PASS native first paint leaves OpenCode untouched');

  // 5. The workspace/draft bootstrap still works with theme hints attached.
  const bootstrap = withSidebarTheme(
    origin + '/?_ocWorkspace=' + encodeURIComponent(directory),
    'beige',
    'light',
  );
  await page.goto(bootstrap);
  await page.waitForURL('**/new-session?draftId=*', { timeout: 30000 });
  await page.locator('[data-component="new-session"]').waitFor({ timeout: 30000 });
  await page.waitForTimeout(500);
  palette = await readPalette(page);
  assert.equal(palette.theme, 'beige');
  assert.equal(palette.background, '#f2f1ea');
  const draft = await page.evaluate(() => JSON.parse(localStorage.getItem('opencode.window.browser.dat:tabs')).find(t => t.type === 'draft'));
  assert.equal(draft.directory, directory);
  assert.equal(new URL(page.url()).searchParams.has('__oc_sidebar_theme'), false);
  await page.screenshot({ path: root + '/theme-draft.png' });
  console.log('PASS workspace bootstrap keeps working with the theme hint');

  assert.equal(errors.length, 0, errors.join('\n'));
  console.log('Artifacts:', root);
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (browser) await browser.close();
  if (proxy) await proxy.dispose();
  service.kill('SIGTERM');
});
