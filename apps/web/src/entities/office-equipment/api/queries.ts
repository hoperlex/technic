import { queryOptions } from '@tanstack/react-query';
import { officeEquipmentTitle } from '@technic/contracts';
import { DICTIONARY_PAGE_SIZE } from '@shared/config';
import {
  officeEquipmentApi,
  officeEquipmentConsumablesApi,
  officeEquipmentModelsApi,
  officeEquipmentTypesApi,
} from './officeEquipmentApi';
import {
  officeEquipmentConsumableKeys,
  officeEquipmentKeys,
  officeEquipmentModelKeys,
  officeEquipmentTypeKeys,
} from './keys';

/**
 * Типы оргтехники для выпадающих списков. Перечень маленький и запрашивается целиком: десяток
 * строк приходит одним ответом, а поиск по ним идёт на клиенте.
 *
 * Порядок задан руками (`sortOrder`), а не алфавитом: МФУ и принтер должны стоять выше «Прочего» —
 * тем же порядком их отдаёт сервер по умолчанию.
 *
 * Выключенные типы из списка не убираются, хотя новую единицу на такой заводить незачем. Причина
 * та же, что у складов приостановленного поставщика: на выключенный тип уже ссылаются заведённые
 * карточки, и в форме правки привязка осталась бы без наименования — вместо названия человек видел
 * бы пустое поле и «терял» тип при первом же сохранении. Поэтому тип назван, но назван честно:
 * подпись говорит, что новых на него не заводят.
 */
export const officeEquipmentTypeOptionsQuery = () =>
  queryOptions({
    queryKey: officeEquipmentTypeKeys.options(),
    queryFn: () =>
      officeEquipmentTypesApi.list({
        page: 1,
        pageSize: DICTIONARY_PAGE_SIZE,
        sortBy: 'sortOrder',
        sortOrder: 'asc',
      }),
    select: (r) =>
      r.items.map((t) => ({
        value: t.id,
        label: t.isActive ? t.name : `${t.name} (не используется)`,
      })),
  });

/**
 * Единицы оргтехники для выбора техники в заявке на обслуживание (§9.3 плана). Подпись собирает
 * `officeEquipmentTitle` из контрактов — «Kyocera M3145 · инв. 0012345» обязано читаться одинаково
 * и в портале, и в письме.
 *
 * Только действующие: заявку заводят на технику, которая стоит в кабинете, а списанную выбирать
 * незачем — в уже заведённых заявках её реквизиты хранятся снимком (Р7) и от справочника не
 * зависят.
 */
export const officeEquipmentOptionsQuery = () =>
  queryOptions({
    queryKey: officeEquipmentKeys.options(),
    queryFn: () =>
      officeEquipmentApi.list({
        page: 1,
        pageSize: DICTIONARY_PAGE_SIZE,
        isActive: 'true',
        sortBy: 'name',
        sortOrder: 'asc',
      }),
    select: (r) =>
      r.items.map((item) => ({
        value: item.id,
        label: officeEquipmentTitle(item),
        warrantyUntil: item.warrantyUntil,
        // Реквизиты выбранной единицы форма заявки показывает отдельными строками (Р48): человек
        // должен увидеть, что именно уйдёт в заявку снимком, до отправки, а не после. Второго
        // запроса за карточкой это не стоит — список всё равно загружен целиком.
        name: item.name,
        serialNumber: item.serialNumber,
        inventoryNumber: item.inventoryNumber,
        typeName: item.type.name,
        objectLabel: `${item.object.code} — ${item.object.name}`,
        departmentName: item.department?.name ?? '',
        // Идентификаторы рядом с подписями — для поля заказчика (план `department-requests-plan.md`,
        // §9 п. 5): из объекта собирается ключ площадки (Р11а), а по отделу-владельцу считается
        // граница «площадка роли отдела только по технике своего отдела» (Р12). Неразмеченная
        // единица приходит с `null` — и площадку по ней сервер отвергает.
        objectId: item.object.id,
        departmentId: item.department?.id ?? null,
        location: item.location,
      })),
  });

/**
 * Модели аппаратов **выбранного типа** — для поля «Модель» карточки техники (Р1, §6 плана).
 *
 * Тип обязателен и задаёт вопрос целиком: одноимённые принтер и МФУ это разные модели, а маршрут
 * на модель чужого типа отвечает 422. Пока тип не выбран, запрос не уходит вовсе (`enabled`):
 * перечень всех моделей портала здесь не значит ничего — выбрать из него можно только неверное.
 *
 * Алфавит просится **явно**: умолчание `baseListQuery` — `sortOrder: 'desc'`, и список без этих
 * двух параметров пришёл бы «последняя заведённая сверху», то есть задом наперёд. В выпадающем
 * списке из полусотни строк это читается как случайный порядок.
 *
 * Только активные: погашенная модель означает «новых аппаратов такого рода не заводим» (Р11), и
 * предлагать её при заведении незачем — сервер такой выбор и не примет. У уже заведённой карточки
 * она остаётся: поле формы добавляет сохранённое значение к списку само (`withSavedOption`), иначе
 * правка кабинета начиналась бы с пустого обязательного поля.
 *
 * Перечень маленький (сорок пять моделей на весь парк, из них на один тип — единицы), поэтому он
 * приходит целиком и ищется на клиенте: серверный поиск на каждую букву стоил бы дороже самого
 * ответа.
 */
export const officeEquipmentModelOptionsQuery = (equipmentTypeId: string | undefined) =>
  queryOptions({
    queryKey: officeEquipmentModelKeys.options(equipmentTypeId),
    queryFn: () =>
      officeEquipmentModelsApi.list({
        page: 1,
        pageSize: DICTIONARY_PAGE_SIZE,
        equipmentTypeId,
        isActive: 'true',
        sortBy: 'name',
        sortOrder: 'asc',
      }),
    enabled: !!equipmentTypeId,
    select: (r) => r.items.map((m) => ({ value: m.id, label: m.name })),
  });

/**
 * Модели аппаратов **всех типов** — для привязки расходника «Подходит к» и для отбора «модель» в
 * окне картриджей (план `docs/office-equipment-consumables-plan.md`, Р6).
 *
 * Тип здесь не спрашивается, и это не упущение, а разница вопросов. В карточке техники тип задан
 * самой карточкой, и модель чужого типа маршрут отобьёт 422; расходник же подходит к аппаратам
 * разных типов сразу — один и тот же картридж живёт и в МФУ, и в принтере, — и сузить перечень
 * типом значило бы спрятать половину законных ответов.
 *
 * Отсюда и подпись с типом: одноимённые принтер и МФУ — разные модели (Р1), и в общем списке две
 * строки «Ricoh IM 350» без типа неразличимы.
 *
 * Ключ тот же, что у перечня по типу с пустым типом (`options(undefined)`): запрос это один и тот
 * же — «все действующие модели». Перечень по типу с пустым типом не уходит вовсе (`enabled`),
 * поэтому спорить за эту запись кэша некому.
 *
 * Только активные: погашенная модель означает «новых аппаратов такого рода не заводим» (Р11).
 * Уже привязанные к расходнику остаются видимыми — их добавляет к списку сама форма
 * (`withSavedOption`), иначе правка комментария снимала бы привязку к погашенной модели молча.
 */
export const officeEquipmentModelPickerQuery = () =>
  queryOptions({
    queryKey: officeEquipmentModelKeys.options(undefined),
    queryFn: () =>
      officeEquipmentModelsApi.list({
        page: 1,
        pageSize: DICTIONARY_PAGE_SIZE,
        isActive: 'true',
        // Алфавит явно: умолчание `baseListQuery` — `desc`, и перечень пришёл бы задом наперёд.
        sortBy: 'name',
        sortOrder: 'asc',
      }),
    select: (r) => r.items.map((m) => ({ value: m.id, label: `${m.name} · ${m.type.name}` })),
  });

/**
 * Позиции номенклатуры для отбора в отчёте по расходу (Р10, опрос В18).
 *
 * ПОГАШЕННЫЕ ВКЛЮЧЕНЫ — в отличие от перечня моделей. Отчёт смотрит в прошлое: позицию, которую
 * перестали покупать в июле, за июнь выдавали, и убрав её из отбора, портал сделал бы невозможным
 * ровно тот вопрос, ради которого в отчёт и заходят («куда делись те картриджи»).
 *
 * Подпись с кодом: по коду позицию ищут в счёте поставщика, а строк с похожими наименованиями в
 * справочнике много («Тонер Ricoh 201» и «Тонер Ricoh 201 увеличенный»).
 */
export const officeEquipmentConsumablePickerQuery = () =>
  queryOptions({
    queryKey: officeEquipmentConsumableKeys.list({ picker: 'usage' }),
    queryFn: () =>
      officeEquipmentConsumablesApi.list({
        page: 1,
        pageSize: DICTIONARY_PAGE_SIZE,
        // Алфавит явно: умолчание `baseListQuery` — `desc`, и перечень пришёл бы задом наперёд.
        sortBy: 'name',
        sortOrder: 'asc',
      }),
    select: (r) => r.items.map((c) => ({ value: c.id, label: `${c.name} · ${c.code}` })),
  });

/**
 * Действующие позиции номенклатуры ЦЕЛИКОМ — для дописывания строк в форме плановой закупки (план
 * `docs/office-equipment-consumables-and-purchase-plan.md`, Р16).
 *
 * ОТЛИЧАЕТСЯ ОТ СОСЕДНЕГО ПОДБОРА ДВУМЯ ВЕЩАМИ, и обе существенны.
 *
 * Первое: только действующие. Погашенная позиция означает «больше не покупаем», и закупка
 * погашенного — это забытая галочка, а не заказ (Р13); сервер такую строку и не примет. Подбор
 * отчёта по расходу, наоборот, показывает и погашенные — он смотрит в прошлое.
 *
 * Второе: сюда приходят сами позиции, а не пара «значение — подпись». Форме нужны их числа —
 * потребность, остаток и «уже заказано»: они и составляют снимок расчёта дописанной строки (Р17).
 * Считает их тот же сервер тем же выражением, что и предзаполнение, и второго вычислителя дефицита
 * на портале нет намеренно.
 */
export const officeEquipmentActiveConsumablesQuery = () =>
  queryOptions({
    queryKey: officeEquipmentConsumableKeys.list({ picker: 'purchase' }),
    queryFn: () =>
      officeEquipmentConsumablesApi.list({
        page: 1,
        pageSize: DICTIONARY_PAGE_SIZE,
        isActive: 'true',
        // Алфавит явно: умолчание `baseListQuery` — `desc`, и перечень пришёл бы задом наперёд.
        sortBy: 'name',
        sortOrder: 'asc',
      }),
    select: (r) => r.items,
  });
