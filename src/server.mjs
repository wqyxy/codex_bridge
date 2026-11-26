import { createServer } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { binding, Devices, expiredSessionCookie, HttpError } from './access.mjs';
import { AppServer, loopbackAppServerUrl, RpcError } from './rpc.mjs';
import { Bridge } from './bridge.mjs';
import { credentialsPath, loadCredentials } from './credentials.mjs';
import { resolveCodexExecutable } from './codex-executable.mjs';
import { DesktopSidebar } from './sidebar.mjs';

const assetNames = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/projects.js', ['projects.js', 'text/javascript; charset=utf-8']],
  ['/markdown.js', ['markdown.js', 'text/javascript; charset=utf-8']],
]);
const BODY_LIMIT = 192 * 1024;
const OP_LIFETIME = 10 * 60_000;

export function httpConsole({ bridge, devices, address }) {
  const listeners = new Set();
  const operations = new Map();
  const server = createServer((req, res) => {
    route(req, res).catch(error => {
      if (res.headersSent) { res.end(); return; }
      const status = error.status ?? (error instanceof RpcError ? (error.code === 'timeout' ? 504 : 409) : 502);
      json(res, status, { error: error.message || '无法连接 Codex。', code: error instanceof HttpError ? error.code : undefined });
    });
  });

  bridge.on('change', push);
  let heartbeat = setInterval(() => push(), 15_000).unref();
  server.on('close', () => {
    clearInterval(heartbeat);
    heartbeat = null;
    bridge.off('change', push);
  });

  function push(change) {
    for (const { req, res } of listeners) {
      if (!devices.get(req.headers.cookie)) {
        res.end('event: revoke\ndata: {}\n\n');
        continue;
      }
      if (res.writableLength > 64 * 1024) {
        res.destroy();
        continue;
      }
      res.write(change ? 'data: ' + JSON.stringify(change) + '\n\n' : ': heartbeat\n\n');
    }
  }

  function dedupe(device, action, body, run) {
    const operationId = id(body.operationId);
    const now = Date.now();
    for (const [key, record] of operations) {
      if (record.expires <= now) operations.delete(key);
    }
    const key = device.id + '/' + action + '/' + operationId;
    const existing = operations.get(key);
    if (existing) return existing.promise;
    if (operations.size >= 2048) throw new HttpError(429, '请求过于频繁，请稍后重试。');
    const record = { expires: Infinity, promise: undefined };
    record.promise = Promise.resolve().then(() => run(operationId))
      .finally(() => { record.expires = Date.now() + OP_LIFETIME; });
    operations.set(key, record);
    return record.promise;
  }

  async function route(req, res) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const port = server.address()?.port;
    const host = req.headers.host;
    if (!address.permits(req.socket.remoteAddress) ||
        !address.names.some(name => host === name + ':' + port || (port === 80 && host === name))) {
      throw new HttpError(403, '此地址无法访问控制台。');
    }
    if (!req.url?.startsWith('/') || req.url.startsWith('//')) throw new HttpError(400, '请求路径无效。');
    const origin = 'http://' + host;
    const { pathname, searchParams } = new URL(req.url, origin);
    if (req.method !== 'GET' && req.method !== 'POST') throw new HttpError(405, '请求方法不受支持。');

    const device = devices.get(req.headers.cookie);
    if (req.method === 'GET') {
      if (assetNames.has(pathname)) {
        const [file, type] = assetNames.get(pathname);
        const data = await readFile(new URL('../public/' + file, import.meta.url));
        res.writeHead(200, { 'Content-Type': type }).end(data);
        return;
      }
      if (pathname === '/api/session') return json(res, 200, { device: device ?? null });
      if (!device) throw new HttpError(401, '请先登录控制台。');
      if (pathname === '/api/events') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8', 'X-Accel-Buffering': 'no',
        });
        res.write('retry: 2000\ndata: {"scope":"reset"}\n\n');
        const stream = { req, res };
        listeners.add(stream);
        res.once('close', () => listeners.delete(stream));
        return;
      }
      const cursor = searchParams.get('cursor');
      if (cursor?.length > 4096) throw new HttpError(400, '历史游标无效。');
      const threadId = () => id(searchParams.get('id'));
      switch (pathname) {
        case '/api/projects': return json(res, 200, await bridge.projects());
        case '/api/threads': {
          const projectId = searchParams.get('project');
          return json(res, 200, await bridge.list(cursor, projectId == null ? undefined : id(projectId)));
        }
        case '/api/thread': return json(res, 200, await bridge.history(threadId(), cursor));
        case '/api/live': return json(res, 200, bridge.live(threadId()));
        case '/api/meta':
          return json(res, 200, await bridge.meta(Number(searchParams.get('directory')), searchParams.get('refresh') === '1'));
        case '/api/account': return json(res, 200, await bridge.account());
        default: throw new HttpError(404, '页面不存在。');
      }
    }

    if (req.headers.origin !== origin) throw new HttpError(403, '请求必须来自本控制台。');
    if (pathname !== '/api/login' && !device) throw new HttpError(401, '请先登录控制台。');
    const body = await jsonBody(req);
    if (pathname === '/api/login') {
      const cookie = await devices.login(body.username, body.password, body.name, req.socket.remoteAddress);
      if (device) devices.revoke(device.id);
      res.setHeader('Set-Cookie', cookie);
      return json(res, 200, { device: devices.get(cookie) });
    }
    // A device may have been revoked while its request body was arriving.
    if (!devices.get(req.headers.cookie)) throw new HttpError(401, '设备授权已撤销。');
    if (pathname === '/api/password') {
      await devices.changePassword(req.headers.cookie, body, req.socket.remoteAddress);
      push();
      return json(res, 200, { updated: true });
    }
    if (pathname === '/api/logout') {
      devices.revoke(device.id);
      res.setHeader('Set-Cookie', expiredSessionCookie);
      push();
      return json(res, 200, {});
    }
    let result;
    switch (pathname) {
      case '/api/thread':
        result = await dedupe(device, pathname, body, () => bridge.create(body.directory));
        break;
      case '/api/send':
        result = await dedupe(device, pathname, body, operationId => bridge.send({
          threadId: id(body.threadId),
          expectedTurnId: body.expectedTurnId == null ? null : id(body.expectedTurnId),
          text: body.text, settings: body.settings, operationId,
        }));
        break;
      case '/api/stop': result = await bridge.stop(id(body.threadId), id(body.turnId)); break;
      case '/api/read': result = await bridge.markRead(id(body.threadId), body.revision); break;
      case '/api/respond': result = await bridge.respond(id(body.id), body); break;
      case '/api/reconnect': result = bridge.reconnect(); break;
      default: throw new HttpError(404, '操作不存在。');
    }
    json(res, 200, result ?? {});
  }

  return {
    server,
    revoke(deviceId) {
      if (!devices.revoke(deviceId)) return false;
      push();
      return true;
    },
    closeStreams() {
      for (const { res } of listeners) res.end();
    },
  };
}

function id(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new HttpError(400, '标识无效。');
  return value;
}

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }).end(JSON.stringify(value));
}

async function jsonBody(req) {
  if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new HttpError(415, '需要 JSON 请求。');
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > BODY_LIMIT) {
      req.resume();
      throw new HttpError(413, '请求内容过大。');
    }
    chunks.push(chunk);
  }
  try {
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    return data;
  } catch {
    throw new HttpError(400, 'JSON 请求无效。');
  }
}

async function main() {
  const { values } = parseArgs({ options: {
    help: { type: 'boolean', short: 'h' },
    lan: { type: 'string' },
    port: { type: 'string', default: '8765' },
    cwd: { type: 'string', multiple: true },
    codex: { type: 'string' },
    'app-server-url': { type: 'string' },
    credentials: { type: 'string' },
    'reset-login': { type: 'boolean' },
  } });
  if (values.help) {
    console.log('node src/server.mjs [--lan <局域网 IPv4>] [--port 8765] [--cwd <目录>] [--codex <CLI 路径> | --app-server-url <ws://127.0.0.1:端口>] [--credentials <文件>] [--reset-login]');
    return;
  }

  const address = binding(values.lan);
  const port = Number(values.port);
  if (!/^\d+$/.test(values.port) || !Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口必须为 1–65535。');
  const paths = await Promise.all((values.cwd ?? [process.cwd()]).map(async path => {
    const directory = await realpath(resolve(path));
    if (!(await stat(directory)).isDirectory()) throw new Error('工作目录无效：' + directory);
    return directory;
  }));
  const directories = [...new Set(paths)];
  const codexHome = resolve(process.env.CODEX_HOME || join(homedir(), '.codex'));
  const authPath = join(codexHome, 'auth.json');
  if (values['app-server-url'] !== undefined && values.codex) {
    throw new Error('共享模式下由主机指定 App Server，请去掉 --codex。');
  }
  const target = values['app-server-url'] ?? (values.codex ? undefined : (process.env.CODEX_APP_SERVER_WS_URL || undefined));
  const sharedUrl = target === undefined ? undefined : loopbackAppServerUrl(target);
  const executable = sharedUrl ? undefined : await resolveCodexExecutable(values.codex);
  const { credentials, initialPassword } = await loadCredentials(
    values.credentials ? resolve(values.credentials) : credentialsPath(), { reset: values['reset-login'] },
  );
  const devices = new Devices(credentials);
  const bridge = new Bridge({
    directories, authPath: sharedUrl ? undefined : authPath, sidebar: new DesktopSidebar(codexHome),
    shared: Boolean(sharedUrl),
    connect: () => new AppServer({ url: sharedUrl, executable, cwd: directories[0] }),
  });
  const app = httpConsole({ bridge, devices, address });
  await bridge.start();
  await new Promise((done, fail) => {
    app.server.once('error', fail);
    app.server.listen(port, address.host, done);
  });
  console.log('Codex Bridge  http://' + address.host + ':' + port);
  console.log('Codex App Server  ' + (sharedUrl ?? executable));
  console.log('网页登录用户名  ' + credentials.username);
  if (initialPassword) console.log('网页登录密码  ' + initialPassword);
  console.log('主机命令  devices 查看设备  ·  revoke <编号> 撤销设备');
  const terminal = createInterface({ input: process.stdin });
  terminal.on('line', line => {
    const [command, deviceId] = line.trim().split(/\s+/);
    if (command === 'devices') {
      const list = devices.list();
      console.log(list.length ? list.map(device => device.id + '  ' + device.name).join('\n') : '暂无配对设备。');
    } else if (command === 'revoke') console.log(app.revoke(deviceId) ? '设备已撤销。' : '找不到该设备。');
  });
  let closing = false;
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, async () => {
      if (closing) return;
      closing = true;
      terminal.close();
      app.closeStreams();
      app.server.close();
      await bridge.close();
    });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
