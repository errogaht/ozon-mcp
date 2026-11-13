import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { z } from 'zod';
import { AppError, loadSettings, privateDir, stateDir, socketPath, writePrivateJSON, publicError, appVersion } from './config.js';
import { OzonBrowser } from './browser.js';
import { ConsumerWorkflows } from './workflows.js';
import { consumerInputs, searchInput, productInput } from './contracts.js';

export const rpcSchemas = {
  status: z.object({}).strict(),
  auth_open: z.object({}).strict(),
  auth_save: z.object({}).strict(),
  search: searchInput,
  product: productInput,
  ...consumerInputs
};

/** One queue covers a WHOLE search, not only individual page actions. Multiple
 * MCP/CLI clients therefore cannot mix tabs, snapshots, or evidence ledgers. */
export function serialQueue() {
  let tail = Promise.resolve();
  return operation => { const current = tail.then(operation); tail = current.catch(() => {}); return current; };
}

export async function runService() {
  await privateDir(stateDir());
  const browser = new OzonBrowser(); const workflows = new ConsumerWorkflows(browser); const enqueue = serialQueue();
  const server = http.createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    if (request.method === 'GET' && request.url === '/health') { response.end(JSON.stringify({ service: 'ozon-consumer-mcp', version: appVersion, pid: process.pid })); return; }
    if (request.method !== 'POST' || request.url !== '/rpc') { response.writeHead(404).end('{}'); return; }
    let body = ''; let size = 0;
    try {
      for await (const chunk of request) { size += chunk.length; if (size > 100000) throw new AppError('invalid_request', 'Слишком большой запрос.'); body += chunk; }
      const payload = JSON.parse(body); const schema = rpcSchemas[payload.method];
      if (!schema) throw new AppError('invalid_request', 'Неизвестный метод MCP.');
      const parsed = schema.safeParse(payload.args ?? {});
      if (!parsed.success) throw new AppError('invalid_request', 'Неверные параметры MCP.');
      const value = await enqueue(async () => {
        const cfg = await loadSettings();
        workflows.startOperation(cfg);
        if (payload.method === 'status') return browser.status(cfg);
        if (payload.method === 'auth_open') return browser.openAuth(cfg);
        if (payload.method === 'auth_save') return browser.saveAuth(cfg);
        if (payload.method === 'search') return workflows.search(parsed.data, cfg);
        if (payload.method === 'product') return workflows.product(parsed.data, cfg);
        if (['product_variants', 'product_variant_select'].includes(payload.method)) return workflows.variants(parsed.data, cfg);
        if (payload.method === 'search_filters') return workflows.filters(parsed.data, cfg);
        if (['product_media', 'review_media'].includes(payload.method)) return workflows.gallery(parsed.data, cfg);
        if (payload.method === 'media_get') return workflows.getMedia(parsed.data, cfg);
        if (payload.method === 'media_import') return workflows.media.importFile(parsed.data.path);
        if (['reviews', 'questions'].includes(payload.method)) return workflows.list(payload.method, parsed.data, cfg);
        if (payload.method === 'orders') return workflows.orders(parsed.data, cfg);
        if (payload.method === 'order_detail') return workflows.orderDetail(parsed.data, cfg);
        if (payload.method === 'collections') return workflows.collections(parsed.data, cfg);
        if (payload.method === 'cart') return workflows.cart(parsed.data, cfg);
        if (['collection_create', 'favorite', 'cart_add'].includes(payload.method)) return workflows.reversible(payload.method, parsed.data, cfg);
        if (payload.method.endsWith('_prepare')) return workflows.prepareAction(payload.method.replace('_prepare', ''), parsed.data, cfg);
        if (payload.method === 'action_confirm') return workflows.confirmAction(parsed.data, cfg);
        if (payload.method === 'action_status') return workflows.confirmations.status(parsed.data.token);
        throw new AppError('invalid_request', 'Неизвестная операция MCP.');
      });
      response.end(JSON.stringify({ ok: true, result: value }));
    } catch (error) { response.end(JSON.stringify({ ok: false, error: publicError(error) })); }
  });
  // The service exposes no TCP port; the private Unix socket is inaccessible to
  // web pages and other system users. No model key or cookies cross the RPC.
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath(), resolve); });
  await fs.chmod(socketPath(), 0o600);
  await writePrivateJSON(path.join(stateDir(), 'service.json'), { pid: process.pid, startedAt: new Date().toISOString() });
  const stop = () => {
    server.close();
    // Deliberately do not browser.close(): Chrome owns the persistent session
    // and must remain visible/usable after this service or any MCP client exits.
    process.exit(0);
  };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}

export function socketRequest(route, payload, timeoutMs = 610000) {
  return new Promise((resolve, reject) => {
    const request = http.request({ socketPath: socketPath(), path: route, method: payload ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' } }, response => {
      let data = ''; response.on('data', chunk => { data += chunk; if (data.length > 48 * 1024 * 1024) request.destroy(new AppError('oversized_response', 'Слишком большой ответ сервиса.')); });
      response.on('end', () => { try { resolve(JSON.parse(data)); } catch { reject(new AppError('service_unavailable', 'Неверный ответ локального сервиса.')); } });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new AppError('timeout', 'Локальный сервис не ответил вовремя.')));
    request.on('error', reject); if (payload) request.write(JSON.stringify(payload)); request.end();
  });
}

/** Startup lock protects socket creation across concurrent MCP clients. Stale
 * sockets are removed only after proving they refuse connections; no live
 * service or browser is killed to acquire ownership. */
export async function ensureService() {
  try { const h = await socketRequest('/health', null, 1000); if (h.service === 'ozon-consumer-mcp') return; throw new AppError('service_conflict', 'Сокет занят другим сервисом.'); }
  catch (error) { if (error instanceof AppError) throw error; if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error; }
  await privateDir(stateDir());
  const lock = path.join(stateDir(), 'service-start.lock');
  let acquired = false;
  for (let i = 0; i < 100 && !acquired; i++) {
    try { await fs.mkdir(lock, { mode: 0o700 }); acquired = true; await writePrivateJSON(path.join(lock, 'owner.json'), { pid: process.pid }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let owner; try { owner = JSON.parse(await fs.readFile(path.join(lock, 'owner.json'), 'utf8')); } catch { /* Allow the lock creator to finish writing. */ }
      if (owner) { try { process.kill(owner.pid, 0); } catch (e) { if (e.code === 'ESRCH') await fs.rm(lock, { recursive: true, force: true }); } }
      await new Promise(r => setTimeout(r, 100));
      try { if ((await socketRequest('/health', null, 500)).service === 'ozon-consumer-mcp') return; } catch { /* Startup still in progress. */ }
    }
  }
  if (!acquired) throw new AppError('service_busy', 'Локальный сервис запускается. Повторите запрос через несколько секунд.');
  try {
    try { if ((await socketRequest('/health', null, 1000)).service === 'ozon-consumer-mcp') return; }
    catch (error) { if (!['ENOENT', 'ECONNREFUSED'].includes(error.code)) throw error; await fs.rm(socketPath(), { force: true }); }
    const log = await fs.open(path.join(stateDir(), 'service.log'), 'a', 0o600);
    const child = spawn(process.execPath, [fileURLToPath(new URL('./cli.js', import.meta.url)), 'service'], { detached: true, stdio: ['ignore', log.fd, log.fd], env: process.env });
    let failed = false; child.once('error', () => { failed = true; }); child.unref(); await log.close();
    for (let i = 0; i < 100 && !failed; i++) {
      await new Promise(r => setTimeout(r, 100));
      try { if ((await socketRequest('/health', null, 500)).service === 'ozon-consumer-mcp') return; } catch { /* Wait for module loading and socket creation. */ }
    }
    throw new AppError('service_unavailable', 'Не удалось запустить локальный сервис MCP.');
  } finally { await fs.rm(lock, { recursive: true, force: true }); }
}

export async function callService(method, args = {}) {
  await ensureService(); const reply = await socketRequest('/rpc', { method, args });
  if (!reply.ok) throw new AppError(reply.error?.code ?? 'service_error', reply.error?.message ?? 'Ошибка локального сервиса.');
  return reply.result;
}
