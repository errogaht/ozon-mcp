#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { callService, runService, socketRequest } from './service.js';
import { serveMcp } from './server.js';
import { loadSettings, stateDir, privateDir, writePrivateJSON, publicError, AppError } from './config.js';
import { providerClient, modelResponse } from './agent.js';

/** CLI and MCP share the same broker and profile. Credentials are never accepted
 * as CLI arguments, avoiding shell history and process-list disclosure. */
async function main() {
  const [command = 'serve', ...rest] = process.argv.slice(2);
  if (command === 'serve') return serveMcp();
  if (command === 'service') return runService();
  let result;
  if (command === 'status') result = await callService('status');
  else if (command === 'login') result = await callService('auth_open');
  else if (command === 'auth-save') result = await callService('auth_save');
  else if (command === 'search') {
    if (!rest.length) throw new AppError('query_missing', 'Пример: node src/cli.js search "мобильные кондиционеры до 30000 руб"');
    result = await callService('search', { query: rest.join(' ') });
  } else if (command === 'product') result = await callService('product', { url: rest[0] ?? '' });
  else if (command === 'rpc') {
    // The structured CLI exercises the exact same validated broker methods as
    // MCP. It is not a raw browser, network or secret-access escape hatch.
    if (!rest[0]) throw new AppError('method_missing', 'Укажите метод и JSON-параметры.');
    let args; try { args = JSON.parse(rest[1] ?? '{}'); } catch { throw new AppError('invalid_request', 'Параметры должны быть JSON-объектом.'); }
    result = await callService(rest[0], args);
  }
  else if (command === 'probe') {
    const cfg = await loadSettings(); const client = await providerClient(cfg); const model = cfg.models.browserAgent;
    const response = await modelResponse(client, { model: model.model, reasoning: { effort: model.reasoningEffort }, instructions: 'Reply briefly.', input: [{ role: 'user', content: 'Ответь одним словом: работает' }] }, AbortSignal.timeout(cfg.provider.timeoutMs));
    result = { provider: 'configured', model: response.model, status: response.status, text: response.output.filter(i => i.type === 'message').flatMap(i => i.content).filter(i => i.type === 'output_text').map(i => i.text).join('') };
  } else if (command === 'service-stop') {
    // Stop only a verified instance of our broker; the independently launched
    // Chrome and its session stay open. A new request restarts the broker.
    const health = await socketRequest('/health', null, 1000);
    if (health.service !== 'ozon-consumer-mcp' || !Number.isInteger(health.pid)) throw new AppError('service_conflict', 'Не удалось проверить локальный сервис.');
    process.kill(health.pid, 'SIGTERM'); result = { stopped: true, browserLeftOpen: true };
  } else if (command === 'config-init') {
    const file = path.join(process.env.HOME, '.config/ozon-mcp/settings.json');
    try { await fs.access(file); throw new AppError('config_exists', 'Файл настроек уже существует.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await privateDir(path.dirname(file)); await writePrivateJSON(file, { models: (await loadSettings()).models }); result = { settingsFile: file };
  } else if (['help', '--help', '-h'].includes(command)) result = { commands: ['serve', 'login', 'status', 'auth-save', 'search "запрос"', 'product URL', 'rpc METHOD JSON', 'probe', 'config-init', 'service-stop'], privateState: stateDir() };
  else throw new AppError('unknown_command', 'Неизвестная команда; используйте help.');
  const { _images = [], ...printable } = result;
  // Binary image content belongs to MCP image blocks, not terminal logs.
  if (_images.length) printable.imageCount = _images.length;
  console.log(JSON.stringify(printable, null, 2));
}

main().catch(error => {
  const message = JSON.stringify(publicError(error));
  // Startup failures in stdio mode must not masquerade as JSON-RPC messages.
  if (!process.argv[2] || ['serve', 'service'].includes(process.argv[2])) console.error(message);
  else console.log(message);
  process.exitCode = 1;
});
