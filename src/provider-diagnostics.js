import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { stateDir, writePrivateJSON } from './config.js';

const names = new Set(['APIConnectionError', 'APIConnectionTimeoutError', 'APIUserAbortError', 'APIError', 'AuthenticationError', 'PermissionDeniedError', 'RateLimitError', 'InternalServerError', 'BadRequestError', 'Error', 'TypeError', 'AbortError', 'TimeoutError']);
const codes = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET']);

/** Persist only allowlisted transport metadata, never arbitrary exception messages,
 * stacks, headers, bodies, prompts or URLs. Even a private SDK error may echo keys.
 * A single atomic latest receipt bounds disk usage; its ID correlates public errors.
 * Diagnostic I/O failure must not replace the original provider failure. */
export async function recordProviderFailure(error, context) {
  const diagnosticId = randomUUID(); const causes = []; let node = error;
  for (let depth = 0; node && depth < 5; depth++, node = node.cause) {
    const name = names.has(node.constructor?.name) ? node.constructor.name : node.name;
    causes.push({ name: names.has(name) ? name : 'OtherError', code: codes.has(node.code) ? node.code : null });
  }
  const status = Number.isInteger(error.status) && error.status >= 100 && error.status <= 599 ? error.status : null;
  const id = error.requestID ?? context.requestId;
  const requestId = typeof id === 'string' && /^(?:req_[A-Za-z0-9_-]{1,100}|[a-f0-9-]{32,36})$/.test(id) ? id : null;
  const timedOut = causes.some(c => /Timeout/.test(c.name) || /TIMEOUT|ETIMEDOUT/.test(c.code ?? ''));
  const receipt = { diagnosticId, at: new Date().toISOString(), phase: context.phase, eventsReceived: context.eventsReceived,
    elapsedMs: Math.round(context.elapsedMs), status, requestId, causes,
    category: context.aborted ? 'operation_aborted' : timedOut ? 'timeout' : status ? 'http_error' : context.phase === 'stream' ? 'stream_error' : 'connection_or_sdk_error' };
  try { await writePrivateJSON(path.join(stateDir(), 'diagnostics/provider-last.json'), receipt); } catch { /* Keep original failure authoritative. */ }
  return receipt;
}
