import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConfirmationStore, digest } from '../src/confirmation.js';

test('Confirmation binds exact account, action, SKU, quantity, total and delivery', async () => {
  // A token prepared for one purchase must never approve another account/plan.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ozon-confirm-')); let now = 100000;
  try {
    const store = new ConfirmationStore(dir, () => now);
    const preview = await store.prepare('checkout', { sku: '123', quantity: 1, total: 99, pickup: 'Test point' }, {}, 'owner1', 1000);
    const confirmation = { ...preview.confirmation, confirmed: true };
    assert.equal((await store.validate(confirmation, 'owner1')).state, 'prepared');
    await assert.rejects(store.validate({ ...confirmation, confirmed: false }, 'owner1'), e => e.code === 'invalid_confirmation');
    await assert.rejects(store.validate({ ...confirmation, digest: digest({ total: 100 }) }, 'owner1'), e => e.code === 'invalid_confirmation');
    await assert.rejects(store.validate(confirmation, 'owner2'), e => e.code === 'account_changed');
    now += 1001; await assert.rejects(store.validate(confirmation, 'owner1'), e => e.code === 'confirmation_expired');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('Concurrent/crashed attempts are fenced and survive broker restarts', async () => {
  // Simulate two executors validating before either writes: O_EXCL must allow
  // exactly one attempt. A new store instance must refuse retry after a crash.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ozon-once-'));
  try {
    const store = new ConfirmationStore(dir);
    const preview = await store.prepare('return', { order: '100-1', product: '123' }, {}, 'owner');
    const c = { ...preview.confirmation, confirmed: true };
    const a = await store.validate(c, 'owner'); const b = await store.validate(c, 'owner');
    const results = await Promise.allSettled([store.attempt(a), store.attempt(b)]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    const restarted = new ConfirmationStore(dir);
    await assert.rejects(restarted.validate(c, 'owner'), e => e.code === 'action_already_attempted');
    await assert.rejects(restarted.prepare('return', { order: '100-1', product: '123' }, {}, 'owner'), e => e.code === 'previous_action_unresolved');
    assert.equal((await restarted.status(c.token)).state, 'attempting');
    await store.finish(a, 'unknown', { reason: 'network interrupted after click' });
    assert.equal((await restarted.status(c.token)).state, 'unknown');
    await assert.rejects(restarted.validate(c, 'owner'), e => e.code === 'action_already_attempted');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('A new token cannot bypass an unknown attempt even after total/quantity changes', async () => {
  // Retry identity is the same business target, not the volatile UI/price hash.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ozon-target-'));
  try {
    const store = new ConfirmationStore(dir); const facts = { productUrl: 'https://www.ozon.ru/product/fixture-123/', totalRub: 99 };
    const p = await store.prepare('checkout', facts, {}, 'owner');
    const record = await store.read(p.confirmation.token); await store.attempt(record); await store.finish(record, 'unknown', {});
    await assert.rejects(store.prepare('checkout', { ...facts, totalRub: 100, quantity: 2 }, {}, 'owner'), e => e.code === 'previous_action_unresolved');
    await assert.rejects(store.prepare('checkout', { ...facts, productUrl: 'https://www.ozon.ru/product/123/' }, {}, 'owner'), e => e.code === 'previous_action_unresolved');
    await store.finish(record, 'succeeded', { verified: true });
    assert.ok((await store.prepare('checkout', facts, {}, 'owner')).confirmation.token);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test('Crash after durable attempt marker but before JSON update is still unknown, never retryable', async () => {
  // This is the narrow crash window between fencing and writing attempting.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ozon-crash-'));
  try {
    const store = new ConfirmationStore(dir); const p = await store.prepare('review', { text: 'Owner supplied' }, {}, 'owner');
    await fs.writeFile(store.file(p.confirmation.token) + '.attempt', 'attempt', { mode: 0o600, flag: 'wx' });
    assert.equal((await new ConfirmationStore(dir).status(p.confirmation.token)).state, 'unknown');
    await assert.rejects(store.attempt(await store.read(p.confirmation.token)), e => e.code === 'action_already_attempted');
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});
