import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rmdir, unlink, utimes, writeFile } from 'node:fs/promises';
import { get } from 'node:http';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { binding, Devices } from '../src/access.mjs';
import { loadCredentials } from '../src/credentials.mjs';
import { resolveCodexExecutable } from '../src/codex-executable.mjs';
import { Bridge } from '../src/bridge.mjs';
import { loopbackAppServerUrl, RpcError } from '../src/rpc.mjs';
import { httpConsole } from '../src/server.mjs';
import { DesktopSidebar } from '../src/sidebar.mjs';
import { groupProjects } from '../public/projects.js';

const threadId = 'thread-1';
const turnId = 'turn-1';
const work = 'C:\\work';
const loginDetails = { username: 'admin', password: 'test-web-password', name: '设备' };
const storedThread = {
  id: threadId, name: '测试', cwd: work, model: 'model-1', status: { type: 'notLoaded' }, historyMode: 'paginated',
};
const page = data => ({ data, nextCursor: null });
const models = account => [{
  model: 'model-' + account, displayName: '模型 ' + account, isDefault: true,
  supportedReasoningEfforts: [{ reasoningEffort: 'medium' }], defaultReasoningEffort: 'medium',
  serviceTiers: [{ id: 'fast', name: 'Fast' }],
}];

class FakeRpc extends EventEmitter {
  constructor(account) {
    super();
    this.account = account;
    this.calls = [];
    this.replies = [];
  }

  async initialize() {}
  async close() {}

  notify(method, params) {
    this.emit('notification', { method, params });
  }

  request(method, id, params) {
    this.emit('request', { method, id, params: { threadId, turnId, ...params } });
  }

  async respond(id, payload) {
    this.replies.push({ id, payload });
  }

  async reject(id, error) {
    this.replies.push({ id, error });
  }

  async call(method, params) {
    this.calls.push({ method, params });
    switch (method) {
      case 'thread/list': {
        if (params.sectionId) return { ...page(this.pinnedThreads ?? []), readStates: this.readStates };
        if (params.projectId && this.missingProject === params.projectId) {
          throw new RpcError('project not found: ' + params.projectId, -32602);
        }
        const thread = params.projectId ? { ...storedThread, projectId: params.projectId } : storedThread;
        return { ...(params.cursor ? page([thread]) : { data: [thread], nextCursor: 'older-threads' }), readStates: this.readStates };
      }
      case 'project/list':
        return params.cursor
          ? page([{ id: 'second-project', name: '第二个项目', roots: [] }])
          : { data: [{ id: 'first-project', name: '首个项目', roots: [{ path: work }], metadata: { private: true } }], nextCursor: 'older-projects' };
      case 'thread/read': return { thread: this.thread ?? storedThread, readState: this.readStates?.[params.threadId] };
      case 'thread/readState/update': {
        if (this.readStates?.[params.threadId]?.revision !== params.expectedRevision) {
          throw new RpcError('read receipt changed', -32600);
        }
        const readState = { firstUnread: null, revision: 'cleared' };
        this.readStates[params.threadId] = readState;
        this.notify('thread/readState/changed', { threadId: params.threadId, readState });
        return { readState };
      }
      case 'thread/turns/list': return { data: this.turns ?? [], nextCursor: params.cursor ? null : 'older-turns' };
      case 'thread/start': return { thread: { ...storedThread, id: this.newThreadId ?? threadId }, model: 'model-' + this.account };
      case 'thread/resume':
        if (this.activeWriter) throw new RpcError('thread thread-1 already has an active writer', -32600);
        return { thread: this.thread ?? storedThread, model: 'model-' + this.account };
      case 'turn/start': {
        if (this.sendRejection) throw this.sendRejection;
        const turn = { id: turnId, status: 'inProgress', items: [] };
        this.notify('turn/started', { threadId: params.threadId, turn });
        if (this.sendFailure) throw this.sendFailure;
        return { turn };
      }
      case 'turn/steer': return { turnId };
      case 'turn/interrupt':
        this.notify('turn/completed', { threadId, turn: { id: turnId, status: 'interrupted', items: [] } });
        return {};
      case 'model/list': return page(models(this.modelRevision ?? this.account));
      case 'collaborationMode/list': return page([{ mode: 'default' }, { mode: 'plan', reasoning_effort: 'medium' }]);
      case 'config/read': return { config: { model: 'model-' + this.account }, layers: ['private config'] };
      case 'account/read': return { account: { type: 'chatgpt', planType: 'plan-' + this.account, secret: 'private' } };
      case 'account/rateLimits/read':
        return { rateLimits: { primary: { usedPercent: 20, resetsAt: 1800000000, windowDurationMins: 300 } } };
      case 'account/usage/read':
        return this.account === 1 ? { summary: { lifetimeTokens: 23 }, dailyUsageBuckets: [{ startDate: '2026-11-26', tokens: 3 }] }
          : Promise.reject(new RpcError('用量接口不可用', -32601));
      default: throw new Error('Unexpected RPC ' + method);
    }
  }
}

async function fixture(t, { authPath, credentials, sidebar, shared, desktopHistory } = {}) {
  const processes = [];
  const devices = new Devices(credentials ?? { verify: async (username, password) => (
    username === loginDetails.username && password === loginDetails.password
  ) });
  const bridge = new Bridge({
    directories: [work], authPath, sidebar, shared, desktopHistory, connect() {
      const rpc = new FakeRpc(processes.length + 1);
      processes.push(rpc);
      return rpc;
    },
  });
  const app = httpConsole({ bridge, devices, address: binding() });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  t.after(async () => {
    app.closeStreams();
    await new Promise(resolve => app.server.close(resolve));
    await bridge.close();
  });
  const url = 'http://127.0.0.1:' + app.server.address().port;

  function request(path, { cookie, body, origin = url, headers, signal } = {}) {
    return fetch(url + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        ...(cookie && { Cookie: cookie }),
        ...(body !== undefined && { Origin: origin, 'Content-Type': 'application/json' }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
  }

  async function login() {
    const response = await request('/api/login', { body: loginDetails });
    assert.equal(response.status, 200);
    const raw = response.headers.get('set-cookie');
    assert.match(raw, /HttpOnly; SameSite=Strict/);
    const { device } = await response.json();
    return { cookie: raw.split(';')[0], device };
  }

  return { app, bridge, devices, processes, request, login };
}

async function data(response, status = 200) {
  const body = await response.json();
  assert.equal(response.status, status, JSON.stringify(body));
  return body;
}

test('restricts a LAN listener to its selected private interface subnet', () => {
  const interfaces = { Ethernet: [{ family: 'IPv4', internal: false, address: '192.168.10.3', netmask: '255.255.255.0' }] };
  const lan = binding('192.168.10.3', interfaces);
  assert.equal(lan.permits('192.168.10.140'), true);
  assert.equal(lan.permits('192.168.11.140'), false);
  assert.throws(() => binding('192.168.10.4', interfaces));
  assert.equal(binding().permits('192.168.10.3'), false);
});

test('prefers the app runtime executable while honoring an explicit Codex binary', async () => {
  const env = { CODEX_APP_RUNTIME_CLI_PATH: process.execPath };
  assert.equal(await resolveCodexExecutable(undefined, env), process.execPath);
  assert.equal(await resolveCodexExecutable('another-codex.exe', env), 'another-codex.exe');
});

test('refreshes the runtime model directory without reconnecting', async t => {
  const f = await fixture(t);
  const { cookie } = await f.login();
  const before = await data(await f.request('/api/meta', { cookie }));
  assert.equal(before.models.value[0].model, 'model-1');
  f.processes[0].modelRevision = 2;
  const cached = await data(await f.request('/api/meta', { cookie }));
  assert.equal(cached.models.value[0].model, 'model-1');
  const fresh = await data(await f.request('/api/meta?refresh=1', { cookie }));
  assert.equal(fresh.models.value[0].model, 'model-2');
  assert.equal(fresh.models.value[0].efforts[0].reasoningEffort, 'medium');
  assert.equal(fresh.models.value[0].speeds[0].id, 'fast');
  assert.equal(f.processes.length, 1);
});

test('includes native unread receipts in history and only clears the observed revision', async t => {
  const f = await fixture(t);
  const { cookie } = await f.login();
  await data(await f.request('/api/read', { body: { threadId, revision: 'old' } }), 401);
  await f.bridge.list();
  const receipt = { firstUnread: { type: 'turn', turnId }, revision: 'new' };
  f.processes[0].readStates = { [threadId]: receipt };
  f.processes[0].pinnedThreads = [storedThread];
  assert.deepEqual((await data(await f.request('/api/threads', { cookie }))).threads[0].readState, receipt);
  assert.deepEqual((await data(await f.request('/api/thread?id=' + threadId, { cookie }))).readState, receipt);
  assert.deepEqual((await data(await f.request('/api/projects', { cookie }))).pinned[0].thread.readState, receipt);
  await data(await f.request('/api/read', { cookie, body: { threadId, revision: 'old' } }), 409);
  assert.deepEqual(f.processes[0].readStates[threadId], receipt);
  const change = once(f.bridge, 'change');
  await data(await f.request('/api/read', { cookie, body: { threadId, revision: 'new' } }));
  assert.deepEqual((await change)[0], { scope: 'read', threadId, readState: { firstUnread: null, revision: 'cleared' } });
});

test('groups worktree threads by native project and falls back to paths for older histories', () => {
  const projects = [
    { id: 'project', name: '原生项目', roots: ['C:\\Work'] },
    { id: 'nested', name: '子项目', roots: ['C:\\Work\\nested'] },
    { id: 'empty', name: '空项目', roots: [] },
  ];
  const threads = [
    { id: 'worktree', cwd: 'C:\\temp\\worktree', projectId: 'project' },
    { id: 'explicit', cwd: 'C:\\Work\\nested', projectId: 'project' },
    { id: 'unassigned', cwd: 'c:/WORK/nested/src/' },
    { id: 'outside', cwd: 'C:\\work2' },
    { id: 'same-folder', cwd: 'C:/WORK2/' },
    { id: 'unknown' },
  ];
  const result = groupProjects(projects, threads);
  assert.deepEqual(result.map(({ name }) => name), ['原生项目', '子项目', '空项目', 'work2', '未分组会话']);
  assert.deepEqual(result.map(group => group.threads.map(thread => thread.id)), [
    ['worktree', 'explicit'], ['unassigned'], [], ['outside', 'same-folder'], ['unknown'],
  ]);
});

test('returns paginated native project summaries and filters the history to one project', async t => {
  const f = await fixture(t);
  await data(await f.request('/api/projects'), 401);
  const { cookie } = await f.login();
  const result = await data(await f.request('/api/projects', { cookie }));
  assert.deepEqual(result.projects, [
    { id: 'first-project', name: '首个项目', roots: [work] },
    { id: 'second-project', name: '第二个项目', roots: [] },
  ]);
  const threads = await data(await f.request('/api/threads?project=first-project&cursor=older-threads', { cookie }));
  assert.equal(threads.threads[0].projectId, 'first-project');
  assert.equal(threads.nextCursor, null);
  const call = f.processes[0].calls.find(entry => entry.method === 'thread/list' && entry.params.projectId);
  assert.equal(call.params.projectId, 'first-project');
  assert.equal(call.params.useStateDbOnly, true);
});

test('mirrors the current desktop owner project order, mixed pins and native project aliases', async t => {
  const root = await mkdtemp(join(process.cwd(), '.bridge-sidebar-test-'));
  const file = join(root, '.codex-global-state.sqlite');
  t.after(async () => { await unlink(file); await rmdir(root); });
  const owner = 'a'.repeat(64);
  const scope = 'electron-owner-atoms:' + owner;
  const db = new DatabaseSync(file);
  try {
    db.exec('CREATE TABLE settings (scope TEXT, key TEXT, value TEXT, PRIMARY KEY(scope,key))');
    const insert = db.prepare('INSERT INTO settings VALUES (?, ?, ?)');
    const put = (key, value, target = 'global') => insert.run(target, key, JSON.stringify(value));
    put('electron-renderer-content-owner', owner);
    put('local-projects', Object.fromEntries(['new', 'one', 'two', 'fixed'].map(id => [
      id, { id, name: id, rootPaths: [join(root, id)] },
    ])));
    put('project-order', ['new', 'one', 'two', 'fixed']);
    put('pinned-project-ids', ['fixed']);
    put('unified-sidebar-project-order-v1', ['codex:project:two', 'codex:project:one'], scope);
    put('unified-sidebar-project-order-v1', ['codex:project:one', 'codex:project:two'], 'other-owner');
    put('unified-sidebar-pinned-order-v1', ['codex:project:fixed', 'codex:thread:local:' + threadId], scope);
    put('app-server-project-id-by-legacy-project-id-by-host', { ['local:' + root]: { two: 'native-two' } });
    put('thread-project-assignments', { [threadId]: { projectKind: 'local', projectId: 'two' } });
    put('unrelated-secret', 'never return this row');
  } finally { db.close(); }

  const f = await fixture(t, { sidebar: new DesktopSidebar(root) });
  const { cookie } = await f.login();
  await f.bridge.list();
  f.processes[0].pinnedThreads = [storedThread];
  const layout = await data(await f.request('/api/projects', { cookie }));
  assert.deepEqual(layout.projects.filter(project => project.id !== 'fixed').map(project => project.id), ['new', 'two', 'one']);
  assert.deepEqual(layout.pinned.map(pin => pin.type), ['project', 'thread']);
  assert.equal(layout.pinned[0].projectId, 'fixed');
  assert.equal(layout.pinned[1].thread.projectId, 'two');
  assert.ok(!JSON.stringify(layout).includes('never return this row'));
  const result = await data(await f.request('/api/threads?project=two', { cookie }));
  assert.equal(result.threads[0].projectId, 'two');
  assert.equal(f.processes[0].calls.at(-1).params.projectId, 'native-two');
  f.processes[0].missingProject = 'native-two';
  const legacy = await data(await f.request('/api/threads?project=two', { cookie }));
  assert.equal(legacy.threads[0].id, threadId);
  assert.equal(legacy.threads[0].projectId, 'two');
  assert.equal(f.processes[0].calls.at(-1).method, 'thread/read');
});

test('gates reads and writes behind password login, origin checks, logout, and host revocation', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('/')).status, 200);
  assert.equal((await f.request('/api/threads')).status, 401);
  assert.equal((await f.request('/api/events')).status, 401);
  assert.equal((await f.request('/api/thread', { body: { directory: 0 } })).status, 401);
  await data(await f.request('/api/login', { body: { ...loginDetails, password: 'bad' } }), 401);
  const first = await f.login();
  const second = await f.login();
  assert.notEqual(first.cookie, second.cookie);
  const logout = await f.request('/api/logout', { cookie: second.cookie, body: {} });
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
  await data(logout);
  await data(await f.request('/api/threads', { cookie: second.cookie }), 401);
  assert.equal((await f.request('/api/reconnect', { cookie: first.cookie, origin: 'http://other.local', body: {} })).status, 403);
  const hostStatus = await new Promise((resolve, reject) => {
    const port = f.app.server.address().port;
    get({ host: '127.0.0.1', port, path: '/api/session', headers: { Host: 'rebinding.local:' + port } }, response => {
      response.resume();
      resolve(response.statusCode);
    }).on('error', reject);
  });
  assert.equal(hostStatus, 403);
  const stream = await f.request('/api/events', { cookie: first.cookie });
  const reader = stream.body.pipeThrough(new TextDecoderStream()).getReader();
  assert.match((await reader.read()).value, /"scope":"reset"/);
  assert.equal(f.app.revoke(first.device.id), true);
  assert.match((await reader.read()).value, /event: revoke/);
  assert.equal((await f.request('/api/live?id=' + threadId, { cookie: first.cookie })).status, 401);
});

test('pages history; deduplicates turns; restores live output, questions, and approval state', async t => {
  const f = await fixture(t);
  const { cookie } = await f.login();
  const second = await f.login();
  const list = await data(await f.request('/api/threads', { cookie }));
  assert.equal(list.nextCursor, 'older-threads');
  assert.equal((await data(await f.request('/api/threads?cursor=older-threads', { cookie }))).nextCursor, null);
  assert.equal((await data(await f.request('/api/thread?id=' + threadId, { cookie }))).nextCursor, 'older-turns');
  const create = { body: { directory: 0, operationId: 'op-create' }, cookie };
  await data(await f.request('/api/thread', create));
  await data(await f.request('/api/thread', create));

  const body = { threadId, operationId: 'op-send', text: '制定计划', settings: { mode: 'plan', model: 'model-1', effort: 'medium', speed: 'fast' } };
  await Promise.all([f.request('/api/send', { cookie, body }), f.request('/api/send', { cookie, body })].map(async promise => data(await promise)));
  const rpc = f.processes[0];
  assert.equal(rpc.calls.filter(call => call.method === 'thread/start').length, 1);
  const starts = rpc.calls.filter(call => call.method === 'turn/start');
  assert.equal(starts.length, 1);
  assert.deepEqual(starts[0].params.collaborationMode, { mode: 'plan', settings: {
    model: 'model-1', reasoning_effort: 'medium', developer_instructions: null,
  } });
  assert.equal(starts[0].params.serviceTier, 'fast');
  assert.equal(starts[0].params.approvalPolicy, undefined);

  rpc.notify('item/agentMessage/delta', { threadId, turnId, itemId: 'agent-1', delta: '已开始' });
  rpc.notify('item/commandExecution/outputDelta', { threadId, turnId, itemId: 'command-1', delta: 'command output' });
  rpc.notify('item/fileChange/patchUpdated', { threadId, turnId, itemId: 'file-1', changes: [{ path: 'demo.txt', diff: '+ demo' }] });
  rpc.notify('turn/plan/updated', { threadId, turnId, plan: [{ step: '第一步', status: 'inProgress' }] });
  rpc.request('item/tool/requestUserInput', 'question-1', { questions: [
    { id: 'scope', question: '范围？', options: [{ label: '全部' }], isOther: false },
    { id: 'format', question: '格式？', options: [{ label: '文本' }], isOther: true },
  ] });
  rpc.request('item/commandExecution/requestApproval', 'native-approval', {
    command: 'Get-Location', availableDecisions: ['accept', 'cancel'],
  });

  const snapshot = await data(await f.request('/api/live?id=' + threadId, { cookie: second.cookie }));
  assert.equal(snapshot.turn.items[0].text, '已开始');
  assert.equal(snapshot.turn.items[1].output, 'command output');
  assert.equal(snapshot.turn.items[2].changes[0].diff, '+ demo');
  assert.equal(snapshot.turn.plan[0].step, '第一步');
  const [question, approval] = snapshot.pending;
  const reconnect = await f.request('/api/events', { cookie: second.cookie });
  const reader = reconnect.body.pipeThrough(new TextDecoderStream()).getReader();
  assert.match((await reader.read()).value, /"scope":"reset"/);
  const recovered = await data(await f.request('/api/live?id=' + threadId, { cookie: second.cookie }));
  assert.deepEqual(recovered.pending.map(request => request.id), [question.id, approval.id]);
  assert.equal(recovered.turn.status, 'inProgress');
  await reader.cancel();
  await data(await f.request('/api/respond', { cookie, body: { id: question.id, answers: { scope: '其他', format: 'CSV' } } }), 400);
  await data(await f.request('/api/respond', { cookie, body: { id: question.id, answers: { scope: '全部', format: 'CSV' } } }));
  assert.deepEqual(rpc.replies[0], { id: 'question-1', payload: { answers: { scope: { answers: ['全部'] }, format: { answers: ['CSV'] } } } });

  const competing = await Promise.all([cookie, second.cookie].map(device => f.request('/api/respond', {
    cookie: device, body: { id: approval.id, choice: 0 },
  })));
  assert.deepEqual(competing.map(result => result.status).sort(), [200, 409]);
  assert.equal(rpc.replies.filter(reply => reply.id === 'native-approval').length, 1);
  rpc.notify('serverRequest/resolved', { threadId, requestId: 'native-approval' });
  rpc.notify('serverRequest/resolved', { threadId, requestId: 'question-1' });

  rpc.request('item/tool/requestUserInput', 'cancel-question', {
    questions: [{ id: 'question', question: '继续？', options: [{ label: '继续' }] }],
  });
  const cancel = f.bridge.live(threadId).pending[0];
  await data(await f.request('/api/respond', { cookie, body: { id: cancel.id, cancel: true } }));
  assert.deepEqual(rpc.replies.at(-1), { id: 'cancel-question', payload: { answers: {} } });
  rpc.notify('serverRequest/resolved', { threadId, requestId: 'cancel-question' });

  rpc.request('item/tool/requestUserInput', 'ended-question', {
    questions: [{ id: 'timeout', question: '等待？', options: [] }],
  });
  const ended = f.bridge.live(threadId).pending[0];
  rpc.notify('serverRequest/resolved', { threadId, requestId: 'ended-question' });
  await data(await f.request('/api/respond', { cookie, body: { id: ended.id, cancel: true } }), 409);

  const refreshed = await data(await f.request('/api/live?id=' + threadId, { cookie }));
  assert.equal(refreshed.pending.length, 0);
  assert.equal(refreshed.turn.status, 'inProgress');

  await data(await f.request('/api/send', { cookie, body: { ...body, operationId: 'op-steer', expectedTurnId: turnId } }));
  const steer = rpc.calls.find(call => call.method === 'turn/steer').params;
  assert.equal(steer.expectedTurnId, turnId);
  assert.equal(steer.collaborationMode, undefined);
  await data(await f.request('/api/stop', { cookie, body: { threadId, turnId } }));
  assert.equal((await f.bridge.live(threadId)).turn.status, 'interrupted');
});

test('waits for active turns before reconnecting and reloads account and catalog with the same cookie', async t => {
  const f = await fixture(t);
  const { cookie } = await f.login();
  const account = await data(await f.request('/api/account', { cookie }));
  assert.deepEqual(account.identity.value, { type: 'chatgpt', plan: 'plan-1' });
  assert.equal(account.limits.value[0].windows[0].usedPercent, 20);
  assert.equal(account.usage.value.daily[0].tokens, 3);

  await data(await f.request('/api/send', { cookie, body: { threadId, operationId: 'start', text: '任务' } }));
  assert.equal(f.processes[0].calls.some(entry => entry.method === 'thread/resume'), true);
  assert.equal((await data(await f.request('/api/reconnect', { cookie, body: {} }))).state, 'waiting');
  assert.equal(f.processes.length, 1);
  await data(await f.request('/api/stop', { cookie, body: { threadId, turnId } }));
  for (let i = 0; i < 10 && f.processes.length === 1; i++) await delay(10);
  assert.equal(f.processes.length, 2);
  const next = await data(await f.request('/api/account', { cookie }));
  assert.equal(next.identity.value.plan, 'plan-2');
  assert.match(next.usage.reason, /用量接口不可用/);
  const meta = await data(await f.request('/api/meta', { cookie }));
  assert.equal(meta.models.value[0].model, 'model-2');
  await data(await f.request('/api/send', { cookie, body: { threadId, operationId: 'next', text: '新账户任务' } }));
});

test('detects a credential file timestamp change and reconnects without changing the device cookie', { timeout: 8_000 }, async t => {
  const authPath = join(process.cwd(), '.bridge-test-' + randomUUID());
  await writeFile(authPath, '');
  const f = await fixture(t, { authPath });
  t.after(() => unlink(authPath));
  const { cookie } = await f.login();
  await data(await f.request('/api/meta', { cookie }));
  await f.bridge.start();
  const stamp = new Date(Date.now() + 5_000);
  await utimes(authPath, stamp, stamp);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6_000);
  try {
    let next;
    do {
      await once(f.bridge, 'change', { signal: controller.signal });
      next = f.processes.length;
    } while (next < 2);
  } finally { clearTimeout(timer); }
  assert.equal(f.processes.length, 2);
  assert.equal((await data(await f.request('/api/account', { cookie }))).identity.value.plan, 'plan-2');
});

test('stores hashed credentials across restarts and supports password reset', async t => {
  const path = join(process.cwd(), '.bridge-test-' + randomUUID());
  t.after(() => unlink(path));
  const setup = await loadCredentials(path);
  const saved = await readFile(path, 'utf8');
  assert.ok(!saved.includes(setup.initialPassword));
  assert.match(JSON.parse(saved).digest, /^[0-9a-f]{64}$/);
  const restarted = await loadCredentials(path);
  assert.equal(restarted.initialPassword, undefined);
  assert.equal(await restarted.credentials.verify('admin', setup.initialPassword), true);
  assert.equal(await restarted.credentials.verify('other', setup.initialPassword), false);
  const updated = await loadCredentials(path, { reset: true });
  assert.equal(await updated.credentials.verify('admin', setup.initialPassword), false);
  assert.equal(await updated.credentials.verify('admin', updated.initialPassword), true);
});

test('throttles repeated failed login attempts', async t => {
  const f = await fixture(t);
  for (let i = 0; i < 8; i++) await data(await f.request('/api/login', { body: { username: 'admin', password: 'wrong' } }), 401);
  await data(await f.request('/api/login', { body: loginDetails }), 429);
});

test('changes a password with current-password proof and invalidates the other sessions', async t => {
  const path = join(process.cwd(), '.bridge-test-' + randomUUID());
  t.after(() => unlink(path));
  const { credentials, initialPassword } = await loadCredentials(path);
  const initialRecord = JSON.parse(await readFile(path, 'utf8'));
  const f = await fixture(t, { credentials });
  const login = async password => {
    const response = await f.request('/api/login', { body: { username: credentials.username, password } });
    await data(response);
    return response.headers.get('set-cookie').split(';')[0];
  };
  const cookie = await login(initialPassword);
  const second = await login(initialPassword);
  const newPassword = '新 passphrase-27';
  const body = { currentPassword: initialPassword, newPassword };
  await data(await f.request('/api/password', { body }), 401);
  await data(await f.request('/api/password', { cookie, origin: 'http://other.local', body }), 403);
  await data(await f.request('/api/password', { cookie, body: { ...body, currentPassword: 'wrong' } }), 403);
  await data(await f.request('/api/password', { cookie, body: { ...body, newPassword: 'too-short' } }), 400);
  await data(await f.request('/api/password', { cookie, body: { ...body, newPassword: initialPassword } }), 400);
  assert.equal(await credentials.verify(credentials.username, initialPassword), true);

  const stream = await f.request('/api/events', { cookie: second });
  const reader = stream.body.pipeThrough(new TextDecoderStream()).getReader();
  assert.match((await reader.read()).value, /"scope":"reset"/);
  assert.deepEqual(await data(await f.request('/api/password', { cookie, body })), { updated: true });
  assert.match((await reader.read()).value, /event: revoke/);
  await reader.cancel();
  await data(await f.request('/api/threads', { cookie }));
  await data(await f.request('/api/threads', { cookie: second }), 401);
  await data(await f.request('/api/login', { body: { username: credentials.username, password: initialPassword } }), 401);
  assert.ok(await login(newPassword));

  const saved = JSON.parse(await readFile(path, 'utf8'));
  assert.notEqual(saved.salt, initialRecord.salt);
  assert.notEqual(saved.digest, initialRecord.digest);
  assert.ok(!JSON.stringify(saved).includes(newPassword));
  const restarted = await loadCredentials(path);
  assert.equal(restarted.initialPassword, undefined);
  assert.equal(await restarted.credentials.verify(credentials.username, newPassword), true);
  assert.equal(await restarted.credentials.verify(credentials.username, initialPassword), false);
});

test('distinguishes an active native writer and continues to allow an independent new conversation', async t => {
  const f = await fixture(t);
  const { cookie } = await f.login();
  await data(await f.request('/api/thread?id=' + threadId, { cookie }));
  f.processes[0].activeWriter = true;
  f.processes[0].newThreadId = 'new-thread';
  const busy = await data(await f.request('/api/send', {
    cookie, body: { threadId, operationId: 'busy-send', text: '草稿' },
  }), 409);
  assert.equal(busy.code, 'THREAD_BUSY');
  assert.match(busy.error, /同一个 App Server/);
  assert.equal(f.processes[0].calls.some(({ method }) => method === 'turn/start'), false);
  await data(await f.request('/api/fork', { cookie, body: { threadId, operationId: 'fork-busy' } }), 404);

  f.processes[0].activeWriter = false;
  const settings = { mode: 'plan', model: 'model-1', effort: 'medium', speed: 'fast' };
  await data(await f.request('/api/send', {
    cookie, body: { threadId, operationId: 'retry-original', text: '草稿', settings },
  }));
  const sends = f.processes[0].calls.filter(({ method }) => method === 'turn/start');
  assert.equal(sends.length, 1);
  assert.equal(sends[0].params.threadId, threadId);
  assert.equal(sends[0].params.input[0].text, '草稿');
  assert.equal(sends[0].params.serviceTier, 'fast');
  assert.equal(sends[0].params.collaborationMode.mode, 'plan');
  const created = await data(await f.request('/api/thread', { cookie, body: { directory: 0, operationId: 'new' } }));
  assert.equal(created.id, 'new-thread');
});

test('a shared connection steers the desktop turn and starts another on the same thread', async t => {
  const f = await fixture(t, { shared: true });
  const { cookie } = await f.login();
  await data(await f.request('/api/thread?id=' + threadId, { cookie }));
  const rpc = f.processes[0];
  rpc.thread = { ...storedThread, status: { type: 'active' } };
  rpc.turns = [{ id: turnId, status: 'inProgress', items: [] }];
  const send = (operationId, extra = {}) => f.request('/api/send', {
    cookie, body: { threadId, operationId, text: '继续原会话', ...extra },
  });

  assert.deepEqual(await data(await send('attach')), { turnId, steered: true });
  const steer = rpc.calls.find(({ method }) => method === 'turn/steer');
  assert.equal(steer.params.threadId, threadId);
  assert.equal(steer.params.expectedTurnId, turnId);
  assert.equal(f.bridge.live(threadId).turn.status, 'inProgress');
  rpc.request('desktop-only/method', 'desktop-only', {});
  assert.deepEqual(rpc.replies, []);

  await data(await send('stale', { expectedTurnId: 'older-turn' }), 409);
  rpc.notify('turn/completed', { threadId, turn: { id: turnId, status: 'completed', items: [] } });
  await data(await send('regular'));
  assert.deepEqual(
    rpc.calls.filter(({ method }) => method === 'turn/start').map(({ params }) => params.threadId),
    [threadId],
  );
});

test('the shared App Server address must be a loopback WebSocket endpoint', () => {
  for (const url of ['ws://127.0.0.1:80', 'ws://[::1]:65535/']) assert.equal(loopbackAppServerUrl(url), url);
  for (const url of ['ws://10.0.0.10:8766', 'ws://0.0.0.0:8766', 'ws://localhost:8766',
    'ws://user@127.0.0.1:8766', 'ws://127.0.0.1:8766/?token=test', 'ws://127.0.0.1:65536',
    'http://127.0.0.1:8766', 'ws://127.0.0.1:8766\n', '']) {
    assert.throws(() => loopbackAppServerUrl(url), /共享 App Server 地址/);
  }
});

test('Bridge ignores an inherited desktop WebSocket override and validates an explicit endpoint', async () => {
  const run = promisify(execFile);
  const entry = fileURLToPath(new URL('../src/server.mjs', import.meta.url));
  const invalidCredentials = fileURLToPath(new URL('../package.json', import.meta.url));
  const env = { ...process.env, CODEX_APP_SERVER_WS_URL: 'invalid', CODEX_APP_RUNTIME_CLI_PATH: process.execPath };
  await assert.rejects(run(process.execPath, [entry, '--credentials', invalidCredentials], { env }),
    { code: 1, stderr: /网页登录配置无效/ });
  await assert.rejects(run(process.execPath, [entry, '--app-server-url', 'invalid'], { env }),
    { code: 1, stderr: /共享 App Server 地址/ });
  await assert.rejects(run(process.execPath, [entry, '--desktop', '--app-server-url', 'ws://127.0.0.1:8766'], { env }),
    { code: 1, stderr: /不能与 --codex 或 --desktop 一起使用/ });
});

test('desktop history keeps web login and history while refusing session writes and unverified account data', async t => {
  const f = await fixture(t, { desktopHistory: true });
  const { cookie } = await f.login();
  const { thread } = await data(await f.request('/api/thread?id=' + threadId, { cookie }));
  assert.equal(thread.id, threadId);
  const live = await data(await f.request('/api/live?id=' + threadId, { cookie }));
  const meta = await data(await f.request('/api/meta', { cookie }));
  assert.match(live.sendBlocked, /无法确认桌面端/);
  assert.equal(meta.sendBlocked, live.sendBlocked);
  assert.equal(meta.models.value, null);
  const account = await data(await f.request('/api/account', { cookie }));
  assert.equal(account.identity.value, null);
  assert.equal(account.limits.value, null);
  const writes = {
    thread: { directory: 0, operationId: 'new' },
    send: { threadId, operationId: 'desktop-send', text: '保留草稿' },
    stop: { threadId, turnId },
    respond: { id: 'approval-1' },
    read: { threadId, revision: 'revision-1' },
  };
  for (const [action, body] of Object.entries(writes)) {
    const error = await data(await f.request('/api/' + action, { cookie, body }), 409);
    assert.equal(error.code, 'DESKTOP_UNAVAILABLE');
  }
  assert.deepEqual(f.processes[0].calls.map(({ method }) => method), ['thread/read', 'thread/turns/list']);
  await data(await f.request('/api/session', { cookie }));
});

test('deduplicates a send after uncertain delivery and distinguishes a confirmed upstream rejection', async t => {
  const f = await fixture(t);
  const { cookie } = await f.login();
  await data(await f.request('/api/thread?id=' + threadId, { cookie }));
  const rpc = f.processes[0];
  const request = operationId => f.request('/api/send', { cookie, body: { threadId, operationId, text: '一条消息' } });
  rpc.sendRejection = new RpcError('turn refused', -32602);
  assert.equal((await data(await request('rejected'), 409)).error, 'turn refused');
  rpc.sendRejection = null;
  rpc.sendFailure = new RpcError('timed out', 'timeout');
  const uncertain = await data(await request('uncertain'), 504);
  assert.equal(uncertain.code, 'SEND_UNCONFIRMED');
  assert.deepEqual(await data(await request('uncertain'), 504), uncertain);
  assert.equal(rpc.calls.filter(({ method }) => method === 'turn/start').length, 2);
});
