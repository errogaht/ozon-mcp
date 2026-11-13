import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { AppError, privateDir, stateDir, writePrivateJSON } from './config.js';
import { catalogURL, searchURL, cleanPageText } from './policy.js';
import { compactTree, readCardsInPage, cardEvidence } from './snapshot.js';

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Chrome outlives both the service and MCP clients. Attach only to the exact
 * dedicated profile; never take over a normal desktop Chrome or Yandex instance. */
export class OzonBrowser {
  constructor() { this.browser = null; this.context = null; this.page = null; this.ledger = new Map(); this.sequence = 0; }

  async connect(cfg) {
    if (this.browser?.isConnected()) {
      if (this.connectedProfile !== cfg.browser.profileDir) throw new AppError('browser_settings_changed', 'Путь профиля изменился. Выполните service-stop перед использованием нового профиля.');
      return;
    }
    await privateDir(stateDir()); await privateDir(cfg.browser.profileDir);
    let connection;
    try { connection = JSON.parse(await fs.readFile(cfg.browser.connectionFile, 'utf8')); } catch { /* A missing connection is an ordinary first start. */ }
    if (connection && connection.profile === cfg.browser.profileDir && Number.isInteger(connection.port) && connection.port > 0 && connection.port < 65536) {
      // Match /proc argv to avoid attaching to another process after port reuse.
      const expected = `--user-data-dir=${cfg.browser.profileDir}`;
      let ownsProfile = false;
      try { ownsProfile = (await fs.readFile(`/proc/${connection.pid}/cmdline`, 'utf8')).replaceAll('\0', ' ').includes(expected + ' '); } catch { /* Process exited or metadata is stale. */ }
      if (ownsProfile) {
        try { this.browser = await chromium.connectOverCDP(`http://127.0.0.1:${connection.port}`, { timeout: 6000, noDefaults: true }); } catch { /* Check for an already-running profile before launching again. */ }
      }
    }
    if (!this.browser) {
      if (await this.runningProfile(cfg.browser.profileDir)) throw new AppError('browser_connection_stale', 'Профиль Chrome уже открыт, но подключение потеряно. Не открывайте второй экземпляр этого профиля; проверьте файл подключения.');
      // An explicit nonzero port keeps the normal visible Chrome launch mode.
      // --remote-debugging-port=0 sets navigator.webdriver=true on this Chrome.
      const server = net.createServer(); await new Promise(r => server.listen(0, '127.0.0.1', r));
      const port = server.address().port; await new Promise(r => server.close(r));
      const args = [`--user-data-dir=${cfg.browser.profileDir}`, '--remote-debugging-address=127.0.0.1', `--remote-debugging-port=${port}`, '--no-first-run', '--no-default-browser-check',
        // The adapter must receive animation frames/lazy-loading callbacks when
        // the dedicated window is behind another desktop app. These are
        // scheduling flags, not fingerprint/automation-property overrides.
        '--disable-renderer-backgrounding', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows'];
      if (cfg.browser.disableQuic) args.push('--disable-quic');
      args.push('--new-window', 'https://www.ozon.ru/');
      const child = spawn(cfg.browser.executable, args, { detached: true, stdio: 'ignore' });
      let failed = false; child.once('error', () => { failed = true; }); child.unref();
      for (let i = 0; i < 60 && !this.browser && !failed; i++) {
        try { this.browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { timeout: 500, noDefaults: true }); } catch { await pause(250); }
      }
      if (!this.browser) throw new AppError('browser_unavailable', 'Не удалось открыть видимый Chrome. Проверьте рабочий стол и путь к браузеру.');
      await writePrivateJSON(cfg.browser.connectionFile, { profile: cfg.browser.profileDir, port, pid: child.pid });
    }
    this.context = this.browser.contexts()[0];
    this.connectedProfile = cfg.browser.profileDir;
    if (!this.context) throw new AppError('browser_unavailable', 'У браузера нет рабочего контекста.');
    this.context.setDefaultTimeout(10000);
    this.page = this.context.pages().find(p => /^https:\/\/(?:www\.)?ozon\.ru\//.test(p.url())) ?? await this.context.newPage();
    this.browser.once('disconnected', () => { this.browser = null; this.context = null; this.page = null; });
  }

  async runningProfile(profile) {
    for (const pid of await fs.readdir('/proc')) {
      if (!/^\d+$/.test(pid)) continue;
      try {
        const args = (await fs.readFile(`/proc/${pid}/cmdline`, 'utf8')).replaceAll('\0', ' ');
        if (args.startsWith('/opt/google/chrome/chrome ') && !args.includes('--type=') && args.includes(`--user-data-dir=${profile} `)) return true;
      } catch { /* Processes may exit during the read-only scan. */ }
    }
    return false;
  }

  async status(cfg) {
    await this.connect(cfg);
    if (!this.page || this.page.isClosed()) this.page = this.context.pages().find(p => p.url().startsWith('https://www.ozon.ru/')) ?? await this.context.newPage();
    const cookies = await this.context.cookies('https://www.ozon.ru/');
    const uid = cookies.find(c => c.name === '__Secure-user-id');
    const token = cookies.some(c => c.name === '__Secure-access-token' && c.value.length > 0);
    const text = await this.page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
    const challenge = /Похоже, нет\s+соединения|Выключите VPN|Доступ ограничен|подтвердите, что вы не робот/iu.test(text);
    const signedIn = !!uid && /^\d+$/.test(uid.value) && Number(uid.value) > 0 && token;
    let savedAt = null;
    try { savedAt = JSON.parse(await fs.readFile(path.join(stateDir(), 'auth/receipt.json'), 'utf8')).savedAt; } catch { /* No manual save yet. */ }
    return { authenticated: signedIn && !challenge, authState: challenge ? 'site_blocked' : signedIn ? 'session_present' : 'login_required',
      evidence: { positiveUserIdCookie: signedIn, profileLinkPresent: await this.page.locator('a[href="/my/main"]').count() > 0 },
      pageTitle: await this.page.title(), pageUrl: this.page.url().split('?')[0], profileDir: cfg.browser.profileDir, savedAt };
  }

  async saveAuth(cfg) {
    const status = await this.status(cfg);
    if (!status.authenticated) throw new AppError(status.authState, 'Вход не подтверждён. Завершите вход в открытом окне Chrome и повторите auth-save.');
    const dir = path.join(stateDir(), 'auth'); await privateDir(dir);
    const file = path.join(dir, 'storage-state.json');
    try { await fs.copyFile(file, path.join(dir, 'storage-state.previous.json')); await fs.chmod(path.join(dir, 'storage-state.previous.json'), 0o600); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const state = await this.context.storageState({ indexedDB: true });
    // Export only Ozon-owned state. The full Chrome profile remains the normal
    // source of persistence; backups are never injected into a logged-out site.
    state.cookies = state.cookies.filter(c => /(^|\.)(?:ozon\.ru|ozone\.ru|ozonusercontent\.com)$/.test(c.domain.replace(/^\./, '')));
    state.origins = state.origins.filter(o => /(^|\.)(?:ozon\.ru|ozone\.ru)$/.test(new URL(o.origin).hostname));
    await writePrivateJSON(file, state);
    const receipt = { savedAt: new Date().toISOString(), profileDir: cfg.browser.profileDir, cookieCount: state.cookies.length, authenticated: true };
    await writePrivateJSON(path.join(dir, 'receipt.json'), receipt);
    return { ...status, savedAt: receipt.savedAt, backupFile: file, persistence: 'dedicated_chrome_profile', backupPermissions: '0600' };
  }

  async openAuth(cfg) {
    await this.connect(cfg);
    if (!/^https:\/\/(?:www\.)?ozon\.ru\//.test(this.page.url())) await this.page.goto('https://www.ozon.ru/', { waitUntil: 'domcontentloaded', timeout: cfg.browser.navigationTimeoutMs });
    await this.page.bringToFront(); return this.status(cfg);
  }

  /** Each agent run gets a fresh evidence ledger and a separate tab, retaining
   * the same authenticated context. The owner may keep their login tab untouched. */
  async beginRun(cfg) {
    await this.connect(cfg);
    const status = await this.status(cfg);
    if (!status.authenticated) throw new AppError(status.authState, 'Для работы MCP войдите в Ozon через auth_open.');
    this.ledger = new Map(); this.sequence = 0;
    if (!this.agentPage || this.agentPage.isClosed()) {
      for (const page of this.context.pages()) {
        if (page.url().startsWith('https://www.ozon.ru/') && await page.evaluate(() => window.name).catch(() => '') === 'ozon-consumer-mcp-research') { this.agentPage = page; break; }
      }
      if (!this.agentPage || this.agentPage.isClosed()) this.agentPage = await this.context.newPage();
    }
    // Wayland can suspend requestAnimationFrame in an occluded desktop window.
    // Focus emulation keeps this dedicated task tab rendering/lazy-loading while
    // the service is attached; it does not change navigator.webdriver or UA.
    if (!this.focusSession || this.focusPage !== this.agentPage) {
      if (this.focusSession) await this.focusSession.detach().catch(() => {});
      this.focusSession = await this.context.newCDPSession(this.agentPage); this.focusPage = this.agentPage;
      await this.focusSession.send('Emulation.setFocusEmulationEnabled', { enabled: true });
      await this.focusSession.send('Page.setWebLifecycleState', { state: 'active' });
    }
    const viewport = this.agentPage.viewportSize();
    if (!viewport || viewport.width !== cfg.browser.viewportWidth || viewport.height !== cfg.browser.viewportHeight) await this.agentPage.setViewportSize({ width: cfg.browser.viewportWidth, height: cfg.browser.viewportHeight });
    return this.agentPage;
  }

  async navigate(url, cfg) {
    await this.agentPage.goto(catalogURL(url), { waitUntil: 'domcontentloaded', timeout: cfg.browser.navigationTimeoutMs });
    await this.agentPage.evaluate(() => { window.name = 'ozon-consumer-mcp-research'; });
    // Ozon streams results after DOMContentLoaded; wait on content, not perpetual
    // network-idle (analytics and long-lived requests make that unreliable).
    await this.agentPage.waitForFunction(() => {
      const text = document.body?.innerText ?? '';
      const ready = location.pathname.startsWith('/product/') ? document.querySelector('h1') && /₽/.test(text) : [...document.querySelectorAll('a[href*="/product/"]')].some(a => a.innerText.trim().length > 5) && /₽/.test(text);
      return ready || /Похоже, нет|Ничего не наш|товары не найдены/i.test(text);
    }, undefined, { timeout: 12000 }).catch(() => {});
    return this.snapshot(cfg);
  }

  search(query, maxPrice, sort, cfg) { return this.navigate(searchURL(query, maxPrice, sort), cfg); }

  async scroll(cfg) {
    await this.agentPage.evaluate(() => window.scrollBy(0, Math.round(innerHeight * 0.85)));
    await pause(900); return this.snapshot(cfg);
  }

  async snapshot(cfg) {
    const page = this.agentPage; catalogURL(page.url());
    const text = await page.locator('body').innerText();
    if (/Похоже, нет\s+соединения|Выключите VPN|Доступ ограничен|подтвердите, что вы не робот/iu.test(text)) throw new AppError('site_blocked', 'Ozon показал ограничение доступа. Окно оставлено открытым для ручной проверки.');
    const sourceUrl = catalogURL(page.url());
    const tree = compactTree(await page.locator('body').ariaSnapshot({ mode: 'ai' }), cfg.agent.snapshotMaxChars);
    const products = [];
    for (const raw of await page.evaluate(readCardsInPage)) {
      try {
        const item = cardEvidence(raw, `p${++this.sequence}`, sourceUrl);
        if (item) { this.ledger.set(item.evidenceId, item); products.push(item); }
      } catch { /* Non-catalog/invalid links are not evidence. */ }
    }
    return { url: sourceUrl, title: cleanPageText(await page.title()), tree, products,
      observedAt: new Date().toISOString(), noResults: /Ничего не нашлось|По вашему запросу ничего|товары не найдены/iu.test(text) };
  }

  async product(url, cfg) {
    const observation = await this.navigate(catalogURL(url, true), cfg);
    // Product h1 and main offer text remain page evidence, not model-generated
    // specifications. The compact tree also contains characteristics/reviews.
    const title = await this.agentPage.locator('h1').first().innerText().catch(() => observation.title);
    return { ...observation, productTitle: cleanPageText(title) };
  }
}
