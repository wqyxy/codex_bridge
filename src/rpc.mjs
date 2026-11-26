import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';

export class RpcError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

export function loopbackAppServerUrl(value) {
  const match = /^ws:\/\/(127\.0\.0\.1|\[::1\]):([1-9]\d{0,4})\/?$/.exec(value);
  if (!match || match[0] !== value || Number(match[2]) > 65535) {
    throw new Error('共享 App Server 地址必须是带端口的 ws://127.0.0.1 或 ws://[::1]。');
  }
  return value;
}

export class AppServer extends EventEmitter {
  #pending = new Map();
  #next = 1;
  #child;
  #socket;
  #socketReady;
  #closed;
  #done;

  constructor({ executable = 'codex', cwd, args = ['app-server', '--listen', 'stdio://'], env, url } = {}) {
    super();
    if (url) {
      const socket = this.#socket = new WebSocket(loopbackAppServerUrl(url));
      this.#socketReady = new Promise(resolve => {
        for (const event of ['open', 'error', 'close']) socket.addEventListener(event, resolve, { once: true });
      });
      socket.addEventListener('message', event => this.#receive(event.data));
      socket.addEventListener('error', () => {
        this.#fail(new Error('无法连接共享 Codex App Server，请检查主机上的 WebSocket 服务。'));
      });
      socket.addEventListener('close', () => {
        this.#fail(new Error('共享 Codex App Server 已断开连接。'));
      });
      return;
    }
    const child = this.#child = spawn(executable, args, {
      cwd, env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.#done = new Promise(resolve => child.once('close', resolve));
    child.once('error', error => this.#fail(error));
    child.once('close', (code, signal) => {
      this.#fail(new Error('Codex App Server 已退出（' + (signal ?? code) + '）'));
    });
    child.stdin.on('error', error => this.#fail(error));
    // Keep upstream diagnostics in the host terminal.
    child.stderr.pipe(process.stderr, { end: false });
    const reader = createInterface({ input: child.stdout, crlfDelay: Infinity });
    reader.on('line', line => this.#receive(line));
  }

  async initialize() {
    await this.call('initialize', {
      clientInfo: { name: 'codex_bridge', title: 'Codex Bridge', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    }, 20_000);
    await this.#send({ method: 'initialized' });
  }

  call(method, params, timeout = 45_000) {
    if (this.#closed) return Promise.reject(this.#closed);
    const id = this.#next++;
    return new Promise((resolve, reject) => {
      const settle = (error, result) => {
        if (!this.#pending.delete(id)) return;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(result);
      };
      const timer = setTimeout(() => settle(new RpcError(method + ' 等待 Codex 响应超时', 'timeout')), timeout);
      this.#pending.set(id, settle);
      this.#send({ id, method, params }).catch(error => settle(error));
    });
  }

  respond(id, result) {
    return this.#send({ id, result });
  }

  reject(id, message) {
    return this.#send({ id, error: { code: -32601, message } });
  }

  async close() {
    if (this.#socket) {
      this.#fail(new Error('已关闭与共享 Codex App Server 的连接。'));
      this.#socket.close();
      return;
    }
    this.#child.stdin.end();
    const timer = setTimeout(() => this.#child.kill(), 2_000);
    try { await this.#done; } finally { clearTimeout(timer); }
  }

  async #send(value) {
    if (this.#socket) await this.#socketReady;
    if (this.#closed) throw this.#closed;
    const payload = JSON.stringify(value);
    if (this.#socket) {
      this.#socket.send(payload);
      return;
    }
    return new Promise((resolve, reject) => {
      this.#child.stdin.write(payload + '\n', error => error ? reject(error) : resolve());
    });
  }

  #receive(line) {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (!message || typeof message !== 'object') return;
    if (message.method) {
      if (message.id != null) this.emit('request', message);
      else this.emit('notification', message);
      return;
    }
    const settle = this.#pending.get(message.id);
    if (!settle) return;
    if (message.error) settle(new RpcError(message.error.message, message.error.code));
    else settle(null, message.result);
  }

  #fail(error) {
    if (this.#closed) return;
    this.#closed = error;
    for (const settle of this.#pending.values()) settle(error);
    this.emit('closed', error);
  }
}
