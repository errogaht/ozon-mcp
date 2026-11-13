import { AppError } from './config.js';

const finalAction = /(?:оформить\s+заказ|подтвердить\s+(?:заказ|оплату)|оплатить(?:\s|$)|заказать\s+и\s+оплатить|отправить\s+(?:заявк|запрос|отзыв)|опубликовать\s+(?:отзыв|подборк)|оформить\s+возврат|подтвердить\s+возврат|вернуть\s+деньги)/iu;
const accountDanger = /(?:удалить\s+аккаунт|выйти\s+из|отменить\s+заказ|повторить\s+заказ|заказать\s+снова|поменять\s+пароль|удалить\s+карту|(?:открыть|оформить)\s+(?:карту|кредит)|подписаться\s+за|заблокировать|пожаловаться|написать\s+продавцу|^чат$)/iu;
const purchaseEntry = /(?:купить\s+сейчас|перейти\s+к\s+оформлению|перейти\s+к\s+заказу|добавить\s+в\s+корзину|^в\s+корзину$|^в\s+корзине$)/iu;
const readControl = /(?:отзыв|вопрос|ответ|описан|характеристик|подробн|полност|разверн|сверн|показать|посмотреть|далее|следующ|назад|закрыть|популяр|дешев|дороже|цене|рейтинг|сначала|новые|полезные|оценк|сортиров|фильтр|бренд|достав|применить|сбросить|категори|товар|фото|видео|картин|play|pause|воспроиз|^ещё$|^еще$|заказ|покупк|заверш|активн|получен|ожида|продавец|магазин)/iu;

/** Paths are scoped per workflow. Unknown query parameters on observed view
 * links are harmless to parse, but no agent can invent arbitrary navigation:
 * BrowserAdapter accepts only URLs in its current observed link registry. */
export function scopedURL(value, scope = 'catalog') {
  let u; try { u = new URL(value, 'https://www.ozon.ru'); } catch { throw new AppError('invalid_url', 'Неверная ссылка Ozon.'); }
  if (u.protocol !== 'https:' || !['ozon.ru', 'www.ozon.ru'].includes(u.hostname) || u.port || u.username || u.password || /%(?:2f|5c|00|25)/i.test(u.pathname)) throw new AppError('invalid_url', 'Нужна HTTPS-ссылка на Ozon.');
  const product = /^\/product\/[^/]+\/?(?:(?:reviews|questions|features|description|videos)\/?)?$/.test(u.pathname);
  const catalog = /^\/(?:search\/?|category\/[^?#]+|seller\/[^?#]+|brand\/[^?#]+|)$/.test(u.pathname);
  const account = /^\/(?:my\/(?:orderlist|orderdetails|order|favorites|wishlist|collections|collection|returns|return|reviews|review|checkout)(?:\/[^?#]*)?|cart\/?|gocheckout\/?|checkout\/?|collection\/[^?#]+|selections\/(?:list|form|addProducts|view\/[\w-]+|[\w-]+)\/?|my\/main\/?)$/.test(u.pathname);
  if (!(product || catalog || (scope !== 'catalog' && account))) throw new AppError('unsupported_route', 'Этот адрес не относится к текущему пользовательскому сценарию.');
  if (scope === 'orders' && account && !/^\/my\/(?:order|return|review)/.test(u.pathname)) throw new AppError('unsupported_route', 'Разрешены только страницы заказов/возвратов/отзывов.');
  if (scope === 'collections' && account && !/favorite|wishlist|collection|selection/.test(u.pathname)) throw new AppError('unsupported_route', 'Разрешены только избранное и подборки.');
  if (scope === 'checkout' && account && !/^\/(?:cart|gocheckout|checkout|my\/checkout)\/?$/.test(u.pathname)) throw new AppError('unsupported_route', 'Разрешены только корзина и оформление заказа.');
  u.hostname = 'www.ozon.ru'; return u.href;
}

/** Tool-level and element-level checks both run. A reader task cannot click a
 * purchase/mutation button just because a hostile title told it to do so. Final
 * submission is NEVER available in the model's browser_click tool. */
export function assertClickAllowed(target, task) {
  const name = `${target.name ?? ''} ${target.text ?? ''}`.trim();
  if (task.collectionSelectionOnly && (/публичн[а-я]*\s+подборк/iu.test(name) || [target.name, target.text].some(value => /^назад$/iu.test(value?.trim() ?? '')) || target.href)) throw new AppError('collection_fields_frozen', 'Поля/видимость подборки уже проверены; здесь разрешён только выбор назначенных товаров.');
  if (task.collectionSelectionOnly && target.role === 'checkbox' && !task.allowedProductSkus?.includes(target.contextSku)) throw new AppError('target_changed', 'Этот флажок не относится к назначенному товару новой подборки.');
  if (task.disclosuresOpened?.some(label => [target.name, target.text].some(value => value?.trim() === label))) throw new AppError('already_expanded', 'Этот блок уже раскрыт. Прочитайте существующий текст; повторное нажатие свернёт его.');
  if (task.prohibitedLabels?.some(label => [target.name, target.text].some(v => v?.trim() === label))) throw new AppError('preview_only', 'Эта операция только готовит предварительный просмотр.');
  if (task.kind === 'collection_create' && !task.allowCollectionCommit && [target.name, target.text].some(v => /^(?:создать|сохранить)(?:\s+(?:подборку|список))?$/iu.test(v?.trim() ?? '') && (task.collectionFormOpen || target.type === 'submit' || !/^создать подборку$/iu.test(v?.trim() ?? '')))) throw new AppError('collection_fields_required', 'Сначала необходимо проверить название, описание, обложку и видимость подборки.');
  if (task.kind === 'favorite' && /удалить\s+из|убрать\s+из|снять\s+отметк/iu.test(name)) throw new AppError('already_saved', 'Сохранённый товар не удаляется: задача только добавить его в нужный список.');
  if (task.kind === 'cart_add' && /удалить|убрать\s+из\s+корзин|очистить/iu.test(name)) throw new AppError('forbidden_action', 'Добавление товара не удаляет позиции корзины.');
  if (accountDanger.test(name)) throw new AppError('forbidden_action', 'Действие вне разрешённого сценария.');
  if (finalAction.test(name) || [target.name, target.text].some(v => /^(?:отправить|опубликовать|подтвердить|оформить|заказать|оплатить)$/iu.test(v?.trim() ?? ''))) throw new AppError('confirmation_required', 'Конечное действие доступно только через подготовленный план и action_confirm.');
  if (task.kind === 'discount' && /хочу\s+скидку|попросить\s+скидку/iu.test(name) && target.hasPopup !== 'dialog') throw new AppError('confirmation_required', 'Не доказано, что кнопка только открывает форму: прямой запрос скидки не отправляется без подтверждения.');
  if (purchaseEntry.test(name) && !['checkout', 'cart_add'].includes(task.kind)) throw new AppError('forbidden_action', 'Переход к покупке не разрешён в операции чтения.');
  if (/задать\s+вопрос|отправить\s+ответ|написать\s+отзыв|оставить\s+отзыв/iu.test(name) && !['review', 'return'].includes(task.kind)) throw new AppError('forbidden_action', 'Читающая операция не открывает отправку сообщения/отзыва.');
  if (/создать\s+подборк/iu.test(name) && task.kind !== 'collection_create') throw new AppError('forbidden_action', 'Создание подборки выполняет отдельный инструмент с проверкой видимости.');
  if (target.href) { scopedURL(target.href, task.scope); return; }
  if (!name && ['button', 'generic'].includes(target.role) && !target.hasMedia && !target.inGallery) throw new AppError('ambiguous_control', 'Неподписанная кнопка не используется без подтверждённого назначения.');
  if (task.mode === 'mutate' || task.mode === 'prepare') return;
  if (['checkbox', 'radio'].includes(target.role) && ['filters', 'filter_apply', 'reviews', 'questions'].includes(task.kind)) return;
  if (['filters', 'filter_apply'].includes(task.kind) && [target.name, target.text].some(value => /^(?:до\s+\d+\s+дн[а-я]*|сегодня|завтра|послезавтра|готово)$/iu.test(value?.trim() ?? ''))) return;
  if (['checkbox', 'radio'].includes(target.role)) throw new AppError('forbidden_action', 'Эта читающая операция не изменяет выбор позиций или настройки аккаунта.');
  if (['option', 'combobox', 'listbox', 'tab'].includes(target.role)) return;
  if (target.type === 'submit' && !['filters', 'filter_apply'].includes(task.kind)) throw new AppError('forbidden_action', 'Читающая операция не отправляет формы.');
  if (readControl.test(name) || /комментари/iu.test(name) || task.allowedLabels?.some(label => name.toLocaleLowerCase().includes(label.toLocaleLowerCase()))) return;
  if (/избранн|подборк|вишлист|списки|список|текущ|прошл/iu.test(name)) return;
  if (['product', 'search_cards', 'cart'].includes(task.kind) && /с банками|с картой|с ozon картой/iu.test(name)) return;
  if (task.kind === 'media' && (target.hasMedia || !name && (target.inDialog || target.inGallery))) return;
  if (task.kind === 'orders' && task.allowOrderOpen && target.hasMedia && !name) return;
  // Bare icon controls are only accepted for explicit local navigation intents
  // (close/back/next in a gallery); the caller cannot pass screen coordinates.
  throw new AppError('ambiguous_control', 'Назначение элемента не подтверждено для этой операции.');
}

export function assertFillAllowed(target, task) {
  if (['password', 'tel'].includes(target.type) || /парол|код\s+из|номер\s+карт|cvc|cvv/iu.test(target.name ?? '')) throw new AppError('secret_input_forbidden', 'Ввод паролей, кодов и банковских реквизитов выполняет владелец.');
  if (!['filter_apply', 'filters', 'collection_create', 'checkout', 'discount', 'return', 'review', 'cart_add'].includes(task.kind)) throw new AppError('forbidden_action', 'Этот сценарий не заполняет формы.');
  if (task.collectionSelectionOnly && /^(?:название(?:\s+подборки)?|описание)$|название\s+подборки/iu.test(target.name ?? '')) throw new AppError('collection_fields_frozen', 'Название и описание уже проверены; в выборе товаров они не меняются.');
}

export function finalButtonAllowed(action, label) {
  const tests = { checkout: /^(?:Оформить заказ|Заказать и оплатить|Подтвердить заказ)$/iu,
    discount: /^(?:Отправить|Отправить запрос|Хочу скидку|Попросить скидку)$/iu,
    return: /^(?:Оформить возврат|Отправить заявку|Подтвердить возврат|Отправить)$/iu,
    review: /^(?:Отправить отзыв|Опубликовать отзыв|Отправить|Опубликовать)$/iu };
  return !!tests[action]?.test(label.trim());
}
