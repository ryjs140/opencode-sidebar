import { strictEqual, deepStrictEqual, rejects } from 'node:assert';
import { test } from 'node:test';
import { CredentialStorage, basicAuthorization, redeemPairingLink, serverOrigin, verifyCredentials } from './Authentication';

function storage() {
  const data = new Map<string, string>();
  let writes = 0;
  const secrets = {
    get: async (key: string) => data.get(key),
    store: async (key: string, value: string) => { writes++; data.set(key, value); },
    delete: async (key: string) => { data.delete(key); },
  };
  return { data, secrets, writes: () => writes };
}
const credentials = { username: 'opencode', password: 'p@ss:%/?#中文', origin: 'http://localhost:49374' };

test('credentials survive a new storage instance and server reordering without duplicate writes', async () => {
  const mock = storage();
  const first = new CredentialStorage(mock.secrets);
  await first.save('a', credentials);
  await first.save('a', credentials);
  strictEqual(mock.writes(), 1);
  await first.save('b', { ...credentials, password: 'other' });
  const restored = new CredentialStorage(mock.secrets);
  strictEqual((await restored.load('b', credentials.origin))?.password, 'other');
  deepStrictEqual(await restored.load('a', credentials.origin), credentials);
  await rejects(restored.load('a', 'http://localhost:49375'));
  deepStrictEqual(await restored.load('a', credentials.origin), credentials);
});

test('legacy credentials bind once to the server and remain recoverable', async () => {
  const mock = storage();
  mock.data.set('opencode-web-sidebar.server.a.password', credentials.password);
  const store = new CredentialStorage(mock.secrets);
  deepStrictEqual(await store.load('a', credentials.origin, 'opencode'), credentials);
  strictEqual(mock.data.get('opencode-web-sidebar.server.a.password'), credentials.password);
  await rejects(store.load('a', 'https://another.example'));
  await store.clear('a');
  strictEqual(await store.load('a', credentials.origin), undefined);
});

test('delayed writes serialize reads; a failed write cannot report success or overwrite saved credentials', async () => {
  const mock = storage();
  const store = new CredentialStorage(mock.secrets);
  await store.save('a', credentials);
  let finish: () => void = () => {};
  const gate = new Promise<void>(resolve => { finish = resolve; });
  const originalStore = mock.secrets.store;
  mock.secrets.store = async (key, value) => { await gate; await originalStore(key, value); };
  let complete = false;
  const save = store.save('a', { ...credentials, password: 'updated' }).then(() => { complete = true; });
  const read = store.load('a', credentials.origin);
  await new Promise(resolve => setImmediate(resolve));
  strictEqual(complete, false);
  finish();
  await save;
  strictEqual((await read)?.password, 'updated');
  mock.secrets.store = async () => { throw new Error('keyring unavailable'); };
  await rejects(store.save('a', credentials));
  strictEqual((await store.load('a', credentials.origin))?.password, 'updated');
});

test('missing reads are not cached forever; malformed local records are not treated as missing passwords', async () => {
  const mock = storage();
  const store = new CredentialStorage(mock.secrets);
  strictEqual(await store.load('a', credentials.origin), undefined);
  await new CredentialStorage(mock.secrets).save('a', credentials);
  deepStrictEqual(await store.load('a', credentials.origin), credentials);
  mock.data.set('opencode-web-sidebar.server.a.credentials', 'broken');
  await rejects(store.load('a', credentials.origin));
});

test('pairing enforces exact origin, no credentials/query/fragment, and rejects redirects without leaking the link', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async (_url, options) => {
      calls++;
      strictEqual(options?.redirect, 'error');
      deepStrictEqual(options?.headers, { Accept: 'application/json' });
      return Response.json({ token: 'opaque-session' });
    };
    for (const link of ['https://evil.example/auth/connect/code', 'http://user:pass@localhost:49374/auth/connect/code',
      'http://localhost:49375/auth/connect/code', 'http://localhost:49374/auth/connect/code?x=1',
      'http://localhost:49374/auth/connect/code#secret', 'http://localhost:49374/other']) {
      await rejects(redeemPairingLink(link, credentials.origin));
    }
    strictEqual(calls, 0);
    strictEqual(await redeemPairingLink(credentials.origin + '/auth/connect/new-code', credentials.origin), 'opaque-session');
    globalThis.fetch = async () => new Response('', { status: 401 });
    await rejects(redeemPairingLink(credentials.origin + '/auth/connect/code', credentials.origin), /expired or already used/);
    globalThis.fetch = async () => { throw new Error('http://localhost:49374/auth/connect/SECRET'); };
    await rejects(redeemPairingLink(credentials.origin + '/auth/connect/code', credentials.origin), /^Error: Pairing connection failed/);
  } finally { globalThis.fetch = originalFetch; }
  await rejects(async () => serverOrigin('http://username:password@localhost:49374'));
});

test('credential validation distinguishes server rejection from temporary connectivity failure', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (_url, options) => {
      strictEqual((options?.headers as Record<string, string>).Authorization,
        basicAuthorization(credentials.username, credentials.password));
      return new Response('', { status: 200 });
    };
    strictEqual(await verifyCredentials(credentials.origin, credentials.username, credentials.password), 'accepted');
    for (const status of [401, 403, 500, 503]) {
      globalThis.fetch = async () => new Response('', { status });
      strictEqual(await verifyCredentials(credentials.origin, credentials.username, credentials.password), status < 500 ? 'rejected' : 'unavailable');
    }
    globalThis.fetch = async () => { throw new Error('timeout'); };
    strictEqual(await verifyCredentials(credentials.origin, credentials.username, credentials.password), 'unavailable');
  } finally { globalThis.fetch = originalFetch; }
});
