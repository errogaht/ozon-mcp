import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { AppError, stateDir, writePrivateJSON, privateDir } from './config.js';

/** Canonical hashes bind intent to exact facts, independent of object key order.
 * Preview timestamps/UI refs are stored separately and never weaken the digest. */
export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}
export const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');

/** File-backed confirmation ledger survives service restarts. Attempted/unknown
 * states are fences: timeouts/crashes cannot turn a purchase into a blind retry.
 * The broker serializes calls, and O_EXCL attempt markers additionally protect
 * final execution from a second process or concurrent executor. */
export class ConfirmationStore {
  constructor(root = path.join(stateDir(), 'confirmations'), now = () => Date.now()) { this.root = root; this.now = now; }
  resourceFile(plan) {
    // A fresh token must not bypass an UNKNOWN attempt for the same business
    // target. Successful, positively observed outcomes release this fence;
    // unknown/crashed attempts require reconciliation outside the submit path.
    const facts = plan.facts;
    let urlSku = null;
    try { urlSku = new URL(facts.productUrl ?? facts.targetUrl).pathname.match(/^\/product\/[^/]*?(\d+)\/?$/)?.[1] ?? null; } catch { /* Generic fixture plans may not have a URL. */ }
    const skus = [...new Set((facts.items ?? []).map(item => item.sku).filter(Boolean))].sort();
    // URL aliases/slug edits and a different spelling of the same title must
    // not unlock an UNKNOWN business action. For returns/reviews the whole
    // exact order remains fenced until its previous unknown send is reconciled.
    const target = facts.orderNumber ? { orderNumber: facts.orderNumber } : skus.length ? { skus } : facts.sku || urlSku ? { skus: [facts.sku ?? urlSku] } : facts.productUrl ?? facts.targetUrl ?? facts;
    const identity = { action: plan.action, ownerHash: plan.ownerHash, target };
    return path.join(this.root, 'target-' + digest(identity) + '.attempt');
  }
  file(token) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new AppError('invalid_confirmation', 'Неверный токен подтверждения.');
    return path.join(this.root, token + '.json');
  }
  async prepare(action, facts, context, ownerHash, ttlMs = 900000) {
    await privateDir(this.root);
    const token = randomBytes(32).toString('base64url');
    const plan = { action, facts, ownerHash }; const hash = digest(plan);
    try { await fs.access(this.resourceFile(plan)); throw new AppError('previous_action_unresolved', 'Предыдущее действие с этим товаром/заказом уже начато, его результат не сверён. Новый токен не отменяет запрет повторной отправки. Проверьте action_status и фактические заказы/заявки.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const record = { token, digest: hash, state: 'prepared', plan, context, createdAt: this.now(), expiresAt: this.now() + ttlMs };
    await writePrivateJSON(this.file(token), record);
    return { action, preview: facts, confirmation: { token, digest: hash, expiresAt: new Date(record.expiresAt).toISOString() },
      instruction: 'Вызывать action_confirm только после явного поручения владельца выполнить именно это действие. confirmed=true — утверждение вызывающего агента о наличии такого поручения; токен не заменяет его.' };
  }
  async read(token) {
    let record;
    try { record = JSON.parse(await fs.readFile(this.file(token), 'utf8')); }
    catch (error) { if (error instanceof AppError) throw error; throw new AppError('confirmation_missing', 'План подтверждения не найден. Подготовьте новый предварительный просмотр.'); }
    return record;
  }
  async validate(confirmation, ownerHash) {
    const record = await this.read(confirmation.token);
    if (confirmation.confirmed !== true || confirmation.digest !== record.digest) throw new AppError('invalid_confirmation', 'Подтверждение не совпадает с подготовленным действием.');
    if (record.plan.ownerHash !== ownerHash) throw new AppError('account_changed', 'Аккаунт изменился после подготовки действия.');
    if ((await this.status(confirmation.token)).state !== 'prepared') throw new AppError('action_already_attempted', 'Отправка уже начиналась. Сначала сверьте её фактический результат; новый клик запрещён.');
    if (record.state !== 'prepared') throw new AppError('action_already_attempted', 'Действие уже выполнялось или его результат неизвестен. Сначала проверьте action_status и заказы; повторная отправка запрещена.');
    if (this.now() > record.expiresAt) throw new AppError('confirmation_expired', 'Предварительный просмотр устарел. Подготовьте действие заново.');
    return record;
  }
  async attempt(record) {
    try { const fence = await fs.open(this.resourceFile(record.plan), 'wx', 0o600); await fence.writeFile(record.token); await fence.close(); }
    catch (error) { if (error.code === 'EEXIST') throw new AppError('previous_action_unresolved', 'Этот товар/заказ уже отправлялся с неизвестным результатом. Новый токен не разрешает повторную отправку.'); throw error; }
    const marker = this.file(record.token) + '.attempt';
    try { const fd = await fs.open(marker, 'wx', 0o600); await fd.writeFile(String(this.now())); await fd.close(); }
    catch (error) { if (error.code === 'EEXIST') throw new AppError('action_already_attempted', 'Повторная отправка уже начатого действия запрещена.'); throw error; }
    record.state = 'attempting'; record.attemptedAt = this.now();
    await writePrivateJSON(this.file(record.token), record);
  }
  async finish(record, state, result) {
    if (!['succeeded', 'unknown', 'failed_before_submit'].includes(state)) throw new Error('Invalid confirmation state');
    record.state = state; record.result = result; record.finishedAt = this.now();
    await writePrivateJSON(this.file(record.token), record);
    if (state === 'succeeded' || state === 'failed_before_submit') {
      const fence = this.resourceFile(record.plan);
      if (await fs.readFile(fence, 'utf8').catch(() => null) === record.token) await fs.rm(fence, { force: true });
    }
  }
  async status(token) {
    const record = await this.read(token);
    let attempted = record.state !== 'prepared';
    try { await fs.access(this.file(token) + '.attempt'); attempted = true; } catch { /* An unattempted preview has no marker. */ }
    if (await fs.readFile(this.resourceFile(record.plan), 'utf8').catch(() => null) === token) attempted = true;
    return { action: record.plan.action, state: record.state === 'prepared' && attempted ? 'unknown' : record.state,
      preview: record.plan.facts, expired: this.now() > record.expiresAt,
      createdAt: new Date(record.createdAt).toISOString(), result: record.result ?? null,
      retryAllowed: false, instruction: attempted ? 'Сверьте результат с заказами/возвратами/отзывами. Этот токен повторно не отправляется.' : 'Действие ещё не отправлялось; требуется явное подтверждение владельца.' };
  }
}
