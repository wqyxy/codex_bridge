export function projectPath(path) {
  if (typeof path !== 'string' || !path) return '';
  const normalized = path.replace(/\\/g, '/').replace(/\/+$/, '') || '/';
  return /^(?:[a-z]:|\/\/)/i.test(normalized) ? normalized.toLowerCase() : normalized;
}

export function groupProjects(projects, threads) {
  const registered = projects.map(project => ({
    key: 'project:' + project.id,
    id: project.id,
    nativeId: project.nativeId,
    name: project.name,
    path: project.roots[0] ?? '',
    roots: project.roots,
    threads: [],
  }));
  const byId = new Map(registered.map(group => [group.id, group]));
  for (const group of registered) {
    if (group.nativeId && !byId.has(group.nativeId)) byId.set(group.nativeId, group);
  }
  const roots = registered.flatMap(group => group.roots
    .filter(Boolean).map(path => [projectPath(path), group]))
    .sort(([a], [b]) => b.length - a.length);
  const inferred = new Map();
  for (const thread of threads) {
    const directory = projectPath(thread.cwd);
    const known = byId.get(thread.projectId) ?? roots.find(([path]) => (
      directory === path || directory.startsWith(path.endsWith('/') ? path : path + '/')
    ))?.[1];
    if (known) {
      known.threads.push(thread);
      continue;
    }
    const key = directory ? 'path:' + directory : 'other';
    if (!inferred.has(key)) {
      const path = thread.cwd ?? '';
      const name = directory ? (path.replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) || path) : '未分组会话';
      inferred.set(key, { key, name, path, roots: [path], threads: [] });
    }
    inferred.get(key).threads.push(thread);
  }
  return [...registered, ...inferred.values()];
}
