import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { HttpError } from './access.mjs';
import { AppServer, RpcError } from './rpc.mjs';
import { legacyWriterPresent } from './legacy.mjs';
import { presentRequest, requestResponse } from './requests.mjs';
import { mergeTurn, threadSummary, turnSummary, updateTurn } from './projection.mjs';
import { orderSidebarPins } from './sidebar.mjs';

const PINNED_SECTION = '01984de2-8f74-7c91-a3b2-5c5e937cf318';
const INTERACTIVE_SOURCES = ['cli', 'vscode', 'exec', 'appServer', 'unknown'];
const active = turn => turn?.status === 'inProgress';
const message = error => error?.message || 'Codex 返回未知错误。';
const unavailable = error => ({ value: null, reason: message(error) });
const available = value => ({ value, reason: null });
const writerConflict = () => new HttpError(409, '原会话由另一个 Codex App Server 持有。请连接同一个 App Server，或等原客户端释放会话后重试。', 'THREAD_BUSY');

export class Bridge extends EventEmitter {
  #rpc;
  #ready;
  #restart;
  #queued = false;
  #inFlight = 0;
  #watcher;
  #stamp;
  #threads = new Map();
  #requests = new Map();
  #catalog;
  #account;
  #shared;
  #working = new Set();

  constructor({ directories, authPath, sidebar, shared = false, connect = () => new AppServer() }) {
    super();
    this.directories = directories;
    this.authPath = authPath;
    this.sidebar = sidebar;
    this.#shared = shared;
    this.connect = connect;
  }

  get state() {
    return this.#restart ? 'reconnecting' : this.#queued ? 'waiting' : this.#ready ? 'connected' : 'disconnected';
  }

  async start() {
    if (this.#shared) {
      await this.#getRpc();
      return;
    }
    this.#stamp = await this.#authStamp();
    this.#watcher = setInterval(async () => {
      try {
        const stamp = await this.#authStamp();
        if (stamp === this.#stamp || stamp === undefined) return;
        this.#stamp = stamp;
        if (this.#rpc) this.reconnect();
      } catch (error) {
        process.stderr.write('凭据状态检查失败：' + message(error) + '\n');
      }
    }, 3_000).unref();
  }

  async #authStamp() {
    if (!this.authPath) return undefined;
    try { return (await stat(this.authPath)).mtimeMs; } catch (error) {
      if (error.code === 'ENOENT') return null;
      if (error.code === 'EACCES' || error.code === 'EPERM') return undefined;
      throw error;
    }
  }

  async close() {
    clearInterval(this.#watcher);
    await this.#restart;
    const rpc = this.#rpc;
    this.#rpc = this.#ready = null;
    await rpc?.close();
  }

  async #getRpc() {
    if (this.#restart) await this.#restart;
    return this.#open();
  }

  #open() {
    if (this.#ready) return this.#ready;
    const rpc = this.#rpc = this.connect();
    let initialized = false;
    const clear = error => {
      if (this.#rpc !== rpc) return;
      this.#rpc = this.#ready = this.#catalog = this.#account = null;
      this.#requests.clear();
      for (const entry of this.#threads.values()) {
        entry.loaded = false;
        if (active(entry.turn)) {
          entry.turn.status = 'failed';
          entry.turn.error = message(error);
        }
      }
      // Initial connection errors are returned to the requesting clients.
      // Notify open browsers only after an established connection is lost.
      if (initialized) this.#emit('reset');
      this.#drainRestart();
    };

    rpc.on('closed', clear);
    rpc.on('notification', notification => {
      if (this.#rpc === rpc) this.#notify(notification);
    });
    rpc.on('request', request => {
      if (this.#rpc === rpc) this.#request(rpc, request);
    });
    this.#ready = rpc.initialize().then(() => {
      initialized = true;
      return rpc;
    }).catch(async error => {
      clear(error);
      await rpc.close();
      throw error;
    });
    return this.#ready;
  }

  reconnect() {
    if (!this.#restart) {
      this.#queued = true;
      this.#drainRestart();
      this.#emit('connection');
    }
    return { state: this.state };
  }

  #drainRestart() {
    if (!this.#queued || this.#restart || this.#inFlight || [...this.#threads.values()].some(entry => active(entry.turn))) return;
    this.#queued = false;
    this.#restart = this.#replaceConnection().finally(() => {
      this.#restart = null;
      this.#emit('reset');
    });
  }

  async #replaceConnection() {
    const previous = this.#rpc;
    this.#rpc = this.#ready = this.#catalog = this.#account = null;
    this.#threads.clear();
    this.#requests.clear();
    try {
      await previous?.close();
      await this.#open();
    } catch (error) {
      process.stderr.write('Codex 重连失败：' + message(error) + '\n');
    }
  }

  #emit(scope, threadId, readState) {
    this.emit('change', { scope, threadId, readState });
  }

  async list(cursor, projectId) {
    const rpc = await this.#getRpc();
    const layout = this.sidebar?.read();
    const desktopProject = layout?.projects.get(projectId);
    if (desktopProject && cursor?.startsWith('legacy:')) {
      const offset = Number(cursor.slice('legacy:'.length));
      if (!Number.isSafeInteger(offset) || offset < 0) throw new HttpError(400, '会话游标无效。');
      return this.#legacyProjectPage(rpc, layout, projectId, offset);
    }
    const nativeProjectId = desktopProject?.nativeId ?? projectId;
    let result;
    try {
      result = await rpc.call('thread/list', {
        cursor, limit: 30, sortKey: 'updated_at', modelProviders: [],
        sourceKinds: INTERACTIVE_SOURCES,
        ...(nativeProjectId && { projectId: nativeProjectId, useStateDbOnly: true }),
      });
    } catch (error) {
      if (desktopProject && error instanceof RpcError && /^project not found:/i.test(error.message)) {
        return this.#legacyProjectPage(rpc, layout, projectId, 0);
      }
      throw error;
    }
    if (desktopProject && !cursor && !result.data.length) {
      return this.#legacyProjectPage(rpc, layout, projectId, 0);
    }
    return { threads: result.data.map(thread => sidebarThread(thread, layout, result.readStates?.[thread.id])), nextCursor: result.nextCursor };
  }

  async #legacyProjectPage(rpc, layout, projectId, offset) {
    const ids = layout.legacyProjectThreads(projectId);
    const next = offset + 20;
    const threads = await readThreadSummaries(rpc, ids.slice(offset, next), layout);
    return { threads, nextCursor: next < ids.length ? 'legacy:' + next : null };
  }

  async projects() {
    const rpc = await this.#getRpc();
    const layout = this.sidebar?.read();
    const pinned = this.#pinnedThreads(rpc, layout);
    if (layout) {
      const projects = [...layout.pinnedProjects, ...layout.projectOrder].map(id => layout.projects.get(id));
      return { projects, pinned: orderSidebarPins(layout, await pinned) };
    }
    const projects = [];
    let cursor;
    do {
      const result = await rpc.call('project/list', { limit: 50, cursor }, 10_000);
      projects.push(...result.data.map(({ id, name, roots }) => ({
        id, name, roots: roots.map(root => root.path),
      })));
      cursor = result.nextCursor;
    } while (cursor);
    return { projects, pinned: orderSidebarPins(undefined, await pinned) };
  }

  async #pinnedThreads(rpc, layout) {
    const threads = [];
    let cursor;
    try {
      do {
        const result = await rpc.call('thread/list', {
          sectionId: PINNED_SECTION, sortKey: 'section_position', sourceKinds: INTERACTIVE_SOURCES,
          modelProviders: [], useStateDbOnly: true, limit: 50, cursor,
        }, 10_000);
        threads.push(...result.data.map(thread => sidebarThread(thread, layout, result.readStates?.[thread.id])));
        cursor = result.nextCursor;
      } while (cursor);
      return threads;
    } catch {
      return threads.length ? threads : readThreadSummaries(rpc, layout?.legacyPinnedThreads.slice(0, 30) ?? [], layout);
    }
  }

  async history(threadId, cursor) {
    const rpc = await this.#getRpc();
    const local = this.#threads.get(threadId);
    let thread = local?.thread;
    let readState;
    if (!thread || !cursor) {
      try {
        const details = await rpc.call('thread/read', { threadId, includeTurns: false });
        thread ??= threadSummary(details.thread);
        readState = details.readState;
      } catch (error) {
        if (!local?.loaded || local.turn || !/not found|not materialized|no rollout/i.test(message(error))) throw error;
      }
    }
    try {
      const turns = await rpc.call('thread/turns/list', { threadId, cursor, limit: 12, sortDirection: 'desc', itemsView: 'full' });
      return { thread, readState, turns: turns.data.map(turnSummary), nextCursor: turns.nextCursor };
    } catch (error) {
      if (!(local?.loaded && !local.turn && !cursor && /not found|not materialized|no rollout/i.test(message(error)))) throw error;
      return { thread, turns: [], nextCursor: null };
    }
  }

  async markRead(threadId, revision) {
    if (typeof revision !== 'string' || !revision.length || revision.length > 128) {
      throw new HttpError(400, '未读回执版本无效。');
    }
    const rpc = await this.#getRpc();
    await rpc.call('thread/readState/update', { threadId, expectedRevision: revision, operation: { type: 'read' } });
    return { marked: true };
  }

  live(threadId) {
    const entry = this.#threads.get(threadId);
    const pending = [...this.#requests.values()].filter(request => request.threadId === threadId)
      .map(({ responses, rpcId, ...request }) => request);
    return { turn: entry?.turn ?? null, loaded: entry?.loaded ?? false, settings: entry?.settings ?? null, pending, state: this.state };
  }

  async create(index) {
    const cwd = this.directories[index];
    if (!Number.isInteger(index) || !cwd) throw new HttpError(400, '请选择主机提供的工作目录。');
    return this.#action(async () => {
      this.#allowNewTurn();
      const rpc = await this.#getRpc();
      const result = await rpc.call('thread/start', { cwd, historyMode: 'paginated' });
      const entry = this.#remember(result);
      this.#emit('history', entry.thread.id);
      return entry.thread;
    });
  }

  async send({ threadId, expectedTurnId, operationId, text, settings = {} }) {
    if (typeof text !== 'string' || !text.trim() || text.length > 65_536) throw new HttpError(400, '请输入有效的任务内容。');
    return this.#action(async () => {
      const input = [{ type: 'text', text, text_elements: [] }];
      const clientUserMessageId = operationId;
      if (!expectedTurnId) this.#allowNewTurn();
      if (this.#working.has(threadId)) {
        throw new HttpError(409, '此会话已有任务正在执行。');
      }
      this.#working.add(threadId);
      try {
        const rpc = await this.#getRpc();
        const entry = expectedTurnId && !this.#shared ? this.#threads.get(threadId) : await this.#resume(rpc, threadId);
        if (expectedTurnId && (entry?.turn?.id !== expectedTurnId || !active(entry?.turn))) {
          throw new HttpError(409, '活动轮次已变化，请查看最新状态后再发送。');
        }
        if (active(entry.turn)) {
          if (!this.#shared && !expectedTurnId) throw new HttpError(409, '此会话已有任务正在执行。');
          const result = await rpc.call('turn/steer', { threadId, expectedTurnId: entry.turn.id, input, clientUserMessageId });
          return { ...result, steered: true };
        }
        const options = await this.#turnOptions(rpc, entry, settings);
        const { turn } = await rpc.call('turn/start', { threadId, input, clientUserMessageId, ...options });
        if (!entry.turn || entry.turn.id !== turn.id) entry.turn = turnSummary(turn);
        if (!entry.thread.preview) {
          entry.thread.preview = text.trim().split('\n')[0].slice(0, 120);
          this.#emit('history', threadId);
        }
        this.#emit('live', threadId);
        return { turnId: turn.id };
      } finally {
        this.#working.delete(threadId);
      }
    });
  }

  async stop(threadId, turnId) {
    if (this.#threads.get(threadId)?.turn?.id !== turnId || !active(this.#threads.get(threadId)?.turn)) {
      throw new HttpError(409, '此轮任务已结束。');
    }
    const rpc = await this.#getRpc();
    return rpc.call('turn/interrupt', { threadId, turnId });
  }

  async respond(id, body) {
    const entry = this.#requests.get(id);
    if (!entry || entry.status !== 'open') throw new HttpError(409, '该请求已提交或已结束。');
    const value = requestResponse(entry, body);
    entry.status = 'submitted';
    this.#emit('live', entry.threadId);
    await this.#rpc.respond(entry.rpcId, value);
    return { submitted: true };
  }

  async #action(fn) {
    this.#inFlight++;
    try { return await fn(); } finally {
      this.#inFlight--;
      this.#drainRestart();
    }
  }

  #allowNewTurn() {
    if (this.#queued) throw new HttpError(409, 'Codex 正等待活动任务结束后重连。');
  }

  #remember(result) {
    const { thread, model, reasoningEffort, serviceTier } = result;
    const entry = this.#threads.get(thread.id) ?? {};
    entry.thread = threadSummary(thread);
    entry.settings ??= { model, effort: reasoningEffort, speed: serviceTier };
    entry.loaded = true;
    this.#threads.delete(thread.id);
    this.#threads.set(thread.id, entry);
    for (const [id, tracked] of this.#threads) {
      if (this.#threads.size <= 50) break;
      if (!tracked.loaded && !active(tracked.turn)) this.#threads.delete(id);
    }
    return entry;
  }

  async #resume(rpc, threadId) {
    const entry = this.#threads.get(threadId);
    if (entry?.loaded) return entry;
    const { thread } = await rpc.call('thread/read', { threadId, includeTurns: false });
    const loadedHere = this.#shared && ['active', 'idle'].includes(thread.status?.type);
    if (thread.historyMode !== 'paginated' && !loadedHere) {
      const { data } = await rpc.call('thread/turns/list', { threadId, limit: 1, sortDirection: 'desc', itemsView: 'notLoaded' });
      if (thread.status?.type === 'active' || data.some(active) || await legacyWriterPresent(thread.path)) {
        throw writerConflict();
      }
    }
    const result = await rpc.call('thread/resume', { threadId, excludeTurns: true }).catch(error => {
      if (error instanceof RpcError && /already has an active writer/i.test(error.message)) throw writerConflict();
      throw error;
    });
    const running = result.thread.status?.type === 'active';
    if (running && !this.#shared) {
      await rpc.call('thread/unsubscribe', { threadId });
      throw writerConflict();
    }
    if (result.thread.canAcceptDirectInput === false) {
      await rpc.call('thread/unsubscribe', { threadId });
      throw new HttpError(409, 'Codex 暂不允许在网页接续此会话。');
    }
    const tracked = this.#remember(result);
    if (running && !active(tracked.turn)) {
      const previous = tracked.turn;
      try {
        const { data: [latest] } = await rpc.call('thread/turns/list', {
          threadId, limit: 1, sortDirection: 'desc', itemsView: 'full',
        });
        if (latest && tracked.turn === previous) tracked.turn = turnSummary(latest);
      } catch (error) {
        tracked.loaded = false;
        throw error;
      }
    }
    return tracked;
  }

  async #turnOptions(rpc, entry, requested) {
    if (!requested || typeof requested !== 'object' || Array.isArray(requested)) throw new HttpError(400, '任务设置无效。');
    const { models, modes } = await this.#loadCatalog(rpc);
    const options = {};
    const model = models.value?.find(item => item.model === (requested.model || entry.settings?.model));
    if (requested.model && !model) throw new HttpError(400, models.reason ?? '此模型当前不可用。');
    if (requested.effort && !model?.efforts.some(option => option.reasoningEffort === requested.effort)) {
      throw new HttpError(400, '此模型不提供所选推理强度。');
    }
    if (requested.speed && requested.speed !== 'default' && !model?.speeds.some(option => option.id === requested.speed)) {
      throw new HttpError(400, '此模型不提供所选速度。');
    }
    if (requested.model) options.model = requested.model;
    if (requested.effort) options.effort = requested.effort;
    if (requested.speed) options.serviceTier = requested.speed === 'default' ? null : requested.speed;
    if (requested.mode) {
      const mode = modes.value?.find(preset => preset.mode === requested.mode);
      if (!mode) throw new HttpError(400, modes.reason ?? '当前 Codex 不提供所选协作模式。');
      const effectiveModel = requested.model || mode.model || entry.settings?.model;
      if (!effectiveModel) throw new HttpError(409, '当前无法确定协作模式使用的模型。');
      const effectiveCatalogModel = models.value?.find(item => item.model === effectiveModel);
      const candidates = [
        requested.effort, mode.effort,
        effectiveModel === entry.settings?.model ? entry.settings?.effort : null,
        effectiveCatalogModel?.defaultEffort,
      ];
      const reasoning = candidates.find(effort => effort && (
        !effectiveCatalogModel || effectiveCatalogModel.efforts.some(option => option.reasoningEffort === effort)
      ));
      options.collaborationMode = {
        mode: mode.mode,
        settings: {
          model: effectiveModel,
          reasoning_effort: reasoning ?? null,
          developer_instructions: null,
        },
      };
    }
    return options;
  }

  async meta(index, refreshCatalog = false) {
    const rpc = await this.#getRpc();
    const cwd = this.directories[index] ?? this.directories[0];
    const [catalog, defaults] = await Promise.all([
      this.#loadCatalog(rpc, refreshCatalog),
      projected(rpc.call('config/read', { cwd, includeLayers: false }), ({ config }) => ({
        model: config?.model, effort: config?.model_reasoning_effort, speed: config?.service_tier,
      })),
    ]);
    return { ...catalog, defaults, directories: this.directories, state: this.state };
  }

  #loadCatalog(rpc, refresh = false) {
    const cached = this.#catalog;
    if (cached && (cached.loading || (!refresh && Date.now() < cached.until))) return cached.promise;
    const catalog = { loading: true, until: 0 };
    catalog.promise = Promise.all([
      projected(allModels(rpc), models => models.filter(model => !model.hidden).map(model => ({
        model: model.model, name: model.displayName, isDefault: model.isDefault,
        efforts: model.supportedReasoningEfforts ?? [], defaultEffort: model.defaultReasoningEffort,
        speeds: model.serviceTiers?.length ? model.serviceTiers : (model.additionalSpeedTiers ?? []).map(id => ({ id, name: id })),
        defaultSpeed: model.defaultServiceTier,
      }))),
      projected(rpc.call('collaborationMode/list', {}), ({ data }) => data.filter(preset => preset.mode === 'default' || preset.mode === 'plan')
        .map(({ name, mode, model, reasoning_effort }) => ({ name, mode, model, effort: reasoning_effort }))),
    ]).then(([models, modes]) => {
      catalog.until = Date.now() + (models.reason ? 3_000 : 30_000);
      return { models, modes };
    }).finally(() => {
      catalog.loading = false;
    });
    this.#catalog = catalog;
    return catalog.promise;
  }

  async account() {
    const rpc = await this.#getRpc();
    if (this.#account && Date.now() < this.#account.until) return this.#account.promise;
    const promise = Promise.all([
      projected(rpc.call('account/read', { refreshToken: false }), ({ account }) => (
        account ? { type: account.type, plan: account.planType ?? null } : null
      )),
      projected(rpc.call('account/rateLimits/read', undefined, 12_000), limitProjection),
      projected(rpc.call('account/usage/read', {}, 12_000), ({ summary, dailyUsageBuckets }) => ({
        summary: summary && { lifetimeTokens: summary.lifetimeTokens, peakDailyTokens: summary.peakDailyTokens },
        daily: dailyUsageBuckets?.map(({ startDate, tokens }) => ({ date: startDate, tokens })) ?? null,
      })),
    ]).then(([identity, limits, usage]) => ({ identity, limits, usage }));
    this.#account = { promise, until: Date.now() + 30_000 };
    return promise;
  }

  #request(rpc, { method, params: p = {}, id: rpcId }) {
    if (method === 'currentTime/read') {
      rpc.respond(rpcId, { currentTimeAt: Math.floor(Date.now() / 1000) }).catch(() => {});
      return;
    }
    const threadId = p.threadId ?? p.conversationId;
    const entry = this.#threads.get(threadId);
    const request = presentRequest(method, p, entry?.turn?.items?.find(item => item.id === p.itemId));
    if (!request || !entry) {
      // In shared mode the desktop can handle client-specific requests.
      if (!this.#shared) rpc.reject(rpcId, 'Codex Bridge does not support this server request: ' + method).catch(() => {});
      return;
    }
    const id = randomUUID();
    this.#requests.set(id, { ...request, id, rpcId, threadId, turnId: p.turnId ?? entry.turn?.id, status: 'open' });
    this.#emit('live', threadId);
  }

  #notify({ method, params: p = {} }) {
    if (method === 'thread/readState/changed') {
      this.#emit('read', p.threadId, p.readState);
      return;
    }
    if (method === 'project/changed') {
      this.#emit('projects');
      return;
    }
    if (method === 'thread/project/updated') {
      const entry = this.#threads.get(p.threadId);
      if (entry) entry.thread.projectId = p.projectId;
      this.#emit('projects');
      return;
    }
    if (method === 'account/updated' || method === 'account/rateLimits/updated') {
      this.#account = null;
      if (method === 'account/updated') this.#catalog = null;
      this.#emit(method === 'account/updated' ? 'reset' : 'account');
      return;
    }
    const threadId = p.threadId ?? p.thread?.id;
    const entry = this.#threads.get(threadId);
    if (!entry) return;
    switch (method) {
      case 'thread/name/updated':
        entry.thread.name = p.threadName;
        this.#emit('history', threadId);
        return;
      case 'thread/status/changed':
        entry.thread.status = p.status;
        break;
      case 'thread/settings/updated': {
        const { model, effort, serviceTier, collaborationMode } = p.threadSettings;
        entry.settings = { model, effort, speed: serviceTier, mode: collaborationMode?.mode };
        break;
      }
      case 'thread/closed':
        entry.loaded = false;
        break;
      case 'serverRequest/resolved':
        for (const [id, request] of this.#requests) {
          if (request.rpcId === p.requestId) this.#requests.delete(id);
        }
        break;
      case 'turn/started':
      case 'turn/completed':
        entry.turn = mergeTurn(entry.turn, turnSummary(p.turn));
        if (method === 'turn/completed') {
          for (const [id, request] of this.#requests) {
            if (request.threadId === threadId && request.turnId === p.turn.id) this.#requests.delete(id);
          }
          this.#emit('history', threadId);
          this.#drainRestart();
        }
        break;
      default:
        if (!entry.turn || entry.turn.id !== p.turnId ||
            !(method === 'error' || method.startsWith('item/') || method.startsWith('turn/'))) return;
        updateTurn(entry.turn, method, p);
    }
    this.#emit('live', threadId);
  }
}

function projected(promise, project) {
  return promise.then(value => available(project(value))).catch(unavailable);
}

function sidebarThread(thread, layout, readState) {
  const summary = { ...threadSummary(thread), readState };
  return layout ? { ...summary, projectId: layout.assignedProject(thread) } : summary;
}

async function readThreadSummaries(rpc, ids, layout) {
  const rows = await Promise.all(ids.map(threadId =>
    rpc.call('thread/read', { threadId, includeTurns: false }, 8_000)
      .then(({ thread, readState }) => sidebarThread(thread, layout, readState)).catch(() => null),
  ));
  return rows.filter(Boolean);
}

async function allModels(rpc) {
  const models = [];
  let cursor;
  do {
    const page = await rpc.call('model/list', { cursor, limit: 50, includeHidden: false });
    models.push(...page.data);
    cursor = page.nextCursor;
  } while (cursor);
  return models;
}

function limitProjection(result) {
  const meetings = result.rateLimitsByLimitId ?? { codex: result.rateLimits };
  return Object.entries(meetings).filter(([, snapshot]) => snapshot).map(([id, snapshot]) => ({
    id, name: snapshot.limitName, plan: snapshot.planType,
    windows: [snapshot.primary, snapshot.secondary].filter(Boolean)
      .map(({ usedPercent, windowDurationMins, resetsAt }) => ({ usedPercent, windowDurationMins, resetsAt })),
    credits: snapshot.credits && {
      hasCredits: snapshot.credits.hasCredits, unlimited: snapshot.credits.unlimited, balance: snapshot.credits.balance,
    },
  }));
}
