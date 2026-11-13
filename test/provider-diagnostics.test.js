import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import OpenAI from 'openai';
import { modelResponse } from '../src/agent.js';
import { publicError } from '../src/config.js';

test('Provider failures preserve safe transport evidence without SDK messages or secrets', async () => {
  // A real SDK timeout and a failed SSE reader exercise distinct phases; neither
  // request bodies nor hostile error messages may enter receipts or MCP output.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ozon-diagnostics-'));
  const previous = process.env.OZON_MCP_STATE_DIR; process.env.OZON_MCP_STATE_DIR = dir;
  try {
    const errors = [new OpenAI.APIConnectionTimeoutError(), new OpenAI.APIConnectionError({ cause: Object.assign(new Error('Bearer secret PAGE_CONTENT'), { code: 'ECONNRESET' }) })];
    for (const [index, error] of errors.entries()) {
      const client = { responses: { create() {
        if (!index) return Promise.reject(error);
        return { async withResponse() { return { request_id: 'req_fixture', data: (async function* () { yield { type: 'response.created' }; throw error; })() }; } };
      } } };
      await assert.rejects(modelResponse(client, {}, new AbortController().signal), e => {
        assert.equal(e.code, index ? 'provider_error' : 'timeout');
        assert.match(publicError(e).diagnosticId, /^[a-f0-9-]{36}$/); return true;
      });
      const file = path.join(dir, 'diagnostics/provider-last.json');
      const text = await fs.readFile(file, 'utf8'); const data = JSON.parse(text);
      assert.equal(data.phase, index ? 'stream' : 'request');
      assert.equal(data.category, index ? 'stream_error' : 'timeout');
      if (index) { assert.equal(data.requestId, 'req_fixture'); assert.equal(data.causes[1].code, 'ECONNRESET'); }
      assert.ok(!/secret|Bearer|PAGE_CONTENT/.test(text));
      assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
    }
  } finally {
    if (previous === undefined) delete process.env.OZON_MCP_STATE_DIR; else process.env.OZON_MCP_STATE_DIR = previous;
    await fs.rm(dir, { recursive: true, force: true });
  }
});
