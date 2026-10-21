export interface Credentials {
  username: string;
  password: string;
  origin: string;
}

export class AuthenticationError extends Error {
  constructor(readonly reason: 'rejected' | 'unavailable' | 'storage' | 'target') {
    super(reason);
    this.name = 'AuthenticationError';
  }
}

interface Secrets {
  get(key: string): Thenable<string | undefined>;
  store(key: string, value: string): Thenable<void>;
  delete(key: string): Thenable<void>;
}

export function serverOrigin(url: string): string {
  const parsed = new URL(url);
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password ||
      parsed.search || parsed.hash || parsed.pathname !== '/') {
    throw new Error('Configure a server HTTP(S) origin without credentials, path, query or fragment.');
  }
  return parsed.origin;
}

export function basicAuthorization(username: string, password: string): string {
  return 'Basic ' + Buffer.from(`${username || 'opencode'}:${password}`).toString('base64');
}

export async function verifyCredentials(url: string, username: string, password: string): Promise<'accepted' | 'rejected' | 'unavailable'> {
  try {
    const origin = serverOrigin(url);
    const options = { headers: { Authorization: basicAuthorization(username, password) },
      redirect: 'error' as const, signal: AbortSignal.timeout(5000) };
    let response = await fetch(origin + '/api/info', options);
    if (response.status === 404) {response = await fetch(origin + '/global/health', { ...options, method: 'HEAD' });}
    if (response.status === 401 || response.status === 403) {return 'rejected';}
    return response.ok ? 'accepted' : 'unavailable';
  } catch { return 'unavailable'; }
}

// Serialize reads and writes per server, including SecretStorage change callbacks.
// A single record keeps the username, secret and destination consistent after reload.
export class CredentialStorage {
  private readonly operations = new Map<string, Promise<unknown>>();
  constructor(private readonly secrets: Secrets) {}

  private run<T>(id: string, action: () => Promise<T>): Promise<T> {
    const next = (this.operations.get(id) ?? Promise.resolve()).catch(() => {}).then(action);
    this.operations.set(id, next);
    return next;
  }

  load(id: string, url: string, username = ''): Promise<Credentials | undefined> {
    return this.run(id, async () => {
      const raw = await this.secrets.get(`opencode-web-sidebar.server.${id}.credentials`);
      if (raw !== undefined) {
        const data = JSON.parse(raw) as Credentials;
        if (data?.username === '' && data.password === '' && data.origin === '') {return undefined;}
        if (typeof data.username !== 'string' || typeof data.password !== 'string' ||
            data.origin !== serverOrigin(url)) {
          throw new Error('Saved credentials do not match the configured server.');
        }
        return data.password ? data : undefined;
      }
      const password = await this.secrets.get(`opencode-web-sidebar.server.${id}.password`);
      if (!password) {return undefined;}
      const credentials = { username: username || 'opencode', password, origin: serverOrigin(url) };
      await this.secrets.store(`opencode-web-sidebar.server.${id}.credentials`, JSON.stringify(credentials));
      return credentials;
    });
  }

  save(id: string, credentials: Credentials): Promise<void> {
    return this.run(id, async () => {
      const key = `opencode-web-sidebar.server.${id}.credentials`;
      const value = JSON.stringify(credentials);
      if (await this.secrets.get(key) !== value) {await this.secrets.store(key, value);}
    });
  }

  clear(id: string): Promise<void> {
    return this.run(id, async () => {
      // A tombstone prevents a partial clear from resurrecting the legacy secret.
      await this.secrets.store(`opencode-web-sidebar.server.${id}.credentials`,
        JSON.stringify({ username: '', password: '', origin: '' }));
      await this.secrets.delete(`opencode-web-sidebar.server.${id}.password`);
    });
  }
}

export async function redeemPairingLink(link: string, serverUrl: string): Promise<string> {
  let url: URL;
  try { url = new URL(link.trim()); } catch { throw new Error('Invalid OpenCode pairing link.'); }
  if (url.origin !== serverOrigin(serverUrl) || url.username || url.password || url.search || url.hash ||
      !/^\/auth\/connect\/[A-Za-z0-9_-]+$/.test(url.pathname)) {
    throw new Error('Pairing link must target the exact configured server origin.');
  }
  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(10000),
    });
    if (response.status === 401) {throw new Error('Pairing link expired or already used. Run opencode pair again.');}
    if (!response.ok) {throw new Error('Pairing server is unavailable.');}
    const data = await response.json() as { token?: unknown };
    if (typeof data.token !== 'string' || !data.token || /[\r\n]/.test(data.token)) {
      throw new Error('Invalid pairing response.');
    }
    return data.token;
  } catch (error) {
    // Never propagate fetch errors containing the one-time URL or response bodies.
    if (error instanceof Error && /^(Pairing link expired|Pairing server|Invalid pairing response)/.test(error.message)) {throw error;}
    throw new Error('Pairing connection failed. Run opencode pair for a new link and retry.');
  }
}
