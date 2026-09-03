import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';
import type {
  OfficeEquipmentModelSpecDto,
  OfficeEquipmentModelSpecInput,
  OfficeEquipmentSpecDto,
} from '@technic/contracts';
import { db } from '../db/client';
import {
  officeEquipmentModelSpecs,
  officeEquipmentSpecs,
  officeEquipmentSpecValues,
  officeEquipmentTypeSpecs,
} from '../db/schema';
import { err } from '../lib/errors';

/**
 * Характеристики моделей оргтехники: чтение в строку списка и запись значения
 * (план `docs/office-equipment-specs-plan.md`, миграция `0252`).
 *
 * Одним модулем на три двери — список техники, список моделей и карточка единицы, — потому что
 * правило «какие характеристики положены этому типу и что у модели выбрано» одно, а написанное
 * трижды оно разошлось бы: первая же дверь, забывшая про `is_active` характеристики, начала бы
 * показывать «н/д» по погашенному вопросу.
 */

/** Перечень характеристик со значениями на выбор: им отвечает `GET /office-equipment-types/:id/specs`. */
export async function listSpecsForType(equipmentTypeId: string): Promise<OfficeEquipmentSpecDto[]> {
  const rows = await db
    .select({
      id: officeEquipmentSpecs.id,
      code: officeEquipmentSpecs.code,
      name: officeEquipmentSpecs.name,
      showInList: officeEquipmentSpecs.showInList,
      sortOrder: officeEquipmentSpecs.sortOrder,
      valueId: officeEquipmentSpecValues.id,
      valueCode: officeEquipmentSpecValues.code,
      valueName: officeEquipmentSpecValues.name,
      valueShortName: officeEquipmentSpecValues.shortName,
    })
    .from(officeEquipmentTypeSpecs)
    .innerJoin(officeEquipmentSpecs, eq(officeEquipmentSpecs.id, officeEquipmentTypeSpecs.specId))
    .innerJoin(
      officeEquipmentSpecValues,
      eq(officeEquipmentSpecValues.specId, officeEquipmentSpecs.id),
    )
    .where(
      and(
        eq(officeEquipmentTypeSpecs.equipmentTypeId, equipmentTypeId),
        eq(officeEquipmentSpecs.isActive, true),
      ),
    )
    .orderBy(
      officeEquipmentSpecs.sortOrder,
      officeEquipmentSpecs.name,
      officeEquipmentSpecValues.sortOrder,
      officeEquipmentSpecValues.name,
    );

  const specs = new Map<string, OfficeEquipmentSpecDto>();
  for (const r of rows) {
    let spec = specs.get(r.id);
    if (!spec) {
      spec = {
        id: r.id,
        code: r.code,
        name: r.name,
        showInList: r.showInList,
        sortOrder: r.sortOrder,
        values: [],
      };
      specs.set(r.id, spec);
    }
    spec.values.push({
      id: r.valueId,
      code: r.valueCode,
      name: r.valueName,
      shortName: r.valueShortName,
    });
  }
  return [...specs.values()];
}

/**
 * Характеристики строки списка — коррелированным подзапросом к типу и модели этой строки.
 *
 * Ссылки на внешние строки приходят **выражениями**, а не колонками, и это не стилистика.
 * Односоставный запрос (`FROM office_equipment_models` без единого `JOIN`) drizzle сокращает до
 * псевдонима, и вписанная колонка внешней таблицы в подзапросе превращается в ссылку на саму
 * себя — предикат становится вечно ложным, ошибки при этом нет никакой (тот же капкан описан у
 * `modelIdRef` в `routes/office-equipment-models.ts`, где он стоил разъезда списка и удаления).
 *
 * `modelIdRef` может быть и `NULL` — это карточка техники без модели (колонка `model_id` весь
 * выпуск A nullable). Тогда `LEFT JOIN` значений не находит ничего, и каждая характеристика типа
 * приезжает с `value: null`, то есть «н/д» (Р9): вопрос законен, ответа нет.
 *
 * Погашенная характеристика (`is_active = false`) в ответ не попадает вовсе — вопрос сняли, и
 * показывать по нему «н/д» значит спрашивать заново.
 */
export function modelSpecsExpr(
  modelIdRef: SQL,
  typeIdRef: SQL,
): SQL<OfficeEquipmentModelSpecDto[]> {
  return sql<OfficeEquipmentModelSpecDto[]>`COALESCE((
    SELECT json_agg(
             json_build_object(
               'specId', s."id",
               'code', s."code",
               'name', s."name",
               'showInList', s."show_in_list",
               'sortOrder', s."sort_order",
               'value', CASE
                          WHEN v."id" IS NULL THEN NULL
                          ELSE json_build_object(
                                 'id', v."id",
                                 'code', v."code",
                                 'name', v."name",
                                 'shortName', v."short_name"
                               )
                        END
             )
             ORDER BY s."sort_order", s."name"
           )
      FROM ${officeEquipmentTypeSpecs} ts
      JOIN ${officeEquipmentSpecs} s
        ON s."id" = ts."spec_id" AND s."is_active"
      LEFT JOIN ${officeEquipmentModelSpecs} ms
        ON ms."spec_id" = s."id" AND ms."model_id" = ${modelIdRef}
      LEFT JOIN ${officeEquipmentSpecValues} v
        ON v."id" = ms."value_id"
     WHERE ts."equipment_type_id" = ${typeIdRef}
  ), '[]'::json)`;
}

/** Минимум от транзакции: сервис зовут и из `db`, и из `db.transaction`. */
type Executor = Pick<typeof db, 'select' | 'insert' | 'delete'>;

/**
 * Записать значения характеристик модели (Р3, Р5).
 *
 * `valueId: null` — «сотри значение»: строка удаляется, и «н/д» снова означает отсутствие строки, а
 * не третье значение перечня. Характеристики, не пришедшей в запросе, функция не трогает вовсе —
 * от этого зависит обмен файлом, где пустая ячейка обязана оставить заведённое как есть (Р12).
 *
 * Проверки здесь говорят словами то, что схема и так держит замками
 * (`office_equipment_model_specs_type_spec_fk`, `…_value_fk`): человек, приславший чужую
 * характеристику, заслуживает ответа о предмете, а не кода `23503` из драйвера.
 */
export async function applyModelSpecs(
  tx: Executor,
  input: { modelId: string; equipmentTypeId: string; specs: OfficeEquipmentModelSpecInput[] },
): Promise<void> {
  const { modelId, equipmentTypeId, specs } = input;
  if (specs.length === 0) return;

  const seen = new Set<string>();
  for (const s of specs) {
    if (seen.has(s.specId)) {
      throw err.badRequest('Характеристика прислана дважды', { specs: 'Повтор характеристики' });
    }
    seen.add(s.specId);
  }

  // Что этому типу вообще положено — одним запросом, а не по одной характеристике: набор мал, а
  // ответ нужен и для проверки принадлежности, и для проверки значения.
  const allowed = await tx
    .select({
      specId: officeEquipmentSpecs.id,
      name: officeEquipmentSpecs.name,
      isActive: officeEquipmentSpecs.isActive,
    })
    .from(officeEquipmentTypeSpecs)
    .innerJoin(officeEquipmentSpecs, eq(officeEquipmentSpecs.id, officeEquipmentTypeSpecs.specId))
    .where(eq(officeEquipmentTypeSpecs.equipmentTypeId, equipmentTypeId));
  const allowedById = new Map(allowed.map((a) => [a.specId, a]));

  const valueIds = specs.map((s) => s.valueId).filter((v): v is string => v !== null);
  const values = valueIds.length
    ? await tx
        .select({ id: officeEquipmentSpecValues.id, specId: officeEquipmentSpecValues.specId })
        .from(officeEquipmentSpecValues)
        .where(inArray(officeEquipmentSpecValues.id, valueIds))
    : [];
  const valueById = new Map(values.map((v) => [v.id, v]));

  for (const s of specs) {
    const spec = allowedById.get(s.specId);
    if (!spec) {
      throw err.badRequest('У этого типа техники такой характеристики не спрашивают', {
        specs: 'Характеристика не относится к типу',
      });
    }
    if (!spec.isActive && s.valueId !== null) {
      throw err.badRequest(`Характеристика «${spec.name}» погашена`, {
        specs: 'Характеристика погашена',
      });
    }
    if (s.valueId === null) continue;
    const value = valueById.get(s.valueId);
    if (!value) {
      throw err.badRequest('Значение характеристики не найдено', { specs: 'Значение не найдено' });
    }
    if (value.specId !== s.specId) {
      throw err.badRequest(`Значение не из характеристики «${spec.name}»`, {
        specs: 'Значение другой характеристики',
      });
    }
  }

  // Сначала снимаем присланное, потом кладём заново: «поменять значение» и «стереть» — одна и та
  // же операция с точки зрения строки, а `ON CONFLICT` пришлось бы дополнять отдельным удалением
  // для `null` и разъезжался бы с ним при первой правке.
  await tx
    .delete(officeEquipmentModelSpecs)
    .where(
      and(
        eq(officeEquipmentModelSpecs.modelId, modelId),
        inArray(officeEquipmentModelSpecs.specId, [...seen]),
      ),
    );

  const rows = specs
    .filter((s) => s.valueId !== null)
    .map((s) => ({
      modelId,
      equipmentTypeId,
      specId: s.specId,
      valueId: s.valueId as string,
    }));
  if (rows.length) await tx.insert(officeEquipmentModelSpecs).values(rows);
}
