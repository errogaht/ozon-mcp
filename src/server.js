import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { callService } from './service.js';
import { publicError, appVersion } from './config.js';
import { consumerInputs, searchInput, productInput } from './contracts.js';

/** Public tools expose shopping intent, not generic browser primitives. Secrets,
 * arbitrary JS and account mutation are deliberately absent from the protocol. */
export function createMcpServer(invoke = callService) {
  const server = new McpServer({ name: 'ozon-consumer', version: appVersion }, {
    instructions: 'Потребительский Ozon через локальный Chrome и внутренний Luna-адаптер. Вход ручной, пароль/код не запрашивайте. Цена означает только подтверждённую цену Ozon Карты; null означает неизвестно. Поиск/карточки/отзывы/вопросы/медиа/заказы возвращают структурированные сущности и покрытие; пагинацию продолжайте до конца, не называйте частичные данные всеми. Обратимые изменения требуют apply=true и поручения владельца. Конечные действия только prepare → прочитать точный preview → явное поручение владельца → action_confirm с полученным токеном/digest/confirmed=true. Токен не является подтверждением владельца. Не повторяйте результат unknown. При разработке запрещены покупки, отправка скидок, возвраты и публикация отзывов.'
  });
  const register = (name, method, description, inputSchema, readOnly) => {
    server.registerTool(name, { description, inputSchema,
      annotations: { readOnlyHint: readOnly, destructiveHint: method === 'action_confirm', idempotentHint: readOnly, openWorldHint: true }
    }, async args => {
      try {
        const raw = await invoke(method, args); const { _images = [], ...data } = raw;
        return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }, ..._images], structuredContent: data };
      } catch (error) { return { isError: true, content: [{ type: 'text', text: JSON.stringify(publicError(error)) }] }; }
    });
  };
  register('ozon_auth_open', 'auth_open', 'Открыть или показать отдельный Chrome для ручного входа в Ozon. Владелец сам вводит телефон и код. Существующая сессия сохраняется; пароль инструменту не нужен.', {}, false);
  register('ozon_auth_status', 'status', 'Проверить наличие сессии Ozon и доступность страницы. Не возвращает cookies, токены, телефон, имя или ID аккаунта.', {}, true);
  register('ozon_auth_save', 'auth_save', 'После ручного входа проверить авторизацию и сохранить приватную резервную копию сессии. Основная авторизация хранится в отдельном профиле Chrome.', {}, false);
  register('ozon_search', 'search', 'Поиск с ценой Ozon Карты, рейтингом товара, числом отзывов/вопросов и сроком доставки. sort: popular/cheaper/expensive/rating/new/relevance. Фильтры: цена, brands, deliveryWithinDays и динамические name/values из ozon_search_filters. Неподтверждённые ограничения не игнорируются.', searchInput, true);
  register('ozon_product', 'product', 'Полная карточка: название, подтверждённая цена Ozon Карты, рейтинг/отзывы/вопросы, раскрытое описание/характеристики, продавец и доставка. sections позволяет узкий запрос. Для галереи, полных отзывов и вопросов используйте отдельные инструменты.', productInput, true);
  const definitions = [
    ['product_variants', 'Наблюдаемые группы вариантов товара: цвет, размер, мощность, комплектация. Возвращает варианты с variantId, URL/SKU и состоянием.', true],
    ['product_variant_select', 'Переключить на вариант из product_variants по variantId. Заново проверяет вариант и конечный SKU. Используйте возвращённый url для карточки и отзывов.', true],
    ['search_filters', 'Показать актуальные фильтры текущей категории и варианты сортировки. Раскрывает цену, бренд, срок доставки и категорийные параметры; исключает финансовые промо.', true],
    ['product_media', 'Открыть галерею товара и собрать все доступные фотографии/видео в максимальном реально наблюдаемом разрешении. Возвращает mediaId, URL, размеры и полноту. Невидимые оригиналы не выдумывает.', true],
    ['review_media', 'Открыть галерею конкретного ранее прочитанного отзыва по reviewId из ozon_reviews. Сверяет автора/дату/текст и собирает реальные крупные источники фото/видео. Не подставляет фото другого отзыва.', true],
    ['media_get', 'Получить ранее наблюдаемое изображение по mediaId как MCP image для просмотра внешним агентом; для видео возвращает исходный URL. analyze=true дополнительно анализирует изображение Luna по question.', true],
    ['media_import', 'Импортировать выбранное владельцем PNG/JPEG/WebP для обложки, отзыва или возврата. Файл должен находиться в ~/.local/share/ozon-mcp/uploads; произвольные локальные файлы не читаются. Возвращает mediaId для явной последующей загрузки.', false],
    ['reviews', 'Отдельные полные отзывы: текст/достоинства/недостатки, звёзды, автор/дата/вариант, фото/видео, ответы и голоса. По умолчанию scope=current: только «Этот вариант». scope=all явно включает всю группу. Если фильтр не подтверждён, отзывы не выдаются. Сортировка useful/new/rating_asc/rating_desc. Продолжайте nextCursor до конца; coverage отражает полноту.', true],
    ['questions', 'Отдельные вопросы и все раскрытые ответы, с автором/датой/признаком продавца. Поддерживает limit/cursor; не отправляет новых вопросов.', true],
    ['orders', 'Активные/завершённые/all заказы: что и когда доставят/доставили, статусы, ссылки на детали и доступность возврата/отзыва. Приватные данные только для запроса владельца.', true],
    ['order_detail', 'Прочитать конкретный заказ, доставку, товары и доступные действия. Передайте url ИЛИ orderId из ozon_orders, даже когда карточка обзора не показала ссылку/названия товаров. Заказ не изменяется.', true],
    ['collections', 'Прочитать списки избранного, вишлисты и подборки, их описания/обложки/видимость/число товаров.', true],
    ['collection_create', 'Создать подборку с точным названием, описанием, обложкой coverMediaId, isPublic и начальными productUrls. По умолчанию preview; apply=true выполняет по поручению владельца. Публичность не выбирается автоматически.', false],
    ['favorite', 'Сохранить товар в favorites, wishlist или collection. Для конкретной подборки/вишлиста укажите listName (collectionName — совместимый вариант). Уже сохранённое не удаляет. apply=true — выполнить по поручению; иначе preview.', false],
    ['cart', 'Прочитать корзину, количества/выбор, цены Ozon Карты и сроки доставки. Ничего не меняет.', true],
    ['cart_add', 'Добавить конкретный товар в корзину с указанным количеством, сохраняя остальные позиции. apply=true — выполнить по поручению; иначе preview. Покупку не оформляет.', false],
    ['checkout_prepare', 'Открыть Купить сейчас, проверить точный товар/количество/итог/доставку/ПВЗ/оплату, НЕ нажимая Оформить заказ. maxTotalRub — предельный итог. Предпочтение: Ozon Рассрочка и сохранённый ПВЗ. При полном плане возвращает одноразовый confirmation.', false],
    ['discount_prepare', 'Подготовить запрос Хочу скидку, заполнить цену/текст, НЕ отправлять. Вернуть точный preview и confirmation, если форма подтверждена.', false],
    ['return_prepare', 'Подготовить возврат конкретного купленного товара/количества, НЕ отправлять. reason — точная реальная причина из формы, comment — пояснение владельца. availableChoices показывает варианты при неполной подготовке. Возвращает условия/план и confirmation при полном подтверждении.', false],
    ['review_prepare', 'Подготовить отзыв только по купленному товару: точные stars/text/pros/cons/media владельца. Не выдумывать опыт и НЕ публиковать. Вернуть preview и confirmation.', false],
    ['action_confirm', 'ОПАСНОЕ КОНЕЧНОЕ ДЕЙСТВИЕ: оформить покупку, отправить скидку/возврат или опубликовать отзыв. Только по ЯВНОМУ поручению владельца после чтения preview. Передать точный token/digest и confirmed=true. Повторно проверяет факты; одноразовое выполнение. Нельзя использовать для тестов разработки. При unknown НЕ повторять.', false],
    ['action_status', 'Прочитать состояние подготовленного/начатого конечного действия. unknown/attempting требуют сверки факта, а не повторной отправки.', true]
  ];
  for (const [method, description, readOnly] of definitions) register('ozon_' + method, method, description, consumerInputs[method], readOnly);
  return server;
}

/** Never print banners/progress to stdout: it belongs exclusively to JSON-RPC. */
export async function serveMcp() { await createMcpServer().connect(new StdioServerTransport()); }
