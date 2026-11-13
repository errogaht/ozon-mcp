import { AppError } from './config.js';
import { clickObserved, entityId, evidenceText } from './adapter.js';
import { outputSchemas } from './contracts.js';
import { scopedURL } from './action-policy.js';
import { productId } from './policy.js';

/** Variant discovery is a small model task; every group/choice must be grounded
 * in its own native DOM subtree. IDs bind labels and actual observed destinations,
 * not unstable snapshot refs. Recommendations are explicitly outside this task. */
export async function discoverVariants(operations, adapter, cfg) {
  const { data, meta } = await operations.adapt(adapter, {
    action: 'Read ONLY selectable product variant groups (color, size, power, kit etc). Do not switch variants.',
    requirements: 'Find native product variant selectors near title/price. Each group sourceRef must contain its label and ALL its own option refs. Exclude recommendations, similar products, shipping/payment, reviews and seller offers. Use refs from the latest snapshot. Use exact option names; for image-only choices use browser_view and their actual alt/title text, never invent. Report truncated groups in missing. Do not buy/cart/favorite.'
  }, outputSchemas.variants, cfg);
  const groups = [];
  for (const group of data.groups) {
    if (!group.sourceRef || !evidenceText(adapter, group.sourceRef)?.includes(group.label)) continue;
    let container = adapter.currentLocator(...group.sourceRef.split(':'));
    // Some snapshots expose the group heading rather than its wrapper. Climb
    // only a few small ancestors with the same label and real variant links.
    for (let depth = 0; depth < 3; depth++) {
      if (await container.locator('a[href*="/product/"]').count() >= 2) break;
      const parent = container.locator('..');
      if (!await parent.count() || !await parent.evaluate((el, label) => (el.innerText ?? '').includes(label) && (el.innerText ?? '').length < 1600 && !/В корзину|Купить сейчас/iu.test(el.innerText ?? ''), group.label)) break;
      container = parent;
    }
    const options = [];
    for (const option of group.options) {
      if (!option.sourceRef) continue;
      const locator = adapter.currentLocator(...option.sourceRef.split(':'));
      const handle = await locator.elementHandle(); if (!handle) continue;
      try {
        if (!await container.evaluate((el, child) => el.contains(child), handle)) continue;
        const native = await locator.evaluate(el => ({ label: el.getAttribute('aria-label') || el.getAttribute('title') || el.innerText || el.closest('[title]')?.title || el.querySelector('img')?.alt || '', href: el.closest('a')?.href || null,
          selected: el.checked === true || el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-selected') === 'true' || el.getAttribute('aria-current') === 'true', disabled: el.disabled === true || el.getAttribute('aria-disabled') === 'true' }));
        if (!native.label.trim() || !native.label.includes(option.label)) continue;
        let url = null; try { if (native.href && productId(native.href)) url = scopedURL(native.href); } catch { /* Invalid links never become capabilities. */ }
        const headerSelected = !native.href && group.label.includes(':') && group.label.slice(group.label.indexOf(':') + 1).trim() === option.label.trim();
        if (headerSelected) url = scopedURL(adapter.page.url());
        options.push({ id: entityId('variant', group.label, option.label, url ?? ''), label: option.label, url, sku: url ? productId(url) : null, selected: headerSelected || native.selected || !!url && productId(url) === productId(adapter.page.url()), disabled: native.disabled, sourceRef: option.sourceRef });
      } finally { await handle.dispose(); }
    }
    if (options.length <= 1) data.missing.push('Другие варианты группы не раскрыты или отсутствуют: ' + group.label);
    if (options.length !== group.options.length) data.missing.push('Часть вариантов не подтверждена в собственной группе: ' + group.label);
    groups.push({ label: group.label, options });
  }
  return { url: adapter.page.url(), sku: productId(adapter.page.url()), groups, coverage: { complete: !data.missing.length, missing: data.missing }, agent: meta };
}

/** Review scope is verified from native selected state, not the model's claim
 * or the mere presence of a label. Never silently return group-wide reviews.
 * This helper only clicks exact read-filter labels, never account/form controls. */
export async function selectReviewScope(adapter, scope, { apply = true, verifyVisual = null } = {}) {
  const pattern = /^Этот вариант(?: товара)?(?:\s*\(?[\d\s]+\)?)?$/iu;
  const allPattern = /^Все варианты(?: товара)?(?:\s*\(?[\d\s]+\)?)?$/iu;
  let label = adapter.page.getByText(scope === 'all' ? allPattern : pattern, { exact: true });
  let toggle = false;
  if (scope === 'all' && !await label.count()) { label = adapter.page.getByText(pattern, { exact: true }); toggle = true; }
  await label.first().waitFor({ state: 'attached', timeout: 8000 }).catch(() => {});
  const proof = { requested: scope, verified: false, label: scope === 'current' ? 'Этот вариант' : 'Все варианты' };
  if (await label.count() !== 1) return { ...proof, reason: 'scope_control_unavailable' };
  const parent = label.locator('xpath=ancestor-or-self::*[@tabindex or @role="tab" or @role="radio" or @role="checkbox" or self::label or self::button][1]');
  const control = await parent.count() === 1 ? parent : label;
  const desired = !(scope === 'all' && toggle);
  const state = async () => {
    const native = await control.evaluate(el => {
      const own = el.control ?? el;
      const style = getComputedStyle(own);
      return { selected: typeof own.checked === 'boolean' ? own.checked : ['aria-checked','aria-selected','aria-pressed'].some(k => own.hasAttribute(k)) ? ['aria-checked','aria-selected','aria-pressed'].some(k=>own.getAttribute(k)==='true') : null,
        style: [style.backgroundColor,style.color,style.borderColor,style.boxShadow].join('|') };
    });
    if (native.selected !== null) return native.selected;
    const cached = adapter.task?.reviewScopeStyles?.[native.style];
    if (cached !== undefined) return cached;
    if (!verifyVisual) return null;
    await control.evaluate(el => el.scrollIntoView({block:'center',behavior:'instant'}));
    const currentActive = await verifyVisual();
    const selected = currentActive === null ? null : scope === 'all' && !toggle ? !currentActive : currentActive;
    if (selected !== null && adapter.task) (adapter.task.reviewScopeStyles ??= {})[native.style] = selected;
    return selected;
  };
  let selected = await state();
  // Never toggle an unknown state: on custom chips vision must first establish
  // whether the exact visible filter is currently active.
  if (apply && selected !== null && selected !== desired) {
    await clickObserved(control); await adapter.page.waitForTimeout(700); selected = await state();
  }
  const literalLabel = (await label.innerText()).trim();
  const countMatch = literalLabel.match(/\(([\d\s]+)\)/u);
  return { ...proof, literalLabel, count: scope === 'current' && countMatch ? Number(countMatch[1].replace(/\s/g, '')) : null, verified: selected === desired, reason: selected === desired ? null : 'scope_state_unverified' };
}
