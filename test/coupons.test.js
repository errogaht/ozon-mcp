import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {productCoupon,couponCheckoutErrors} from '../src/coupons.js';

test('Applied coupon price is grounded in its own panel and never discounted twice',async()=>{
  // The rendered card price already includes the coupon. A crossed-out or other
  // bank price must not replace the verified Ozon Card amount.
  const b=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:true});try{
    const p=await b.newPage();await p.route('**/*',r=>r.fulfill({contentType:'text/html; charset=utf-8',body:'<h1>Точный инструмент</h1><section><span>7 276 ₽ С банками</span><span>8 364 ₽ С другими банками</span><div><a href="https://www.ozon.ru/highlight/coupon-123/"><button>Скидка по купону до 17 ноября</button></a><span>Применён</span></div></section><aside>1 ₽ Купон постороннего товара</aside>'}));await p.goto('https://www.ozon.ru/product/tool-123/');
    const coupon=await productCoupon(p,{cardPrice:{amount:7276,verified:true}});
    assert.equal(coupon.applied,true);assert.equal(coupon.priceRub,7276);assert.equal(coupon.alreadyIncludedInDisplayedPrice,true);
    assert.deepEqual(couponCheckoutErrors(coupon,7276,1),[]);assert.deepEqual(couponCheckoutErrors(coupon,14552,2),[]);
    assert.ok(couponCheckoutErrors(coupon,8085,1).length);
    assert.equal((await productCoupon(p,{cardPrice:{amount:1,verified:true}})).priceRub,null);
  }finally{await b.close();}
});

test('Coupon requirement blocks inactive, unknown-price and vanished-discount plans',()=>{
  // A coupon badge is never sufficient authority for an expensive checkout.
  assert.ok(couponCheckoutErrors({available:true,checked:true,applied:false},100,1).length);
  assert.ok(couponCheckoutErrors({available:true,checked:true,applied:true,priceRub:null},100,1).length);
  assert.deepEqual(couponCheckoutErrors({available:false},100,1),[]);
});

test('Inactive coupon is activated through its observed promotion and rechecked on the same SKU',async()=>{
  // Activation is a bounded reversible action, never a purchase click. The
  // coupon must still be applied after returning to the original product.
  const b=await chromium.launch({executablePath:'/usr/bin/google-chrome',headless:true});try{
    const p=await b.newPage();let applied=false;let activations=0;
    await p.exposeFunction('activateCoupon',()=>{applied=true;activations++;});
    await p.route('**/*',r=>r.fulfill({contentType:'text/html; charset=utf-8',body:r.request().url().includes('/highlight/')?'<h1>Скидка 10%</h1><div>Примените купон</div><button onclick="activateCoupon().then(()=>this.textContent=\'Применен\')">Применить</button>':`<h1>Инструмент</h1><section><span>900 ₽</span><div><a href="https://www.ozon.ru/highlight/coupon-123/"><button>Скидка по купону</button></a><span>${applied?'Применён':'Не применён'}</span></div></section>`}));
    await p.goto('https://www.ozon.ru/product/tool-123/');
    assert.equal((await productCoupon(p)).applied,false);
    const result=await productCoupon(p,{apply:true,cardPrice:{amount:900,verified:true}});
    assert.equal(result.applied,true);assert.equal(result.priceRub,900);assert.equal(activations,1);
    await productCoupon(p,{apply:true,cardPrice:{amount:900,verified:true}});assert.equal(activations,1);
    assert.ok(p.url().includes('/product/tool-123/'));
  }finally{await b.close();}
});
