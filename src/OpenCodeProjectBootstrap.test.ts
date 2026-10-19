import { strictEqual } from 'node:assert';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import {
  OPENCODE_PROJECT_BOOTSTRAP_SCRIPT,
  OPENCODE_SERVER_STATE_KEY,
  OPENCODE_V2_BOOTSTRAP_SCRIPT,
} from './OpenCodeProjectBootstrap';
import { encodeOpenCodeRouteSegment } from './WorkspaceNavigation';

function runBootstrap(pathname: string, initialState?: unknown): Map<string, string> {
  const values = new Map<string, string>();
  if (initialState !== undefined) {
    values.set(OPENCODE_SERVER_STATE_KEY, JSON.stringify(initialState));
  }
  const window = {
    location: { pathname },
    localStorage: {
      getItem(key: string) {
        return values.get(key) ?? null;
      },
      setItem(key: string, value: string) {
        values.set(key, value);
      },
    },
  };
  const source = OPENCODE_PROJECT_BOOTSTRAP_SCRIPT
    .replace(/^<script>\s*/, '')
    .replace(/\s*<\/script>$/, '');
  runInNewContext(source, {
    window,
    Uint8Array,
    TextDecoder,
    atob,
  });
  return values;
}

test('registers an unseen compatibility-route workspace before OpenCode starts', () => {
  const directory = 'C:\\Users\\demo\\new workspace';
  const pathname = `/${encodeOpenCodeRouteSegment(directory)}/session`;
  const values = runBootstrap(pathname, {
    list: [],
    projects: {
      local: [{ worktree: 'C:\\Users\\demo\\existing', expanded: false }],
    },
    lastProject: { local: 'C:\\Users\\demo\\existing' },
    recentlyClosed: { local: [directory] },
    untouched: { value: true },
  });
  const state = JSON.parse(values.get(OPENCODE_SERVER_STATE_KEY) ?? '{}');

  strictEqual(state.projects.local[0].worktree, directory);
  strictEqual(state.projects.local[0].expanded, true);
  strictEqual(state.projects.local[1].worktree, 'C:\\Users\\demo\\existing');
  strictEqual(state.lastProject.local, directory);
  strictEqual(state.recentlyClosed.local.length, 0);
  strictEqual(state.untouched.value, true);
});

test('does not duplicate a workspace already recorded with slash variations', () => {
  const directory = 'C:\\Users\\demo\\project\\';
  const pathname = `/${encodeOpenCodeRouteSegment(directory)}/session`;
  const values = runBootstrap(pathname, {
    projects: {
      local: [{ worktree: 'C:/Users/demo/project', expanded: false }],
    },
  });
  const state = JSON.parse(values.get(OPENCODE_SERVER_STATE_KEY) ?? '{}');

  strictEqual(state.projects.local.length, 1);
  strictEqual(state.lastProject.local, directory);
});

test('supports UTF-8 workspace paths and ignores unrelated routes', () => {
  const directory = '/home/demo/\u00e9tude';
  const route = `/${encodeOpenCodeRouteSegment(directory)}/session`;
  const registered = runBootstrap(route);
  const state = JSON.parse(registered.get(OPENCODE_SERVER_STATE_KEY) ?? '{}');
  strictEqual(state.projects.local[0].worktree, directory);

  const ignored = runBootstrap('/new-session?draftId=draft_123');
  strictEqual(ignored.has(OPENCODE_SERVER_STATE_KEY), false);
});

function runV2(directory: string, restore = '', initial: Record<string, unknown> = {}) {
  const values = new Map(Object.entries(initial).map(([key, value]) => [key, JSON.stringify(value)]));
  const origin = 'http://127.0.0.1:4109';
  let target = '';
  const localStorage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
  runInNewContext(OPENCODE_V2_BOOTSTRAP_SCRIPT.replace(/^<script>\s*/, '').replace(/\s*<\/script>$/, ''), {
    window: { location: { href: origin + '/?' + new URLSearchParams({ _ocWorkspace: directory, _ocRestore: restore }) } },
    localStorage, URL, TextEncoder, btoa, crypto: { randomUUID: () => 'test-draft' },
    history: { replaceState: (_state: unknown, _title: string, path: string) => { target = path; } },
  });
  return { values, target, origin };
}

test('V2 selects a real draft in a workspace with spaces, preserving other tabs and settings', () => {
  const directory = '/home/gfy/software/Traffic monitor';
  const result = runV2(directory, '', {
    'opencode.global.dat:server': { list: [{ http: { url: 'http://other' } }], untouched: true },
    'opencode.window.browser.dat:tabs': [{ type: 'draft', draftID: 'existing', server: 'http://other', directory: '/other' }],
  });
  strictEqual(result.target, '/new-session?draftId=test-draft');
  const state = JSON.parse(result.values.get('opencode.global.dat:server')!);
  strictEqual(state.lastProject.local, directory);
  strictEqual(state.projects.local[0].worktree, directory);
  strictEqual(state.untouched, true);
  strictEqual(state.list.length, 1);
  const tabs = JSON.parse(result.values.get('opencode.window.browser.dat:tabs')!);
  strictEqual(tabs.length, 2);
  strictEqual(tabs[1].directory, directory);
  strictEqual(tabs[1].server, result.origin);
});

test('V2 restores a draft without duplicating or discarding it', () => {
  const tab = { type: 'draft', draftID: 'saved', directory: '/project', server: 'http://127.0.0.1:4109' };
  const result = runV2('/project', '/new-session?draftId=saved', { 'opencode.window.browser.dat:tabs': [tab] });
  strictEqual(result.target, '/new-session?draftId=saved');
  strictEqual(JSON.parse(result.values.get('opencode.window.browser.dat:tabs')!).length, 1);
});

test('V2 restores a concrete session with a new browser storage origin', () => {
  const path = `/server/${encodeOpenCodeRouteSegment('http://127.0.0.1:4109')}/session/ses_123`;
  const result = runV2('/project', path);
  strictEqual(result.target, path);
  strictEqual(JSON.parse(result.values.get('opencode.window.browser.dat:tabs')!)[0].sessionId, 'ses_123');
});

test('V2 falls back to home for invalid persisted routes and corrupt storage', () => {
  strictEqual(runV2('/project', '/encoded/session').target, '/');
  strictEqual(runV2('/project', '//evil.test').target, '/');
  strictEqual(runV2('/project', '', { 'opencode.window.browser.dat:tabs': {} }).target, '/');
});
