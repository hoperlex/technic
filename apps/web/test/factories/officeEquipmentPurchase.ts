import type {
  OfficeEquipmentConsumableDto,
  OfficeEquipmentPurchaseDetailDto,
  OfficeEquipmentPurchaseItemDto,
  OfficeEquipmentPurchasePrefillRowDto,
} from '@technic/contracts';

/**
 * Фикстуры плановой закупки расходников (план
 * `docs/office-equipment-consumables-and-purchase-plan.md`, Р15–Р18).
 *
 * Общей фабрикой, а не копией в каждом файле: форму, карточку и список проверяют три сценария, и
 * числа снимка расчёта у них обязаны совпадать — иначе «12» в одном тесте и «12» в другом
 * означали бы разное, и разбор 409 читался бы как совпадение.
 *
 * Числа подобраны так, чтобы формула Р15 на них сходилась: потребность 20, на складе 5, уже
 * заказано 3, «к закупке» 12. Сама формула здесь не проверяется — её считает сервер одним местом,
 * и второй вычислитель в тестах разошёлся бы с ним при первой правке правила.
 */

/** Маршруты закупки в том виде, в каком их ждёт `mockHttp`. */
export const PURCHASES = {
  list: 'GET /office-equipment-purchases',
  detail: 'GET /office-equipment-purchases/:id',
  create: 'POST /office-equipment-purchases',
  update: 'PATCH /office-equipment-purchases/:id',
  submit: 'POST /office-equipment-purchases/:id/submit',
  close: 'POST /office-equipment-purchases/:id/close',
  cancel: 'POST /office-equipment-purchases/:id/cancel',
} as const;

/** Позиция номенклатуры с дефицитом: из неё собирается и предзаполнение, и дописанная строка. */
export function consumableDto(
  over: Partial<OfficeEquipmentConsumableDto> = {},
): OfficeEquipmentConsumableDto {
  return {
    id: 'oec-1',
    code: 'Д0000093569',
    name: 'Тонер Ricoh 201 (шт)',
    quantity: 5,
    requiredQuantity: 20,
    alreadyOrdered: 3,
    deficit: 12,
    isActive: true,
    color: null,
    comment: '',
    models: [],
    hasStockHistory: true,
    equipmentCount: 1,
    lastManualStockAt: '2026-08-20T09:00:00.000Z',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-20T09:00:00.000Z',
    ...over,
  };
}

/** Строка предзаполнения: то же, что позиция, но глазами формы (Р16). */
export function prefillRow(
  over: Partial<OfficeEquipmentPurchasePrefillRowDto> = {},
): OfficeEquipmentPurchasePrefillRowDto {
  return {
    consumableId: 'oec-1',
    code: 'Д0000093569',
    name: 'Тонер Ricoh 201 (шт)',
    color: null,
    required: 20,
    stock: 5,
    alreadyOrdered: 3,
    suggested: 12,
    openPurchases: [],
    ...over,
  };
}

/** Строка заведённой закупки со снимком расчёта — тем самым, из которого вышло количество (Р17). */
export function purchaseItem(
  over: Partial<OfficeEquipmentPurchaseItemDto> = {},
): OfficeEquipmentPurchaseItemDto {
  return {
    id: 'oepi-1',
    consumableId: 'oec-1',
    code: 'Д0000093569',
    name: 'Тонер Ricoh 201 (шт)',
    color: null,
    quantity: 12,
    requiredSnapshot: 20,
    stockSnapshot: 5,
    alreadyOrderedSnapshot: 3,
    suggestedQuantity: 12,
    // Остаток СЕЙЧАС, а не снимок: его показывает форма закрытия — человеку нечем проверить себя,
    // кроме этого числа (Р11).
    currentStock: 5,
    ...over,
  };
}

/** Карточка закупки: шапка, лента переходов из своих колонок и строки (Р9, Р10). */
export function detailDto(
  over: Partial<OfficeEquipmentPurchaseDetailDto> = {},
): OfficeEquipmentPurchaseDetailDto {
  const items = over.items ?? [purchaseItem()];
  return {
    id: 'oep-1',
    num: 14,
    displayNumber: 'ЗК-14',
    status: 'new',
    comment: '',
    contentVersion: 1,
    itemCount: items.length,
    totalQuantity: items.reduce((sum, i) => sum + i.quantity, 0),
    createdById: 'user-1',
    createdByName: 'Иванов И. И.',
    createdAt: '2026-08-31T09:00:00.000Z',
    submittedByName: null,
    submittedAt: null,
    closedByName: null,
    closedAt: null,
    cancelledByName: null,
    cancelledAt: null,
    // Пусто у неотменённой: пустая строка означает «отмены не было», и это же держит `CHECK`.
    cancelReason: '',
    updatedAt: '2026-08-31T09:00:00.000Z',
    ...over,
    items,
  };
}
