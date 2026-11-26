import { HttpError } from './access.mjs';

const choices = {
  accept: '允许这一次',
  acceptForSession: '允许本次会话',
  decline: '拒绝',
  cancel: '取消',
  approved: '允许这一次',
  approved_for_session: '允许本次会话',
  denied: '拒绝',
  abort: '取消',
  acceptWithExecpolicyAmendment: '允许并记住命令规则',
  applyNetworkPolicyAmendment: '应用网络规则',
};

export function presentRequest(method, p, item) {
  const context = {
    reason: p.reason,
    command: Array.isArray(p.command) ? p.command.join(' ') : p.command ?? item?.command,
    cwd: p.cwd,
    changes: p.fileChanges ?? item?.changes,
    grantRoot: p.grantRoot,
    network: p.networkApprovalContext,
    permissions: p.permissions ?? p.additionalPermissions,
  };

  switch (method) {
    case 'item/tool/requestUserInput':
      return { type: 'questions', questions: p.questions, isBlocking: p.isBlocking };
    case 'item/commandExecution/requestApproval': {
      const decisions = p.availableDecisions ?? ['accept', 'acceptForSession', 'decline', 'cancel'];
      return approval('命令审批', context, decisions.map(decision => {
        const name = typeof decision === 'string' ? decision : Object.keys(decision)[0];
        return [decision, choices[name] ?? '应用 Codex 提议', typeof decision === 'object' && decision];
      }));
    }
    case 'item/fileChange/requestApproval':
      return approval('文件改动审批', context, ['accept', 'acceptForSession', 'decline', 'cancel'].map(value => [value, choices[value]]));
    case 'item/permissions/requestApproval': {
      const permissions = Object.fromEntries(Object.entries(p.permissions ?? {}).filter(([, value]) => value != null));
      return approval('权限审批', context, [
        [{ permissions, scope: 'turn' }, '允许此轮'],
        [{ permissions, scope: 'session' }, '允许本次会话'],
        [{ permissions: {}, scope: 'turn' }, '拒绝'],
      ], value => value);
    }
    case 'execCommandApproval':
    case 'applyPatchApproval':
      return approval('操作审批', context, [
        ['approved', choices.approved],
        ['approved_for_session', choices.approved_for_session],
        [{ denied: { rejection: '' } }, choices.denied],
        ['abort', choices.abort],
      ]);
    default:
      return null;
  }
}

function approval(title, context, options, encode = decision => ({ decision })) {
  return {
    type: 'approval', title, context,
    choices: options.map(([, label, detail]) => ({ label, detail: detail || undefined })),
    responses: options.map(([value]) => encode(value)),
  };
}

export function requestResponse(request, input) {
  const invalid = () => new HttpError(400, '请提供该请求支持的选项。');
  if (request.type === 'approval') {
    if (!Number.isInteger(input.choice) || !request.responses[input.choice]) throw invalid();
    return request.responses[input.choice];
  }
  if (input.cancel === true) return { answers: {} };

  const answers = [];
  for (const question of request.questions) {
    const value = input.answers?.[question.id];
    if (typeof value !== 'string' || !value.trim() || value.length > 4000) throw invalid();
    const matches = question.options?.some(option => option.label === value);
    if (question.options?.length && !question.isOther && !matches) throw invalid();
    answers.push([question.id, { answers: [value] }]);
  }
  return { answers: Object.fromEntries(answers) };
}
