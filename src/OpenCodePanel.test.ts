import { strictEqual, match } from 'node:assert';
import { test } from 'node:test';
import Module = require('node:module');
import { encodeOpenCodeRouteSegment } from './WorkspaceNavigation';

// Exercise the real panel methods without starting a VS Code extension host.
const loader = Module as unknown as { _load: (name: string, ...args: unknown[]) => unknown };
const originalLoad = loader._load;
let resolveExternal: (uri: unknown) => Promise<{ toString(): string }>;
let disposals = 0;
loader._load = function(name, ...args) {
  if (name === 'vscode') return {
    env: { remoteName: 'ssh-remote', asExternalUri: (uri: unknown) => resolveExternal(uri) },
    Uri: { parse: (value: string) => value },
  };
  if (name === './ProxyServer') return {
    getOrCreateProxy: async () => ({ port: 4109, dispose: async () => { disposals++; } }),
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
