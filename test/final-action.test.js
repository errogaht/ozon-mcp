import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { ConsumerWorkflows } from '../src/workflows.js';
import { BrowserAdapter } from '../src/adapter.js';
import { ConfirmationStore } from '../src/confirmation.js';
import { loadSettings } from '../src/config.js';

test('Final executor revalidates exact price, clicks once and fences repeat attempts in a synthetic checkout', async () => {
  // This is a fully local fake checkout, NOT a real Ozon order. Removing price
  // revalidation or at-most-once enforcement must make this test fail.
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ozon-final-'));
  try {
    const page = await browser.newPage();
    await page.route('https://www.ozon.ru/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<button onclick="window.fixtureClicks=(window.fixtureClicks||0)+1;document.body.innerHTML=\'<p>Заказ оформлен</p>\'">Оформить заказ</button>' }));
    await page.goto('https://www.ozon.ru/my/checkout');
    const cfg = await loadSettings(); const adapter = new BrowserAdapter(page, { kind: 'checkout', scope: 'checkout', mode: 'prepare' }, cfg);
    await adapter.observe({ viewportOnly: false });
    const [ref] = [...adapter.current.nodes].find(([, node]) => node.name === 'Оформить заказ');
    const fakeBrowser = { async connect() {} }; const workflows = new ConsumerWorkflows(fakeBrowser);
    workflows.confirmations = new ConfirmationStore(root); workflows.ownerHash = async () => 'fixture-owner';
    const facts = { sku: '123', quantity: 1, totalRub: 99, payment: 'ozon_installment', pickup: 'Fixture point' };
    const prepared = await workflows.confirmations.prepare('checkout', facts, { args: {} }, 'fixture-owner');
    let freshFacts = { ...facts, totalRub: 100 };
    workflows.prepareAction = async () => ({ facts: freshFacts, adapter, button: { snapshot: adapter.current.id, ref, target: { name: 'Оформить заказ' } } });
    const args = { confirmation: { ...prepared.confirmation, confirmed: true } };
    await assert.rejects(workflows.confirmAction(args, cfg), e => e.code === 'preview_changed');
    assert.equal(await page.evaluate(() => window.fixtureClicks ?? 0), 0);
    freshFacts = facts;
    const result = await workflows.confirmAction(args, cfg);
    assert.equal(result.state, 'succeeded'); assert.equal(await page.evaluate(() => window.fixtureClicks), 1);
    await assert.rejects(workflows.confirmAction(args, cfg), e => e.code === 'action_already_attempted');
    assert.equal(await page.evaluate(() => window.fixtureClicks), 1);
  } finally { await browser.close(); await fs.rm(root, { recursive: true, force: true }); }
});
