// Opt-in integration check against an isolated real OpenCode V2 binary.
// All data, configuration, proxy state and generated secrets stay under /tmp.
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { mkdtempSync, rmSync } = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const Module = require('node:module');
const { basicAuthorization, redeemPairingLink, verifyCredentials, CredentialStorage } = require('../out/Authentication');
const root = mkdtempSync(path.join(os.tmpdir(), 'sidebar-auth-live-'));
const binary = process.env.OPENCODE_AUTH_TEST_BINARY;
if (!binary) throw new Error('Set OPENCODE_AUTH_TEST_BINARY to the installed V2 binary.');
let child;
let handle;
let blocker;
const secret = crypto.randomBytes(32).toString('base64url') + ':@%/?#中文';
const env = { ...process.env, XDG_DATA_HOME: root + '/data', XDG_STATE_HOME: root + '/state',
  XDG_CACHE_HOME: root + '/cache', XDG_CONFIG_HOME: root + '/config', OPENCODE_CONFIG_DIR: root + '/config',
  OPENCODE_PASSWORD: secret, OPENCODE_DISABLE_MODELS_FETCH: 'true' };
async function start(password = secret) {
  child = spawn(binary, ['serve', '--hostname', '127.0.0.1', '--port', '0'], { env: { ...env, OPENCODE_PASSWORD: password }, stdio: ['ignore', 'pipe', 'pipe'] });
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Isolated OpenCode startup timed out')), 20000);
    let buffer = '';
    child.stdout.on('data', bytes => {
      buffer += bytes.toString();
      const match = /server listening on (http:\/\/127\.0\.0\.1:\d+)/.exec(buffer);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
    child.stderr.resume(); // Never print server output: it can contain credentials.
    child.once('error', () => { clearTimeout(timer); reject(new Error('Could not start isolated OpenCode')); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('Isolated OpenCode exited')); });
  });
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  await exited;
}
async function request(url, headers = {}, method = 'GET') {
  const response = await fetch(url, { method, headers, redirect: 'error', signal: AbortSignal.timeout(5000) });
  return { status: response.status, body: await response.text() };
}
(async () => {
  let origin = await start();
  const auth = { Authorization: basicAuthorization('opencode', secret) };
  assert.equal((await request(origin + '/api/info')).status, 401);
  const info = await request(origin + '/api/info', auth);
  assert.equal(info.status, 200);
  assert.match(JSON.parse(info.body).version, /^2\./);
  console.log('PASS real V2 version=' + JSON.parse(info.body).version + '; unauthenticated=401, Basic=200 (special characters included)');
  const pair = await request(origin + '/api/pair', auth, 'POST');
  assert.equal(pair.status, 200);
  const { code, expires_in } = JSON.parse(pair.body);
  assert.equal(expires_in, 300);
  const token = await redeemPairingLink(origin + '/auth/connect/' + code, origin);
  assert.equal(await verifyCredentials(origin, 'opencode', token), 'accepted');
  await assert.rejects(redeemPairingLink(origin + '/auth/connect/' + code, origin), /expired or already used/);
  const seconds = Number(token.split('.')[0]) - Math.floor(Date.now() / 1000);
  assert.ok(seconds >= 2591990 && seconds <= 2592000);
  assert.equal(await verifyCredentials(origin, 'opencode', 'incorrect'), 'rejected');
  console.log('PASS real pairing: TTL=300s, single use, JSON token accepted as Basic password, session TTL=30 days, wrong token=401');
  const data = new Map();
  const secrets = { get: async k => data.get(k), store: async (k, v) => { data.set(k, v); }, delete: async k => { data.delete(k); } };
  await new CredentialStorage(secrets).save('isolated', { username: 'opencode', password: token, origin });
  const restored = await new CredentialStorage(secrets).load('isolated', origin);
  assert.equal(await verifyCredentials(origin, restored.username, restored.password), 'accepted');
  // Load the real proxy with temporary state and only VS Code's translation API mocked.
  const originalLoad = Module._load;
  Module._load = function(name, ...args) {
    if (name === 'vscode') return { l10n: { t: x => x } };
    if (name === 'os') return { ...os, homedir: () => root };
    return originalLoad.call(this, name, ...args);
  };
  const { getOrCreateProxy } = require('../out/ProxyServer');
  Module._load = originalLoad;
  const target = new URL(origin); target.username = 'opencode'; target.password = encodeURIComponent(secret);
  handle = await getOrCreateProxy(target.href);
  assert.equal((await request(`http://127.0.0.1:${handle.port}/api/info`, { Authorization: 'Basic invalid' })).status, 200);
  const oldPort = handle.port;
  await handle.dispose(); handle = undefined;
  blocker = http.createServer(); blocker.listen(oldPort, '127.0.0.1'); await once(blocker, 'listening');
  handle = await getOrCreateProxy(target.href);
  assert.notEqual(handle.port, oldPort);
  assert.equal((await request(`http://127.0.0.1:${handle.port}/api/info`)).status, 200);
  await handle.dispose(); handle = undefined;
  await new Promise(resolve => blocker.close(resolve)); blocker = undefined;
  console.log('PASS real proxy: encoded credentials decoded, Authorization supplied, proxy port change preserves authentication');
  // Generate a genuine short-lived signed session using the isolated server's key.
  const expiry = String(Math.floor(Date.now() / 1000) + 2);
  const key = crypto.createHmac('sha256', secret).update('opencode-session-v1').digest();
  const shortToken = expiry + '.' + crypto.createHmac('sha256', key).update(expiry).digest('base64url');
  assert.equal(await verifyCredentials(origin, 'opencode', shortToken), 'accepted');
  await new Promise(resolve => setTimeout(resolve, 2200));
  assert.equal(await verifyCredentials(origin, 'opencode', shortToken), 'rejected');
  await stop();
  assert.equal(await verifyCredentials(origin, 'opencode', token), 'unavailable');
  assert.equal((await new CredentialStorage(secrets).load('isolated', origin)).password, token);
  origin = await start();
  assert.equal(await verifyCredentials(origin, 'opencode', token), 'accepted');
  await stop(); origin = await start(crypto.randomBytes(32).toString('base64url'));
  assert.equal(await verifyCredentials(origin, 'opencode', token), 'rejected');
  console.log('PASS real token expiration=401, outage retains stored credentials, restart with same key=200, changed server key=401');
})().catch(error => { console.error('FAIL', error.name, error.message.replace(/https?:\/\/\S+/g, '[URL]')); process.exitCode = 1; })
  .finally(async () => { if (handle) await handle.dispose(); if (blocker) blocker.close(); await stop(); rmSync(root, { recursive: true, force: true }); });
