const OUTPUT_LIMIT = 32_000;
const visibleItems = new Set(['userMessage', 'agentMessage', 'plan', 'commandExecution', 'fileChange']);

export function threadSummary(thread) {
  const { id, name, preview, cwd, projectId, forkedFromId, status, updatedAt, model, reasoningEffort, historyMode, canAcceptDirectInput } = thread;
  return { id, name, preview, cwd, projectId, forkedFromId, status, updatedAt, model, reasoningEffort, historyMode, canAcceptDirectInput };
}

export function turnSummary(turn) {
  const { id, status, startedAt, completedAt, error, items } = turn;
  return {
    id, status, startedAt, completedAt, error: error?.message,
    items: (items ?? []).filter(item => visibleItems.has(item.type)).map(projectItem),
  };
}

function projectItem(item) {
  const { id, type, status } = item;
  if (type === 'userMessage') {
    const text = item.content?.map(part => part.type === 'text' ? part.text : '〔' + part.type + '〕').join('\n');
    return { id, type, text };
  }
  if (type === 'agentMessage' || type === 'plan') return { id, type, text: item.text ?? '' };
  if (type === 'commandExecution') {
    const { command, cwd, aggregatedOutput, exitCode } = item;
    return { id, type, status, command, cwd, exitCode, output: limitOutput(aggregatedOutput ?? '') };
  }
  return { id, type, status, changes: (item.changes ?? []).map(projectChange) };
}

function projectChange(change) {
  return { path: change.path, kind: change.kind?.type, diff: limitOutput(change.diff ?? '') };
}

function limitOutput(text) {
  return text.length > OUTPUT_LIMIT ? '〔较早输出已截断〕\n' + text.slice(-OUTPUT_LIMIT) : text;
}

const deltas = {
  'item/agentMessage/delta': ['agentMessage', 'text'],
  'item/plan/delta': ['plan', 'text'],
  'item/commandExecution/outputDelta': ['commandExecution', 'output'],
  'item/fileChange/outputDelta': ['fileChange', 'output'],
};

export function updateTurn(turn, method, p) {
  if (method === 'turn/plan/updated') {
    turn.plan = p.plan;
    turn.explanation = p.explanation;
  } else if (method === 'turn/diff/updated') {
    turn.diff = limitOutput(p.diff);
  } else if (method === 'error') {
    turn.error = p.error?.message;
  } else if (p.item && visibleItems.has(p.item.type)) {
    const previous = turn.items.find(item => item.id === p.item.id);
    const next = projectItem(p.item);
    if (previous?.output && !next.output) next.output = previous.output;
    upsertItem(turn, next);
  } else if (method === 'item/fileChange/patchUpdated') {
    const previous = turn.items.find(item => item.id === p.itemId);
    upsertItem(turn, { ...previous, id: p.itemId, type: 'fileChange', changes: p.changes?.map(projectChange) });
  } else if (Object.hasOwn(deltas, method)) {
    const [type, field] = deltas[method];
    const previous = turn.items.find(item => item.id === p.itemId);
    const value = (previous?.[field] ?? '') + p.delta;
    upsertItem(turn, { ...previous, id: p.itemId, type, [field]: field === 'output' ? limitOutput(value) : value });
  }
}

function upsertItem(turn, item) {
  const index = turn.items.findIndex(current => current.id === item.id);
  if (index < 0) turn.items.push(item);
  else turn.items[index] = item;
}

export function mergeTurn(previous, update) {
  if (!previous || previous.id !== update.id) return update;
  const items = [...previous.items];
  const turn = { ...previous, ...update, items };
  for (const item of update.items) upsertItem(turn, { ...items.find(current => current.id === item.id), ...item });
  return turn;
}
