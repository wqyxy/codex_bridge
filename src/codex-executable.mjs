import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function isFile(path) {
  if (!path || !isAbsolute(path)) return false;
  try { return (await stat(path)).isFile(); } catch { return false; }
}

async function installedWindowsDesktop(env) {
  const powershell = join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = [
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
    'Get-AppxPackage -Name OpenAI.Codex | Select-Object -First 1 -ExpandProperty InstallLocation',
  ].join('\n');
  try {
    const { stdout } = await execFileAsync(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], {
      env, windowsHide: true, timeout: 4_000,
    });
    const location = stdout.trim();
    if (isAbsolute(location)) return join(location, 'app', 'resources', 'codex.exe');
  } catch {
    // Continue with the PATH installation when no registered desktop runtime is available.
  }
}

export async function resolveCodexExecutable(override, env = process.env) {
  if (override) return override;
  if (await isFile(env.CODEX_APP_RUNTIME_CLI_PATH)) return env.CODEX_APP_RUNTIME_CLI_PATH;
  if (process.platform === 'win32') {
    const desktop = await installedWindowsDesktop(env);
    if (await isFile(desktop)) return desktop;
  }
  return 'codex';
}
