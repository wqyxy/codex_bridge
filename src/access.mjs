import { randomBytes } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { isIPv4 } from 'node:net';

const COOKIE = 'codex_bridge_session';
const ATTEMPT_WINDOW = 60_000;
const MAX_ATTEMPTS = 8;
const DEVICE_MAX_AGE = 30 * 24 * 60 * 60;

export class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export class Devices {
  #sessions = new Map();
  #attempts = new Map();
  #checking = 0;
  #changingPassword = false;

  constructor(credentials) {
    this.credentials = credentials;
  }

  async login(username, password, name, address) {
    this.#checkPasswordChange();
    if (!await this.#verify(username, password, address)) throw new HttpError(401, '用户名或密码不正确。');
    this.#checkPasswordChange();
    const token = randomBytes(32).toString('base64url');
    const id = randomBytes(8).toString('hex');
    this.#sessions.set(token, {
      id,
      name: typeof name === 'string' ? name.trim().replace(/[\x00-\x1f\x7f]/g, '').slice(0, 48) || '浏览器' : '浏览器',
      loggedInAt: Date.now(),
    });
    return COOKIE + '=' + token + '; Path=/; HttpOnly; SameSite=Strict; Max-Age=' + DEVICE_MAX_AGE;
  }

  async changePassword(cookie, { currentPassword, newPassword }, address) {
    this.#checkPasswordChange();
    if (typeof newPassword !== 'string' || newPassword.length > 128 || Array.from(newPassword).length < 12 ||
        !newPassword.trim() || /[\r\n\x00]/.test(newPassword)) {
      throw new HttpError(400, '新密码需为 12 至 128 个字符。');
    }
    this.#changingPassword = true;
    try {
      if (!await this.#verify(this.credentials.username, currentPassword, address)) {
        throw new HttpError(403, '当前密码不正确。');
      }
      if (currentPassword === newPassword) throw new HttpError(400, '请使用和当前密码不同的新密码。');
      const device = this.get(cookie);
      if (!device) throw new HttpError(401, '设备授权已撤销。');
      try { await this.credentials.setPassword(newPassword); } catch (error) {
        console.error('无法保存网页密码摘要：' + error.message);
        throw new HttpError(500, '暂时无法保存新密码。');
      }
      for (const [token, session] of this.#sessions) {
        if (session.id !== device.id) this.#sessions.delete(token);
      }
    } finally {
      this.#changingPassword = false;
    }
  }

  #checkPasswordChange() {
    if (this.#changingPassword) throw new HttpError(409, '正在更新网页密码，请稍后重试。');
  }

  async #verify(username, password, address) {
    const now = Date.now();
    for (const [key, attempts] of this.#attempts) {
      if (now >= attempts.until) this.#attempts.delete(key);
    }
    const attempts = this.#attempts.get(address) ?? { until: now + ATTEMPT_WINDOW, count: 0 };
    if (attempts.count >= MAX_ATTEMPTS || this.#checking >= 8 || this.#attempts.size >= 1024) {
      throw new HttpError(429, '密码验证尝试过多，请稍后重试。');
    }
    attempts.count++;
    this.#attempts.set(address, attempts);
    this.#checking++;
    try {
      const verified = await this.credentials.verify(username, password);
      if (verified) this.#attempts.delete(address);
      return verified;
    } finally {
      this.#checking--;
    }
  }

  get(cookie) {
    const token = cookie?.match(/(?:^|;\s*)codex_bridge_session=([A-Za-z0-9_-]{43})(?:;|$)/)?.[1];
    const device = this.#sessions.get(token);
    if (device && Date.now() - device.loggedInAt >= DEVICE_MAX_AGE * 1000) {
      this.#sessions.delete(token);
      return undefined;
    }
    return device;
  }

  list() {
    return [...this.#sessions.values()];
  }

  revoke(id) {
    for (const [token, device] of this.#sessions) {
      if (device.id === id) return this.#sessions.delete(token);
    }
    return false;
  }
}

export const expiredSessionCookie = COOKIE + '=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0';

function asNumber(ip) {
  return ip.split('.').reduce((value, part) => (value << 8) | Number(part), 0);
}

export function binding(lan, interfaces = networkInterfaces()) {
  if (!lan) return { host: '127.0.0.1', names: ['127.0.0.1', 'localhost'], permits: address => address === '127.0.0.1' };
  const local = Object.values(interfaces).flat().find(item => item.family === 'IPv4' && item.address === lan && !item.internal);
  if (!isIPv4(lan) || !local || !/^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(lan)) {
    throw new Error('--lan 需要本机已分配的私有局域网 IPv4 地址。');
  }
  const mask = asNumber(local.netmask);
  return {
    host: lan,
    names: [lan],
    permits: address => Boolean(isIPv4(address) && (asNumber(address) & mask) === (asNumber(lan) & mask)),
  };
}
