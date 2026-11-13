import { AppError } from './config.js';

/** A fresh URL alone does not prove hydrated results. Wait for the actual search
 * input to echo this query and for the card DOM to stop changing. No network-idle
 * wait: Ozon keeps analytics connections open indefinitely. */
export async function waitForSearch(page, phrase) {
  try {
    await page.waitForFunction(query => [...document.querySelectorAll('input')].some(el => el.value.trim().toLocaleLowerCase() === query.trim().toLocaleLowerCase()) &&
      (!!document.querySelector('a[href*="/product/"]') || /Ничего не наш|товары не найдены/iu.test(document.body.innerText)), phrase, { timeout: 15000 });
    let last = ''; let stable = 0;
    for (let i = 0; i < 12; i++) {
      const signature = await page.locator('a[href*="/product/"]').evaluateAll(es => es.slice(0,30).map(e => e.href+' '+e.textContent).join('\n'));
      stable = signature === last ? stable + 1 : 0; last = signature;
      if (stable >= 2) return;
      await page.waitForTimeout(350);
    }
  } catch { /* Surface unverified readiness, never relabel stale data as stock. */ }
  throw new AppError('search_not_ready', 'Не подтверждено обновление выдачи для текущего запроса. Повторите чтение после загрузки страницы.');
}

/** Model/brand anchors provide an independent negative control for precise SKU
 * research. General Russian category queries remain the adapter's selection task;
 * a missing price is unrelated to relevance. */
export function preciseQueryMatches(query, title) {
  const anchors = query.match(/[A-Za-z][A-Za-z0-9.-]{2,}|\d+(?:\.\d+){2,}/g) ?? [];
  const normalize = value => value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  return !anchors.length || anchors.some(anchor => normalize(title).includes(normalize(anchor)));
}
