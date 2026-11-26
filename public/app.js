import { groupProjects, projectPath } from './projects.js';
import { renderMarkdown } from './markdown.js';

const $ = id => document.getElementById(id);
const node = (name, text, className) => {
  const element = document.createElement(name);
  if (text != null) element.textContent = text;
  if (className) element.className = className;
  return element;
};
const statusLabels = {
  inProgress: '运行中', completed: '已完成', interrupted: '已停止', failed: '失败',
  pending: '待执行', declined: '已拒绝', in_progress: '运行中', notLoaded: '已保存',
};
const effortLabels = { none: '无', minimal: '极低', low: '低', medium: '中', high: '高', xhigh: '很高', max: '最高', ultra: 'Ultra' };
const speedLabels = { fast: '快速', priority: '快速', ultrafast: '极速' };
const connectionLabels = {
  connected: '本机已连接', waiting: '等待任务结束后重连', reconnecting: '正在重连', disconnected: 'Codex 未连接', offline: '网页已离线',
};
const dateFormat = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const state = {
  streams: null, selected: null, threads: [], olderThreads: null, projects: [], pinned: [], projectPages: new Map(),
  turns: [], olderTurns: null, live: null,
  meta: null, preferences: {}, connection: 'disconnected', busy: false, creating: false, selection: 0,
};
const keyedRequests = new Map();
const projectStorageKey = 'codex-bridge-projects';
const expandedProjects = readProjectChoices();
const drafts = new Map();
let scheduled;
let metaVersion = 0;
let lastCatalogRequest = 0;
let listVersion = 0;
let liveVersion = 0;
let projectsVersion = 0;
let reading;

function readProjectChoices() {
  try { return new Map(JSON.parse(localStorage.getItem(projectStorageKey) ?? '[]')); }
  catch { return new Map(); }
}

function draftFor(id) {
  if (drafts.has(id)) return drafts.get(id);
  let draft = { text: '', unconfirmed: false };
  try {
    const saved = JSON.parse(sessionStorage.getItem('codex-bridge-draft:' + id));
    if (saved && typeof saved.text === 'string') draft = { text: saved.text, unconfirmed: saved.unconfirmed === true };
  } catch {}
  drafts.set(id, draft);
  return draft;
}

function saveDraft(id, changes) {
  const draft = draftFor(id);
  Object.assign(draft, changes);
  const key = 'codex-bridge-draft:' + id;
  try {
    if (draft.text || draft.unconfirmed) sessionStorage.setItem(key, JSON.stringify(draft));
    else sessionStorage.removeItem(key);
  } catch {}
}

async function api(path, data) {
  const response = await fetch(path, data === undefined ? {} : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
  });
  const value = await response.json();
  if (response.status === 401 && path !== '/api/login') loginView();
  if (!response.ok) throw Object.assign(new Error(value.error || '请求失败。'), {
    status: response.status, code: value.code,
  });
  return value;
}

const operation = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
const setError = (id, error) => { $(id).textContent = error?.message ?? ''; };
const threadName = thread => thread?.name || thread?.preview || '新会话';
const route = (path, params) => path + '?' + new URLSearchParams(params);

function loginView() {
  state.streams?.close();
  state.streams = null;
  if ($('account-dialog').open) $('account-dialog').close();
  if ($('password-dialog').open) $('password-dialog').close();
  $('login-view').hidden = false;
  $('console-view').hidden = true;
}

function consoleView() {
  $('login-view').hidden = true;
  $('console-view').hidden = false;
  if (state.streams) return;
  const stream = state.streams = new EventSource('/api/events');
  stream.onerror = () => {
    connection('offline');
    api('/api/session').then(({ device }) => { if (!device) loginView(); }).catch(() => {});
  };
  stream.addEventListener('revoke', loginView);
  stream.onmessage = event => {
    const change = JSON.parse(event.data);
    if (change.scope === 'reset') {
      refreshMeta();
      loadProjects();
      loadList();
      if (state.selected) {
        loadHistory();
        refreshLive();
      }
      if ($('account-dialog').open) loadAccount();
    } else if (change.scope === 'history') {
      scheduleLive(change.threadId);
      loadList();
      if (change.threadId === state.selected) loadHistory();
    } else if (change.scope === 'live') {
      scheduleLive(change.threadId);
    } else if (change.scope === 'connection') {
      refreshMeta();
      if (state.selected) scheduleLive(state.selected);
    } else if (change.scope === 'account' && $('account-dialog').open) {
      loadAccount();
    } else if (change.scope === 'projects') {
      reloadProjects();
    } else if (change.scope === 'read' && change.readState) {
      applyReadState(change.threadId, change.readState);
      if (change.readState.firstUnread && change.threadId === state.selected && document.visibilityState === 'visible') loadHistory();
    }
  };
  try {
    const remembered = sessionStorage.getItem('codex-bridge-thread');
    if (remembered) openThread(remembered);
  } catch {}
}

function connection(value) {
  state.connection = value;
  const readOnly = state.meta?.sendBlocked || state.live?.sendBlocked;
  $('connection').textContent = readOnly ? '桌面历史 · 只读' : connectionLabels[value] ?? connectionLabels.disconnected;
  $('connection').dataset.connected = String(!readOnly && value === 'connected');
  updateComposer();
}

async function refreshMeta(fresh = false) {
  const version = ++metaVersion;
  lastCatalogRequest = Date.now();
  try {
    const meta = await api(route('/api/meta', {
      directory: $('directory').value || '0', ...(fresh && { refresh: '1' }),
    }));
    if (version !== metaVersion) return;
    state.meta = meta;
    const select = $('directory');
    setSelect(select, meta.directories.map((path, index) => [String(index), path]), select.value);
    connection(meta.state);
    renderList();
    if (state.selected) renderTimeline();
  } catch (error) {
    if (version !== metaVersion) return;
    connection('disconnected');
    setError('history-error', error);
  }
}

function refreshCatalogIfStale() {
  if (state.streams && document.visibilityState === 'visible' && Date.now() - lastCatalogRequest >= 30_000) {
    refreshMeta(true);
  }
}

async function loadList(more = false, keepOlder = false) {
  const version = ++listVersion;
  const cursor = more ? state.olderThreads : null;
  $('more-threads').disabled = true;
  try {
    const result = await api(cursor ? route('/api/threads', { cursor }) : '/api/threads');
    if (version !== listVersion) return;
    const threads = more ? state.threads : state.threads.filter(thread => thread.id === state.selected);
    const unique = new Map(result.threads.map(thread => [thread.id, thread]));
    if (more) state.threads = [...new Map([...threads, ...result.threads].map(thread => [thread.id, thread])).values()];
    else if (keepOlder) state.threads = [...result.threads, ...state.threads.filter(thread => !unique.has(thread.id))];
    else state.threads = [...threads.filter(thread => !unique.has(thread.id)), ...result.threads];
    if (!keepOlder || state.threads.length <= result.threads.length) state.olderThreads = result.nextCursor;
    if (unique.has(state.selected)) updateHeader(unique.get(state.selected));
    setError('history-error');
    renderList();
  } catch (error) {
    if (version === listVersion) setError('history-error', error);
  } finally {
    if (version === listVersion) $('more-threads').disabled = false;
  }
}

async function loadProjects(refresh = false) {
  const version = ++projectsVersion;
  try {
    const { projects, pinned = [] } = await api('/api/projects');
    if (version !== projectsVersion) return;
    if (!refresh && JSON.stringify([projects, pinned]) === JSON.stringify([state.projects, state.pinned])) return;
    state.projects = projects;
    state.pinned = pinned;
    if (refresh) state.projectPages.clear();
    renderList();
  } catch {
    // Older App Server versions still expose history and working directories.
  }
}

function reloadProjects() {
  loadProjects(true);
  loadList();
}

async function loadProjectThreads(id, more = false, keepOlder = false) {
  const page = state.projectPages.get(id) ?? { threads: [], cursor: null };
  if (page.loading || (more && !page.cursor)) return;
  page.loading = true;
  page.error = null;
  state.projectPages.set(id, page);
  try {
    const params = { project: id };
    if (more) params.cursor = page.cursor;
    const result = await api(route('/api/threads', params));
    const threads = more || keepOlder ? [...page.threads, ...result.threads] : result.threads;
    page.threads = [...new Map(threads.map(thread => [thread.id, thread])).values()];
    if (!keepOlder || page.threads.length <= result.threads.length) page.cursor = result.nextCursor;
  } catch (error) {
    page.error = error.message;
  } finally {
    page.loading = false;
    if (state.projectPages.get(id) === page) renderList();
  }
}

function renderThreadButton(thread) {
  const button = node('button', null, 'history-button');
  button.append(node('span', threadName(thread), 'history-title'));
  if (thread.readState?.firstUnread) {
    const dot = node('span', null, 'unread-dot');
    dot.setAttribute('aria-hidden', 'true');
    button.append(dot, node('span', '（有未读回复）', 'sr-only'));
  }
  button.type = 'button';
  button.dataset.historyFocus = 'thread:' + thread.id;
  button.title = thread.cwd || '';
  if (thread.id === state.selected) button.setAttribute('aria-current', 'true');
  button.addEventListener('click', () => openThread(thread.id, thread));
  return button;
}

function renderList() {
  const list = $('threads');
  const scrollTop = list.scrollTop;
  const focused = document.activeElement?.dataset.historyFocus;
  const threads = new Map(state.threads.map(thread => [thread.id, thread]));
  for (const page of state.projectPages.values()) {
    for (const thread of page.threads) if (!threads.has(thread.id)) threads.set(thread.id, thread);
  }
  for (const pin of state.pinned) if (pin.type === 'thread') threads.delete(pin.thread.id);
  const ordered = [...threads.values()].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  const projects = groupProjects(state.projects, ordered);
  const workspace = projectPath(state.meta?.directories[0]);
  const preferred = projects.find(project => project.threads.some(thread => thread.id === state.selected))
    ?? projects.find(project => workspace && project.roots.some(root => projectPath(root) === workspace))
    ?? projects.find(project => project.threads.length);
  const pending = [];
  const groups = new Map(projects.map((project, index) => {
    const previous = project.nativeId ? expandedProjects.get('project:' + project.nativeId) : undefined;
    const open = expandedProjects.get(project.key) ?? previous ?? (project === preferred);
    if (open && project.id && !state.projectPages.has(project.id)) pending.push(project.id);
    return [project.key, renderProject(project, index, open)];
  }));
  const pinned = [];
  for (const pin of state.pinned) {
    if (pin.type === 'thread') {
      pinned.push(renderThreadButton(pin.thread));
    } else {
      const key = 'project:' + pin.projectId;
      const group = groups.get(key);
      if (group) pinned.push(group);
      groups.delete(key);
    }
  }
  const rows = [];
  if (pinned.length) rows.push(sidebarSection('置顶', 'pinned', pinned));
  const registered = projects.filter(project => project.id && groups.has(project.key)).map(project => groups.get(project.key));
  if (registered.length) rows.push(sidebarSection('项目', 'projects', registered));
  const other = projects.filter(project => !project.id).map(project => groups.get(project.key));
  if (other.length) rows.push(sidebarSection('其他会话', 'other', other));
  if (!rows.length) rows.push(node('p', '暂无项目或历史会话', 'directory-label'));
  list.replaceChildren(...rows);
  list.scrollTop = scrollTop;
  if (focused) {
    const replacement = [...list.querySelectorAll('[data-history-focus]')].find(element => element.dataset.historyFocus === focused);
    replacement?.focus({ preventScroll: true });
  }
  $('more-threads').hidden = !state.olderThreads;
  for (const id of pending) loadProjectThreads(id);
}

function sidebarSection(title, key, items) {
  const section = node('section', null, 'sidebar-section');
  const heading = node('h2', title);
  heading.id = 'sidebar-' + key;
  section.setAttribute('aria-labelledby', heading.id);
  section.append(heading, ...items);
  return section;
}

function renderProject(project, index, open) {
  const group = node('section', null, 'project-group');
  const button = node('button', project.name, 'project-toggle');
  button.type = 'button';
  button.dataset.historyFocus = project.key;
  button.title = project.path || project.name;
  const body = node('div', null, 'project-threads');
  body.id = 'project-threads-' + index;
  button.setAttribute('aria-controls', body.id);
  const toggle = visible => {
    button.setAttribute('aria-expanded', String(visible));
    body.hidden = !visible;
  };
  toggle(open);
  button.onclick = () => {
    const visible = body.hidden;
    toggle(visible);
    expandedProjects.set(project.key, visible);
    try { localStorage.setItem(projectStorageKey, JSON.stringify([...expandedProjects])); } catch {}
    if (visible && project.id && !state.projectPages.has(project.id)) loadProjectThreads(project.id);
  };
  body.append(...project.threads.map(renderThreadButton));
  const page = state.projectPages.get(project.id);
  if (page?.error) {
    body.append(node('p', page.error, 'error'));
    const retry = node('button', '重试', 'quiet project-more');
    retry.onclick = () => { retry.disabled = true; loadProjectThreads(project.id, Boolean(page.cursor)); };
    body.append(retry);
  } else if (page?.cursor) {
    const more = node('button', '更多会话', 'quiet project-more');
    more.disabled = page.loading;
    more.onclick = () => { more.disabled = true; loadProjectThreads(project.id, true); };
    body.append(more);
  } else if (!project.threads.length) {
    body.append(node('p', !page || page.loading ? '加载会话…' : '暂无会话', 'project-empty'));
  }
  group.append(button, body);
  return group;
}

function updateHeader(thread) {
  state.thread = thread;
  $('thread-title').textContent = threadName(thread);
  $('thread-path').textContent = [thread?.forkedFromId && '会话分支', thread?.cwd].filter(Boolean).join(' · ');
  updateComposer();
}

function menu(open) {
  $('console-view').dataset.menu = open ? 'open' : 'closed';
  $('menu-toggle').setAttribute('aria-expanded', String(open));
}

function openThread(id, thread) {
  state.selection++;
  state.selected = id;
  state.turns = [];
  state.olderTurns = undefined;
  state.live = null;
  state.preferences = {};
  keyedRequests.clear();
  try { sessionStorage.setItem('codex-bridge-thread', id); } catch {}
  $('prompt').value = draftFor(id).text;
  $('empty').hidden = true;
  $('content').hidden = false;
  $('composer').hidden = false;
  $('pending').replaceChildren();
  setError('thread-error');
  setError('send-error');
  menu(false);
  updateHeader(thread);
  renderList();
  renderTimeline('bottom');
  loadHistory();
  refreshLive();
}

async function loadHistory(more = false) {
  const id = state.selected;
  const selection = state.selection;
  const cursor = more ? state.olderTurns : null;
  if (!id) return;
  $('more-turns').disabled = true;
  try {
    const result = await api(route('/api/thread', cursor ? { id, cursor } : { id }));
    if (selection !== state.selection) return;
    updateHeader(result.thread);
    // Keep previously paged turns on network reconnection.
    const turns = new Map([...state.turns, ...result.turns].map(turn => [turn.id, turn]));
    state.turns = [...turns.values()].sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0) || a.id.localeCompare(b.id));
    if (more || state.olderTurns === undefined) state.olderTurns = result.nextCursor;
    setError('thread-error');
    renderTimeline(more ? 'prepend' : undefined);
    if (!more) markViewed(id, result.readState, result.turns);
  } catch (error) {
    if (selection === state.selection) setError('thread-error', error);
  } finally {
    if (selection === state.selection) $('more-turns').disabled = false;
  }
}

function applyReadState(id, receipt) {
  const update = thread => thread.id === id ? { ...thread, readState: receipt } : thread;
  state.threads = state.threads.map(update);
  state.pinned = state.pinned.map(pin => pin.type === 'thread' ? { ...pin, thread: update(pin.thread) } : pin);
  for (const page of state.projectPages.values()) page.threads = page.threads.map(update);
  renderList();
}

async function markViewed(id, receipt, turns) {
  if (state.meta?.sendBlocked || state.live?.sendBlocked || document.visibilityState !== 'visible' || !receipt?.firstUnread || !receipt.revision) return;
  if (receipt.firstUnread.type === 'turn' && !turns.some(turn => turn.status !== 'inProgress')) return;
  const key = id + '/' + receipt.revision;
  if (reading === key) return;
  reading = key;
  try {
    await api('/api/read', { threadId: id, revision: receipt.revision });
    // The App Server publishes the new revision. Keep unsent replies visible if a newer revision arrives.
  } catch {
    // A newer reply may have superseded this receipt. Leave it unread until fetched.
  } finally {
    if (reading === key) reading = null;
  }
}

function scheduleLive(id) {
  if (id !== state.selected || scheduled) return;
  scheduled = setTimeout(() => {
    scheduled = null;
    refreshLive();
  }, 110);
}

async function refreshLive() {
  const id = state.selected;
  const version = ++liveVersion;
  const selection = state.selection;
  if (!id) return;
  try {
    const result = await api(route('/api/live', { id }));
    if (version !== liveVersion || selection !== state.selection) return;
    const previous = state.live?.turn;
    if (previous && previous.id !== result.turn?.id && previous.status !== 'inProgress' && !state.turns.some(turn => turn.id === previous.id)) {
      state.turns.push(previous);
    }
    state.live = result;
    connection(result.state);
    renderTimeline();
    renderPending(result.pending);
  } catch (error) {
    if (version === liveVersion && selection === state.selection) setError('send-error', error);
  }
}

function displayedTurns() {
  const turns = [...state.turns];
  const live = state.live?.turn;
  if (!live) return turns;
  const index = turns.findIndex(turn => turn.id === live.id);
  if (index < 0) return [...turns, live];
  const stored = turns[index];
  const items = new Map(stored.items.map(item => [item.id, item]));
  for (const item of live.items) items.set(item.id, { ...items.get(item.id), ...item });
  turns[index] = { ...stored, ...live, items: [...items.values()] };
  return turns;
}

function renderTimeline(anchor) {
  const container = $('conversation');
  const timeline = $('timeline');
  const open = new Set([...timeline.querySelectorAll('details[open]')].map(detail => detail.dataset.key));
  const height = container.scrollHeight;
  const top = container.scrollTop;
  const atBottom = height - top - container.clientHeight < 100;
  const turns = displayedTurns();
  timeline.replaceChildren(...turns.map((turn, index) => renderTurn(turn, open, index === turns.length - 1)));
  $('more-turns').hidden = !state.olderTurns;
  if (anchor === 'prepend') container.scrollTop = top + container.scrollHeight - height;
  else if (anchor === 'bottom' || atBottom) container.scrollTop = container.scrollHeight;
  else container.scrollTop = top;
}

function renderTurn(turn, open, latest) {
  const section = node('section', null, 'turn');
  for (let i = 0; i < turn.items.length;) {
    const item = turn.items[i];
    if (!isActivity(item)) {
      section.append(renderItem(item, open));
      i++;
      continue;
    }
    const group = [];
    while (i < turn.items.length && isActivity(turn.items[i])) group.push(turn.items[i++]);
    const active = group.some(entry => ['inProgress', 'in_progress', 'pending'].includes(entry.status));
    const detail = detailPanel('activity-' + item.id, active ? '任务活动进行中' : group.length + ' 项任务活动', open);
    detail.classList.add('activity-group');
    const entries = node('div', null, 'activity-items');
    entries.append(...group.map(entry => renderItem(entry, open)));
    detail.append(entries);
    section.append(detail);
  }
  if (turn.plan?.length) {
    const plan = node('section', null, 'plan-steps');
    plan.append(node('h3', '计划进度'));
    if (turn.explanation) plan.append(node('p', turn.explanation));
    const list = node('ul');
    for (const step of turn.plan) {
      const line = node('li', (statusLabels[step.status] ?? step.status) + ' · ' + step.step);
      line.dataset.status = step.status;
      list.append(line);
    }
    plan.append(list);
    section.append(plan);
  }
  if (turn.diff && !turn.items.some(item => item.type === 'fileChange')) {
    const detail = detailPanel(turn.id + '-diff', '本轮文件改动', open);
    detail.append(node('pre', turn.diff));
    section.append(detail);
  }
  if (turn.error) section.append(node('p', turn.error, 'error'));
  if (latest && turn.status === 'completed' && turn.items.some(item => item.type === 'plan') &&
      state.meta?.modes.value?.some(mode => mode.mode === 'default')) {
    const execute = node('button', '按计划执行', 'primary');
    execute.disabled = state.busy || state.connection !== 'connected';
    execute.onclick = () => {
      state.preferences.mode = 'default';
      updateComposer();
      sendMessage('请按上面的计划执行。');
    };
    section.append(execute);
  }
  return section;
}

function isActivity(item) {
  return item.type === 'commandExecution' || item.type === 'fileChange';
}

function renderItem(item, open) {
  const { id, type, text, status } = item;
  if (isActivity(item)) {
    const command = type === 'commandExecution';
    const label = command ? '命令输出' : '文件改动';
    const detail = detailPanel(id, label + (status ? ' · ' + (statusLabels[status] ?? status) : ''), open);
    if (item.command) detail.append(node('pre', item.command));
    if (item.output) detail.append(node('pre', item.output));
    if (item.exitCode != null) detail.append(node('p', '退出码 ' + item.exitCode));
    for (const change of item.changes ?? []) {
      detail.append(node('p', change.path));
      if (change.diff) detail.append(node('pre', change.diff));
    }
    return detail;
  }
  const element = node('article', null, 'item ' + type);
  element.setAttribute('aria-label', type === 'plan' ? '计划' : type === 'userMessage' ? '你的指令' : 'Codex 回复');
  if (type === 'plan') element.append(node('strong', '计划'));
  if (type === 'userMessage') element.append(node('div', text ?? '', 'message-text'));
  else {
    const markdown = node('div', null, 'markdown');
    markdown.append(renderMarkdown(text ?? ''));
    element.append(markdown);
  }
  return element;
}

function detailPanel(id, label, open) {
  const detail = node('details', null, 'item');
  detail.dataset.key = id;
  detail.open = open.has(id);
  detail.append(node('summary', label));
  return detail;
}

function renderPending(requests) {
  const parent = $('pending');
  const keys = new Set(requests.map(request => request.id));
  for (const [id, section] of keyedRequests) {
    if (keys.has(id)) continue;
    section.remove();
    keyedRequests.delete(id);
  }
  for (const request of requests) {
    let section = keyedRequests.get(request.id);
    if (!section) {
      section = request.type === 'questions' ? questionCard(request) : approvalCard(request);
      keyedRequests.set(request.id, section);
      parent.append(section);
      const container = $('conversation');
      if (container.scrollHeight - container.scrollTop - container.clientHeight < section.offsetHeight + 120) {
        container.scrollTop = container.scrollHeight;
      }
    }
    if (request.status === 'submitted') {
      section.querySelectorAll('button, input').forEach(input => { input.disabled = true; });
      section.querySelector('[role="status"]').textContent = '已提交，等待 Codex 确认。';
    }
  }
}

function questionCard(request) {
  const form = node('form', null, 'request');
  form.append(node('h3', 'Codex 需要你的回复'));
  const selections = new Map();
  for (const [index, question] of request.questions.entries()) {
    const fieldset = node('fieldset');
    fieldset.append(node('legend', question.header || '问题'));
    fieldset.append(node('p', question.question));
    const inputName = 'q-' + request.id + '-' + index;
    const options = question.options ?? [];
    const radios = options.map((option, optionIndex) => {
      const radio = node('input');
      radio.type = 'radio';
      radio.name = inputName;
      radio.value = String(optionIndex);
      radio.required = true;
      const label = node('label');
      label.append(radio, document.createTextNode(option.label));
      if (option.description) label.append(node('span', ' · ' + option.description, 'muted'));
      fieldset.append(label);
      return radio;
    });
    const custom = node('input');
    custom.type = question.isSecret ? 'password' : 'text';
    custom.maxLength = 4000;
    custom.autocomplete = 'off';
    custom.setAttribute('aria-label', question.question);
    if (!options.length) {
      custom.required = true;
      fieldset.append(custom);
    } else if (question.isOther) {
      const other = node('input');
      other.type = 'radio';
      other.name = inputName;
      other.required = true;
      const label = node('label');
      label.append(other, document.createTextNode('自定义答案'));
      fieldset.append(label, custom);
      custom.hidden = true;
      fieldset.addEventListener('change', () => {
        custom.hidden = !other.checked;
        custom.required = other.checked;
        if (other.checked) custom.focus();
      });
    }
    selections.set(question.id, () => {
      const selected = radios.findIndex(radio => radio.checked);
      return selected < 0 ? custom.value : options[selected].label;
    });
    form.append(fieldset);
  }
  const actions = node('div', null, 'request-actions');
  const submit = node('button', '提交答案', 'primary');
  const cancel = node('button', '取消回答', 'secondary');
  cancel.type = 'button';
  actions.append(submit, cancel);
  const error = node('p', null, 'error');
  error.setAttribute('role', 'status');
  form.append(actions, error);
  form.addEventListener('submit', event => {
    event.preventDefault();
    const answers = Object.fromEntries([...selections].map(([id, selected]) => [id, selected()]));
    respond(request.id, { answers }, form, error);
  });
  cancel.onclick = () => respond(request.id, { cancel: true }, form, error);
  return form;
}

function approvalCard(request) {
  const section = node('section', null, 'request');
  section.append(node('h3', request.title));
  const { reason, command, cwd, changes, grantRoot, network, permissions } = request.context ?? {};
  if (reason) section.append(node('p', reason));
  if (cwd) section.append(node('p', cwd, 'muted'));
  if (command) section.append(node('pre', command));
  if (grantRoot) section.append(node('p', '申请写入范围  ' + grantRoot));
  if (changes?.length) {
    for (const change of changes) {
      section.append(node('p', change.path));
      if (change.diff) section.append(node('pre', change.diff));
    }
  } else if (changes) section.append(node('pre', JSON.stringify(changes, null, 2)));
  if (permissions || network) section.append(node('pre', JSON.stringify(permissions ?? network, null, 2)));
  const actions = node('div', null, 'request-actions');
  const error = node('p', null, 'error');
  error.setAttribute('role', 'status');
  request.choices.forEach((choice, index) => {
    if (choice.detail) {
      const detail = node('details', null, 'item');
      detail.append(node('summary', choice.label + '的规则详情'), node('pre', JSON.stringify(choice.detail, null, 2)));
      section.append(detail);
    }
    const button = node('button', choice.label, 'secondary');
    button.type = 'button';
    button.onclick = () => respond(request.id, { choice: index }, section, error);
    actions.append(button);
  });
  section.append(actions, error);
  return section;
}

async function respond(id, body, section, output) {
  const controls = section.querySelectorAll('button, input');
  controls.forEach(control => { control.disabled = true; });
  output.textContent = '';
  try {
    await api('/api/respond', { id, ...body });
    output.textContent = '已提交，等待 Codex 确认。';
  } catch (error) {
    controls.forEach(control => { control.disabled = false; });
    output.textContent = error.message;
  } finally {
    refreshLive();
  }
}

function setSelect(select, pairs, value) {
  const signature = JSON.stringify(pairs);
  if (select.dataset.options !== signature) {
    select.replaceChildren(...pairs.map(([key, text, disabled = false]) => {
      const option = node('option', text);
      option.value = key;
      option.disabled = disabled;
      return option;
    }));
    select.dataset.options = signature;
  }
  if (pairs.some(([key]) => key === value)) select.value = value;
  else if (select.options.length) select.selectedIndex = 0;
}

function updateComposer() {
  const { meta, preferences, live, thread } = state;
  const settings = live?.settings ?? {};
  const models = meta?.models.value ?? [];
  const modes = meta?.modes.value ?? [];
  const defaults = meta?.defaults.value ?? {};
  const active = live?.turn?.status === 'inProgress';
  const blocked = live?.sendBlocked ?? meta?.sendBlocked;
  const unconfirmed = state.selected && draftFor(state.selected).unconfirmed;
  const capable = !blocked && state.connection === 'connected';
  const canSteer = active && !blocked && (capable || state.connection === 'waiting');
  const defaultMode = settings.mode ?? 'default';

  if (!modes.some(mode => mode.mode === preferences.mode)) delete preferences.mode;
  if (preferences.model && meta?.models.value && !models.some(model => model.model === preferences.model)) {
    delete preferences.model;
    delete preferences.effort;
    delete preferences.speed;
  }
  const currentMode = preferences.mode ?? defaultMode;
  const preset = modes.find(mode => mode.mode === currentMode);
  const baseModel = settings.model ?? thread?.model ?? defaults.model;
  const preferredModel = preferences.model ?? preset?.model ?? baseModel;
  const selectedModel = preferredModel
    ? models.find(model => model.model === preferredModel)
    : models.find(model => model.isDefault) ?? models[0];
  const unavailableModel = Boolean(preferredModel && !selectedModel);
  const modelOptions = models.map(model => [model.model, model.name || model.model]);
  if (unavailableModel) modelOptions.unshift([preferredModel, preferredModel + '（当前）', true]);
  const modelChanged = preferences.model && selectedModel?.model !== baseModel;
  const efforts = selectedModel?.efforts ?? [];
  const nativeEffort = settings.effort ?? thread?.reasoningEffort ?? defaults.effort;
  const displayEffort = [
    preferences.effort, preferences.mode ? preset?.effort : null,
    !modelChanged ? nativeEffort : null, selectedModel?.defaultEffort,
  ].find(effort => efforts.some(option => option.reasoningEffort === effort));
  const displaySpeed = preferences.speed ?? (!modelChanged ? settings.speed ?? defaults.speed : null)
    ?? selectedModel?.defaultSpeed ?? 'default';

  setSelect($('mode'), modes.length ? modes.map(mode => [mode.mode, mode.mode === 'plan' ? '计划模式' : '普通模式']) : [['', '不可用']], currentMode);
  setSelect($('model'), modelOptions.length ? modelOptions : [['', '主机默认']], selectedModel?.model ?? preferredModel);
  setSelect($('effort'), efforts.length ? efforts.map(option => [option.reasoningEffort, effortLabels[option.reasoningEffort] ?? option.reasoningEffort]) : [['', effortLabels[nativeEffort] ?? nativeEffort ?? '主机默认']], displayEffort);
  const speeds = selectedModel?.speeds ?? [];
  setSelect($('speed'), [['default', '标准'], ...speeds.filter(speed => speed.id !== 'default').map(speed => [speed.id, speedLabels[speed.id] ?? speed.name ?? speed.id])], displaySpeed);

  $('mode').disabled = !capable || active || modes.length < 2;
  $('model').disabled = !capable || active || !models.length;
  $('effort').disabled = !capable || active || !efforts.length;
  $('speed').disabled = !capable || active || !speeds.length;
  $('composer-settings').hidden = Boolean(blocked);
  $('reconnect').textContent = blocked ? '刷新历史连接' : '重连 Codex';
  $('send').disabled = state.busy || state.creating || Boolean(unconfirmed) || (active ? !canSteer : !capable);
  $('confirm-send').hidden = !unconfirmed || state.busy;
  $('send').textContent = active ? '补充指令' : '发送';
  $('stop').hidden = !active;
  $('stop').disabled = !canSteer;
  $('new-thread').disabled = !capable || state.creating;
  $('empty-new').disabled = $('new-thread').disabled;
  $('prompt').placeholder = active ? '补充当前任务的指令' : '输入任务指令';
  $('thread-status').textContent = statusLabels[live?.turn?.status ?? thread?.status?.type]
    ?? (live?.loaded ? '就绪' : thread ? '已保存' : '读取中');
  $('composer-note').textContent = !state.busy && unconfirmed ? '发送结果待确认。请在原会话检查这条消息，再解除发送锁定。' :
    blocked ?? (active ? '补充指令会追加到当前轮次。' :
    !capable ? connectionLabels[state.connection] :
    meta?.modes.reason ?? meta?.models.reason ??
    (unavailableModel && meta ? '当前会话的模型不在可选目录中。' :
      Object.keys(preferences).length ? '所选设置将在下一轮生效。' : ''));
}

async function newThread() {
  if (state.creating) return;
  state.creating = true;
  setError('history-error');
  updateComposer();
  try {
    const thread = await api('/api/thread', { directory: Number($('directory').value), operationId: operation() });
    state.threads = [thread, ...state.threads.filter(result => result.id !== thread.id)];
    openThread(thread.id, thread);
    $('prompt').focus();
  } catch (error) {
    setError('history-error', error);
    menu(true);
  } finally {
    state.creating = false;
    updateComposer();
  }
}

async function sendMessage(text) {
  if ($('send').disabled || !text.trim() || !state.selected) return;
  const id = state.selected;
  const turn = state.live?.turn;
  const expectedTurnId = turn?.status === 'inProgress' ? turn.id : null;
  const { model, ...preferences } = state.preferences;
  const settings = { ...preferences, ...(model && { model }) };
  const operationId = operation();
  saveDraft(id, { text, unconfirmed: true });
  state.busy = true;
  setError('send-error');
  updateComposer();
  try {
    const { steered } = await api('/api/send', { threadId: id, expectedTurnId, text, settings, operationId });
    const clear = draftFor(id).text === text;
    saveDraft(id, { unconfirmed: false, ...(clear && { text: '' }) });
    if (clear && state.selected === id) $('prompt').value = '';
    if (!steered && state.selected === id) state.preferences = {};
  } catch (error) {
    if (error.status && error.code !== 'SEND_UNCONFIRMED') saveDraft(id, { unconfirmed: false });
    if (state.selected === id) {
      setError('send-error', error);
    }
  } finally {
    state.busy = false;
    updateComposer();
    refreshLive();
  }
}

async function stopTurn() {
  const turn = state.live?.turn;
  if (!turn || turn.status !== 'inProgress') return;
  $('stop').disabled = true;
  setError('send-error');
  try { await api('/api/stop', { threadId: state.selected, turnId: turn.id }); }
  catch (error) { setError('send-error', error); }
  finally { refreshLive(); }
}

function unavailable(reason) {
  return reason ? '暂不可用 · ' + reason : '当前账户或本机版本未提供数据。';
}

let accountVersion = 0;
async function loadAccount() {
  const version = ++accountVersion;
  const container = $('account-data');
  container.replaceChildren(node('p', '读取本机账户数据…', 'muted'));
  setError('account-error');
  try {
    const { identity, limits, usage } = await api('/api/account');
    if (version !== accountVersion) return;
    const info = accountSection('当前套餐', identity.value
      ? identity.value.plan?.replaceAll('_', ' ') || ({ apiKey: 'API 密钥', amazonBedrock: 'Amazon Bedrock' })[identity.value.type] || identity.value.type
      : identity.reason ? unavailable(identity.reason) : '主机未登录。');
    const quota = accountSection('可用额度', limits.value?.length ? '' : unavailable(limits.reason));
    for (const bucket of limits.value ?? []) {
      quota.append(node('p', bucket.name || bucket.id));
      const list = node('ul');
      for (const window of bucket.windows) {
        const left = window.usedPercent == null ? '额度未知' : '剩余 ' + Math.max(0, 100 - window.usedPercent) + '%';
        const time = window.resetsAt ? '重置 ' + dateFormat.format(window.resetsAt * 1000) : '重置时间未知';
        const label = window.windowDurationMins ? window.windowDurationMins + ' 分钟 · ' + left : left;
        const row = node('li');
        row.append(node('span', label), node('span', time, 'muted'));
        list.append(row);
      }
      if (!list.children.length) quota.append(node('p', '未提供额度窗口。', 'muted'));
      if (bucket.credits?.unlimited) quota.append(node('p', '不限额积分'));
      else if (bucket.credits?.balance != null) quota.append(node('p', '积分余额  ' + bucket.credits.balance));
      quota.append(list);
    }
    const activity = accountSection('用量', usage.value ? '' : unavailable(usage.reason));
    const summary = usage.value?.summary;
    if (summary?.lifetimeTokens != null) activity.append(node('p', '累计  ' + summary.lifetimeTokens.toLocaleString('zh-CN') + ' tokens'));
    if (summary?.peakDailyTokens != null) activity.append(node('p', '单日峰值  ' + summary.peakDailyTokens.toLocaleString('zh-CN') + ' tokens'));
    if (usage.value?.daily?.length) {
      const list = node('ul');
      for (const day of [...usage.value.daily].sort((a, b) => b.date.localeCompare(a.date))) {
        const row = node('li');
        row.append(node('span', day.date), node('span', day.tokens.toLocaleString('zh-CN') + ' tokens'));
        list.append(row);
      }
      activity.append(list);
    } else if (usage.value && !activity.querySelector('p')) activity.append(node('p', '当前没有可用的用量记录。', 'muted'));
    container.replaceChildren(info, quota, activity);
  } catch (error) {
    if (version !== accountVersion) return;
    container.replaceChildren();
    setError('account-error', error);
  }
}

function accountSection(title, description) {
  const section = node('section');
  section.append(node('h3', title));
  if (description) section.append(node('p', description));
  return section;
}

$('login-form').addEventListener('submit', async event => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  setError('login-error');
  try {
    await api('/api/login', {
      username: $('login-username').value.trim(), password: $('login-password').value, name: $('login-name').value,
    });
    $('login-password').value = '';
    consoleView();
  } catch (error) {
    setError('login-error', error);
  } finally {
    button.disabled = false;
  }
});
$('menu-toggle').onclick = () => menu($('menu-toggle').getAttribute('aria-expanded') !== 'true');
$('reload-history').onclick = () => { reloadProjects(); refreshMeta(true); };
$('directory').onchange = () => refreshMeta();
$('model').addEventListener('focus', refreshCatalogIfStale);
window.addEventListener('focus', refreshCatalogIfStale);
document.addEventListener('visibilitychange', () => {
  refreshCatalogIfStale();
  if (state.streams && state.selected && document.visibilityState === 'visible') loadHistory();
});
setInterval(() => {
  if (!state.streams || document.visibilityState !== 'visible') return;
  loadList(false, true);
  loadProjects();
  for (const [id, page] of state.projectPages) {
    const toggle = [...$('threads').querySelectorAll('.project-toggle[aria-expanded="true"]')]
      .find(button => button.dataset.historyFocus === 'project:' + id);
    if (toggle && !page.loading) loadProjectThreads(id, false, true);
  }
}, 15_000);
$('new-thread').onclick = $('empty-new').onclick = () => newThread();
$('more-threads').onclick = () => loadList(true);
$('more-turns').onclick = () => loadHistory(true);
$('send-form').onsubmit = event => { event.preventDefault(); sendMessage($('prompt').value); };
$('prompt').oninput = () => {
  if (state.selected) saveDraft(state.selected, { text: $('prompt').value });
};
$('confirm-send').onclick = () => {
  if (!state.selected || state.busy) return;
  saveDraft(state.selected, { unconfirmed: false });
  setError('send-error');
  updateComposer();
};
$('prompt').onkeydown = event => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing && !$('send').disabled) {
    event.preventDefault();
    $('send-form').requestSubmit();
  }
};
for (const setting of ['mode', 'model', 'effort', 'speed']) {
  $(setting).onchange = event => {
    state.preferences[setting] = event.target.value;
    if (setting === 'model') {
      delete state.preferences.effort;
      const found = state.meta.models.value?.find(model => model.model === event.target.value);
      state.preferences.speed = found?.defaultSpeed ?? 'default';
    }
    if (setting === 'mode') delete state.preferences.effort;
    updateComposer();
  };
}
$('stop').onclick = stopTurn;
$('account-button').onclick = () => { $('account-dialog').showModal(); loadAccount(); };
$('change-password').onclick = () => {
  $('account-dialog').close();
  $('password-dialog').showModal();
};
$('password-dialog').addEventListener('close', () => {
  $('password-form').reset();
  setError('password-error');
  $('password-status').textContent = '';
});
$('password-form').addEventListener('submit', async event => {
  event.preventDefault();
  const currentPassword = $('current-password').value;
  const newPassword = $('new-password').value;
  setError('password-error');
  $('password-status').textContent = '';
  if (newPassword !== $('confirm-password').value) {
    setError('password-error', new Error('两次输入的新密码不一致。'));
    $('confirm-password').focus();
    return;
  }
  $('save-password').disabled = true;
  try {
    await api('/api/password', { currentPassword, newPassword });
    $('password-form').reset();
    $('password-status').textContent = '网页密码已更新。当前浏览器保持登录。';
  } catch (error) {
    setError('password-error', error);
  } finally {
    $('save-password').disabled = false;
  }
});
$('logout').onclick = async () => {
  $('logout').disabled = true;
  try {
    await api('/api/logout', {});
    loginView();
  } catch (error) {
    setError('account-error', error);
  } finally {
    $('logout').disabled = false;
  }
};
$('reconnect').onclick = async () => {
  $('reconnect').disabled = true;
  try {
    const { state: next } = await api('/api/reconnect', {});
    connection(next);
    if (next === 'reconnecting') $('account-data').replaceChildren(node('p', '正在连接主机上的 Codex。', 'muted'));
    else setError('account-error');
  } catch (error) {
    setError('account-error', error);
  } finally {
    $('reconnect').disabled = false;
  }
};

api('/api/session').then(({ device }) => device ? consoleView() : loginView()).catch(error => {
  loginView();
  setError('login-error', error);
});
