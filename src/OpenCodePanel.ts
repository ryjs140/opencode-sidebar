import * as vscode from 'vscode';
import { AuthenticationError, CredentialStorage, basicAuthorization, redeemPairingLink, serverOrigin, verifyCredentials } from './Authentication';
import { spawn, type ChildProcess } from 'child_process';
import { getOrCreateProxy } from './ProxyServer';
import {
  decideTrackedIframePath,
  getWorkspaceSessionPath,
  isV2AppPath,
  rebaseSessionPath,
} from './WorkspaceNavigation';
import {
  normalizeSidebarTheme,
  withSidebarTheme,
  type SidebarThemeMode,
  type SidebarThemePreference,
} from './SidebarTheme';

const HEALTH_CHECK_TIMEOUT_MS = 3000;
const PROXY_START_TIMEOUT_MS = 4000;
const PROXY_URI_TIMEOUT_MS = 15000;
const CONNECTION_RECHECK_TIMEOUT_MS = 30000;

function escapeAttr(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeJsString(text: string): string {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });

  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

type ConnectionState = 'checking' | 'disconnected' | 'auth-required' | 'connected' | 'starting';

interface ServerConfig {
  id: string;
  url: string;
  label?: string;
  isWsl: boolean;
  isDefault: boolean;
  serverCommand?: string;
  username?: string;
  authEnabled?: boolean;
}

export class OpenCodePanel implements vscode.WebviewViewProvider {
  public static readonly viewType = 'opencode-web-sidebar.view';

  private _view: vscode.WebviewView | undefined;
  private _isVisible = false;
  private _connectionState: ConnectionState = 'checking';
  private _statusBarItem: vscode.StatusBarItem;
  private _pollTimer: ReturnType<typeof setInterval> | undefined;
  private _reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private _reconnectAttempts = 0;
  private _disposed = false;
  private _isReconnecting = false;
  private _cachedUsername = '';
  private _cachedPassword = '';
  private _servers: ServerConfig[] = [];
  private _activeServerId = '';
  private _serverGeneration = 0;
  private _showServerSelector = false;
  private _pendingChanges = new Map<string, Record<string, any>>();
  private _serverStatuses = new Map<string, ConnectionState | 'unknown'>();
  private _allServersPollTimer: ReturnType<typeof setInterval> | undefined;
  private _isFormEditing = false;
  private _pollInFlight: Promise<void> | undefined;
  private _proxyOperationId = 0;
  private _proxyPort: number | undefined;
  private _proxyDispose: (() => Promise<void>) | undefined;
  private _proxyBaseUrl: string | undefined;
  private _serverProcess: ChildProcess | undefined;
  private _serverProcessId = 0;
  private _startedByUs = false;
  private _log: vscode.OutputChannel;
  private _migrationDone = false;
  private _migrationOperation: Promise<void> | undefined;
  private _usingEnvPassword = false;
  private _consecutiveHealthFailures = 0;
  private _consecutiveAuthRequired = 0;
  private _savedIframePath = '';
  private _webUiV2: boolean | undefined;
  private _webUiServerUrl = '';
  private _proxyReady = false;
  private _proxyStarting: Promise<boolean> | undefined;
  private _proxyStartingKey = '';
  private _proxyTargetKey = '';
  private _workspaceLaunchPath = '';
  private _workspaceLaunchPending = false;
  private _workspaceFolder = '';
  private _iframeNeedsNavigation = false;
  private _iframeWasConnected = false;
  private _themePreference: SidebarThemePreference = 'codex';

  private _credentialStorage: CredentialStorage | undefined;
  private readonly _usernamesCache = new Map<string, string>();
  private readonly _credentialErrors = new Set<string>();
  private _authRejected = false;
  private _secretSubscription: vscode.Disposable | undefined;

  private get credentialStorage(): CredentialStorage {
    return this._credentialStorage ??= new CredentialStorage(this._secrets);
  }

  private readonly _passwordsCache = new Map<string, string>();

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _secrets: vscode.SecretStorage,
    private readonly _globalState: vscode.Memento,
  ) {
    this._log = vscode.window.createOutputChannel(vscode.l10n.t('OpenCode Sidebar'));
    this._statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this._statusBarItem.command = 'opencode-web-sidebar.focusPanel';
    this.updateStatusBar();
    this._secretSubscription = this._secrets.onDidChange(e => {
      if (!e.key.startsWith('opencode-web-sidebar.server.')) {return;}
      const before = this._cachedPassword;
      void this.loadServers().then(async () => {
        if (!this._disposed && this._isVisible) {
          if (before !== this._cachedPassword) {await this.restartProxy();}
          return this.recheckConnection({ showChecking: false });
        }
      }).catch(() => this.log('Local credential refresh failed; saved data retained'));
    });
    vscode.commands.executeCommand('setContext', 'opencode-web-sidebar.startedByUs', false);
  }

  private log(msg: string): void {
    this._log.appendLine(`[${new Date().toLocaleTimeString()}] ${msg}`);
  }

  private migrateFromOldSettings(): Promise<void> {
    if (this._migrationDone) {return Promise.resolve();}
    return this._migrationOperation ??= this.migrateSettingsOperation().then(() => {
      this._migrationDone = true;
    }).finally(() => { this._migrationOperation = undefined; });
  }

  private async migrateSettingsOperation(): Promise<void> {
    const config = vscode.workspace.getConfiguration('opencode-web-sidebar');
    const inspect = config.inspect<ServerConfig[]>('servers');
    const hasExplicitServers = inspect?.globalValue !== undefined || inspect?.workspaceValue !== undefined
      || inspect?.workspaceFolderValue !== undefined;

    if (hasExplicitServers) {
      const sv = config.get<ServerConfig[]>('servers');
      if (sv && sv.length > 0) {
        this.log(`Loaded ${sv.length} servers from settings`);
        this._servers = sv;
        return;
      }
    }

    const oldUrl = config.get<string>('url', 'http://localhost:4096');
    const oldCmd = config.get<string>('serverCommand', 'opencode web --port 4096');
    const oldWsl = config.get<'none' | 'wsl'>('workspacePathStyle', 'none');

    let servers: ServerConfig[] = [];

    const oldUsername = await this._secrets.get('opencode-web-sidebar.username') || '';
    const oldPassword = await this._secrets.get('opencode-web-sidebar.password') || '';

    this.log('Migrating from old single-server config');

    const localId = 'default';
    servers.push({
      id: localId,
      url: oldUrl,
      label: 'Local Server',
      username: oldUsername,
      isWsl: oldWsl === 'wsl',
      isDefault: true,
      serverCommand: oldCmd,
      authEnabled: !!(oldUsername || oldPassword),
    });

    if (oldPassword && !await this._secrets.get(`opencode-web-sidebar.server.${localId}.password`) &&
        !await this._secrets.get(`opencode-web-sidebar.server.${localId}.credentials`)) {
      await this._secrets.store(`opencode-web-sidebar.server.${localId}.password`, oldPassword);
      // Retain legacy data as a recovery source; new records take precedence.
    }

    await config.update('servers', servers, vscode.ConfigurationTarget.Global);
    this._servers = servers;
    this.log('Migration complete');
  }

  private async loadServers(): Promise<void> {
    let migrationFailed = false;
    try { await this.migrateFromOldSettings(); } catch {
      migrationFailed = true;
      this.log('Local credential/settings migration failed; saved data retained; will retry');
    }

    const config = vscode.workspace.getConfiguration('opencode-web-sidebar');
    const servers = config.get<ServerConfig[]>('servers', []);
    if (servers.length > 0) {
      this._servers = servers;
    }

    for (const server of this._servers) {
      if (migrationFailed || !server.id || this._servers.filter(s => s.id === server.id).length !== 1) {
        this._credentialErrors.add(server.id);
        if (server.id === this._activeServerId) {await this.stopProxy();}
        this.log('Local credential association unavailable: migration failed or server ID is missing/duplicated');
        continue;
      }
      try {
        const credentials = await this.credentialStorage.load(server.id, server.url, server.username);
        this._passwordsCache.set(server.id, credentials?.password || '');
        this._usernamesCache.set(server.id, credentials?.username || server.username || '');
        this._credentialErrors.delete(server.id);
        this.log(`SecretStorage read: server=${server.id} credentials=${credentials ? 'present' : 'absent'}`);
      } catch {
        this._credentialErrors.add(server.id);
        if (server.id === this._activeServerId) {await this.stopProxy();}
        this.log(`Local credential read failed: server=${server.id}; saved data retained`);
      }
    }

    const savedActive = this._globalState.get<string>('opencode-web-sidebar.activeServerId', '');
    const defaultServer = this._servers.find(s => s.isDefault);
    if (savedActive && this._servers.find(s => s.id === savedActive)) {
      this._activeServerId = savedActive;
    } else if (defaultServer) {
      this._activeServerId = defaultServer.id;
      await this._globalState.update('opencode-web-sidebar.activeServerId', this._activeServerId);
    } else if (this._servers.length > 0) {
      this._activeServerId = this._servers[0].id;
      await this._globalState.update('opencode-web-sidebar.activeServerId', this._activeServerId);
    }

    this.loadCredentialsForActive();
    this.log(`Active server: ${this._activeServerId}`);
  }

  private loadCredentialsForActive(): void {
    const active = this.getActiveServer();
    this._cachedUsername = this._usernamesCache.get(this._activeServerId) || active?.username || '';
    this._cachedPassword = this._passwordsCache.get(this._activeServerId) || '';
    this._usingEnvPassword = false;
    const environmentPassword = process.env.OPENCODE_PASSWORD || process.env.OPENCODE_SERVER_PASSWORD;
    if (!this._credentialErrors.has(this._activeServerId) && !this._cachedPassword && environmentPassword) {
      this.log('Using server password from environment');
      this._cachedPassword = environmentPassword;
      this._usingEnvPassword = true;
      if (!this._cachedUsername) {
        this._cachedUsername = 'opencode';
      }
    }
    if (this._cachedPassword || this._cachedUsername) {
      this.log(`Credentials loaded: server=${this._activeServerId} source=${this._usingEnvPassword ? 'environment' : 'SecretStorage'}`);
    }
  }

  get cachedUsername(): string {
    return this._cachedUsername;
  }

  private getActiveServer(): ServerConfig | undefined {
    return this._servers.find(s => s.id === this._activeServerId);
  }

  private displayServerLabel(server: ServerConfig, pendingLabel?: string): string {
    if (pendingLabel !== undefined) return pendingLabel;
    const label = server.label || '';
    if (server.id === 'default' && (label === '' || label === 'Local Server')) {
      return vscode.l10n.t('Local Server');
    }
    return label;
  }

  private renderCurrentServerCard(): string {
    const server = this.getActiveServer();
    if (!server) return '';

    let dotClass = 'status-dot';
    let statusLabel = '';
    if (this._connectionState === 'connected') { dotClass += ' connected'; statusLabel = vscode.l10n.t('Connected'); }
    else if (this._connectionState === 'checking') { dotClass += ' pulse'; statusLabel = vscode.l10n.t('Connecting...'); }
    else if (this._connectionState === 'starting') { dotClass += ' pulse'; statusLabel = vscode.l10n.t('Starting...'); }
    else if (this._connectionState === 'auth-required') { dotClass += ' auth'; statusLabel = vscode.l10n.t('Password required'); }
    else if (this._isReconnecting) { dotClass += ' pulse'; statusLabel = vscode.l10n.t('Reconnecting...'); }
    else { dotClass += ' disconnected'; statusLabel = vscode.l10n.t('Disconnected'); }

    const label = escapeAttr(this.displayServerLabel(server) || server.url);
    const url = escapeAttr(server.url);

    return `<div class="card" style="cursor:pointer;width:100%;max-width:400px" onclick="selectServer()">
      <div class="card-header">
        <div class="card-title">
          <span>${label}</span>
          <span class="${dotClass}"></span>
        </div>
        <div class="card-description">${url}</div>
      </div>
      <div class="card-content" style="flex-direction:row;justify-content:space-between;align-items:center;padding-top:2px">
        <span style="font-size:11px;color:var(--muted-foreground)">${escapeAttr(statusLabel)}</span>
        <span style="font-size:11px;color:var(--muted-foreground)">${escapeAttr(vscode.l10n.t('Manage →'))}</span>
      </div>
    </div>`;
  }

  private async saveServerPassword(serverId: string, password: string): Promise<void> {
    const server = this._servers.find(s => s.id === serverId);
    if (!server || !password) {return;} // Blank form fields never erase saved credentials.
    const username = this._pendingChanges.get(serverId)?.username ?? this._usernamesCache.get(serverId) ?? server.username ?? 'opencode';
    await this.persistCredentials(serverId, server.url, username, password);
    this.sendStateUpdate();
  }

  private async clearServerPassword(serverId: string): Promise<void> {
    this.log(`Clearing password for server ${serverId}`);
    await this.credentialStorage.clear(serverId);
    this._usernamesCache.delete(serverId);
    this._credentialErrors.delete(serverId);
    this._passwordsCache.set(serverId, '');
    if (serverId === this._activeServerId) {
      this._cachedPassword = '';
      await this.stopProxy();
      await this.pollOnce();
    }
    this.sendStateUpdate();
  }

  private async persistServers(): Promise<void> {
    const config = vscode.workspace.getConfiguration('opencode-web-sidebar');
    await config.update('servers', this._servers, vscode.ConfigurationTarget.Global);
  }

  private async switchToServer(serverId: string): Promise<void> {
    const gen = ++this._serverGeneration;
    this.log(`Switching to server: ${serverId}`);

    this._isReconnecting = false;
    this._reconnectAttempts = 0;
    this.clearReconnectTimer();
    this._showServerSelector = false;
    if (this._allServersPollTimer) {
      clearInterval(this._allServersPollTimer);
      this._allServersPollTimer = undefined;
    }
    this._serverStatuses.clear();

    if (this._startedByUs && this._serverProcess && serverId !== this._activeServerId) {
      this.log('Stopping previously-started server on switch');
      this._killServerProcess();
      this._startedByUs = false;
      vscode.commands.executeCommand('setContext', 'opencode-web-sidebar.startedByUs', false);
    }

    await this.commitPendingChanges(serverId);
    this._activeServerId = serverId;
    await this._globalState.update('opencode-web-sidebar.activeServerId', serverId);
    this.loadCredentialsForActive();
    this.prepareWorkspaceLaunch(true);

    this._connectionState = 'checking';
    this.updateStatusBar();
    if (gen === this._serverGeneration) {
      this.render();
    }

    const proxyReady = await this.startProxy();
    if (gen !== this._serverGeneration) return;
    if (!proxyReady) {
      this._connectionState = 'disconnected';
      this.updateStatusBar();
      this.sendStateUpdate();
      return;
    }
    await this.pollOnce();
  }

  private async updateServerConfig(serverId: string, key: string, value: any): Promise<void> {
    const server = this._servers.find(s => s.id === serverId);
    if (!server) return;

    const gen = this._serverGeneration;

    if (key === 'url') server.url = value;
    else if (key === 'label') server.label = value;
    else if (key === 'username') server.username = value;
    else if (key === 'isWsl') server.isWsl = !!value;
    else if (key === 'authEnabled') server.authEnabled = !!value;
    else if (key === 'serverCommand') server.serverCommand = value;

    await this.persistServers();
    if (serverId === this._activeServerId && gen === this._serverGeneration) {
      if (key === 'url' || key === 'isWsl') {
        this.prepareWorkspaceLaunch(true);
        this._connectionState = 'checking';
        this.updateStatusBar();
        this.render();
        const proxyReady = await this.startProxy();
        if (gen === this._serverGeneration) {
          if (proxyReady) {
            await this.pollOnce();
          } else {
            this._connectionState = 'disconnected';
            this.updateStatusBar();
            this.sendStateUpdate();
          }
        }
      } else {
        this.sendStateUpdate();
      }
    } else {
      this.sendStateUpdate();
    }
  }

  private async setDefaultServer(serverId: string): Promise<void> {
    for (const s of this._servers) {
      s.isDefault = s.id === serverId;
    }
    await this.persistServers();
    this.sendStateUpdate();
  }

  private async removeServer(serverId: string): Promise<void> {
    const idx = this._servers.findIndex(s => s.id === serverId);
    if (idx < 0) return;

    this._servers.splice(idx, 1);
    await this.clearServerPassword(serverId);
    await this.persistServers();

    if (this._activeServerId === serverId) {
      const defaultServer = this._servers.find(s => s.isDefault) || this._servers[0];
      if (defaultServer) {
        await this.switchToServer(defaultServer.id);
      } else {
        this._activeServerId = '';
        this._connectionState = 'disconnected';
        this._showServerSelector = true;
        this.updateStatusBar();
        this.sendStateUpdate();
      }
    } else {
      this.sendStateUpdate();
    }
  }

  private async addServer(config: { url: string; label?: string; isWsl?: boolean }): Promise<void> {
    const id = `srv_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const count = this._servers.filter(s => s.id !== 'default').length + 1;
    this._servers.push({
      id,
      url: config.url,
      label: config.label || vscode.l10n.t('Server #{0}', count),
      authEnabled: false,
      isWsl: config.isWsl || false,
      isDefault: false,
    });
    await this.persistServers();
    this.sendStateUpdate();
  }

  async getCredentialTarget(): Promise<{ id: string; url: string }> {
    try {
      if (!this._servers.length) {await this.loadServers();}
    } catch { throw new AuthenticationError('storage'); }
    return this.credentialTarget;
  }

  get credentialTarget(): { id: string; url: string } {
    return { id: this._activeServerId, url: this.getConfiguredUrl() };
  }

  private async persistCredentials(id: string, url: string, username: string, password: string): Promise<void> {
    const server = this._servers.find(s => s.id === id);
    if (!server || server.url !== url) {throw new AuthenticationError('target');}
    const verified = await verifyCredentials(url, username, password);
    this.log(`Login verification: server=${id} result=${verified}`);
    if (verified !== 'accepted') {throw new AuthenticationError(verified === 'rejected' ? 'rejected' : 'unavailable');}
    if (!this._servers.some(s => s.id === id && s.url === url)) {throw new AuthenticationError('target');}
    try {
      await this.credentialStorage.save(id, { username: username || 'opencode', password, origin: serverOrigin(url) });
    } catch {
      this.log(`Local credential write failed: server=${id}; previous saved credentials retained`);
      throw new AuthenticationError('storage');
    }
    this._passwordsCache.set(id, password);
    this._usernamesCache.set(id, username || 'opencode');
    this._credentialErrors.delete(id);
    this.log(`SecretStorage write complete: server=${id}`);
    if (id === this._activeServerId && this.getConfiguredUrl() === url) {
      this.loadCredentialsForActive();
      this._authRejected = false;
      await this.restartProxy();
      await this.recheckConnection({ showChecking: false });
    }
  }

  async saveCredentials(username: string, password: string, target = this.credentialTarget): Promise<void> {
    if (!password) {throw new Error('Enter a non-empty password. Existing credentials were retained.');}
    await this.persistCredentials(target.id, target.url, username, password);
  }

  async loginWithPairingLink(): Promise<void> {
    let target;
    try { target = await this.getCredentialTarget(); }
    catch (error) { this.showAuthenticationError(error); return; }
    const link = await vscode.window.showInputBox({
      prompt: vscode.l10n.t('Run opencode pair and paste the new pairing link for the configured server'),
      password: true, ignoreFocusOut: true,
    });
    if (link === undefined) {return;}
    try {
      if (!this._servers.some(s => s.id === target.id && s.url === target.url)) {throw new AuthenticationError('target');}
      const token = await redeemPairingLink(link, target.url);
      await this.persistCredentials(target.id, target.url, 'opencode', token);
      vscode.window.showInformationMessage(vscode.l10n.t('OpenCode credentials saved.'));
    } catch (error) {
      if (error instanceof AuthenticationError) { this.showAuthenticationError(error); return; }
      this.log(`Pairing exchange failed: server=${target.id}; existing credentials retained`);
      vscode.window.showErrorMessage(vscode.l10n.t('Pairing failed. Check the server address, generate a new link with opencode pair, and retry. Saved credentials were retained.'));
    }
  }

  showAuthenticationError(error: unknown): void {
    const reason = error instanceof AuthenticationError ? error.reason : 'storage';
    this.log(`Login failed: reason=${reason}; saved data retained`);
    const message = reason === 'rejected'
      ? vscode.l10n.t('The server rejected the supplied credentials. Existing credentials were retained.')
      : reason === 'unavailable'
        ? vscode.l10n.t('The server is unavailable. Existing credentials were retained. Retry when connected.')
        : reason === 'target'
          ? vscode.l10n.t('The configured server changed during login. Please retry.')
          : vscode.l10n.t('Could not save OpenCode credentials. Check SecretStorage access and retry.');
    vscode.window.showErrorMessage(message);
  }

  async clearCredentials(): Promise<void> {
    await this.clearServerPassword(this._activeServerId);
  }

  get isVisible(): boolean {
    return this._isVisible;
  }

  async resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): Promise<void> {
    this._view = webviewView;
    this._isVisible = true;
    this.log('Webview resolved');

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri],
    };

    webviewView.webview.onDidReceiveMessage(async (msg) => {
      this.log(`Message from webview: ${JSON.stringify(msg)}`);
      switch (msg.type) {
        case 'closePanel':
          vscode.commands.executeCommand('opencode-web-sidebar.openPanel');
          break;
        case 'openSettings':
          vscode.commands.executeCommand('workbench.action.openSettings', 'opencode-web-sidebar');
          break;
        case 'pair':
          await this.loginWithPairingLink();
          break;
        case 'setPassword':
          vscode.commands.executeCommand('opencode-web-sidebar.setPassword');
          break;
        case 'refresh':
          await this.recheckConnection({ showChecking: true, reloadIframe: true });
          break;
        case 'startServer':
          this.startServer();
          break;
        case 'stopServer':
          this.stopServer();
          break;
        case 'cancelReconnect':
          this.cancelReconnect();
          break;
        case 'selectServer':
          this._showServerSelector = !this._showServerSelector;
          if (this._showServerSelector) {
            this.pollAllServers();
            this._allServersPollTimer = setInterval(() => this.pollAllServers(), 5000);
          } else {
            if (this._allServersPollTimer) {
              clearInterval(this._allServersPollTimer);
              this._allServersPollTimer = undefined;
            }
            this._serverStatuses.clear();
          }
          this.sendStateUpdate();
          break;
        case 'connectToServer':
          if (msg.serverId) {
            await this.switchToServer(msg.serverId);
          }
          break;
        case 'startAndConnect':
          if (msg.serverId) {
            await this.commitPendingChanges(msg.serverId);
            const gen = ++this._serverGeneration;
            this._showServerSelector = false;
            if (this._allServersPollTimer) {
              clearInterval(this._allServersPollTimer);
              this._allServersPollTimer = undefined;
            }
            this._serverStatuses.clear();
            this._activeServerId = msg.serverId;
            await this._globalState.update('opencode-web-sidebar.activeServerId', msg.serverId);
            this.loadCredentialsForActive();
            this.prepareWorkspaceLaunch(true);
            this._connectionState = 'checking';
            this.updateStatusBar();
            this.render();
            const proxyReady = await this.startProxy();
            if (gen !== this._serverGeneration) break;
            const state = proxyReady ? await this.checkHealth() : 'disconnected';
            if (gen !== this._serverGeneration) break;
            if (state === 'connected' || state === 'auth-required') {
              this._connectionState = state;
              this._startedByUs = false;
              vscode.commands.executeCommand('setContext', 'opencode-web-sidebar.startedByUs', false);
              this.updateStatusBar();
              this.sendStateUpdate();
            } else {
              await this.startServer();
            }
          }
          break;
        case 'updateServerConfig':
          if (msg.serverId && msg.key !== undefined) {
            await this.updateServerConfig(msg.serverId, msg.key, msg.value);
          }
          break;
        case 'saveCredentials':
          if (msg.serverId) {
            await this.saveServerPassword(msg.serverId, msg.password || '');
          }
          break;
        case 'removeServer':
          if (msg.serverId) {
            const removeLabel = vscode.l10n.t('Remove');
            const result = await vscode.window.showWarningMessage(
              vscode.l10n.t('Remove this server?'), { modal: true }, removeLabel);
            if (result === removeLabel) {
              this._pendingChanges.delete(msg.serverId);
              await this.removeServer(msg.serverId);
            }
          }
          break;
        case 'setDefaultServer':
          if (msg.serverId) {
            await this.setDefaultServer(msg.serverId);
          }
          break;
        case 'addServer':
          await this.addServer(msg.config);
          break;
        case 'formEditing':
          this._isFormEditing = msg.editing;
          break;
        case 'pendingChange':
          if (msg.serverId) {
            const existing = this._pendingChanges.get(msg.serverId) || {};
            existing[msg.key] = msg.value;
            this._pendingChanges.set(msg.serverId, existing);
            if (!this._isFormEditing) {
              this.sendStateUpdate();
            }
          }
          break;
        case 'commitServerChanges':
          if (msg.serverId) {
            await this.commitPendingChanges(msg.serverId);
          }
          break;
        case 'ocFrameUrlChanged':
          if (msg.path) {
            this.trackIframePath(msg.path);
          }
          break;
      }
    });

    webviewView.onDidDispose(() => {
      this._view = undefined;
      this._isVisible = false;
      this.stopPolling();
      if (this._allServersPollTimer) {
        clearInterval(this._allServersPollTimer);
        this._allServersPollTimer = undefined;
      }
      this._serverStatuses.clear();
      this.log('Webview disposed');
    });

    webviewView.onDidChangeVisibility(() => {
      this._isVisible = webviewView.visible;
      this.log(`Visibility changed: ${this._isVisible}`);
      if (this._isVisible) {
        this._view = webviewView;
        // VS Code can discard an iframe's renderer while its containing view is
        // hidden. In that case the webview shell survives (and still shows the
        // last connection state), but the iframe comes back blank. Always
        // navigate it again after the view becomes visible.
        this._iframeNeedsNavigation = true;
        void this.recheckConnection({ showChecking: false, reloadIframe: true });
      } else {
        this._iframeNeedsNavigation = true;
        this.stopPolling();
      }
    });

    await this.loadServers();
    this.prepareWorkspaceLaunch(true);
    this._connectionState = 'checking';
    this._isReconnecting = false;
    this.updateStatusBar();
    this.render();
    await this.recheckConnection({ showChecking: false });
    this.startPolling();
  }

  async show(): Promise<void> {
    if (this._isVisible) { return; }
    await vscode.commands.executeCommand('workbench.view.extension.opencode-web-sidebar');
  }

  async close(): Promise<void> {
    this._isVisible = false;
    this._iframeNeedsNavigation = true;
    this.stopPolling();
    try {
      await vscode.commands.executeCommand('workbench.action.toggleAuxiliaryBar');
    } catch {
      vscode.window.showErrorMessage(vscode.l10n.t('Failed to close sidebar panel'));
    }
  }

  render(): void {
    if (!this._view) { return; }
    try {
      this._view.webview.html = this.getHtmlContent();
      this.log('Rendered webview HTML');
    } catch (err) {
      this.log(`Render failed: ${err instanceof Error ? err.name : 'Error'}`);
    }
  }

  private async recheckConnection(options: { showChecking?: boolean; reloadIframe?: boolean } = {}): Promise<void> {
    if (this._credentialErrors.has(this._activeServerId)) {await this.loadServers();}
    const { showChecking = true, reloadIframe = false } = options;
    const gen = ++this._serverGeneration;

    this._isReconnecting = false;
    this._reconnectAttempts = 0;
    this._consecutiveHealthFailures = 0;
    this._consecutiveAuthRequired = 0;
    this.clearReconnectTimer();

    if (showChecking) {
      this._connectionState = 'checking';
      this.updateStatusBar();
      this.safeSendStateUpdate();
    }

    let state: ConnectionState = 'disconnected';
    try {
      state = await withTimeout((async () => {
        // A refresh only needs to re-check the upstream and reload the iframe.
        // Restarting a healthy proxy here can block while Node waits for the
        // iframe's long-lived HTTP/WebSocket connections to close.
        if (this._credentialErrors.has(this._activeServerId)) {return 'disconnected';}
        if (!this._proxyReady || this._proxyTargetKey !== this.currentProxyKey()) {
          const proxyReady = await this.startProxy();
          if (!proxyReady) {
            return 'disconnected';
          }
        }
        return await this.checkHealth();
      })(), CONNECTION_RECHECK_TIMEOUT_MS, 'connection recheck');
    } catch (err) {
      this.log(`Connection recheck failed: ${err instanceof Error ? err.name : 'Error'}`);
      state = 'disconnected';
    }

    if (this._disposed || gen !== this._serverGeneration) {
      return;
    }

    this._connectionState = state;
    this._isReconnecting = false;
    this.updateStatusBar();

    try {
      if (reloadIframe && state === 'connected') {
        // Reassigning iframe.src is not sufficient when VS Code has discarded
        // the iframe's renderer. In that state the outer webview can still
        // receive messages and show "Connected", while the frame never paints
        // again. Rebuilding the outer document creates a fresh iframe renderer
        // and does not depend on a postMessage reaching the stale document.
        this._iframeNeedsNavigation = false;
        this.render();
      } else {
        this.safeSendStateUpdate();
      }
    } catch (err) {
      this.log(`Failed to update webview after recheck: ${err instanceof Error ? err.name : 'Error'}`);
    }

    if (state === 'disconnected') {
      this.scheduleReconnect();
    }

    if (this._isVisible) {
      this.startPolling();
    }
  }

  async onUrlChanged(): Promise<void> {
    this._serverGeneration++;
    this.log('Config changed, reloading servers');
    await this.loadServers();
    this.prepareWorkspaceLaunch(true);
    await this.recheckConnection({ showChecking: true });
  }

  onWorkspaceFoldersChanged(): void {
    if (!this.prepareWorkspaceLaunch(false)) {
      return;
    }
    this.safeSendStateUpdate();
  }

  dispose(): void {
    this._disposed = true;
    this._secretSubscription?.dispose();
    if (this._startedByUs && this._serverProcess) {
      this.log('Killing server on deactivate');
      this._killServerProcess();
    }
    this.stopProxy();
    this.stopPolling();
    this.clearReconnectTimer();
    this._statusBarItem.dispose();
    this._log.dispose();
  }

  private getConfiguredUrl(): string {
    const active = this.getActiveServer();
    return active ? active.url : '';
  }

  private getSidebarThemePreference(): SidebarThemePreference {
    try {
      const value = vscode.workspace.getConfiguration('opencode-web-sidebar').get<unknown>('theme', 'codex');
      this._themePreference = normalizeSidebarTheme(value);
      return this._themePreference;
    } catch {
      // Unit tests instantiate panel methods without an extension host.
      return normalizeSidebarTheme(this._themePreference);
    }
  }

  private getWindowThemeMode(): SidebarThemeMode {
    try {
      const window = (vscode as unknown as { window?: typeof vscode.window }).window;
      const kind = window?.activeColorTheme?.kind;
      return kind === vscode.ColorThemeKind.Dark || kind === vscode.ColorThemeKind.HighContrast
        ? 'dark'
        : 'light';
    } catch {
      return 'light';
    }
  }

  /**
   * The webview observes VS Code body-class changes itself; this method only
   * tells it which palette preference to forward to the iframe.
   */
  onThemeChanged(): void {
    const theme = this.getSidebarThemePreference();
    if (!this._view) {
      return;
    }
    this.log(`Theme preference changed: ${theme}`);
    this._view.webview.postMessage({ type: 'sidebarThemeChanged', theme });
  }

  private getServerCommand(): string {
    const active = this.getActiveServer();
    if (active?.serverCommand) return active.serverCommand;
    return vscode.workspace.getConfiguration('opencode-web-sidebar').get('serverCommand', 'opencode web --port 4096');
  }

  private getWorkspaceStyle(): 'none' | 'wsl' {
    const active = this.getActiveServer();
    if (active?.isWsl) return 'wsl';
    return 'none';
  }

  private getUrlOrigin(url: string): string {
    try {
      return new URL(url).origin;
    } catch {
      return '';
    }
  }

  private getWorkspaceFolder(): string {
    const raw = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || '';
    this.log(`Workspace folder raw: ${raw || '(none)'}`);
    if (!raw) { return ''; }
    const style = this.getWorkspaceStyle();
    if (style === 'wsl' && process.platform === 'win32') {
      const translated = raw.replace(/^([A-Za-z]):\\/, (_, l: string) => `/mnt/${l.toLowerCase()}/`)
        .replace(/\\/g, '/');
      this.log(`Workspace folder translated (wsl): ${translated}`);
      return translated;
    }
    this.log(`Workspace folder: ${raw}`);
    return raw;
  }

  private prepareWorkspaceLaunch(force: boolean): boolean {
    const workspaceFolder = this.getWorkspaceFolder();
    if (!force && workspaceFolder === this._workspaceFolder) {
      return false;
    }
    this._workspaceFolder = workspaceFolder;
    this._workspaceLaunchPath = getWorkspaceSessionPath(workspaceFolder);
    this._workspaceLaunchPending = !!this._workspaceLaunchPath;
    this._savedIframePath = this._globalState.get<string>(this.navigationStateKey(), '');
    if (this._webUiServerUrl !== this.getConfiguredUrl()) {
      this._webUiV2 = undefined;
      this._webUiServerUrl = this.getConfiguredUrl();
    }
    if (this._savedIframePath) this._workspaceLaunchPending = false;
    this._iframeNeedsNavigation = true;
    this._iframeWasConnected = false;
    this.log(`Prepared workspace navigation: ${this._webUiV2 === undefined ? '(awaiting web UI detection)' : this._webUiV2 ? getWorkspaceSessionPath(workspaceFolder, true) : this._workspaceLaunchPath || '/'}`);
    return true;
  }

  private navigationStateKey(): string {
    return 'opencode-web-sidebar.navigation.' + JSON.stringify([
      this._activeServerId, this.getConfiguredUrl(), this._workspaceFolder,
    ]);
  }

  private trackIframePath(path: string): void {
    if (typeof path !== 'string') return;
    if (this._webUiV2) {
      // Bootstrap parameters are transient, never a resumable app address.
      if (/[?&]_oc(?:Workspace|Restore)=/.test(path)) return;
      if (!isV2AppPath(path)) {
        this._savedIframePath = '/';
        this._workspaceLaunchPending = false;
        void this._globalState.update(this.navigationStateKey(), '/');
        this._iframeNeedsNavigation = true;
        this.safeSendStateUpdate();
        return;
      }
      this._workspaceLaunchPending = false;
      this._savedIframePath = rebaseSessionPath(path,
        this.getUrlOrigin(this._proxyBaseUrl || ''), this.getUrlOrigin(this.getConfiguredUrl()));
      void this._globalState.update(this.navigationStateKey(), this._savedIframePath);
      return;
    }
    const decision = decideTrackedIframePath(
      path,
      this._workspaceLaunchPending,
      this._workspaceLaunchPath,
    );
    if (!decision.accept) {
      this.log('Ignored iframe path during workspace navigation');
      this._iframeNeedsNavigation = true;
      this.safeSendStateUpdate();
      return;
    }
    this._savedIframePath = path;
    void this._globalState.update(this.navigationStateKey(), path);
    if (decision.completesWorkspaceLaunch) {
      this._workspaceLaunchPending = false;
      this.log('Workspace navigation completed');
    }
  }

  private computeUIState(): {
    statusColor: string;
    statusText: string;
    statusBarStop: string;
    overlayContent: string;
    overlayHidden: boolean;
    showIframe: boolean;
    iframeUrl: string;
  } {
    let statusColor: string;
    let statusText: string;
    if (this._connectionState === 'checking') {
      statusColor = '#e5c07b';
      statusText = vscode.l10n.t('Checking...');
    } else if (this._connectionState === 'starting') {
      statusColor = '#e5c07b';
      statusText = vscode.l10n.t('Starting...');
    } else if (this._isReconnecting) {
      statusColor = '#e06c75';
      statusText = vscode.l10n.t('Reconnecting...');
    } else if (this._connectionState === 'connected') {
      statusColor = '#4ec94e';
      statusText = vscode.l10n.t('Connected');
    } else if (this._connectionState === 'auth-required') {
      statusColor = '#e5c07b';
      statusText = vscode.l10n.t('Password required');
    } else {
      statusColor = '#e06c75';
      statusText = vscode.l10n.t('Disconnected');
    }

    const url = this.getConfiguredUrl();
    let overlayContent: string;
    if (this._showServerSelector) {
      overlayContent = this.renderServerSelector();
    } else if (!url) {
      overlayContent =
        `<span>${escapeAttr(vscode.l10n.t('No URL configured. Configure a server below.'))}</span>` +
        `<div class="btn-row"><button class="btn btn-default" onclick="selectServer()">${escapeAttr(vscode.l10n.t('Servers'))}</button></div>`;
    } else {
      const card = this.renderCurrentServerCard();
      const statusHtml = this._isReconnecting ? (
        `<span>${escapeAttr(vscode.l10n.t('Connection lost, reconnecting...'))}</span>` +
        `<div class="btn-row"><button class="btn btn-default" onclick="cancelReconnect()">${escapeAttr(vscode.l10n.t('Cancel'))}</button>` +
        `<button class="btn btn-outline" onclick="selectServer()">${escapeAttr(vscode.l10n.t('Servers'))}</button></div>`
      ) : this._connectionState === 'checking' ? (
        '<div class="oc-icon"><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 300" width="40" height="40" fill="none"><path fill="#f1ecec" d="M180 60H60v180h120zm60 240H0V0h240z" clip-path="url(#b)" mask="url(#a)" transform="translate(30)"/><defs><clipPath id="b" clipPathUnits="userSpaceOnUse"><path fill="#fff" d="M0 0h240v300H0z"/></clipPath><mask id="a" maskUnits="userSpaceOnUse"><path fill="#fff" d="M240 0H0v300h240z"/></mask></defs></svg></div>' +
        '<div class="spinner"></div>' +
        `<span>${escapeAttr(vscode.l10n.t('Connecting to server...'))}</span>`
      ) : this._connectionState === 'starting' ? (
        '<div class="spinner"></div>' +
        `<span>${escapeAttr(vscode.l10n.t('Starting OpenCode server...'))}</span>`
      ) : this._connectionState === 'auth-required' ? (
        '<div class="lock-icon">🔒</div>' +
        `<span>${escapeAttr(this._authRejected ? vscode.l10n.t('Saved credentials were rejected by the server. Please authenticate again.') : vscode.l10n.t('Server requires authentication. Sign in for the first time.'))}</span>` +
        `<div class="btn-row"><button class="btn btn-default" onclick="setPassword()">${escapeAttr(vscode.l10n.t('Login with Username & Password'))}</button><button class="btn btn-outline" onclick="pair()">${escapeAttr(vscode.l10n.t('Login with pairing link'))}</button></div>`
      ) : this._connectionState === 'disconnected' ? (
        `<span>${escapeAttr(this._credentialErrors?.has(this._activeServerId) ? vscode.l10n.t('Local credentials could not be read or do not match this server. Saved data was retained. Retry or authenticate again.') : vscode.l10n.t('OpenCode server is not reachable'))}</span>` +
        `<div class="btn-row"><button class="btn btn-default" onclick="refresh()">${escapeAttr(vscode.l10n.t('Retry'))}</button><button class="btn btn-default" onclick="selectServer()">${escapeAttr(vscode.l10n.t('Servers'))}</button>` +
        `<button class="btn btn-outline" onclick="openSettings()">${escapeAttr(vscode.l10n.t('Settings'))}</button>${this._credentialErrors?.has(this._activeServerId) ? `<button class="btn btn-default" onclick="setPassword()">${escapeAttr(vscode.l10n.t('Login with Username & Password'))}</button><button class="btn btn-outline" onclick="pair()">${escapeAttr(vscode.l10n.t('Login with pairing link'))}</button>` : ''}</div>`
      ) : '';

      overlayContent = card
        ? `<div style="display:flex;flex-direction:column;width:100%;height:100%;align-items:center">
            <div style="display:flex;flex-direction:column;align-items:center;width:100%;padding:32px 12px 0;flex-shrink:0">${card}</div>
            <div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;width:100%">${statusHtml}</div>
          </div>`
        : statusHtml;
    }

    const proxyUrl = !this._proxyReady ? '' : this._proxyBaseUrl || (this._proxyPort
      ? `http://127.0.0.1:${this._proxyPort}`
      : '');
    const iframePath = this._webUiV2
      ? getWorkspaceSessionPath(this._workspaceFolder, true,
        rebaseSessionPath(this._savedIframePath,
          this.getUrlOrigin(this.getConfiguredUrl()), this.getUrlOrigin(proxyUrl || '')))
      : this._workspaceLaunchPending
      ? this._workspaceLaunchPath
      : this._savedIframePath || this._workspaceLaunchPath;
    const iframeUrl = proxyUrl ? proxyUrl + iframePath : '';
    const themedIframeUrl = withSidebarTheme(
      iframeUrl,
      this.getSidebarThemePreference(),
      this.getWindowThemeMode(),
    );
    const connectedAndReady = !this._isReconnecting && this._connectionState === 'connected' && !!themedIframeUrl && !this._showServerSelector;
    if (connectedAndReady) {
      this._iframeWasConnected = true;
    }
    const showIframe = this._iframeWasConnected && !!themedIframeUrl && !this._showServerSelector;
    const overlayHidden = showIframe && !this._showServerSelector;

    const statusBarStop = this._startedByUs
      ? `<a onclick="stopServer()">${escapeAttr(vscode.l10n.t('Stop'))}</a><span class="separator">&nbsp;|&nbsp;</span>`
      : '';

    return { statusColor, statusText, statusBarStop, overlayContent, overlayHidden, showIframe, iframeUrl: themedIframeUrl };
  }

  private safeSendStateUpdate(options: { reloadIframe?: boolean } = {}): void {
    if (!this._view) return;
    try {
      const state = this.computeUIState();

      const navigateIframe = state.showIframe
        && !!state.iframeUrl
        && (this._iframeNeedsNavigation || !!options.reloadIframe);
      const iframeUrl = navigateIframe ? state.iframeUrl : '';
      if (navigateIframe) {
        this._iframeNeedsNavigation = false;
      }

      this.log(`sendStateUpdate: state=${this._connectionState} showIframe=${state.showIframe} overlayHidden=${state.overlayHidden} iframeUrl=${iframeUrl ? 'set' : 'preserved'}`);
      this._view.webview.postMessage({
        type: 'updateState',
        statusColor: state.statusColor,
        statusText: state.statusText,
        statusBarStop: state.statusBarStop,
        overlayContent: state.overlayContent,
        overlayHidden: state.overlayHidden,
        showIframe: state.showIframe,
        iframeUrl,
        reloadIframe: !!options.reloadIframe,
      });
    } catch (err) {
      this.log(`Failed to send state update: ${err instanceof Error ? err.name : 'Error'}`);
    }
  }

  private sendStateUpdate(): void {
    this.safeSendStateUpdate();
  }

  private currentProxyKey(): string {
    return JSON.stringify([this.getConfiguredUrl(), this._cachedUsername, this._cachedPassword]);
  }

  private startProxy(): Promise<boolean> {
    const key = this.currentProxyKey();
    if (this._proxyReady && key === this._proxyTargetKey) { return Promise.resolve(true); }
    if (this._proxyStarting && key === this._proxyStartingKey) return this._proxyStarting;
    this._proxyStartingKey = key;
    const operation = this.startProxyOperation();
    this._proxyStarting = operation;
    void operation.finally(() => {
      if (this._proxyStarting === operation) this._proxyStarting = undefined;
    });
    return operation;
  }

  private async startProxyOperation(): Promise<boolean> {
    const opId = ++this._proxyOperationId;
    await this.stopProxy(false);
    if (opId !== this._proxyOperationId || this._disposed) return false;
    const url = this.getConfiguredUrl();
    if (!url) {
      this.log('No URL configured, skipping proxy');
      return false;
    }
    try {
      if (this._credentialErrors.has(this._activeServerId)) { return false; }
      const parsed = new URL(serverOrigin(url));
      if (this._cachedPassword) {
        parsed.username = encodeURIComponent(this._cachedUsername || 'opencode');
        parsed.password = encodeURIComponent(this._cachedPassword);
      }
      const targetUrl = parsed.toString();
      const targetKey = this.currentProxyKey();
      this.log(`Starting proxy: server=${this._activeServerId} target=${parsed.origin} credentials=${!!this._cachedPassword}`);
      const pending = getOrCreateProxy(targetUrl);
      let expired = false;
      void pending.then(handle => {
        if (expired) void handle.dispose();
      }, () => {});
      const handle = await withTimeout(pending, PROXY_START_TIMEOUT_MS, 'proxy startup')
        .catch(err => { expired = true; throw err; });
      if (opId !== this._proxyOperationId || this._disposed) {
        await handle.dispose();
        return false;
      }
      this._proxyPort = handle.port;
      this._proxyDispose = handle.dispose;
      this._iframeNeedsNavigation = true;
      this.log(`Proxy listening on port ${this._proxyPort}`);
      const baseUrl = await withTimeout(this.resolveProxyBaseUrl(handle.port), PROXY_URI_TIMEOUT_MS, 'proxy URI resolution');
      if (opId !== this._proxyOperationId || this._disposed) return false;
      this._proxyBaseUrl = baseUrl;
      this._proxyTargetKey = targetKey;
      this._proxyReady = true;
      this.log(`Proxy ready: server=${this._activeServerId} authentication=${this._cachedPassword ? 'supplied' : 'absent'}`);
      return true;
    } catch (err) {
      this.log(`Failed to start proxy: ${err instanceof Error ? err.name : 'Error'}; credentials retained`);
      if (opId === this._proxyOperationId) await this.stopProxy();
      return false;
    }
  }

  private async resolveProxyBaseUrl(port: number): Promise<string> {
    const local = `http://127.0.0.1:${port}`;
    if (!vscode.env.remoteName) return local;
    const external = await vscode.env.asExternalUri(vscode.Uri.parse(local));
    const result = external.toString().replace(/\/$/, '');
    this.log(`Resolved proxy address (remote=${vscode.env.remoteName})`);
    return result;
  }

  private async stopProxy(invalidateInFlight = true): Promise<void> {
    this._proxyReady = false;
    this._proxyTargetKey = '';
    if (invalidateInFlight) {
      this._proxyStarting = undefined;
      this._proxyOperationId++;
    }
    const dispose = this._proxyDispose;
    this._proxyDispose = undefined;
    this._proxyPort = undefined;
    this._proxyBaseUrl = undefined;
    if (dispose) {
      this.log('Stopping proxy');
      await dispose();
    }
  }

  private async restartProxy(): Promise<void> {
    await this.startProxy();
    this.sendStateUpdate();
  }

  async startServer(): Promise<void> {
    if (this._connectionState === 'connected' || this._connectionState === 'starting') {
      return;
    }

    const state = await this.checkHealth();
    if (state === 'connected' || state === 'auth-required') {
      if (state === 'connected' && !this._proxyReady) {
        const proxyReady = await this.startProxy();
        if (!proxyReady) {
          this._connectionState = 'disconnected';
          this.updateStatusBar();
          this.sendStateUpdate();
          return;
        }
      }
      this._connectionState = state;
      this._startedByUs = false;
      vscode.commands.executeCommand('setContext', 'opencode-web-sidebar.startedByUs', false);
      this.updateStatusBar();
      this.sendStateUpdate();
      return;
    }

    const cmdStr = this.getServerCommand();
    if (!cmdStr) {
      this.log('No server command configured');
      return;
    }

    const parts = cmdStr.split(/\s+/);
    const cmd = parts[0];
    const args = parts.slice(1);
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

    this.log('Starting configured server command');

    this._connectionState = 'starting';
    this._isReconnecting = false;
    this._startedByUs = true;
    vscode.commands.executeCommand('setContext', 'opencode-web-sidebar.startedByUs', true);
    this.updateStatusBar();
    this.sendStateUpdate();

    this.stopPolling();
    this._pollTimer = setInterval(() => this.pollOnce(), 2000);

    try {
      const id = ++this._serverProcessId;
      this._serverProcess = spawn(cmd, args, {
        cwd: workspaceFolder,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      this._serverProcess.stdout?.on('data', (data: Buffer) => {
        for (const line of data.toString().split('\n')) {
          const trimmed = line.trim();
          if (trimmed) { this.log('[server] output received (suppressed to protect authentication data)'); }
        }
      });

      this._serverProcess.stderr?.on('data', (data: Buffer) => {
        for (const line of data.toString().split('\n')) {
          const trimmed = line.trim();
          if (trimmed) { this.log('[server] output received (suppressed to protect authentication data)'); }
        }
      });

      this._serverProcess.on('error', (err) => {
        if (id !== this._serverProcessId) { return; }
        this.log(`Server process error: ${err.name}`);
        this._serverProcess = undefined;
        this.cleanupServer();
      });

      this._serverProcess.on('exit', (code, signal) => {
        if (id !== this._serverProcessId) { return; }
        this.log(`Server process exited (code=${code}, signal=${signal})`);
        this._serverProcess = undefined;
        this.cleanupServer();
      });
    } catch (err) {
      this.log(`Failed to spawn server: ${err instanceof Error ? err.name : 'Error'}`);
      this.cleanupServer();
    }
  }

  async stopServer(): Promise<void> {
    if (!this._startedByUs || !this._serverProcess) { return; }

    this.log('Stopping server process');
    this._killServerProcess();
    this._startedByUs = false;
    vscode.commands.executeCommand('setContext', 'opencode-web-sidebar.startedByUs', false);
    await this.pollOnce();
  }

  private _killServerProcess(): void {
    if (!this._serverProcess) { return; }
    this._serverProcess.kill('SIGTERM');
    const proc = this._serverProcess;
    setTimeout(() => {
      try {
        if (proc && !proc.killed) { proc.kill('SIGKILL'); }
      } catch { /* ignore */ }
    }, 3000);
    this._serverProcess = undefined;
  }

  private cleanupServer(): void {
    if (!this._startedByUs) { return; }
    this._startedByUs = false;
    vscode.commands.executeCommand('setContext', 'opencode-web-sidebar.startedByUs', false);
    if (this._connectionState === 'starting') {
      this._connectionState = 'disconnected';
      this.updateStatusBar();
      this.sendStateUpdate();
    }
    this.stopPolling();
    this.startPolling();
  }

  private updateStatusBar(): void {
    if (this._connectionState === 'checking') {
      this._statusBarItem.text = '$(globe) ' + vscode.l10n.t('OpenCode: Checking...');
      this._statusBarItem.backgroundColor = undefined;
      this._statusBarItem.tooltip = vscode.l10n.t('Checking OpenCode server...');
      this._statusBarItem.show();
    } else if (this._connectionState === 'starting') {
      this._statusBarItem.text = '$(globe) ' + vscode.l10n.t('OpenCode: Starting...');
      this._statusBarItem.backgroundColor = undefined;
      this._statusBarItem.tooltip = vscode.l10n.t('Starting OpenCode server...');
      this._statusBarItem.show();
    } else if (this._isReconnecting) {
      this._statusBarItem.text = '$(globe) ' + vscode.l10n.t('OpenCode: Reconnecting...');
      this._statusBarItem.backgroundColor = undefined;
      this._statusBarItem.tooltip = vscode.l10n.t('Attempting to reconnect to OpenCode server');
      this._statusBarItem.show();
    } else if (this._connectionState === 'connected') {
      this._statusBarItem.text = '$(globe) ' + vscode.l10n.t('OpenCode: Connected');
      this._statusBarItem.backgroundColor = undefined;
      this._statusBarItem.tooltip = vscode.l10n.t('OpenCode server is reachable');
      this._statusBarItem.show();
    } else if (this._connectionState === 'auth-required') {
      this._statusBarItem.text = '$(key) ' + vscode.l10n.t('OpenCode: Password Required');
      this._statusBarItem.backgroundColor = undefined;
      this._statusBarItem.tooltip = this._authRejected ? vscode.l10n.t('Saved credentials were rejected by the server. Please authenticate again.') : vscode.l10n.t('OpenCode server requires a password — click to open panel');
      this._statusBarItem.show();
    } else {
      this._statusBarItem.text = '$(globe) ' + vscode.l10n.t('OpenCode: Disconnected');
      this._statusBarItem.backgroundColor = undefined;
      this._statusBarItem.tooltip = vscode.l10n.t('OpenCode server is not reachable — click to open panel');
      this._statusBarItem.show();
    }
  }

  private async pollAllServers(): Promise<void> {
    const gen = this._serverGeneration;
    for (const server of this._servers) {
      if (server.id === this._activeServerId) continue;
      try {
        const resp = await fetch(server.url, {
          method: 'HEAD',
          signal: AbortSignal.timeout(3000),
        });
        if (resp.ok) {
          this._serverStatuses.set(server.id, 'connected');
        } else if (resp.status >= 500) {
          this._serverStatuses.set(server.id, 'disconnected');
        } else {
          this._serverStatuses.set(server.id, 'connected');
        }
      } catch {
        this._serverStatuses.set(server.id, 'disconnected');
      }
      if (this._disposed || gen !== this._serverGeneration) { return; }
    }
    if (!this._isFormEditing) {
      this.sendStateUpdate();
    }
  }

  private async commitPendingChanges(serverId: string): Promise<void> {
    const pending = this._pendingChanges.get(serverId);
    if (!pending) return;
    const server = this._servers.find(s => s.id === serverId);
    if (!server) { this._pendingChanges.delete(serverId); return; }
    const password = pending.password || this._passwordsCache.get(serverId) || '';
    const username = pending.username ?? this._usernamesCache.get(serverId) ?? server.username ?? 'opencode';
    for (const key of Object.keys(pending)) {
      if (key === 'password') continue;
      (server as any)[key] = pending[key];
    }
    await this.persistServers();
    if (password && ('password' in pending || 'username' in pending)) {
      await this.persistCredentials(serverId, server.url, username, password);
    }
    this._pendingChanges.delete(serverId);
    this.sendStateUpdate();
  }

  private getHealthUrl(): string {
    const base = this.getConfiguredUrl();
    if (!base) return '';
    return base.replace(/\/+$/, '') + '/global/health';
  }

  private async checkHealth(): Promise<ConnectionState> {
    const url = this.getHealthUrl();
    if (!url || this._credentialErrors?.has(this._activeServerId)) { return 'disconnected'; }

    const generation = this._serverGeneration;
    const navigationKey = this.navigationStateKey();
    try {
      if (this._webUiV2 !== false) {
        const infoUrl = this.getConfiguredUrl().replace(/\/+$/, '') + '/api/info';
        const headers: Record<string, string> = {};
        if (this._cachedPassword) {
          headers.Authorization = basicAuthorization(this._cachedUsername, this._cachedPassword);
        }
        const info = await fetch(infoUrl, { headers, redirect: 'error', signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS) });
        if (generation !== this._serverGeneration || navigationKey !== this.navigationStateKey()) { return 'disconnected'; }
        this.log(`Health /api/info: server=${this._activeServerId} status=${info.status} credentials=${!!this._cachedPassword}`);
        if (info.status === 401 || info.status === 403) { return this.authenticationRequired(); }
        if (info.status >= 500) { return 'disconnected'; }
        if (info.ok && info.headers.get('content-type')?.includes('application/json')) {
          const data = await info.json() as { version?: string };
          if (generation !== this._serverGeneration || navigationKey !== this.navigationStateKey()) return 'disconnected';
          if (typeof data.version === 'string' && /^2\./.test(data.version)) {
            if (!this._webUiV2) { this.log('Detected OpenCode V2 web UI'); }
            this._webUiV2 = true;
            // A removed session is a valid route syntactically, but cannot be resumed.
            const match = /^\/server\/([^/]+)\/session\/([^/?#]+)(?:[?#].*)?$/.exec(this._savedIframePath);
            if (match && match[1] === Buffer.from(this.getUrlOrigin(this.getConfiguredUrl())).toString('base64url')) {
              const session = await fetch(this.getConfiguredUrl().replace(/\/+$/, '') + '/api/session/' + encodeURIComponent(match[2]),
                { headers, redirect: 'error', signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS) });
              if (generation !== this._serverGeneration || navigationKey !== this.navigationStateKey()) return 'disconnected';
              this.log(`Health session: status=${session.status}`);
              if (session.status === 401 || session.status === 403) { return this.authenticationRequired(); }
              if (session.status >= 500) { return 'disconnected'; }
              if (session.status === 404) {
                this._savedIframePath = '/';
                this._workspaceLaunchPending = false;
                void this._globalState.update(this.navigationStateKey(), '/');
                this._iframeNeedsNavigation = true;
              }
            }
            return 'connected';
          }
        }
        if (this._webUiV2) return 'disconnected';
        this._webUiV2 = false;
      }
      const resp = await fetch(url, {
        signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS), method: 'HEAD', redirect: 'error',
        headers: this._cachedPassword ? { Authorization: basicAuthorization(this._cachedUsername, this._cachedPassword) } : {},
      });
      if (generation !== this._serverGeneration || navigationKey !== this.navigationStateKey()) { return 'disconnected'; }
      this.log(`Health /global/health: server=${this._activeServerId} status=${resp.status} credentials=${!!this._cachedPassword}`);
      if (resp.status === 401 || resp.status === 403) { return this.authenticationRequired(); }
      return resp.ok ? 'connected' : 'disconnected';
    } catch (err) {
      this.log(`Health connection failure: ${err instanceof Error ? err.name : 'Error'}; credentials retained`);
      return 'disconnected';
    }
  }

  private authenticationRequired(): ConnectionState {
    this._authRejected = !!this._cachedPassword;
    this.log(`Authentication: server=${this._activeServerId} state=${this._authRejected ? 'rejected-by-server' : 'first-login'}; credentials retained`);
    return 'auth-required';
  }

  private startPolling(): void {
    if (this._pollTimer) { return; }
    this.pollOnce();
    this._pollTimer = setInterval(() => this.pollOnce(), 2500);
  }

  private stopPolling(): void {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = undefined;
    }
  }

  private clearReconnectTimer(): void {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = undefined;
    }
  }

  private async pollOnce(): Promise<void> {
    if (this._pollInFlight) {
      return this._pollInFlight;
    }
    this._pollInFlight = this.doPollOnce().finally(() => {
      this._pollInFlight = undefined;
    });
    return this._pollInFlight;
  }

  private async doPollOnce(): Promise<void> {
    const gen = this._serverGeneration;
    if (this._disposed) { return; }
    if (this._credentialErrors.has(this._activeServerId)) { await this.loadServers(); }
    if (this._disposed || gen !== this._serverGeneration) { return; }
    const state = await this.checkHealth();
    if (gen !== this._serverGeneration) { return; }
    if (
      state === this._connectionState &&
      !this._isReconnecting &&
      !this._iframeNeedsNavigation &&
      !(state === 'connected' && !this._proxyReady)
    ) { return; }

    if (state === 'connected') {
      if (!this._proxyReady) {
        const proxyReady = await this.startProxy();
        if (gen !== this._serverGeneration) return;
        if (!proxyReady) {
          this._connectionState = 'disconnected';
          this.updateStatusBar();
          this.sendStateUpdate();
          return;
        }
      }
      this._consecutiveAuthRequired = 0;
      this._authRejected = false;
      if (this._connectionState !== 'connected') {
        this.stopPolling();
        this._pollTimer = setInterval(() => this.pollOnce(), 10000);
        if (this._connectionState === 'starting') {
          this.log(`Server is ready (${state})`);
        }
      }
      this._consecutiveHealthFailures = 0;
      this._isReconnecting = false;
      this._reconnectAttempts = 0;
      this.clearReconnectTimer();
      if (state !== this._connectionState) {
        this.log(`State change: ${this._connectionState} -> ${state}`);
        this._connectionState = state;
      }
      this.updateStatusBar();
      if (gen === this._serverGeneration) {
        this.sendStateUpdate();
      }
    } else if (state === 'auth-required') {
      this._consecutiveHealthFailures = 0;
      this._consecutiveAuthRequired++;
      if (this._consecutiveAuthRequired < 2) {
        return;
      }
      this._consecutiveAuthRequired = 0;
      if (this._connectionState !== 'auth-required') {
        this.stopPolling();
        this._pollTimer = setInterval(() => this.pollOnce(), 10000);
        if (this._connectionState === 'starting') {
          this.log(`Server is ready (${state})`);
        }
      }
      this._isReconnecting = false;
      this._reconnectAttempts = 0;
      this.clearReconnectTimer();
      if (state !== this._connectionState) {
        this.log(`State change: ${this._connectionState} -> ${state}`);
        this._connectionState = state;
      }
      this.updateStatusBar();
      if (gen === this._serverGeneration) {
        this.sendStateUpdate();
      }
    } else if (this._connectionState === 'starting') {
      this.log('Waiting for server to start...');
    } else if (this._connectionState === 'checking') {
      this._connectionState = 'disconnected';
      this.updateStatusBar();
      if (gen === this._serverGeneration) {
        this.sendStateUpdate();
      }
      this.scheduleReconnect();
    } else {
      this._consecutiveHealthFailures++;
      if (this._consecutiveHealthFailures < 2 && this._connectionState === 'connected') {
        return;
      }
      this._isReconnecting = true;
      this._connectionState = 'disconnected';
      this.updateStatusBar();
      if (gen === this._serverGeneration) {
        this.sendStateUpdate();
      }
      this.scheduleReconnect();
    }
  }

  private cancelReconnect(): void {
    this._isReconnecting = false;
    this._reconnectAttempts = 0;
    this.clearReconnectTimer();
    this.updateStatusBar();
    this.sendStateUpdate();
  }

  private scheduleReconnect(): void {
    if (this._disposed) { return; }
    const autoReconnect = vscode.workspace.getConfiguration('opencode-web-sidebar').get('autoReconnect', true);
    if (!autoReconnect) {
      this._isReconnecting = false;
      this.updateStatusBar();
      this.sendStateUpdate();
      return;
    }

    const maxAttempts = vscode.workspace.getConfiguration('opencode-web-sidebar').get('maxReconnectAttempts', 0);
    if (maxAttempts > 0 && this._reconnectAttempts >= maxAttempts) {
      this._isReconnecting = false;
      this.updateStatusBar();
      this.sendStateUpdate();
      return;
    }

    const jitter = Math.random() * 1000;
    const delay = Math.min(Math.pow(2, this._reconnectAttempts) * 1000, 30000) + jitter;
    this._reconnectAttempts++;
    const gen = this._serverGeneration;

    this.clearReconnectTimer();
    this._reconnectTimer = setTimeout(async () => {
      if (this._disposed || gen !== this._serverGeneration) { return; }
      const state = await this.checkHealth();
      if (gen !== this._serverGeneration) { return; }
      if (state === 'connected' || state === 'auth-required') {
        if (state === 'connected' && !this._proxyReady) {
          const proxyReady = await this.startProxy();
          if (gen !== this._serverGeneration) return;
          if (!proxyReady) {
            this.scheduleReconnect();
            return;
          }
        }
        this._isReconnecting = false;
        this._connectionState = state;
        this._reconnectAttempts = 0;
        this.updateStatusBar();
        this.sendStateUpdate();
      } else {
        this.scheduleReconnect();
      }
    }, delay);
  }

  private renderServerRow(server: ServerConfig, isLocal: boolean): string {
    const activeId = this._activeServerId;
    const isActive = server.id === activeId;
    const pending = this._pendingChanges.get(server.id);
    const hasPending = !!pending;
    const serverIdJs = escapeJsString(server.id);
    const serverIdAttr = escapeAttr(server.id);
    const label = this.displayServerLabel(server, pending?.label);
    const url = pending?.url ?? server.url;
    const serverUsername = pending?.username ?? this._usernamesCache.get(server.id) ?? server.username ?? '';
    const authEnabled = pending?.authEnabled ?? server.authEnabled ?? false;
    const isWsl = pending?.isWsl ?? server.isWsl ?? false;
    const hasPassword = !!(this._passwordsCache.get(server.id));
    const usingEnv = isActive && this._usingEnvPassword && !hasPassword;
    const isDefault = server.isDefault;

    const urlValue = escapeAttr(url);

    let statusClass = 'status-dot';
    if (isActive) {
      if (this._connectionState === 'connected') statusClass += ' connected';
      else if (this._connectionState === 'checking' || this._connectionState === 'starting') statusClass += ' pulse';
      else if (this._connectionState === 'auth-required') statusClass += ' auth';
      else statusClass += ' disconnected';
    } else {
      const s = this._serverStatuses.get(server.id) || 'unknown';
      if (s === 'connected') statusClass += ' connected';
      else if (s === 'auth-required') statusClass += ' auth';
      else statusClass += ' disconnected';
    }

    let action: string;
    if (isLocal) {
      if (isActive) {
        action = `<span class="badge badge-active">${escapeAttr(vscode.l10n.t('ACTIVE'))}</span>`;
      } else {
        action = `<div class="btn-row">
          <button class="btn btn-outline btn-xs" onclick="startAndConnect('${serverIdJs}')">${escapeAttr(vscode.l10n.t('Start & Connect'))}</button>
          <button class="btn btn-default btn-xs" onclick="connectToServer('${serverIdJs}')">${escapeAttr(vscode.l10n.t('Connect'))}</button>
        </div>`;
      }
    } else {
      if (isActive) {
        action = `<span class="badge badge-active">${escapeAttr(vscode.l10n.t('ACTIVE'))}</span>`;
      } else {
        action = `<button class="btn btn-default btn-xs" onclick="connectToServer('${serverIdJs}')">${escapeAttr(vscode.l10n.t('Connect'))}</button>`;
      }
    }

    let footerLeft = '';
    if (isDefault) {
      footerLeft = `<span class="badge badge-outline">${escapeAttr(vscode.l10n.t('default'))}</span>`;
    } else {
      footerLeft = `<button class="btn btn-ghost btn-xs" onclick="setDefaultServer('${serverIdJs}')">${escapeAttr(vscode.l10n.t('Set Default'))}</button>`;
    }

    const trashSvg = '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" style="pointer-events:none;display:block"><path d="M6.5 1.5H5V3h6V1.5H9.5L9 1H7L6.5 1.5zM3 4v1h1v9.5c0 .3.2.5.5.5h7c.3 0 .5-.2.5-.5V5h1V4H3zm2 1h6v9H5V5z"/></svg>';
    const saveSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" style="pointer-events:none;display:block"><path fill-rule="evenodd" clip-rule="evenodd" d="M18.1716 1C18.702 1 19.2107 1.21071 19.5858 1.58579L22.4142 4.41421C22.7893 4.78929 23 5.29799 23 5.82843V20C23 21.6569 21.6569 23 20 23H4C2.34315 23 1 21.6569 1 20V4C1 2.34315 2.34315 1 4 1H18.1716ZM4 3C3.44772 3 3 3.44772 3 4V20C3 20.5523 3.44772 21 4 21L5 21L5 15C5 13.3431 6.34315 12 8 12L16 12C17.6569 12 19 13.3431 19 15V21H20C20.5523 21 21 20.5523 21 20V6.82843C21 6.29799 20.7893 5.78929 20.4142 5.41421L18.5858 3.58579C18.2107 3.21071 17.702 3 17.1716 3H17V5C17 6.65685 15.6569 8 14 8H10C8.34315 8 7 6.65685 7 5V3H4ZM17 21V15C17 14.4477 16.5523 14 16 14L8 14C7.44772 14 7 14.4477 7 15L7 21L17 21ZM9 3H15V5C15 5.55228 14.5523 6 14 6H10C9.44772 6 9 5.55228 9 5V3Z"/></svg>';
    const saveBtn = hasPending
      ? `<span class="btn btn-default btn-xs" onclick="commitServerChanges('${serverIdJs}')" title="${escapeAttr(vscode.l10n.t('Save changes'))}" role="button" tabindex="0" style="cursor:pointer;display:inline-flex;align-items:center;gap:4px">${escapeAttr(vscode.l10n.t('SAVE'))} ${saveSvg}</span>`
      : '';

    const userPlaceholder = (usingEnv && !server.username) ? vscode.l10n.t('[Using opencode]') : vscode.l10n.t('Username');
    const passPlaceholder = usingEnv ? vscode.l10n.t('[Using OPENCODE_SERVER_PASSWORD]') : hasPassword ? '••••••••' : vscode.l10n.t('Password');
    const authFieldsStyle = authEnabled ? '' : ' style="display:none"';

    return `<div class="card" data-id="${serverIdAttr}">
      <div class="card-header">
        <div class="card-title">
          <input class="input-title" type="text" value="${escapeAttr(label)}" onchange="pendingChange('${serverIdJs}','label',this.value)" placeholder="${escapeAttr(vscode.l10n.t('Server name'))}" spellcheck="false">
          ${isActive ? `<span class="${statusClass}"></span>` : ''}
        </div>
        <div class="card-description">${urlValue}</div>
        <div class="card-action">${isActive ? action : `<span class="${statusClass}"></span> ${action}`}</div>
      </div>
      <div class="card-content">
        <input class="input" type="text" value="${urlValue}" onchange="pendingChange('${serverIdJs}','url',this.value)" placeholder="http://localhost:4096">
        <div class="field-row"${authFieldsStyle}>
          <input class="input input-sm" id="user-${serverIdAttr}" type="text" placeholder="${escapeAttr(userPlaceholder)}" value="${escapeAttr(serverUsername)}" onchange="pendingChange('${serverIdJs}','username',this.value)">
          <input class="input input-sm" id="pass-${serverIdAttr}" type="password" placeholder="${escapeAttr(passPlaceholder)}" onchange="pendingChange('${serverIdJs}','password',this.value)">
        </div>
        <div class="toggle-row">
          <label class="switch-label">
            <input type="checkbox" class="switch-input" ${authEnabled ? 'checked' : ''} onchange="pendingChange('${serverIdJs}','authEnabled',this.checked)">
            <span>${escapeAttr(vscode.l10n.t('authentication'))}</span>
          </label>
          <label class="switch-label">
            <input type="checkbox" class="switch-input" ${isWsl ? 'checked' : ''} onchange="pendingChange('${serverIdJs}','isWsl',this.checked)">
            <span>${escapeAttr(vscode.l10n.t('is WSL / Linux'))}</span>
          </label>
        </div>
      </div>
      <div class="card-footer">
        ${footerLeft}
        <div style="flex:1"></div>
        ${saveBtn}
        ${isLocal ? '' : `<span class="btn btn-ghost btn-xs" onclick="removeServer('${serverIdJs}')" title="${escapeAttr(vscode.l10n.t('Remove server'))}" role="button" tabindex="0" style="cursor:pointer">${trashSvg}</span>`}
      </div>
    </div>`;
  }

  private getHtmlContent(): string {
    const url = this.getConfiguredUrl();
    const activeServer = this.getActiveServer();

    this.log(`Generating HTML (state=${this._connectionState}, showSelector=${this._showServerSelector})`);

    const uiState = this.computeUIState();
    const { statusColor, statusText, statusBarStop, overlayContent, overlayHidden, showIframe, iframeUrl } = uiState;

    const origin = this.getUrlOrigin(url);

    const proxyOrigin = this._proxyBaseUrl
      ? new URL(this._proxyBaseUrl).origin
      : (this._proxyPort ? `http://127.0.0.1:${this._proxyPort}` : '');
    const frameSrcBase = proxyOrigin || origin;
    const frameSrc = showIframe && frameSrcBase
      ? `frame-src ${frameSrcBase};`
      : "frame-src http://127.0.0.1:* http://localhost:*;";

    const imgSrc = showIframe && (proxyOrigin || origin)
      ? `${proxyOrigin || origin}`
      : 'http://127.0.0.1:* http://localhost:* https:';
    const connectSrc = showIframe && (proxyOrigin || origin)
      ? `${proxyOrigin || origin}`
      : 'http://127.0.0.1:* http://localhost:*';

    const csp = [
      "default-src 'self';",
      frameSrc,
      "style-src 'self' 'unsafe-inline';",
      "script-src 'self' 'unsafe-inline';",
      `img-src 'self' ${imgSrc} data:;`,
      `connect-src 'self' ${connectSrc} data:;`,
      "font-src 'self' data:;",
    ].join(' ');

    const iframeSrc = showIframe && iframeUrl
      ? `src="${escapeAttr(iframeUrl)}"` : '';
    const iframeStyle = showIframe ? 'display:block' : 'display:none';

    this.log(`iframe URL prepared (showIframe=${showIframe})`);

    const activeLabel = activeServer?.label || activeServer?.url || 'Server';
    const sidebarTheme = this.getSidebarThemePreference();

    return `<!DOCTYPE html>
<html lang="${escapeAttr(vscode.env.language || 'en')}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <title>OpenCode</title>
  <style>
    :root {
      --background: var(--vscode-sideBar-background, #1e1e1e);
      --foreground: var(--vscode-sideBar-foreground, #cccccc);
      --card: var(--vscode-sideBar-background, #1e1e1e);
      --card-foreground: var(--vscode-foreground, #cccccc);
      --primary: var(--vscode-button-background, #007acc);
      --primary-foreground: var(--vscode-button-foreground, #ffffff);
      --secondary: var(--vscode-button-secondaryBackground, rgba(128,128,128,0.16));
      --secondary-foreground: var(--vscode-button-secondaryForeground, var(--vscode-foreground, #cccccc));
      --muted: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,0.12));
      --muted-foreground: var(--vscode-descriptionForeground, var(--vscode-foreground, #888888));
      --accent: var(--vscode-list-hoverBackground, rgba(128,128,128,0.12));
      --accent-foreground: var(--vscode-list-hoverForeground, var(--vscode-foreground, #cccccc));
      --destructive: var(--vscode-errorForeground, #e06c75);
      --destructive-foreground: var(--vscode-button-foreground, #ffffff);
      --border: var(--vscode-panel-border, var(--vscode-widget-border, rgba(128,128,128,0.25)));
      --input: var(--vscode-input-border, var(--vscode-panel-border, rgba(128,128,128,0.35)));
      --ring: var(--vscode-focusBorder, #007acc);
      --radius: 0.625rem;
    }
    * { margin:0; padding:0; box-sizing:border-box; }
    html,body { height:100%; width:100%; overflow:hidden; background:var(--background); color:var(--foreground); font-family:var(--vscode-font-family,sans-serif); font-size:13px; -webkit-font-smoothing:antialiased; }
    iframe { width:100%; height:calc(100% - 24px); border:none; display:none; }
    input { font-family:inherit; font-size:inherit; }

    .status-bar {
      height:24px; display:flex; align-items:center; padding:0 10px;
      font-family:var(--vscode-font-family,sans-serif); font-size:11px;
      background:var(--vscode-statusBar-background,#007acc);
      color:var(--vscode-statusBar-foreground,#fff);
      gap:6px; user-select:none;
    }
    .status-bar .dot {
      display:inline-block; width:8px; height:8px; border-radius:50%;
      flex-shrink:0;
    }
    .status-bar .spacer { flex:1; }
    .status-bar a {
      color:inherit; opacity:.7; text-decoration:none; cursor:pointer;
    }
    .status-bar a:hover { opacity:1; text-decoration:underline; }
    .separator { color:inherit; opacity:.35; }

    .overlay {
      position:absolute; inset:24px 0 0 0; display:flex; flex-direction:column;
      align-items:center; justify-content:center; gap:12px;
      color:var(--muted-foreground);
      font-family:var(--vscode-font-family,sans-serif); font-size:13px;
      padding:20px;
    }
    .overlay.hidden { display:none; }
    .overlay .lock-icon { font-size:32px; }
    .overlay code { font-size:12px; opacity:.8; }
    .overlay .btn-row { display:flex; gap:8px; margin-top:4px; }
    .overlay .oc-icon {
      display:flex; align-items:center; justify-content:center; opacity:.5;
      margin-bottom:8px;
    }
    .overlay .spinner {
      width:24px; height:24px; border:3px solid var(--muted-foreground);
      border-top-color:transparent; border-radius:50%;
      animation:spin .8s linear infinite;
    }
    @keyframes spin { to { transform:rotate(360deg); } }

    .server-selector {
      width:100%; height:100%; overflow-y:auto; padding:12px;
      display:flex; flex-direction:column; gap:8px;
    }

    .card {
      display:flex; flex-direction:column; gap:12px;
      border-radius:var(--radius); padding:12px 0;
      background:var(--card); color:var(--card-foreground);
      border:1px solid var(--border); overflow:hidden;
    }
    .card:has(.card-footer) { padding-bottom:0; }
    .card-header {
      display:grid; gap:4px; padding:0 12px;
      align-items:start; grid-auto-rows:min-content;
    }
    .card-header:has(.card-title) { grid-template-columns:1fr auto; }
    .card-title {
      font-size:13px; font-weight:500; line-height:1.3;
      display:flex; align-items:center; gap:6px;
    }
    .card-title .status-dot { margin-top:4px; }
    .card-description {
      font-size:11px; color:var(--muted-foreground); word-break:break-all;
    }
    .card-action {
      grid-column:2; grid-row:1/span 2; justify-self:end; align-self:start;
      display:flex; align-items:center; gap:4px;
    }
    .card-action .status-dot { margin-top:2px; }
    .card-content {
      padding:0 12px; display:flex; flex-direction:column; gap:4px;
    }
    .card-footer {
      display:flex; align-items:center; gap:4px; padding:8px 12px; margin:0;
      background:color-mix(in srgb,var(--muted) 50%,transparent);
      border-top:1px solid var(--border);
      border-radius:0 0 var(--radius) var(--radius);
      flex-wrap:wrap;
    }

    .btn {
      display:inline-flex; align-items:center; justify-content:center;
      border-radius:12px; font-size:12px; font-weight:500; line-height:1;
      white-space:nowrap; transition:all .15s; cursor:pointer;
      border:1px solid transparent; font-family:inherit; outline:none;
      height:28px; padding:0 10px; gap:4px;
    }
    .btn:hover { opacity:.9; }
    .btn:active { transform:translateY(1px); }
    .btn-default {
      background:var(--primary); color:var(--primary-foreground);
    }
    .btn-outline {
      background:transparent; color:var(--foreground);
      border-color:var(--border);
    }
    .btn-outline:hover { background:var(--muted); }
    .btn-ghost {
      background:transparent; color:var(--foreground);
    }
    .btn-ghost:hover { background:var(--muted); }
    .btn-destructive {
      background:color-mix(in srgb,var(--destructive) 10%,transparent);
      color:var(--destructive);
    }
    .btn-destructive:hover {
      background:color-mix(in srgb,var(--destructive) 20%,transparent);
    }
    .btn-xs { height:24px; padding:0 8px; font-size:11px; border-radius:10px; }
    .btn-icon { width:28px; height:28px; padding:0; }
    .btn-row { display:flex; gap:6px; align-items:center; }

    .badge {
      display:inline-flex; align-items:center; justify-content:center;
      height:20px; padding:0 8px; border-radius:9999px;
      font-size:11px; font-weight:500; white-space:nowrap;
      border:1px solid transparent; line-height:1;
    }
    .badge-active {
      background:var(--vscode-inputValidation-infoBackground,#063b6d);
      color:var(--vscode-inputValidation-infoBorder,#3794ff);
      border-color:var(--vscode-inputValidation-infoBorder,#3794ff);
    }
    .badge-outline {
      background:transparent; color:var(--foreground);
      border-color:var(--border);
    }
    .badge-secondary {
      background:var(--secondary); color:var(--secondary-foreground);
    }

    .input {
      width:100%; height:32px; padding:4px 10px;
      border-radius:8px; border:1px solid var(--input);
      background:transparent; color:var(--foreground);
      font-family:var(--vscode-font-family,sans-serif); font-size:13px;
      transition:border-color .15s,box-shadow .15s;
      outline:none; min-width:0; display:block;
    }
    .input:focus {
      border-color:var(--ring);
      box-shadow:0 0 0 3px color-mix(in srgb,var(--ring) 50%,transparent);
    }
    .input::placeholder { color:var(--muted-foreground); opacity:1; }
    .input-sm { height:28px; padding:2px 8px; font-size:12px; border-radius:6px; }
    .input-title {
      width:100%; font-size:13px; font-weight:500; line-height:1.3;
      background:transparent; border:none; color:var(--card-foreground);
      font-family:var(--vscode-font-family,sans-serif); outline:none; padding:0; margin:0;
    }
    .input-title::placeholder { color:var(--muted-foreground); opacity:.5; }
    .field-row { display:flex; gap:4px; }
    .field-row > .input { flex:1; min-width:0; }

    .toggle-row {
      display:flex; align-items:center; gap:12px; flex-wrap:wrap;
    }
    .switch-label {
      display:inline-flex; align-items:center; gap:6px;
      cursor:pointer; font-size:11px; user-select:none;
    }
    .switch-input {
      appearance:none; -webkit-appearance:none;
      width:32px; height:18.4px; border-radius:9999px;
      background:var(--input); cursor:pointer; transition:background .2s;
      flex-shrink:0; position:relative; border:1px solid transparent; margin:0;
    }
    .switch-input::after {
      content:''; position:absolute; top:1.2px; left:1.2px;
      width:14px; height:14px; border-radius:50%;
      background:var(--card-foreground); transition:transform .2s;
    }
    .switch-input:checked { background:var(--primary); }
    .switch-input:checked::after { transform:translateX(13.6px); }

    .status-dot {
      display:inline-block; width:10px; height:10px; border-radius:50%;
      flex-shrink:0; background:var(--muted);
    }
    .status-dot.connected { background:#4ec94e; }
    .status-dot.disconnected { background:var(--destructive); }
    .status-dot.auth { background:var(--muted-foreground); }
    .status-dot.muted { background:var(--muted); opacity:.5; }
    .status-dot.pulse { animation:pulse 1.5s ease-in-out infinite; }
    @keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:.5; } }

    .local-section {
      margin-top:16px; padding-top:12px;
      border-top:1px solid var(--border);
    }
    .section-title {
      text-align:center; font-size:12px; font-weight:600; text-transform:uppercase;
      color:var(--muted-foreground); margin-bottom:8px; letter-spacing:.5px;
    }
  </style>
</head>
<body>
  <div class="status-bar">
    <span class="dot" id="statusDot" style="background:${statusColor}"></span>
    <span id="statusText">${statusText}</span>
    <span class="spacer"></span>
    <span id="statusBarActions">${statusBarStop}</span>
    <a onclick="refresh()">${escapeAttr(vscode.l10n.t('Refresh'))}</a>
    <span class="separator">&nbsp;|&nbsp;</span>
    <a onclick="selectServer()">${escapeAttr(vscode.l10n.t('Servers'))}</a>
    <span class="separator">&nbsp;|&nbsp;</span>
    <a onclick="closePanel()">${escapeAttr(vscode.l10n.t('Close'))}</a>
  </div>

  <iframe id="ocFrame" onload="sendWorkspace(); syncTheme()" sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
    ${iframeSrc} style="${iframeStyle}"></iframe>

  <div id="overlay" class="overlay ${overlayHidden ? 'hidden' : ''}">
    ${overlayContent}
  </div>

  <script>
    const vscode = acquireVsCodeApi();

    let __overlayEditing = false;
    let __sidebarTheme = ${JSON.stringify(sidebarTheme)};

    const __overlay = document.getElementById('overlay');
    __overlay.addEventListener('focusin', e => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') {
        if (!__overlayEditing) {
          __overlayEditing = true;
          vscode.postMessage({ type: 'formEditing', editing: true });
        }
      }
    });
    __overlay.addEventListener('focusout', e => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.tagName === 'SELECT') {
        setTimeout(() => {
          const active = document.activeElement;
          if (!active || !__overlay.contains(active) ||
              !(active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT')) {
            if (__overlayEditing) {
              __overlayEditing = false;
              vscode.postMessage({ type: 'formEditing', editing: false });
            }
          }
        }, 0);
      }
    });

    window.addEventListener('message', event => {
      const msg = event.data;
      if (msg.type === 'updateState') {
        document.getElementById('statusDot').style.background = msg.statusColor;
        document.getElementById('statusText').textContent = msg.statusText;
        document.getElementById('statusBarActions').innerHTML = msg.statusBarStop || '';
        document.getElementById('overlay').innerHTML = msg.overlayContent;
        document.getElementById('overlay').className = 'overlay' + (msg.overlayHidden ? ' hidden' : '');
        const iframe = document.getElementById('ocFrame');
        if (iframe) {
          if (msg.showIframe && msg.iframeUrl && (msg.reloadIframe || iframe.src !== msg.iframeUrl)) {
            iframe.src = msg.iframeUrl;
          }
          iframe.style.display = msg.showIframe ? 'block' : 'none';
        }
      } else if (msg.type === 'sidebarThemeChanged') {
        __sidebarTheme = msg.theme === 'codex' || msg.theme === 'vscode' || msg.theme === 'native' ? msg.theme : 'codex';
        syncTheme();
      } else if (msg.type === 'ocFrameUrlChanged') {
        const frame = document.getElementById('ocFrame');
        if (!frame || event.source !== frame.contentWindow || event.origin !== new URL(frame.src).origin) return;
        vscode.postMessage({ type: 'ocFrameUrlChanged', path: msg.path });
      }
    });

    function openSettings() {
      vscode.postMessage({ type: 'openSettings' });
    }

    function closePanel() {
      vscode.postMessage({ type: 'closePanel' });
    }

    function pair() {
      vscode.postMessage({ type: 'pair' });
    }

    function setPassword() {
      vscode.postMessage({ type: 'setPassword' });
    }

    function refresh() {
      vscode.postMessage({ type: 'refresh' });
    }

    function startServer() {
      vscode.postMessage({ type: 'startServer' });
    }

    function stopServer() {
      vscode.postMessage({ type: 'stopServer' });
    }

    function cancelReconnect() {
      vscode.postMessage({ type: 'cancelReconnect' });
    }

    function selectServer() {
      vscode.postMessage({ type: 'selectServer' });
    }

    function connectToServer(serverId) {
      vscode.postMessage({ type: 'connectToServer', serverId });
    }

    function startAndConnect(serverId) {
      vscode.postMessage({ type: 'startAndConnect', serverId });
    }

    function pendingChange(serverId, key, value) {
      vscode.postMessage({ type: 'pendingChange', serverId, key, value });
    }

    function commitServerChanges(serverId) {
      vscode.postMessage({ type: 'commitServerChanges', serverId });
    }

    function removeServer(serverId) {
      vscode.postMessage({ type: 'removeServer', serverId });
    }

    function setDefaultServer(serverId) {
      vscode.postMessage({ type: 'setDefaultServer', serverId });
    }

    function addServer() {
      vscode.postMessage({ type: 'addServer', config: { url: 'http://localhost:4096', label: '' } });
    }

    function sendWorkspace() {
      const iframe = document.getElementById('ocFrame');
      const folder = ${JSON.stringify(this.getWorkspaceFolder())};
      if (iframe && iframe.contentWindow && folder) {
        const origin = iframe.src ? new URL(iframe.src).origin : '*';
        const bytes = new TextEncoder().encode(folder);
        const binary = Array.from(bytes, byte => String.fromCharCode(byte)).join('');
        const b64 = btoa(binary).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
        iframe.contentWindow.postMessage(
          { type: 'openProject', path: folder, dir: b64, source: 'vscode' }, origin
        );
      }
    }

    // VS Code injects its color theme as --vscode-* custom properties into the
    // webview document; the iframe cannot see them (separate document), so we
    // forward a small snapshot and let the injected script resolve tokens.
    const VSCODE_COLOR_VARS = [
      'sideBar-background', 'editor-background', 'foreground', 'descriptionForeground',
      'icon-foreground', 'input-background', 'input-placeholderForeground', 'focusBorder',
      'sideBarSectionHeader-background', 'menu-background', 'editorWidget-background',
      'list-hoverBackground', 'list-activeSelectionBackground', 'button-background',
      'button-foreground', 'button-secondaryBackground', 'badge-background', 'badge-foreground',
      'textLink-foreground', 'textLink-activeForeground'
    ];

    function readVscodeColors() {
      const colors = {};
      try {
        const targets = [getComputedStyle(document.documentElement)];
        if (document.body) { targets.push(getComputedStyle(document.body)); }
        for (const name of VSCODE_COLOR_VARS) {
          for (const style of targets) {
            const value = style.getPropertyValue('--vscode-' + name).trim();
            if (value) { colors[name] = value; break; }
          }
        }
      } catch (error) {
        // Leave the snapshot empty; the page keeps the static fallback palette.
      }
      return colors;
    }

    function syncTheme() {
      const classes = document.body.className;
      const dark = classes.includes('vscode-dark') || classes.includes('vscode-high-contrast');
      const mode = dark && !classes.includes('vscode-high-contrast-light') ? 'dark' : 'light';
      const iframe = document.getElementById('ocFrame');
      if (iframe && iframe.contentWindow && iframe.src) {
        const payload = { type: 'ocSidebarTheme', theme: __sidebarTheme, mode, source: 'vscode' };
        if (__sidebarTheme === 'vscode') { payload.colors = readVscodeColors(); }
        iframe.contentWindow.postMessage(payload, new URL(iframe.src).origin);
      }
    }

    let __syncQueued = false;
    function queueSyncTheme() {
      if (__syncQueued) { return; }
      __syncQueued = true;
      setTimeout(() => { __syncQueued = false; syncTheme(); }, 50);
    }

    syncTheme();
    const obs = new MutationObserver(queueSyncTheme);
    obs.observe(document.body, { attributes: true, attributeFilter: ['class'] });
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-vscode-theme-kind', 'data-vscode-theme-id'] });
    obs.observe(document.head, { childList: true, subtree: true, characterData: true });
  </script>
</body>
</html>`;
  }

  private renderServerSelector(): string {
    const regularServers = this._servers.filter(s => s.id !== 'default');
    const localServer = this._servers.find(s => s.id === 'default');

    const regularHtml = regularServers.map(s => this.renderServerRow(s, false)).join('\n');
    const localHtml = localServer ? this.renderServerRow(localServer, true) : '';

    const regularSection = regularHtml || regularServers.length > 0
      ? `<div class="section-title" style="margin-top:8px">${escapeAttr(vscode.l10n.t('Servers'))}</div>${regularHtml}` : '';

    return `<div class="server-selector">
      <button class="btn btn-ghost btn-xs" onclick="selectServer()" style="margin-bottom:4px;flex-shrink:0">${escapeAttr(vscode.l10n.t('← Back'))}</button>
      ${regularSection}
      <div class="local-section">
        <div class="section-title">${escapeAttr(vscode.l10n.t('Local Server'))}</div>
        ${localHtml || `<span style="font-size:12px;opacity:.5">${escapeAttr(vscode.l10n.t('No local server configured'))}</span>`}
      </div>
      <div class="btn-row" style="justify-content:center;margin-top:4px">
        <button class="btn btn-outline" style="height:32px;padding:0 16px;border-radius:8px" onclick="addServer()">${escapeAttr(vscode.l10n.t('+ Add Server'))}</button>
      </div>
    </div>`;
  }
}
