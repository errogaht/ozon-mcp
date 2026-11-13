import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import metadata from '../package.json' with { type: 'json' };

export const appVersion = metadata.version;

export const projectRoot = fileURLToPath(new URL('../', import.meta.url));
export const expandHome = value => value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : path.resolve(value);
export const stateDir = () => expandHome(process.env.OZON_MCP_STATE_DIR ?? '~/.local/share/ozon-mcp');
export const socketPath = () => path.join(stateDir(), 'service.sock');

const schema = z.object({
  provider: z.object({ baseURL: z.url(), keyFile: z.string(), timeoutMs: z.number().int().min(1000).max(180000) }),
  models: z.object({ browserAgent: z.object({ model: z.string().min(1), reasoningEffort: z.enum(['none', 'low', 'medium', 'high', 'xhigh', 'max']) }), mediaAnalysis: z.object({ model: z.string().min(1), reasoningEffort: z.enum(['none', 'low', 'medium', 'high', 'xhigh', 'max']) }) }),
  browser: z.object({ executable: z.string(), profileDir: z.string(), connectionFile: z.string(), disableQuic: z.boolean(), viewportWidth: z.number().int().min(800).max(1920), viewportHeight: z.number().int().min(600).max(1440), navigationTimeoutMs: z.number().int().min(1000).max(60000) }),
  agent: z.object({ maxSteps: z.number().int().min(1).max(20), timeoutMs: z.number().int().min(1000).max(600000), snapshotMaxChars: z.number().int().min(1000).max(40000), defaultLimit: z.number().int().min(1).max(30), maxLimit: z.number().int().min(1).max(30) }),
  adapter: z.object({ maxSteps: z.number().int().min(2).max(40) }),
  consumer: z.object({ priceBasis: z.literal('ozon_card'), payment: z.enum(['ozon_installment', 'ozon_bank']), deliveryMethod: z.enum(['pickup', 'courier']), pickupPoint: z.string().max(500).nullable() })
});

/** Config is snapshotted per operation: editing the private overrides affects the
 * next request, never a running agent or its already-selected model. */
export async function loadSettings() {
  const defaults = JSON.parse(await fs.readFile(new URL('../config/defaults.json', import.meta.url), 'utf8'));
  const overridePath = expandHome(process.env.OZON_MCP_CONFIG ?? '~/.config/ozon-mcp/settings.json');
  let overrides = {};
  try { overrides = JSON.parse(await fs.readFile(overridePath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new AppError('invalid_config', 'Не удалось прочитать настройки MCP.'); }
  const merged = {};
  let preferences = {};
  try { preferences = JSON.parse(await fs.readFile(expandHome('~/.config/ozon-mcp/preferences.json'), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw new AppError('invalid_config', 'Не удалось прочитать предпочтения пользователя.'); }
  for (const key of ['provider', 'browser', 'agent', 'adapter', 'consumer']) merged[key] = { ...defaults[key], ...(key === 'consumer' ? preferences : {}), ...overrides[key] };
  merged.models = Object.fromEntries(['browserAgent', 'mediaAnalysis'].map(key => [key, { ...defaults.models[key], ...overrides.models?.[key] }]));
  const parsed = schema.safeParse(merged);
  if (!parsed.success) throw new AppError('invalid_config', 'Неверные настройки MCP: ' + parsed.error.issues.map(i => i.path.join('.')).join(', '));
  const cfg = parsed.data;
  cfg.provider.keyFile = expandHome(cfg.provider.keyFile);
  for (const k of ['profileDir', 'connectionFile']) cfg.browser[k] = expandHome(cfg.browser[k]);
  return cfg;
}

/** Only project-owned private directories are passed here; do not chmod the
 * owner's home or normal browser directories to store task artifacts. */
export async function privateDir(dir) {
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  await fs.chmod(dir, 0o700);
}

/** Atomic secret writes prevent a crash from truncating the only usable session. */
export async function writePrivateJSON(file, value) {
  await privateDir(path.dirname(file));
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await fs.rename(tmp, file);
  } finally { await fs.rm(tmp, { force: true }); }
}

export class AppError extends Error {
  constructor(code, message) { super(message); this.name = 'AppError'; this.code = code; }
}

/** Do not forward provider/browser error bodies: they may include headers,
 * auth tokens, account text, or echoed prompts. Known application errors are safe. */
export function publicError(error) {
  if (error instanceof AppError) return { code: error.code, message: error.message };
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError' || error?.name === 'APIConnectionTimeoutError') return { code: 'timeout', message: 'Истекло время ожидания. Браузерная сессия сохранена; можно повторить запрос.' };
  return { code: 'internal_error', message: 'Операция не завершена. Проверьте состояние MCP и браузера через status.' };
}
