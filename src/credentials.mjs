import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const derive = promisify(scrypt);

export function credentialsPath() {
  return process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, 'CodexBridge', 'login.json')
    : join(homedir(), '.codex-bridge', 'login.json');
}

function fromRecord(path, record) {
  if (record?.version !== 1 || typeof record.username !== 'string' ||
      !/^[a-zA-Z0-9_.-]{1,48}$/.test(record.username) ||
      typeof record.salt !== 'string' || !/^[a-f0-9]{32}$/.test(record.salt) ||
      typeof record.digest !== 'string' || !/^[a-f0-9]{64}$/.test(record.digest)) {
    throw new Error('网页登录配置无效。可用 --reset-login 生成新凭据。');
  }
  let active = record;
  return {
    username: record.username,
    async verify(username, password) {
      if (typeof username !== 'string' || username.length > 48 ||
          typeof password !== 'string' || password.length > 128) return false;
      const snapshot = active;
      const salt = Buffer.from(snapshot.salt, 'hex');
      const digest = Buffer.from(snapshot.digest, 'hex');
      const candidate = await derive(password, salt, digest.length);
      return active === snapshot && timingSafeEqual(candidate, digest) && username === snapshot.username;
    },
    async setPassword(password) {
      const next = await makeRecord(record.username, password);
      await writeRecord(path, next, true);
      active = next;
    },
  };
}

async function readExisting(path) {
  try {
    return fromRecord(path, JSON.parse(await readFile(path, 'utf8')));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    if (error instanceof SyntaxError) throw new Error('网页登录配置无效。可用 --reset-login 生成新凭据。');
    throw error;
  }
}

async function makeRecord(username, password) {
  const salt = randomBytes(16);
  return {
    version: 1,
    username,
    salt: salt.toString('hex'),
    digest: (await derive(password, salt, 32)).toString('hex'),
  };
}

async function writeRecord(path, record, replace) {
  const contents = JSON.stringify(record, null, 2) + '\n';
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  if (!replace) return writeFile(path, contents, { flag: 'wx', mode: 0o600 });
  const temp = path + '.' + randomBytes(8).toString('hex') + '.tmp';
  await writeFile(temp, contents, { flag: 'wx', mode: 0o600 });
  try { await rename(temp, path); } finally { await unlink(temp).catch(() => {}); }
}

export async function loadCredentials(path, { reset = false } = {}) {
  if (!reset) {
    const existing = await readExisting(path);
    if (existing) return { credentials: existing };
  }
  const password = randomBytes(15).toString('base64url');
  const record = await makeRecord('admin', password);
  try { await writeRecord(path, record, reset); } catch (error) {
    if (!reset && error.code === 'EEXIST') {
      const existing = await readExisting(path);
      if (existing) return { credentials: existing };
    }
    throw error;
  }
  return { credentials: fromRecord(path, record), initialPassword: password };
}
