import { AppError } from './config.js';
import { clickObserved } from './adapter.js';
import { productId } from './policy.js';
import { scopedURL } from './action-policy.js';

/** Coupon state belongs to the exact product's price panel, never recommendations.
 * Prices already rendered after activation must NOT be discounted a second time.
 * Labels/URLs are native UI evidence; no generated classes or shopping API calls. */
export async function productCoupon(page, { apply = false, cardPrice = null } = {}) {
  const sku=productId(page.url());const productUrl=page.url();
  const controls=page.getByRole('button',{name:/^Скидка по купону/iu});
  await controls.first().waitFor({state:'attached',timeout:3000}).catch(()=>{});
  if(!await controls.count()){
    const badge=page.getByText(/^(?:Купон на скидку|Цена с купоном)$/iu,{exact:true});
    if(await badge.count())return {available:true,checked:false,applied:false,priceRub:null,missing:['Есть отметка купона, но его условия и применение не прочитаны.']};
    return {available:false,checked:true,applied:false,priceRub:null};
  }
  if(await controls.count()!==1)return {available:true,checked:false,applied:false,priceRub:null,missing:['Купон товара не определён однозначно.']};
  const observed=await controls.evaluate(el=>{
    const label=el.innerText;const own=el.parentElement;let root=own;
    for(let i=0;i<4 && root;i++,root=root.parentElement){if(/₽/.test(root.innerText) && root.innerText.length<4000)break;}
    const stateRoot=own.parentElement?.innerText.length<1000?own.parentElement:own;
    const applied=[stateRoot,...stateRoot.querySelectorAll('*')].some(node=>{const text=node.textContent.trim();const style=getComputedStyle(node);return /^(?:Купон\s+)?Примен[её]н(?:а|о)?$/iu.test(text) && style.display!=='none' && style.visibility!=='hidden' && Number(style.opacity)>0 && node.getBoundingClientRect().width>0;});
    return {label, applied, stateText:own.parentElement?.innerText.length<1000?own.parentElement.innerText:own.innerText,panelText:root?.innerText??'',promotionUrl:el.closest('a')?.href??own.closest('a')?.href??null};
  });
  let applied=observed.applied;
  if(apply && !applied){
    let promotion=observed.promotionUrl;
    if(promotion){
      if(!/^\/highlight\//.test(new URL(scopedURL(promotion)).pathname))throw new AppError('coupon_unverified','Адрес условий купона не подтверждён.');
      await page.goto(scopedURL(promotion),{waitUntil:'domcontentloaded'});
    }else{
      // Router-bound coupon controls may expose no href. Click only the exact
      // observed coupon wrapper, then validate the actual resulting read route.
      await clickObserved(controls.locator('..'));await page.waitForTimeout(700);
      if(productId(page.url())===sku)return productCoupon(page,{apply:false,cardPrice});
      promotion=page.url();
      if(!/^\/highlight\//.test(new URL(scopedURL(promotion)).pathname))throw new AppError('coupon_unverified','Контрол купона не открыл подтверждённые условия акции.');
    }
    await page.getByText('Примените купон',{exact:true}).first().waitFor({timeout:10000});
    const use=page.getByRole('button',{name:/^Применить(?: купон)?$/iu});
    const already=page.getByText(/^Примен[её]н$/iu,{exact:true});
    if(!await already.count()){
      if(await use.count()!==1)throw new AppError('coupon_unverified','Активация купона не определена однозначно. Покупка остановлена.');
      await clickObserved(use);await page.waitForTimeout(700);
    }
    await page.goto(productUrl,{waitUntil:'domcontentloaded'});await page.waitForTimeout(1200);
    if(productId(page.url())!==sku)throw new AppError('target_changed','После активации открыт другой вариант товара.');
    return productCoupon(page,{apply:false,cardPrice});
  }
  const displayed=[...observed.panelText.matchAll(/(\d[\d\s\u00a0\u2009\u202f]*)\s*₽/g)].map(m=>Number(m[1].replace(/\s/g,'')));
  const verifiedPrice=applied && cardPrice?.verified && displayed.includes(cardPrice.amount) ? cardPrice.amount : null;
  return {available:true,checked:true,applied,label:observed.label,promotionUrl:observed.promotionUrl,
    priceRub:verifiedPrice,priceBasis:'ozon_card_with_coupon',alreadyIncludedInDisplayedPrice:applied,
    stateText:observed.stateText,panelText:observed.panelText,
    missing:applied?[]:['Купон обнаружен, но применение не подтверждено.']};
}

/** Fail closed before a token is issued and again during final revalidation.
 * A visible coupon alone is not an applied discount. Quantity scales the already
 * discounted unit price; unknown shipping/fees cannot justify silent overpayment. */
export function couponCheckoutErrors(coupon,totalRub,quantity) {
  if(!coupon?.available)return [];
  if(!coupon.checked || !coupon.applied)return ['Не подтверждено применение купона. Покупка без него запрещена.'];
  if(!(coupon.priceRub>0))return ['Не подтверждена цена Ozon Карты с применённым купоном.'];
  if(!(totalRub>0) || totalRub>Math.round(coupon.priceRub*quantity*100)/100)return ['Итог выше подтверждённой цены с купоном. Проверьте оплату, доставку и условия; покупка остановлена.'];
  return [];
}
