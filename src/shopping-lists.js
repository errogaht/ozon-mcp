import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { AppError, stateDir, writePrivateJSON } from './config.js';
import { clickObserved } from './adapter.js';
import { productId } from './policy.js';
import { scopedURL } from './action-policy.js';

/** Native text/links only: no Ozon CSS classes, internal APIs or guessed URLs.
 * A personal collection is the shopping-list object; a gift wishlist has different
 * sharing semantics. The index is also the reconciliation source after a crash. */
export function nativeListIndex(kind) {
  const pattern = /\d+\s+(?:товар[а-я]*|подар[а-я]*)\s*•|•\s*\d+\s+подписчик[а-я]*/iu; const cards = []; const roots = new Set();
  for (const leaf of document.querySelectorAll('body *')) {
    if (leaf.children.length || !pattern.test(leaf.textContent)) continue;
    let root = leaf;
    for (let depth = 0; root && depth < 5; depth++, root = root.parentElement) {
      const lines = (root.innerText ?? '').split('\n').map(x=>x.trim()).filter(Boolean);
      if (lines.length < 2 || lines.length > 6 || !lines.some(x=>pattern.test(x))) continue;
      const names=lines.filter(x=>!pattern.test(x));
      const name = names.length>1 && names[0].length===1 ? names.at(-1) : names[0];
      if (!name) continue;
      if(roots.has(root))break;roots.add(root);
      cards.push({kind,name,count:/подписчик/iu.test(leaf.textContent)?null:Number(leaf.textContent.match(/\d+/)[0]),isPublic:kind==='collection' ? !/Личная подборка/iu.test(leaf.textContent) : null,metadata:leaf.textContent.trim()});break;
    }
  }
  return cards;
}

/** Wait for actual list content rather than a fixed DOMContentLoaded delay. */
async function settle(page) { await page.waitForTimeout(1400); }
async function exactClick(page, name) {
  const label = page.getByText(name,{exact:true});
  if (await label.count() !== 1) throw new AppError('list_ambiguous','Имя/контрол списка не найден однозначно: '+name);
  // Small clickable card wrappers may receive the hit instead of their child text.
  const handle = await label.evaluateHandle(el=>{
    let node=el;
    for(let i=0;node && i<4;i++,node=node.parentElement) if(getComputedStyle(node).cursor==='pointer' && node.getBoundingClientRect().height>20 && (node.innerText??'').length<700) return node;
    return el;
  });
  try { await clickObserved(handle.asElement()); } finally { await handle.dispose(); }
  await settle(page);
}
async function go(page,url,cfg) {await page.goto(scopedURL(url,'collections'),{waitUntil:'domcontentloaded',timeout:cfg.browser.navigationTimeoutMs});await settle(page);}

export async function listIndex(page,cfg,kind='all') {
  const result=[]; const missing=[];
  for(const tab of kind==='all'?['collection','wishlist']:[kind]) {
    await go(page,'https://www.ozon.ru/my/favorites/',cfg);
    await exactClick(page,tab==='collection'?'Подборки':'Вишлисты');
    let last=-1; let stable=0; let rows=[];
    for(let i=0;i<12;i++) {
      rows=await page.evaluate(nativeListIndex,tab);
      stable=rows.length===last?stable+1:0;last=rows.length;
      if(stable>=2 && rows.length>0)break;
      await page.evaluate(()=>window.scrollBy(0,innerHeight));await page.waitForTimeout(400);
    }
    const count = await page.getByText(tab==='collection'?'Подборки':'Вишлисты',{exact:true}).evaluate(el=>Number(el.parentElement.innerText.match(/\d+/)?.[0])||0);
    if(rows.length!==count)missing.push(`${tab}: прочитано ${rows.length} из ${count}; чужие вишлисты могут иметь отдельный раздел.`);
    result.push(...rows);
  }
  return {items:result,coverage:{complete:!missing.length,missing}};
}

/** Only links before the actual recommendation heading belong to this list.
 * Keep duplicate card renders separate from duplicate list entries by SKU. */
export function nativeListProducts() {
  const recommendation=[...document.querySelectorAll('*')].find(el=>el.children.length===0 && /^(?:Возможно, вам понравится|Рекомендуем также|Смотрите также)$/iu.test(el.textContent.trim()));
  return [...document.querySelectorAll('a[href*="/product/"]')].filter(el=>!recommendation || !!(el.compareDocumentPosition(recommendation)&Node.DOCUMENT_POSITION_FOLLOWING)).map(el=>({url:el.href,title:el.innerText.trim(),images:[...el.querySelectorAll('img')].map(img=>img.currentSrc||img.src)}));
}
export async function readNamedList(page,cfg,name,kind='collection') {
  const index=await listIndex(page,cfg,kind);const matches=index.items.filter(x=>x.name===name);
  if(matches.length!==1)return {status:matches.length?'ambiguous':'not_found',name,items:[],matches:matches.length,coverage:index.coverage};
  if(!index.coverage.complete)return {status:'unverified',name,items:[],missing:index.coverage.missing};
  await exactClick(page,name);
  const url=page.url();await page.reload({waitUntil:'domcontentloaded'});await settle(page);
  let rows=[];
  // Detail cards hydrate after the heading/count. An empty first DOM is not
  // evidence that the saved list lost its products, nor permission to recreate.
  for(let attempt=0;attempt<30;attempt++){
    rows=await page.evaluate(nativeListProducts);
    if(new Set(rows.map(row=>productId(row.url)).filter(Boolean)).size>=matches[0].count)break;
    await page.waitForTimeout(400);
  }
  const items=[];
  for(const row of rows){const sku=productId(row.url);const previous=items.find(x=>x.sku===sku);if(previous){if(row.title.length>previous.title.length)previous.title=row.title;}else if(sku)items.push({...row,sku,url:row.url.split('?')[0]});}
  const heading=await page.getByText(name,{exact:true}).count();
  const verified=heading>0 && items.length===matches[0].count;
  return {status:verified?'verified':'unverified',stateVerified:verified,...matches[0],url,items,missing:verified?[]:['Имя или полный состав списка после перезагрузки не подтверждены.'],coverage:{complete:verified}};
}

/** Ensure, never toggle. Verify each precise SKU on its page before saving and
 * capture title/image identities for the linkless native collection picker. */
async function ensureFavorites(page,urls,cfg) {
  const products=[];
  for(const url of urls) {
    await go(page,url,cfg);await page.getByRole('heading',{level:1}).waitFor();
    if(productId(page.url())!==productId(url))throw new AppError('target_changed','Ozon открыл другой SKU.');
    const title=(await page.getByRole('heading',{level:1}).innerText()).trim();
    const add=page.getByRole('button',{name:'Добавить в избранное',exact:true});
    if(await add.count()===1){await clickObserved(add);await settle(page);}
    // No repeated heart click. Reconciliation below reads the favorite catalog.
    products.push({sku:productId(url),url,title});
  }
  await go(page,'https://www.ozon.ru/my/favorites/',cfg);
  await page.waitForFunction(skus=>skus.every(sku=>[...document.querySelectorAll('a[href*="/product/"]')].some(a=>new RegExp('(?:-|/)'+sku+'/?(?:[?#]|$)').test(a.href))),products.map(p=>p.sku),{timeout:12000});
  return products;
}

/** Match a linkless picker row through an exact title previously grounded on
 * that SKU's page. Ambiguous equal titles are rejected, not assigned by order. */
/** Ozon's picker uses native inputs whose checked property stays false while
 * its visible checkmark changes. Read the rendered checkbox glyph (including
 * ancestor opacity), not generated class names or model assertions. */
export function renderedPickerState(el) {
  if(Array.isArray(el))return el.map(renderedPickerState);
  if(el.checked || el.getAttribute('aria-checked')==='true')return true;
  const label=el.closest('label');if(!label || label.querySelectorAll('input').length!==1)return false;
  const icons=label.querySelectorAll('svg');if(icons.length!==1)return false;
  let node=icons[0];const box=node.getBoundingClientRect();if(!box.width || !box.height)return false;
  while(node && node!==label){const style=getComputedStyle(node);if(Number(style.opacity)===0 || style.visibility==='hidden' || style.display==='none')return false;node=node.parentElement;}
  return true;
}
export async function selectPickerProducts(page,products) {
  await page.getByRole('checkbox').first().waitFor({state:'attached',timeout:15000});
  const inputs=page.getByRole('checkbox');const selected=[];
  for(const product of products) {
    const handles=[];
    for(let i=0;i<await inputs.count();i++) {
      const input=inputs.nth(i);
      const matches=await input.evaluate((el,title)=>{
        let root=el.parentElement;
        for(let d=0;root && d<5;d++,root=root.parentElement)if(root.querySelectorAll('input[type="checkbox"]').length===1 && [...root.querySelectorAll('*')].some(n=>n.children.length===0 && n.textContent.trim()===title))return true;
        return false;
      },product.title);
      if(matches)handles.push(input);
    }
    if(handles.length!==1)throw new AppError('picker_identity_unverified','Не найдена однозначная строка назначенного SKU: '+product.sku);
    if(!await handles[0].evaluate(renderedPickerState)){await clickObserved(handles[0]);await page.waitForTimeout(350);}
    if(!await handles[0].evaluate(renderedPickerState))throw new AppError('picker_state_unverified','Флажок товара не выбран: '+product.sku);
    selected.push(product.sku);
  }
  if((await inputs.evaluateAll(renderedPickerState)).filter(Boolean).length!==selected.length)throw new AppError('picker_extra_products','Выбраны посторонние товары. Сохранение остановлено.');
  return selected;
}

export async function ensureShoppingList(ops,args,cfg) {
  try { return await ensureShoppingListInternal(ops,args,cfg); }
  catch(error) { return {status:'unverified',stateVerified:false,name:args.name,missing:[error instanceof AppError ? error.message : 'Не завершён или не подтверждён шаг интерфейса Ozon. Изменение могло примениться.'],reason:error instanceof AppError?error.code:'native_ui_incomplete',reconcile:{tool:'ozon_collections',arguments:{kind:'collection',name:args.name}},instruction:'Сначала перечитайте этот список. Не повторяйте создание или нажатие сердечка вслепую.'}; }
}
async function ensureShoppingListInternal(ops,args,cfg) {
  const urls=[...new Map(args.productUrls.map(url=>[productId(url),url])).values()];
  if(urls.some(url=>!productId(url)))throw new AppError('invalid_url','Нужны точные ссылки на товары.');
  if(!args.apply)return {status:'preview',name:args.name,isPublic:false,productUrls:urls};
  const page=await ops.browser.beginRun(cfg);await page.bringToFront();
  const existing=await readNamedList(page,cfg,args.name);
  if(existing.stateVerified && existing.isPublic===false && existing.items.length===urls.length && urls.every(url=>existing.items.some(x=>x.sku===productId(url))))return {...existing,status:'already_present'};
  const extending=existing.stateVerified && existing.isPublic===false && existing.items.every(item=>urls.some(url=>productId(url)===item.sku));
  if(existing.status!=='not_found' && !extending)return {...existing,status:'unverified',missing:['Список уже существует или его состояние неясно. Слепое повторное создание запрещено. Используйте collections с name для сверки.']};
  if(!existing.coverage.complete)return {...existing,status:'unverified',missing:['Не прочитан полный индекс; создавать возможный дубликат нельзя.']};
  const file=path.join(stateDir(),'shopping-lists',createHash('sha256').update(args.name+'|'+await ops.ownerHash()).digest('hex')+'.json');
  let receipt=null;try{receipt=JSON.parse(await fs.readFile(file,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
  if(receipt && receipt.phase!=='picker' && !extending)throw new AppError('list_attempt_unresolved','Предыдущая отправка или создание черновика имеет неопределённый исход. Сначала сверка списка; повторное сохранение запрещено.');
  const products=await ensureFavorites(page,urls,cfg);
  if(extending){
    await go(page,existing.url,cfg);await clickObserved(page.getByRole('button',{name:'Добавить товары',exact:true}));await settle(page);
    await writePrivateJSON(file,{name:args.name,phase:'picker',pickerUrl:page.url(),products,editing:true});
  } else if(receipt?.pickerUrl)await go(page,receipt.pickerUrl,cfg);
  else {
    if(receipt)throw new AppError('list_attempt_unresolved','Предыдущая попытка создания требует сверки, новый список не создаётся.');
    await go(page,'https://www.ozon.ru/my/favorites/',cfg);await exactClick(page,'Подборки');await exactClick(page,'Создать подборку');
    await page.getByText('Название',{exact:true}).locator('..').getByRole('textbox').fill(args.name);
    if(args.description)await page.getByText('Описание',{exact:true}).locator('..').getByRole('textbox').fill(args.description);
    const visibility=page.getByRole('checkbox');if(await visibility.count()!==1)throw new AppError('visibility_unverified','Не найден переключатель публичности.');
    if(await visibility.isChecked())await clickObserved(visibility);
    if(await visibility.isChecked())throw new AppError('visibility_unverified','Подборка осталась публичной.');
    await writePrivateJSON(file,{name:args.name,phase:'creating_draft'});
    await clickObserved(page.getByRole('button',{name:'Выбрать товары',exact:true}));await settle(page);
    await writePrivateJSON(file,{name:args.name,phase:'picker',pickerUrl:page.url(),products});
  }
  await selectPickerProducts(page,products);
  await writePrivateJSON(file,{name:args.name,phase:'committing',pickerUrl:page.url(),products});
  const commit=page.getByRole('button',{name:extending?/^(?:Сохранить|Сохранить подборку|Добавить товары|Создать подборку)$/:/^Создать подборку$/});
  if(await commit.count()!==1)throw new AppError('list_commit_unverified','Не найдена однозначная кнопка сохранения списка.');
  await clickObserved(commit);await settle(page);
  const verified=await readNamedList(page,cfg,args.name);
  const expected=products.map(x=>x.sku).sort();const actual=verified.items.map(x=>x.sku).sort();
  const success=verified.stateVerified && verified.isPublic===false && JSON.stringify(expected)===JSON.stringify(actual);
  await writePrivateJSON(file,{name:args.name,phase:success?'verified':'unknown',url:verified.url,expected,actual});
  return {...verified,status:success?'applied':'unverified',stateVerified:success,missing:success?[]:['Создание могло примениться; точный состав/приватность не подтверждены. Сначала перечитайте список, не повторяйте изменение.']};
}
