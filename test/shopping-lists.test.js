import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {nativeListIndex,nativeListProducts,selectPickerProducts,renderedPickerState} from '../src/shopping-lists.js';
import {waitForSearch,preciseQueryMatches} from '../src/search-readiness.js';
import {clickObserved} from '../src/adapter.js';

test('List index keeps the eleventh card and detects two equal-name lists instead of deduplicating them',async()=>{
  // The owner's failure dropped the last private collection. Equal names are
  // separate entities and must block a supposedly idempotent create operation.
  const b=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:true});try{
    const p=await b.newPage();await p.setContent(Array.from({length:11},(_,i)=>`<div><div>${i<2?'Сравнение':'Лист '+i}</div><div>4 товара • Личная подборка</div></div>`).join(''));
    const rows=await p.evaluate(nativeListIndex,'collection');assert.equal(rows.length,11);assert.equal(rows.filter(x=>x.name==='Сравнение').length,2);assert.ok(rows.every(x=>x.isPublic===false));
  }finally{await b.close();}
});

test('Picker selects four exact grounded titles once and rejects ambiguous title matches',async()=>{
  // A checkbox without a product URL is accepted only against a title grounded
  // on the exact product page. No blanket select-all or unrelated checkbox.
  const b=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:true});try{
    const p=await b.newPage();const products=Array.from({length:4},(_,i)=>({sku:String(i+1),title:'Инструмент '+i}));
    const row=title=>`<section><span>${title}</span><label><input type="checkbox">Выбрать</label></section>`;
    await p.setContent(products.map(x=>row(x.title)).join('')+row('Посторонний'));
    assert.deepEqual(await selectPickerProducts(p,products),['1','2','3','4']);
    await selectPickerProducts(p,products);assert.equal(await p.locator('input:checked').count(),4);
    await p.setContent(row('Дубликат')+row('Дубликат'));await assert.rejects(selectPickerProducts(p,[{sku:'1',title:'Дубликат'}]),e=>e.code==='picker_identity_unverified');
  }finally{await b.close();}
});

test('Native single-input switch proxy changes private state without clicking the surrounding form',async()=>{
  // Actual Ozon visibility switches hide a 1px input without a native label.
  const b=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:true});try{
    const p=await b.newPage();await p.setContent(`<div style="width:44px;height:24px;background:blue" onclick="this.querySelector('input').checked=!this.querySelector('input').checked"><input type="checkbox" checked style="width:1px;height:1px;opacity:0"><span>●</span></div>`);
    await clickObserved(p.locator('input'));assert.equal(await p.locator('input').isChecked(),false);
  }finally{await b.close();}
});

test('Search readiness waits for fresh query; precise model research rejects unrelated cards',async()=>{
  // A delayed replacement initially shows the prior query and its InterSkol card.
  // Cards matching only that prior request must never pad a complete PROFIPOWER result.
  const b=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:true});try{
    const p=await b.newPage();await p.setContent('<input value="Интерскол"><a href="https://www.ozon.ru/product/p-1/">Интерскол 575.2.2.77</a>');
    await p.evaluate(()=>setTimeout(()=>{document.querySelector('input').value='PROFIPOWER MKBL-20BM';document.querySelector('a').textContent='PROFIPOWER MKBL-20BM';},500));
    await waitForSearch(p,'PROFIPOWER MKBL-20BM');assert.equal(await p.locator('input').inputValue(),'PROFIPOWER MKBL-20BM');
    assert.equal(preciseQueryMatches('PROFIPOWER MKBL-20BM DEKO DKCD20FU-Li','Интерскол 575.2.2.77'),false);
    assert.equal(preciseQueryMatches('PROFIPOWER MKBL-20BM DEKO DKCD20FU-Li','DEKO DKCD20FU Li'),true);
    await p.setContent('<a href="https://www.ozon.ru/product/p-1/">Свой</a><h2>Возможно, вам понравится</h2><a href="https://www.ozon.ru/product/p-2/">Чужой</a>');
    assert.equal((await p.evaluate(nativeListProducts)).length,1);
  }finally{await b.close();}
});


test('Visible picker checkmarks remain authoritative when native checked is false',async()=>{
  // The live picker updates a custom tick while leaving input.checked=false.
  // Retrying an already ticked row must not remove it from the pending list.
  const b=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:true});try{
    const p=await b.newPage();await p.setContent(`<section><span>Точный инструмент</span><label onclick="event.preventDefault()"><input type="checkbox"><svg width="16" height="16" style="opacity:1"><path d="M0 0 L8 8 L16 0"/></svg></label></section>`);
    assert.equal(await p.locator('input').isChecked(),false);assert.equal(await p.locator('input').evaluate(renderedPickerState),true);
    await selectPickerProducts(p,[{sku:'42',title:'Точный инструмент'}]);assert.equal(await p.locator('input').evaluate(renderedPickerState),true);
  }finally{await b.close();}
});

test('Search never replaces model-selected candidates with unrelated first native cards',async()=>{
  // A fresh Ozon page may lead with irrelevant sponsored cards. The old fallback
  // returned those even when the adapter explicitly selected only the DEKO row.
  const {ConsumerWorkflows}=await import('../src/workflows.js');
  const {BrowserAdapter}=await import('../src/adapter.js');
  const {loadSettings}=await import('../src/config.js');
  const b=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:true});try{
    const p=await b.newPage();await p.route('**/*',r=>r.fulfill({contentType:'text/html; charset=utf-8',body:'<input value="DEKO DKCD20FU"><main><div><span>100 ₽</span><a href="https://www.ozon.ru/product/p-111/">Шуруповёрт Интерскол посторонний</a></div><div><span>200 ₽</span><a href="https://www.ozon.ru/product/p-222/">Шуруповёрт DEKO DKCD20FU нужный</a></div></main>'}));await p.goto('https://www.ozon.ru/search/?text=DEKO');
    const cfg=await loadSettings();const adapter=new BrowserAdapter(p,{kind:'search_cards',scope:'catalog',mode:'read'},cfg);await adapter.observe({viewportOnly:false});
    const ops=new ConsumerWorkflows({});ops.open=async()=>adapter;ops.adapt=async()=>({data:{items:[{url:'https://www.ozon.ru/product/p-222/',title:'Шуруповёрт DEKO DKCD20FU нужный',sourceRef:null,priceOzonCard:{amount:null,sourceRef:null,basisLabel:null,verifiedOzonCard:false},mediaRefs:[]}],missing:[],hasMore:false},meta:{}});ops.priceForProduct=async()=>({amount:200,verified:true});
    const result=await ops.search({query:'DEKO DKCD20FU',limit:2},cfg);assert.deepEqual(result.products.map(x=>x.sku),['222']);assert.equal(result.status,'partial');
  }finally{await b.close();}
});

test('Independent list read waits for delayed product hydration after the heading',async()=>{
  // A real repeated SDK read exposed heading/count before its four cards. That
  // transient empty DOM must not become not-found, unverified or a duplicate create.
  const {readNamedList}=await import('../src/shopping-lists.js');const {loadSettings}=await import('../src/config.js');
  const b=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:true});try{
    const p=await b.newPage();await p.route('**/*',r=>r.fulfill({contentType:'text/html; charset=utf-8',body:r.request().url().includes('/selections/view/')?`<h1>Сравнение</h1><main></main><script>setTimeout(()=>document.querySelector('main').innerHTML=[1,2,3,4].map(x=>'<a href="https://www.ozon.ru/product/p-'+x+'/">Инструмент '+x+'</a>').join(''),2300)</script>`:`<div><a href="https://www.ozon.ru/selections/list">Подборки</a><span>1</span></div><a style="display:block;height:40px" href="https://www.ozon.ru/selections/view/fixture"><span>Сравнение</span><div>4 товара • Личная подборка</div></a>`}));
    const result=await readNamedList(p,await loadSettings(),'Сравнение');assert.equal(result.stateVerified,true);assert.equal(result.items.length,4);assert.equal(result.isPublic,false);
  }finally{await b.close();}
});
