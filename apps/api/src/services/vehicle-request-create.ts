import { and, eq } from 'drizzle-orm';
import { isVehicleKindAllowedForRequest, type VehicleRequestType } from '@technic/contracts';
import type { db } from '../db/client';
import {
  constructionObjects,
  specialEquipmentRequestDetails,
  vehicleCategories,
  vehicleKinds,
  vehicleRequests,
  vehicleRequestStatusHistory,
  vehicleTypes,
} from '../db/schema';
import { err } from '../lib/errors';

/**
 * Заведение заказа спецтехники — одним кодом на оба места, где он рождается: форму заказа
 * (`POST /vehicle-requests`) и применение недельной заявки (ADR 0085).
 *
 * Общим вынесено не «вставить строку», а **условия появления заказа**: живая площадка и годная
 * позиция классификатора. Записанные по разу в каждом вызывающем, они разошлись бы при первой же
 * правке справочника — и недельная заявка молча наплодила бы заказы на погашенный тип ТС или на
 * снесённую площадку, тогда как форма на то же самое отвечает отказом.
 */

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function assertObjectActive(tx: Tx, objectId: string): Promise<void> {
  const [o] = await tx
    .select({ isActive: constructionObjects.isActive })
    .from(constructionObjects)
    .where(eq(constructionObjects.id, objectId));
  if (!o) throw err.badRequest('Объект не найден');
  if (!o.isActive) throw err.badRequest('Объект неактивен');
}

/**
 * Заказанная позиция классификатора (ADR 0028): активный тип ТС (ADR 0005) активного вида,
 * разрешённого этому типу заявки, и — если у типа есть активные категории (ADR 0016) — одна из
 * них. Тип заявки задаётся в форме явно: на объект заказывают технику любого вида,
 * грузоперевозку — только грузовым (`isVehicleKindAllowedForRequest`).
 *
 * Категория не «ещё одно поле формы», а часть выбора: у типа с категориями заказ без неё
 * неадресен («нужен автокран» — какой?), а у типа без ТТХ её неоткуда взять. Принадлежность
 * категории типу держит составной FK, но сверяется и здесь — вместо ошибки целостности человек
 * должен получить ответ.
 */
export async function resolveClassification(
  tx: Tx,
  typeId: string,
  categoryId: string | null,
  requestType: VehicleRequestType,
): Promise<void> {
  const [row] = await tx
    .select({
      name: vehicleTypes.name,
      isActive: vehicleTypes.isActive,
      kindCode: vehicleKinds.code,
      kindActive: vehicleKinds.isActive,
    })
    .from(vehicleTypes)
    .innerJoin(vehicleKinds, eq(vehicleTypes.kindId, vehicleKinds.id))
    .where(eq(vehicleTypes.id, typeId));
  if (!row) throw err.badRequest('Тип ТС не найден');
  if (!row.isActive) throw err.badRequest('Тип ТС неактивен');
  if (!row.kindActive) throw err.badRequest('Вид ТС неактивен');
  if (!isVehicleKindAllowedForRequest(requestType, row.kindCode)) {
    throw err.unprocessable('Грузоперевозку выполняет только грузовая техника');
  }

  const activeCategories = await tx
    .select({ id: vehicleCategories.id })
    .from(vehicleCategories)
    .where(and(eq(vehicleCategories.vehicleTypeId, typeId), eq(vehicleCategories.isActive, true)));

  if (!categoryId) {
    if (activeCategories.length > 0) {
      throw err.unprocessable(`Выберите категорию типа «${row.name}»`, {
        vehicleCategoryId: 'Выберите категорию',
      });
    }
    return;
  }
  // Категория чужого типа и выключенная категория — разные ошибки: первая означает сломанный
  // клиент, вторая — что позицию убрали из справочника, пока форма была открыта.
  if (!activeCategories.some((c) => c.id === categoryId)) {
    const [existing] = await tx
      .select({ isActive: vehicleCategories.isActive, typeId: vehicleCategories.vehicleTypeId })
      .from(vehicleCategories)
      .where(eq(vehicleCategories.id, categoryId));
    if (!existing || existing.typeId !== typeId) {
      throw err.badRequest('Категория не найдена у этого типа ТС', {
        vehicleCategoryId: 'Категория другого типа',
      });
    }
    throw err.unprocessable('Категория неактивна', { vehicleCategoryId: 'Категория неактивна' });
  }
}

/** Заказ спецтехники, каким его заводят: площадка, позиция классификатора, срок и контакт. */
export interface NewSpecialEquipmentRequest {
  objectId: string;
  vehicleTypeId: string;
  vehicleCategoryId: string | null;
  dateFrom: string;
  /** Пусто у однодневного заказа: срок читается как `coalesce(date_to, date_from)`. */
  dateTo: string | null;
  responsibleName: string;
  responsiblePhone: string;
  comment: string;
  createdBy: string;
  /**
   * Виза, проставленная в момент заведения. У формы это автовиза заказчика (ADR 0025 п. 5,
   * ADR 0032), у недельной заявки — виза, которой её и применили (ADR 0085 Р8): порождённый заказ
   * второй визы не спрашивает.
   */
  approvedBy: string | null;
  approvedAt: Date | null;
}

/**
 * Завести заказ спецтехники в статусе «Новая» — вместе с деталью срока и первой записью истории
 * статусов. Файлы сюда не входят: они принадлежность формы, а не заказа как такового.
 *
 * Возвращает идентификатор — реквизиты вызывающий читает сам: форме нужен DTO целиком, недельной
 * заявке — только ссылка в строку состава.
 */
export async function createSpecialEquipmentRequest(
  tx: Tx,
  draft: NewSpecialEquipmentRequest,
): Promise<string> {
  await assertObjectActive(tx, draft.objectId);
  await resolveClassification(
    tx,
    draft.vehicleTypeId,
    draft.vehicleCategoryId,
    'special_equipment',
  );

  const [row] = await tx
    .insert(vehicleRequests)
    .values({
      requestType: 'special_equipment',
      objectId: draft.objectId,
      departmentId: null,
      vehicleTypeId: draft.vehicleTypeId,
      vehicleCategoryId: draft.vehicleCategoryId,
      status: 'new',
      comment: draft.comment,
      createdBy: draft.createdBy,
      approvedBy: draft.approvedBy,
      approvedAt: draft.approvedAt,
    })
    .returning({ id: vehicleRequests.id });
  const id = row!.id;

  await tx.insert(specialEquipmentRequestDetails).values({
    requestId: id,
    dateFrom: draft.dateFrom,
    dateTo: draft.dateTo,
    responsibleName: draft.responsibleName,
    responsiblePhone: draft.responsiblePhone,
  });
  await tx.insert(vehicleRequestStatusHistory).values({
    vehicleRequestId: id,
    fromStatus: null,
    toStatus: 'new',
    changedBy: draft.createdBy,
  });
  return id;
}
