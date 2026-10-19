// Optional real-browser smoke test. No project dependencies are added.
// OPENCODE_BINARY=/path/to/opencode PLAYWRIGHT_MODULE=/path/to/playwright node scripts/verify-v2.cjs
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const http = require('node:http');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
async function diagnostic(page) {
  return page.evaluate(() => document.body.innerText + '\n' + Array.from(document.querySelectorAll('textarea')).map(e => e.value).join('\n'));
}
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sidebar-v2-smoke-'));
// Keep shared proxy metadata separate from the user's running extension.
os.homedir = () => root;
const { getOrCreateProxy } = require('../out/ProxyServer');
const { getWorkspaceSessionPath, encodeOpenCodeRouteSegment, rebaseSessionPath } = require('../out/WorkspaceNavigation');
const directory = process.env.TEST_WORKSPACE || path.join(root, 'Traffic monitor');
if (!process.env.TEST_WORKSPACE) fs.mkdirSync(directory);
const env = { ...process.env, XDG_DATA_HOME: root + '/data', XDG_STATE_HOME: root + '/state', XDG_CACHE_HOME: root + '/cache', XDG_CONFIG_HOME: root + '/config' };
const service = spawn(process.env.OPENCODE_BINARY, ['serve', '--hostname', '127.0.0.1', '--port', '0'], { env, cwd: root });
console.log('Artifacts:', root);
let browser, proxy, secondProxy, blocker, shellServer;
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
(async () => {
  const { address, password } = await ready;
  const auth = 'Basic ' + Buffer.from('opencode:' + password).toString('base64');
  const info = await fetch(address + '/api/info', { headers: { Authorization: auth } }).then(r => r.json());
  console.log('OpenCode version:', info.version, 'workspace:', directory);
  const target = new URL(address); target.username = 'opencode'; target.password = password;
  proxy = await getOrCreateProxy(target.href);
  const origin = 'http://127.0.0.1:' + proxy.port;
  browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 600, height: 900 }, serviceWorkers: 'block' });
  const page = await context.newPage();
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  const old = '/' + encodeOpenCodeRouteSegment(directory) + '/session';
  for (const route of ['/', old]) {
    const response = await page.goto(origin + route);
    await page.waitForTimeout(3000);
    if (route !== '/') {
      await page.getByText('Error Details', { exact: true }).waitFor({ timeout: 20000 }).catch(() => {});
      await page.screenshot({ path: root + '/baseline-legacy.png' });
      console.log('Baseline body:', (await diagnostic(page)).slice(0, 1200), 'errors:', errors);
    }
    console.log('Baseline route', route === '/' ? 'home' : 'legacy', 'HTTP', response.status(),
      'route error:', (await diagnostic(page)).includes('Unrecognised route!'));
  }
  // The exact error must occur before validating the fix.
  assert((await diagnostic(page)).includes('Unrecognised route!'));
  errors.length = 0;
  await page.goto(origin + getWorkspaceSessionPath(directory, true));
  await page.waitForURL('**/new-session?draftId=*');
  await page.locator('[data-component="new-session"]').waitFor({ timeout: 30000 });
  const draftPath = new URL(page.url()).pathname + new URL(page.url()).search;
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('opencode.window.browser.dat:tabs')).find(t => t.type === 'draft').directory), directory);
  await page.screenshot({ path: root + '/draft.png' });
  console.log('PASS workspace registration and rendered draft');
  await page.reload();
  await page.locator('[data-component="new-session"]').waitFor();
  assert.equal(new URL(page.url()).pathname + new URL(page.url()).search, draftPath);
  console.log('PASS browser refresh retains draft');
  // Seed sessions through the real API; no provider calls, costs, or user database writes.
  const sessions = [];
  for (const title of ['Sidebar smoke A', 'Sidebar smoke B']) {
    const response = await fetch(origin + '/api/session', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title, location: { directory } }) });
    assert.equal(response.status, 200);
    const result = await response.json(); sessions.push(result.data.id);
  }
  let saved;
  for (const id of sessions) {
    saved = `/server/${encodeOpenCodeRouteSegment(origin)}/session/${id}`;
    await page.goto(origin + getWorkspaceSessionPath(directory, true, saved));
    await page.waitForURL('**/session/' + id);
    await page.waitForFunction(() => document.body.innerText.includes('Sidebar smoke'));
    assert(!(await diagnostic(page)).includes('Unrecognised route!'));
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.getByText('Sidebar smoke A', { exact: true }).first().click();
  await page.waitForURL('**/session/' + sessions[0]);
  await page.getByText('Sidebar smoke B', { exact: true }).first().click();
  await page.waitForURL('**/session/' + sessions[1]);
  await page.setViewportSize({ width: 600, height: 900 });
  console.log('PASS real API session creation, rendering, and UI tab switching');
  await page.reload(); assert(page.url().endsWith(saved));
  await page.close();
  const reopened = await context.newPage();
  await reopened.goto(origin + getWorkspaceSessionPath(directory, true, saved));
  await reopened.waitForURL('**/session/' + sessions[1]);
  console.log('PASS session refresh and reopen');
  // Dispose after closing all browser connections, occupy the old port, and restart.
  await context.close(); await proxy.dispose(); proxy = undefined;
  blocker = http.createServer((_req, res) => res.end('occupied'));
  await new Promise(resolve => blocker.listen(Number(new URL(origin).port), '127.0.0.1', resolve));
  secondProxy = await getOrCreateProxy(target.href);
  const newOrigin = 'http://127.0.0.1:' + secondProxy.port;
  assert.notEqual(newOrigin, origin);
  const fresh = await browser.newContext({ serviceWorkers: 'block' });
  const restored = await fresh.newPage();
  await restored.goto(newOrigin + getWorkspaceSessionPath(directory, true, rebaseSessionPath(saved, origin, newOrigin)));
  await restored.waitForURL('**/session/' + sessions[1]);
  await restored.waitForFunction(() => document.body.innerText.includes('Sidebar smoke B'));
  await restored.screenshot({ path: root + '/restored-session.png' });
  // Render the extension's actual HTML (including its CSP and iframe sandbox),
  // supplying only the VS Code host API bridge. This is not a Remote SSH host.
  const Module = require('node:module');
  const load = Module._load;
  Module._load = function(name, ...args) { return name === 'vscode' ? {} : load.call(this, name, ...args); };
  const { OpenCodePanel } = require('../out/OpenCodePanel');
  Module._load = load;
  const panel = Object.create(OpenCodePanel.prototype);
  const state = new Map();
  Object.assign(panel, {
    _workspaceFolder: directory, _activeServerId: 'smoke', _webUiV2: true,
    _webUiServerUrl: address, _savedIframePath: rebaseSessionPath(saved, origin, address),
    _proxyReady: true, _proxyBaseUrl: newOrigin, _connectionState: 'connected',
    _globalState: { get: (key, fallback) => state.get(key) || fallback,
      update: async (key, value) => state.set(key, value) },
    getConfiguredUrl: () => address, getActiveServer: () => ({ label: 'Smoke' }),
    getWorkspaceFolder: () => directory, renderCurrentServerCard: () => '',
    log: () => {}, safeSendStateUpdate: () => {},
  });
  shellServer = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' }); res.end(panel.getHtmlContent());
  });
  await new Promise(resolve => shellServer.listen(0, '127.0.0.1', resolve));
  const shellUrl = 'http://127.0.0.1:' + shellServer.address().port;
  const shell = await fresh.newPage();
  await shell.setViewportSize({ width: 600, height: 900 });
  const shellErrors = []; shell.on('pageerror', e => shellErrors.push(e.message));
  await shell.exposeFunction('__bridge', msg => { if (msg.type === 'ocFrameUrlChanged') panel.trackIframePath(msg.path); });
  await shell.addInitScript(() => {
    window.acquireVsCodeApi = () => ({ postMessage: msg => window.__bridge(msg) });
  });
  await shell.goto(shellUrl);
  await shell.frameLocator('#ocFrame').getByText('Sidebar smoke B', { exact: true }).first().waitFor();
  await shell.waitForTimeout(300);
  assert(panel._savedIframePath.endsWith('/session/' + sessions[1]));
  await shell.reload();
  await shell.frameLocator('#ocFrame').getByText('Sidebar smoke B', { exact: true }).first().waitFor();
  await shell.screenshot({ path: root + '/sidebar-iframe.png' });
  assert.equal(shellErrors.length, 0, shellErrors.join('\n'));
  console.log('PASS actual panel HTML, CSP, iframe sandbox, URL message bridge, and shell reload');
  assert.equal(errors.length, 0, errors.join('\n'));
  console.log('PASS changed proxy port and fresh browser storage restore session');
  console.log('Artifacts:', root);
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (browser) await browser.close();
  if (proxy) await proxy.dispose();
  if (secondProxy) await secondProxy.dispose();
  if (blocker) blocker.close();
  if (shellServer) shellServer.close();
  service.kill('SIGTERM');
});
