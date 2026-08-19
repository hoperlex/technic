import { queryOptions } from '@tanstack/react-query';
import { officeEquipmentTitle } from '@technic/contracts';
import { DICTIONARY_PAGE_SIZE } from '@shared/config';
import { officeEquipmentApi, officeEquipmentTypesApi } from './officeEquipmentApi';
import { officeEquipmentKeys, officeEquipmentTypeKeys } from './keys';

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
