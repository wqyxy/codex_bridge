import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const desktopProjectPrefix = 'codex:project:';
const desktopThreadPrefix = 'codex:thread:local:';
const validId = id => typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id);
const ids = values => Array.isArray(values) ? values.filter(validId) : [];
const orderedKeys = (values, prefix) => Array.isArray(values)
  ? values.filter(value => typeof value === 'string' && value.startsWith(prefix)).map(value => value.slice(prefix.length)).filter(validId)
  : [];

export class DesktopSidebar {
  #snapshot;
  #expires = 0;

  constructor(codexHome) {
    this.codexHome = codexHome;
  }

  read() {
    if (Date.now() < this.#expires) return this.#snapshot;
    this.#expires = Date.now() + 1_000;
    try {
      const db = new DatabaseSync(join(this.codexHome, '.codex-global-state.sqlite'), { readOnly: true });
      try {
        db.exec('BEGIN');
        const query = db.prepare('SELECT value FROM settings WHERE scope = ? AND key = ?');
        const get = (key, scope = 'global') => {
          const { value } = query.get(scope, key) ?? {};
          return typeof value === 'string' ? JSON.parse(value) : undefined;
        };
        this.#snapshot = this.#layout(get);
      } finally { db.close(); }
    } catch {
      if (this.#snapshot) return this.#snapshot;
      try {
        const legacy = JSON.parse(readFileSync(join(this.codexHome, '.codex-global-state.json'), 'utf8'));
        this.#snapshot = this.#layout((key, scope) => scope ? legacy[scope]?.[key] : legacy[key]);
      } catch {}
    }
    return this.#snapshot;
  }

  #layout(get) {
    const registry = get('local-projects');
    if (!registry || typeof registry !== 'object') return undefined;
    const owner = get('electron-renderer-content-owner');
    const scope = typeof owner === 'string' && /^[a-f0-9]{64}$/i.test(owner) ? 'electron-owner-atoms:' + owner : null;
    const orders = get('app-server-project-id-by-legacy-project-id-by-host');
    const normalize = value => process.platform === 'win32' ? value.replaceAll('/', '\\').toLowerCase() : value;
    const host = Object.keys(orders ?? {}).find(key => normalize(key) === normalize('local:' + this.codexHome));
    const aliases = host ? orders[host] : {};
    const projects = new Map();
    const aliasesToProject = new Map();
    for (const record of Object.values(registry)) {
      if (!validId(record?.id) || typeof record.name !== 'string' || !Array.isArray(record.rootPaths)) continue;
      const nativeId = validId(aliases?.[record.id]) ? aliases[record.id] : record.id;
      const roots = record.rootPaths.filter(root => typeof root === 'string' && root.length);
      projects.set(record.id, { id: record.id, nativeId, name: record.name, roots });
      aliasesToProject.set(nativeId, record.id);
    }

    const pinnedIds = new Set(ids(get('pinned-project-ids')));
    const pinnedProjects = [...projects.keys()].filter(id => pinnedIds.has(id));
    const baseOrder = ids(get('project-order'));
    const desktopOrder = scope ? orderedKeys(get('unified-sidebar-project-order-v1', scope), desktopProjectPrefix) : [];
    const desktopSet = new Set(desktopOrder);
    const regular = new Set([...baseOrder.filter(id => !desktopSet.has(id)), ...desktopOrder, ...projects.keys()]);
    const projectOrder = [...regular].filter(id => projects.has(id) && !pinnedIds.has(id));
    const pinnedOrder = scope ? get('unified-sidebar-pinned-order-v1', scope) : null;
    const assignments = get('thread-project-assignments');
    const assignedProject = thread => {
      const local = assignments?.[thread.id];
      if (local?.projectKind === 'local' && projects.has(local.projectId)) return local.projectId;
      return aliasesToProject.get(thread.projectId) ?? thread.projectId;
    };
    const legacyProjectThreads = projectId => Object.entries(assignments ?? {})
      .filter(([id, entry]) => validId(id) && entry?.projectKind === 'local' && entry.projectId === projectId)
      .map(([id]) => id).sort().reverse();

    return {
      projects, pinnedProjects, projectOrder, pinnedOrder, assignedProject, legacyProjectThreads,
      legacyPinnedThreads: ids(get('pinned-thread-ids')),
    };
  }
}

export function orderSidebarPins(layout, threads) {
  const pinned = new Map();
  for (const thread of threads) {
    pinned.set(desktopThreadPrefix + thread.id, { type: 'thread', thread });
  }
  for (const projectId of layout?.pinnedProjects ?? []) {
    pinned.set(desktopProjectPrefix + projectId, { type: 'project', projectId });
  }
  const order = Array.isArray(layout?.pinnedOrder) ? layout.pinnedOrder : [];
  const keys = new Set([...order, ...pinned.keys()]);
  return [...keys].filter(key => pinned.has(key)).map(key => pinned.get(key));
}
