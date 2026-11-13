import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { ConsumerWorkflows } from '../src/workflows.js';
import { MediaStore } from '../src/media.js';
import { loadSettings, writePrivateJSON } from '../src/config.js';

test('Review gallery excludes other-user photos and prefetched videos from the exact requested review', async () => {
  // Regression for the real viewer: unrelated media can be LARGE and Ozon
  // prefetches its MP4 responses. Neither size nor network activity proves
  // ownership. Only assets observed in this exact review qualify.
  const browser = await chromium.launch({ executablePath: '/usr/bin/google-chrome', headless: true });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ozon-gallery-'));
  const priorState = process.env.OZON_MCP_STATE_DIR; process.env.OZON_MCP_STATE_DIR = root;
  try {
    const page = await browser.newPage(); const id = 'review_' + 'a'.repeat(20);
    const own = 'https://ir.ozone.ru/s3/rp-photo-14/wc1600/own.jpeg';
    const wrongPhoto = 'https://ir.ozone.ru/s3/rp-photo-14/wc1600/other.jpeg';
    const wrongVideo = 'https://vr-1.ozone.ru/vod/video-72/OTHER_ASSET/asset.mp4';
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+afo0AAAAASUVORK5CYII=', 'base64');
    await page.route('https://**/*', route => {
      if (route.request().url().includes('ozone.ru')) return route.fulfill({ contentType: route.request().url().includes('.mp4') ? 'video/mp4' : 'image/png', body: png });
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<article><p>Иван</p><p>1 ноября 2026</p><p>Own photo</p><img style="width:100px;height:100px" src="${own.replace('wc1600','wc100')}"><button onclick="document.querySelector('#viewer').style.display='block';fetch('${wrongVideo}')">Открыть галерею</button></article><div id="viewer" style="display:none;position:fixed;inset:0;background:white"><p>Иван 1 ноября 2026 Own photo</p><img style="width:700px;height:500px" src="${own}"><h2>Другие пользователи</h2><img style="width:400px;height:400px" src="${wrongPhoto}"></div>` });
    });
    await writePrivateJSON(path.join(root, 'entities', id + '.json'), { id, productUrl: 'https://www.ozon.ru/product/fixture-123/', listUrl: 'https://www.ozon.ru/product/fixture-123/reviews/', author: 'Иван', date: '1 ноября 2026', text: 'Own photo' });
    const workflows = new ConsumerWorkflows({ async beginRun() { return page; } }); workflows.media = new MediaStore(path.join(root, 'media'));
    workflows.adapt = async adapter => {
      await adapter.observe({ viewportOnly: false });
      return { data: { galleryRef: adapter.current.id + ':e0', thumbnailRefs: [], mainImageRef: null, videoRefs: [], expectedCount: 1, hasMoreThumbnails: false, missing: [] }, meta: {} };
    };
    const result = await workflows.gallery({ reviewId: id, limit: 10 }, await loadSettings());
    assert.equal(result.media.length, 1); assert.equal(result.media[0].url, own); assert.equal(result.media[0].kind, 'image');
    assert.equal(result.coverage.complete, true);
    assert.equal(await page.locator('[data-ozon-mcp-gallery]').count(), 0);
  } finally {
    await browser.close(); await fs.rm(root, { recursive: true, force: true });
    if (priorState === undefined) delete process.env.OZON_MCP_STATE_DIR; else process.env.OZON_MCP_STATE_DIR = priorState;
  }
});
