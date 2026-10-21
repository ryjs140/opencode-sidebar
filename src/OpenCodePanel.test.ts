import { strictEqual, match, rejects, deepStrictEqual } from 'node:assert';
import { test } from 'node:test';
import Module = require('node:module');
import { encodeOpenCodeRouteSegment } from './WorkspaceNavigation';

// Exercise the real panel methods without starting a VS Code extension host.
const loader = Module as unknown as { _load: (name: string, ...args: unknown[]) => unknown };
const originalLoad = loader._load;
let resolveExternal: (uri: unknown) => Promise<{ toString(): string }>;
let disposals = 0;
let proxyTarget = '';
let configuredServers: Array<{ id: string; url: string; username?: string; isDefault?: boolean }> = [];
loader._load = function(name, ...args) {
  if (name === 'vscode') return {
    env: { remoteName: 'ssh-remote', language: 'en', asExternalUri: (uri: unknown) => resolveExternal(uri) },
    Uri: { parse: (value: string) => value },
    commands: { executeCommand: async () => {} },
    workspace: { getConfiguration: () => ({ get: (key: string, fallback: unknown) => key === 'servers' ? configuredServers : fallback }) },
    l10n: {
      t: (message: string, ...args: Array<string | number | boolean>) =>
        message.replace(/\{(\d+)\}/g, (placeholder, index) =>
          index < args.length ? String(args[Number(index)]) : placeholder),
    },
  };
  if (name === './ProxyServer') return {
    getOrCreateProxy: async (url: string) => { proxyTarget = url; return { port: 4109, dispose: async () => { disposals++; } }; },
  };
  return originalLoad.call(this, name, ...args);
};
const { OpenCodePanel } = require('./OpenCodePanel');
loader._load = originalLoad;

function panel() {
  const values = new Map<string, string>();
  const p = Object.create(OpenCodePanel.prototype);
  Object.assign(p, {
    _workspaceFolder: '/home/gfy/software/Traffic monitor', _activeServerId: 'test',
    _savedIframePath: '', _workspaceLaunchPending: true, _webUiV2: true,
    _webUiServerUrl: 'http://localhost:49374',
    _proxyBaseUrl: 'http://127.0.0.1:4109', _proxyOperationId: 0, _serverGeneration: 0,
    _proxyReady: true, _cachedPassword: '', _connectionState: 'connected',
    _credentialErrors: new Set(), _passwordsCache: new Map(), _usernamesCache: new Map(),
    _pendingChanges: new Map(), _migrationDone: true,
    _globalState: { get: (key: string, fallback: string) => values.get(key) ?? fallback,
      update: async (key: string, value: string) => { values.set(key, value); } },
    getConfiguredUrl: () => 'http://localhost:49374', log: () => {},
    renderCurrentServerCard: () => '', safeSendStateUpdate: () => {},
    getWorkspaceFolder: () => p._workspaceFolder,
  });
  return p;
}

test('URL tracking survives panel recreation and uses the new proxy port', () => {
  const p = panel();
  p.trackIframePath(`/server/${encodeOpenCodeRouteSegment(p._proxyBaseUrl)}/session/ses_123`);
  strictEqual(p._workspaceLaunchPending, false);
  p.prepareWorkspaceLaunch(true);
  p._proxyBaseUrl = 'http://127.0.0.1:4200';
  const url = new URL(p.computeUIState().iframeUrl);
  strictEqual(url.origin, p._proxyBaseUrl);
  strictEqual(url.searchParams.get('_ocRestore'),
    `/server/${encodeOpenCodeRouteSegment(p._proxyBaseUrl)}/session/ses_123`);
});

test('V2 saved rejection differs from first login; timeouts and 5xx retain the credentials', async () => {
  const p = panel();
  const originalFetch = globalThis.fetch;
  p._cachedPassword = 'saved-token';
  try {
    globalThis.fetch = async () => new Response('', { status: 401 });
    strictEqual(await p.checkHealth(), 'auth-required');
    p._connectionState = 'auth-required';
    match(p.computeUIState().overlayContent, /Saved credentials were rejected/);
    for (const status of [500, 503]) {
      globalThis.fetch = async () => new Response('', { status });
      strictEqual(await p.checkHealth(), 'disconnected');
      strictEqual(p._cachedPassword, 'saved-token');
    }
    globalThis.fetch = async () => { throw new Error('timeout'); };
    strictEqual(await p.checkHealth(), 'disconnected');
    strictEqual(p._cachedPassword, 'saved-token');
    p._cachedPassword = '';
    globalThis.fetch = async () => new Response('', { status: 401 });
    strictEqual(await p.checkHealth(), 'auth-required');
    match(p.computeUIState().overlayContent, /first time/);
  } finally { globalThis.fetch = originalFetch; }
});

test('legacy health carries the same Basic credentials and a timeout never asks for login', async () => {
  const p = panel();
  p._webUiV2 = false;
  p._cachedUsername = 'opencode';
  p._cachedPassword = 'p@ss%中文';
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url, options) => {
      match(String(url), /\/global\/health$/);
      strictEqual((options?.headers as Record<string, string>).Authorization,
        'Basic ' + Buffer.from('opencode:p@ss%中文').toString('base64'));
      throw new Error('timeout');
    };
    strictEqual(await p.checkHealth(), 'disconnected');
    strictEqual(p._cachedPassword, 'p@ss%中文');
    globalThis.fetch = async () => new Response('', { status: 503 });
    strictEqual(await p.checkHealth(), 'disconnected');
  } finally { globalThis.fetch = originalFetch; }
});

test('stale health rejection cannot affect the newly selected server; diagnostics redact fetch errors', async () => {
  const p = panel();
  const logs: string[] = [];
  p.log = (message: string) => { logs.push(message); };
  p._cachedPassword = 'DO-NOT-LOG-TOKEN';
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => {
      p._serverGeneration++;
      return new Response('', { status: 401 });
    };
    strictEqual(await p.checkHealth(), 'disconnected');
    strictEqual(p._authRejected, undefined);
    globalThis.fetch = async () => { throw new Error('http://user:DO-NOT-LOG-TOKEN@server/auth/connect/SECRET'); };
    strictEqual(await p.checkHealth(), 'disconnected');
    strictEqual(logs.some(line => /DO-NOT-LOG|SECRET|Authorization|user:/.test(line)), false);
    match(logs.join('\n'), /credentials retained/);
  } finally { globalThis.fetch = originalFetch; }
});

test('SecretStorage reload refreshes empty caches, binds IDs, and reports local errors separately', async () => {
  const p = panel();
  const data = new Map<string, string>();
  p._secrets = { get: async (key: string) => data.get(key),
    store: async (key: string, value: string) => { data.set(key, value); } };
  configuredServers = [{ id: 'test', url: 'http://localhost:49374', isDefault: true },
    { id: 'other', url: 'http://localhost:49375' }];
  p._passwordsCache.set('test', '');
  data.set('opencode-web-sidebar.server.test.password', 'legacy-token');
  await p.loadServers();
  strictEqual(p._cachedPassword, 'legacy-token');
  configuredServers.reverse();
  await p.loadServers();
  strictEqual(p._activeServerId, 'test');
  strictEqual(p._cachedPassword, 'legacy-token');
  p._secrets.get = async () => { throw new Error('keyring locked'); };
  await p.loadServers();
  strictEqual(await p.checkHealth(), 'disconnected');
  strictEqual(p._cachedPassword, 'legacy-token');
  p._connectionState = 'disconnected';
  match(p.computeUIState().overlayContent, /Local credentials could not be read/);
});

test('saving waits for SecretStorage; reauthentication preserves session and workspace', async () => {
  const p = panel();
  p._servers = [{ id: 'test', url: 'http://localhost:49374' }];
  const data = new Map<string, string>();
  let finish: () => void = () => {};
  const gate = new Promise<void>(resolve => { finish = resolve; });
  p._secrets = { get: async (key: string) => data.get(key), store: async (key: string, value: string) => {
    await gate; data.set(key, value);
  } };
  p._savedIframePath = '/server/stable/session/keep-me';
  const workspace = p._workspaceFolder;
  let restarted = 0;
  p.restartProxy = async () => { restarted++; };
  p.recheckConnection = async () => {};
  const originalFetch = globalThis.fetch;
  let finished = false;
  try {
    globalThis.fetch = async () => Response.json({ version: '2.0.32' });
    const pending = p.saveCredentials('opencode', 'new-token').then(() => { finished = true; });
    await new Promise(resolve => setImmediate(resolve));
    strictEqual(finished, false);
    strictEqual(p._cachedPassword, '');
    finish(); await pending;
    strictEqual(p._cachedPassword, 'new-token');
    strictEqual(restarted, 1);
    strictEqual(p._savedIframePath, '/server/stable/session/keep-me');
    strictEqual(p._workspaceFolder, workspace);
    deepStrictEqual(JSON.parse(data.get('opencode-web-sidebar.server.test.credentials')!), {
      username: 'opencode', password: 'new-token', origin: 'http://localhost:49374',
    });
    globalThis.fetch = async () => new Response('', { status: 401 });
    await rejects(p.saveCredentials('opencode', 'wrong-token'));
    strictEqual(p._cachedPassword, 'new-token');
    strictEqual(JSON.parse(data.get('opencode-web-sidebar.server.test.credentials')!).password, 'new-token');
    await rejects(p.saveCredentials('opencode', 'another', { id: 'test', url: 'http://wrong.example' }));
    globalThis.fetch = async () => Response.json({ version: '2.0.32' });
    p._secrets.store = async () => { throw new Error('SecretStorage unavailable'); };
    await rejects(p.saveCredentials('opencode', 'not-saved'));
    strictEqual(p._cachedPassword, 'new-token');
    strictEqual(JSON.parse(data.get('opencode-web-sidebar.server.test.credentials')!).password, 'new-token');
  } finally { globalThis.fetch = originalFetch; }
});

test('theme changes do not touch credentials, proxy, or session navigation', () => {
  const p = panel();
  p._cachedPassword = 'keep-token';
  p._passwordsCache.set('test', 'keep-token');
  p._savedIframePath = '/server/stable/session/preserved';
  const messages: unknown[] = [];
  p._view = { webview: { postMessage: (message: unknown) => { messages.push(message); } } };
  p.onThemeChanged();
  strictEqual(p._cachedPassword, 'keep-token');
  strictEqual(p._passwordsCache.get('test'), 'keep-token');
  strictEqual(p._proxyReady, true);
  strictEqual(p._savedIframePath, '/server/stable/session/preserved');
  strictEqual(messages.length, 1);
});

test('closing and recreating the sidebar restores credentials from storage without deleting session state', async () => {
  const p = panel();
  const data = new Map<string, string>();
  const secrets = { get: async (key: string) => data.get(key),
    store: async (key: string, value: string) => { data.set(key, value); } };
  p._secrets = secrets;
  configuredServers = [{ id: 'test', url: 'http://localhost:49374', isDefault: true }];
  data.set('opencode-web-sidebar.server.test.credentials', JSON.stringify({
    username: 'opencode', password: 'restored-token', origin: 'http://localhost:49374',
  }));
  await p.loadServers();
  const savedPath = `/server/${encodeOpenCodeRouteSegment('http://localhost:49374')}/session/keep-session`;
  p._savedIframePath = savedPath;
  await p._globalState.update(p.navigationStateKey(), savedPath);
  await p.close();
  strictEqual(p._cachedPassword, 'restored-token');
  strictEqual(p._savedIframePath, savedPath);
  // A new panel models a new extension instance, rather than relying on old memory.
  const recreated = panel();
  recreated._secrets = secrets;
  recreated._globalState = p._globalState;
  await recreated.loadServers();
  recreated.prepareWorkspaceLaunch(true);
  strictEqual(recreated._cachedPassword, 'restored-token');
  strictEqual(recreated._cachedUsername, 'opencode');
  strictEqual(recreated._savedIframePath, savedPath);
});

test('a server switch during SecretStorage write cannot attach the login to the new server', async () => {
  const p = panel();
  p._servers = [{ id: 'test', url: 'http://localhost:49374' }, { id: 'other', url: 'http://localhost:49375' }];
  const data = new Map<string, string>();
  p._secrets = { get: async (key: string) => data.get(key), store: async (key: string, value: string) => {
    p._activeServerId = 'other';
    p._cachedPassword = 'other-token';
    data.set(key, value);
  } };
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => Response.json({ version: '2.0.32' });
    await p.saveCredentials('opencode', 'test-token');
    strictEqual(p._cachedPassword, 'other-token');
    strictEqual(JSON.parse(data.get('opencode-web-sidebar.server.test.credentials')!).password, 'test-token');
    strictEqual(data.has('opencode-web-sidebar.server.other.credentials'), false);
  } finally { globalThis.fetch = originalFetch; }
});

test('proxy target encodes literal percent signs and reuses credentials after recreation', async () => {
  const p = panel();
  p._cachedUsername = 'opencode';
  p._cachedPassword = 'p@ss%/?#中文';
  resolveExternal = async () => ({ toString: () => 'http://127.0.0.1:4400' });
  strictEqual(await p.startProxy(), true);
  strictEqual(decodeURIComponent(new URL(proxyTarget).password), p._cachedPassword);
  const target = proxyTarget;
  await p.stopProxy();
  strictEqual(p._cachedPassword, 'p@ss%/?#中文');
  strictEqual(await p.startProxy(), true);
  strictEqual(proxyTarget, target);
});

test('invalid V2 navigation falls back once, and refresh preserves home', () => {
  const p = panel();
  p.trackIframePath('/encoded/session');
  strictEqual(p._savedIframePath, '/');
  p.prepareWorkspaceLaunch(true);
  strictEqual(new URL(p.computeUIState().iframeUrl).searchParams.get('_ocRestore'), '/');
});

test('a valid V2 API response detects the version, missing sessions fall back, auth stays explicit', async () => {
  const originalFetch = globalThis.fetch;
  const p = panel();
  p._webUiV2 = undefined;
  p._savedIframePath = `/server/${encodeOpenCodeRouteSegment('http://localhost:49374')}/session/removed`;
  try {
    globalThis.fetch = async (url) => String(url).endsWith('/api/info')
      ? Response.json({ version: '2.0.31' }) : new Response('', { status: 404 });
    strictEqual(await p.checkHealth(), 'connected');
    strictEqual(p._webUiV2, true);
    strictEqual(p._savedIframePath, '/');
    globalThis.fetch = async () => new Response('', { status: 401 });
    strictEqual(await p.checkHealth(), 'auth-required');
    globalThis.fetch = async () => { throw new Error('ECONNREFUSED'); };
    strictEqual(await p.checkHealth(), 'disconnected');
    p._connectionState = 'disconnected';
    match(p.computeUIState().overlayContent, /not reachable/);
    match(p.computeUIState().overlayContent, /onclick="refresh\(\)">Retry/);
  } finally { globalThis.fetch = originalFetch; }
});

test('slow SSH forwarding completes after the old 4-second deadline; startup callers share one operation', async () => {
  const p = panel();
  resolveExternal = async () => {
    await new Promise(resolve => setTimeout(resolve, 4500));
    return { toString: () => 'https://forwarded.example:4109/' };
  };
  const first = p.startProxy();
  strictEqual(p.startProxy(), first);
  strictEqual(await first, true);
  strictEqual(p._proxyReady, true);
  strictEqual(p._proxyBaseUrl, 'https://forwarded.example:4109');
});

test('URI timeout cleans up; late completion cannot overwrite a later successful startup', async () => {
  const p = panel();
  let late: (value: { toString(): string }) => void = () => {};
  resolveExternal = () => new Promise(resolve => { late = resolve; });
  const originalTimeout = globalThis.setTimeout;
  // Advance only the URI deadline; all production timeout values stay intact.
  globalThis.setTimeout = ((fn: () => void, ms: number) => originalTimeout(fn, ms === 15000 ? 10 : ms)) as typeof setTimeout;
  const before = disposals;
  try {
    strictEqual(await p.startProxy(), false);
    strictEqual(p._proxyReady, false);
    strictEqual(p._proxyPort, undefined);
    strictEqual(disposals, before + 1);
    resolveExternal = async () => ({ toString: () => 'http://127.0.0.1:4200' });
    strictEqual(await p.startProxy(), true);
    late({ toString: () => 'http://stale.example' });
    await new Promise(resolve => setImmediate(resolve));
    strictEqual(p._proxyBaseUrl, 'http://127.0.0.1:4200');
    strictEqual(p._proxyReady, true);
  } finally { globalThis.setTimeout = originalTimeout; }
});

test('switching servers during URI resolution starts a new operation and ignores the old result', async () => {
  const p = panel();
  let previous: (value: { toString(): string }) => void = () => {};
  resolveExternal = () => new Promise(resolve => { previous = resolve; });
  const old = p.startProxy();
  // Let the first operation reach URI resolution.
  await new Promise(resolve => setImmediate(resolve));
  p.getConfiguredUrl = () => 'http://localhost:49375';
  resolveExternal = async () => ({ toString: () => 'http://127.0.0.1:4300' });
  strictEqual(await p.startProxy(), true);
  previous({ toString: () => 'http://127.0.0.1:stale' });
  strictEqual(await old, false);
  strictEqual(p._proxyBaseUrl, 'http://127.0.0.1:4300');
});
