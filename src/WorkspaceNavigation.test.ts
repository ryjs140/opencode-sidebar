import { strictEqual } from 'node:assert';
import { test } from 'node:test';
import {
  decideTrackedIframePath,
  encodeOpenCodeRouteSegment,
  getWorkspaceSessionPath,
  rebaseSessionPath,
  isV2AppPath,
} from './WorkspaceNavigation';

test('encodes OpenCode route segments as unpadded Base64URL', () => {
  strictEqual(encodeOpenCodeRouteSegment('C:/tmp/ÿ'), 'QzovdG1wL8O_');
  strictEqual(encodeOpenCodeRouteSegment('࠾'), '4KC-');
});

test('builds a workspace new-session compatibility route', () => {
  strictEqual(
    getWorkspaceSessionPath('C:\\Users\\demo'),
    '/QzpcVXNlcnNcZGVtbw/session',
  );
  strictEqual(getWorkspaceSessionPath(''), '');
});

test('keeps a workspace launch pending at its compatibility route', () => {
  const route = '/QzpcV29ya3NwYWNl/session';
  const decision = decideTrackedIframePath(route, true, route);
  strictEqual(decision.accept, true);
  strictEqual(decision.completesWorkspaceLaunch, false);
});

test('ignores restored home and unrelated tab routes during workspace launch', () => {
  const route = '/QzpcV29ya3NwYWNl/session';
  strictEqual(decideTrackedIframePath('/', true, route).accept, false);
  strictEqual(decideTrackedIframePath('/new-session', true, route).accept, false);
  strictEqual(decideTrackedIframePath('/settings', true, route).accept, false);
});

test('accepts the new UI draft redirect and concrete sessions', () => {
  const route = '/QzpcV29ya3NwYWNl/session';
  for (const path of [
    '/new-session?draftId=draft_123',
    '/QzpcV29ya3NwYWNl/session/ses_123',
    '/server/aHR0cDovL2xvY2FsaG9zdDo0MDk2/session/ses_123',
  ]) {
    const decision = decideTrackedIframePath(path, true, route);
    strictEqual(decision.accept, true);
    strictEqual(decision.completesWorkspaceLaunch, true);
  }
});

test('tracks ordinary navigation after workspace launch completes', () => {
  const decision = decideTrackedIframePath('/', false, '/ignored/session');
  strictEqual(decision.accept, true);
  strictEqual(decision.completesWorkspaceLaunch, false);
});

test('rejects absolute and protocol-relative iframe paths', () => {
  strictEqual(decideTrackedIframePath('https://example.com/', false, '').accept, false);
  strictEqual(decideTrackedIframePath('//example.com/', false, '').accept, false);
});

test('V2 launches through home with a lossless space-containing directory and restore path', () => {
  const directory = '/home/gfy/software/Traffic monitor';
  const restore = '/new-session?draftId=draft_123';
  const url = new URL(getWorkspaceSessionPath(directory, true, restore), 'http://localhost');
  strictEqual(url.pathname, '/');
  strictEqual(url.searchParams.get('_ocWorkspace'), directory);
  strictEqual(url.searchParams.get('_ocRestore'), restore);
});

test('rebinds only the current server session across dynamic proxy ports', () => {
  const oldOrigin = 'http://127.0.0.1:4097';
  const newOrigin = 'https://forwarded.example:4100';
  const path = `/server/${encodeOpenCodeRouteSegment(oldOrigin)}/session/ses_123`;
  strictEqual(rebaseSessionPath(path, oldOrigin, newOrigin),
    `/server/${encodeOpenCodeRouteSegment(newOrigin)}/session/ses_123`);
  strictEqual(rebaseSessionPath(path, 'http://other-server', newOrigin), path);
});

test('V2 route validation rejects old, malformed and external addresses', () => {
  for (const path of ['/encoded/session', '/server/!!!/session/ses_123', '//evil.test/', '/\\evil.test/']) {
    strictEqual(isV2AppPath(path), false, path);
  }
  for (const path of ['/', '/settings', '/new-session?draftId=abc', '/server/aHR0cDovL2xvY2FsaG9zdDo0MDk2/session/ses_123']) {
    strictEqual(isV2AppPath(path), true, path);
  }
});
