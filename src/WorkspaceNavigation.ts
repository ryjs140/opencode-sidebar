export interface TrackedIframePathDecision {
  accept: boolean;
  completesWorkspaceLaunch: boolean;
}

export function encodeOpenCodeRouteSegment(value: string): string {
  return Buffer.from(value, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function getWorkspaceSessionPath(workspaceFolder: string, v2 = false, restorePath = ''): string {
  if (v2) {
    const query = new URLSearchParams();
    if (workspaceFolder) query.set('_ocWorkspace', workspaceFolder);
    if (restorePath) query.set('_ocRestore', restorePath);
    return query.size ? `/?${query}` : '/';
  }
  return workspaceFolder ? `/${encodeOpenCodeRouteSegment(workspaceFolder)}/session` : '';
}

export function decideTrackedIframePath(
  path: string,
  workspaceLaunchPending: boolean,
  workspaceLaunchPath: string,
): TrackedIframePathDecision {
  if (!isRelativeAppPath(path)) {
    return { accept: false, completesWorkspaceLaunch: false };
  }
  if (!workspaceLaunchPending) {
    return { accept: true, completesWorkspaceLaunch: false };
  }
  // The new UI can briefly restore its persisted home/tabs route before it
  // turns the legacy workspace URL into a draft. Keep the launch authoritative
  // until that draft or a concrete session is visible.
  if (path === workspaceLaunchPath) {
    return { accept: true, completesWorkspaceLaunch: false };
  }
  if (isNewSessionDraftPath(path) || isConcreteSessionPath(path)) {
    return { accept: true, completesWorkspaceLaunch: true };
  }
  return { accept: false, completesWorkspaceLaunch: false };
}

function isRelativeAppPath(value: string): boolean {
  if (!value.startsWith('/') || value.startsWith('//')) {
    return false;
  }
  try {
    const url = new URL(value, 'http://opencode.local');
    return url.origin === 'http://opencode.local';
  } catch {
    return false;
  }
}

function isNewSessionDraftPath(value: string): boolean {
  const url = new URL(value, 'http://opencode.local');
  return url.pathname === '/new-session' && !!url.searchParams.get('draftId');
}

function isConcreteSessionPath(value: string): boolean {
  const pathname = new URL(value, 'http://opencode.local').pathname;
  return /^\/server\/[^/]+\/session\/[^/]+$/.test(pathname)
    || /^\/[^/]+\/session\/[^/]+$/.test(pathname);
}

/** Rebase only this proxy's server key; other servers' session routes stay intact. */
export function rebaseSessionPath(path: string, from: string, to: string): string {
  const prefix = `/server/${encodeOpenCodeRouteSegment(from)}/session/`;
  return path.startsWith(prefix)
    ? `/server/${encodeOpenCodeRouteSegment(to)}/session/` + path.slice(prefix.length)
    : path;
}

export function isV2AppPath(path: string): boolean {
  if (!isRelativeAppPath(path)) return false;
  const url = new URL(path, 'http://opencode.local');
  if (['/', '/settings', '/new-session'].includes(url.pathname)) return true;
  const match = /^\/server\/([^/]+)\/session\/([^/]+)$/.exec(url.pathname);
  if (!match) return false;
  return encodeOpenCodeRouteSegment(Buffer.from(match[1], 'base64url').toString('utf8')) === match[1];
}
