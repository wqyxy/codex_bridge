import { execFile } from 'node:child_process';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';
import { HttpError } from './access.mjs';

const run = promisify(execFile);
// A legacy Codex rollout keeps its Windows write handle open. A read-only
// handle that denies sharing for writers detects it without altering the file.
const probe = [
  'try {',
  '  $share = [IO.FileShare]::Read -bor [IO.FileShare]::Delete',
  '  $stream = [IO.File]::Open($env:CODEX_BRIDGE_ROLLOUT, "Open", "Read", $share)',
  '  $stream.Dispose()',
  '  "0"',
  '} catch {',
  '  $_.Exception.GetBaseException().HResult -band 65535',
  '}',
].join('\n');

export async function legacyWriterPresent(path) {
  if (process.platform !== 'win32' || !path) return false;
  if (!isAbsolute(path)) throw new HttpError(409, 'Codex 返回的旧版会话路径无效。');
  const executable = join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  try {
    const { stdout } = await run(executable, ['-NoProfile', '-NonInteractive', '-Command', probe], {
      env: { ...process.env, CODEX_BRIDGE_ROLLOUT: path }, timeout: 5_000, windowsHide: true,
    });
    const result = stdout.trim();
    if (result === '0') return false;
    if (result === '32' || result === '33') return true;
  } catch (error) {
    process.stderr.write('旧版会话写入状态检查失败：' + error.message + '\n');
  }
  throw new HttpError(409, '无法确认旧版会话的写入状态。请关闭原客户端中的会话后重试。');
}
