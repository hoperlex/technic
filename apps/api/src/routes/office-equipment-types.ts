import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { and, count, eq, ne } from 'drizzle-orm';
import { z } from 'zod';
import {
  createOfficeEquipmentTypeSchema,
  officeEquipmentTypeListQuerySchema,
  type OfficeEquipmentTypeDto,
  updateOfficeEquipmentTypeSchema,
} from '@technic/contracts';
import { db } from '../db/client';
import { officeEquipment, officeEquipmentTypes, type OfficeEquipmentTypeRow } from '../db/schema';
import { err } from '../lib/errors';
import { pgErrorOf } from '../lib/pg-error';
import { writeAudit } from '../lib/audit';
import { requirePrincipal } from '../auth/plugin';
import { orderByFrom, pageParams, searchCondition } from '../lib/pagination';
import { listSpecsForType } from '../services/office-equipment-specs';

/**
 * Перечень типов оргтехники (ADR 0085): МФУ, принтер, ноутбук, монитор. Ведётся в модальном окне из
 * вкладки справочника (Р34) — сам по себе тип ничего не значит, и отдельная вкладка ради десяти
 * строк не заводится.
 *
 * Права свои, а не справочниковые (Р7): `directories.read` есть у всех ролей, включая коменданта и
 * исполнителя чужого модуля, а `directories.write` открывает весь раздел справочников. Перечень
 * закрыт той же парой, что и сами единицы, — иначе тип заводил бы один человек, а технику вёл
 * другой.
 *
 * Области у типа нет: перечень одинаков для всей компании, сужается по объекту и отделу только
 * список единиц.
 */

const idParams = z.object({ id: z.string().uuid() });

function toDto(r: OfficeEquipmentTypeRow): OfficeEquipmentTypeDto {
  return {
    id: r.id,
    code: r.code,
    name: r.name,
    sortOrder: r.sortOrder,
    isActive: r.isActive,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

/**
 * Один текст и одна пометка поля на обе двери отказа — проверку до записи и разбор `23505` из
 * гонки: человеку всё равно, какая из них сработала, а форме нужно знать, какое поле подсветить
 * (ADR 0094).
 */
const CODE_TAKEN = 'Тип с таким кодом уже существует';
const CODE_TAKEN_FIELDS = { code: 'Такой код уже занят' };

/**
 * Гонка двух заведений одного кода доходит до уникального индекса: чужая незакоммиченная строка
 * проверке ниже не видна, обе транзакции её проходят, и вторая падает на `23505`. Без разбора это
 * 500 — «внутренняя ошибка» там, где человеку нужно то же слово, что и при обычном дубле.
 *
 * Опознаётся кодом и именем ограничения, а не текстом сообщения: текст зависит от версии и локали
 * сервера, а имя индекса задано схемой. Через `pgErrorOf`, потому что drizzle оборачивает ошибку
 * драйвера в свою и на верхнем объекте кода уже нет — прямая проверка молчала бы.
 */
function asTypeCodeConflict(e: unknown): unknown {
  const pg = pgErrorOf(e);
  if (pg?.code === '23505' && pg.constraint === 'office_equipment_types_code_unique') {
    return err.conflict(CODE_TAKEN, { fields: CODE_TAKEN_FIELDS });
  }
  return e;
}

/**
 * Код уникален. Проверяем до вставки, хотя уникальный индекс держит то же самое: нарушение
 * ограничения превратилось бы в 500 с текстом про индекс, а человеку нужно знать, что такой тип уже
 * заведён. Щель между этой проверкой и записью закрывает `asTypeCodeConflict` выше.
 */
async function assertCodeFree(code: string, exceptId?: string): Promise<void> {
  const dup = await db
    .select({ id: officeEquipmentTypes.id })
    .from(officeEquipmentTypes)
    .where(
      and(
        eq(officeEquipmentTypes.code, code),
        exceptId ? ne(officeEquipmentTypes.id, exceptId) : undefined,
      ),
    );
  if (dup.length > 0) throw err.conflict(CODE_TAKEN, { fields: CODE_TAKEN_FIELDS });
}

export default async function officeEquipmentTypesRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const canRead = app.requirePermission('officeEquipment.read');
  const canWrite = app.requirePermission('officeEquipment.write');

  r.get(
    '/',
    {
      preHandler: [app.authenticate, canRead],
      schema: { querystring: officeEquipmentTypeListQuerySchema },
    },
    async (req) => {
      const q = req.query;
      const where = and(
        q.isActive === undefined ? undefined : eq(officeEquipmentTypes.isActive, q.isActive),
        // Ищут и по названию, и по коду: в разговоре тип называют «МФУ», в импорте — `mfp`.
        searchCondition(q.search, [officeEquipmentTypes.name, officeEquipmentTypes.code]),
      );
      const sortCols = {
        name: officeEquipmentTypes.name,
        code: officeEquipmentTypes.code,
        sortOrder: officeEquipmentTypes.sortOrder,
        isActive: officeEquipmentTypes.isActive,
      };
      const p = pageParams(q);
      const [rows, totalRows] = await Promise.all([
        db
          .select()
          .from(officeEquipmentTypes)
          .where(where)
          // Порядок задан руками (`sortOrder`): в выпадающем списке МФУ и принтер должны стоять
          // выше «Прочего», а алфавит поставил бы их как придётся.
          .orderBy(orderByFrom(sortCols, q.sortBy, q.sortOrder, 'sortOrder'))
          .limit(p.limit)
          .offset(p.offset),
        db.select({ c: count() }).from(officeEquipmentTypes).where(where),
      ]);
      return {
        items: rows.map(toDto),
        total: Number(totalRows[0]!.c),
        page: p.page,
        pageSize: p.pageSize,
      };
    },
  );

  r.post(
    '/',
    {
      preHandler: [app.authenticate, canWrite],
      schema: { body: createOfficeEquipmentTypeSchema },
    },
    async (req, reply) => {
      const p = requirePrincipal(req);
      await assertCodeFree(req.body.code);
      const [created] = await db
        .insert(officeEquipmentTypes)
        .values(req.body)
        .returning()
        // Гонка с соседним заведением приходит сюда нарушением индекса — и уходит тем же 409.
        .catch((e: unknown) => {
          throw asTypeCodeConflict(e);
        });
      await writeAudit({
        actorUserId: p.id,
        action: 'officeEquipmentType.create',
        entityType: 'officeEquipmentType',
        entityId: created!.id,
        metadata: { code: created!.code, name: created!.name },
      });
      reply.code(201);
      return toDto(created!);
    },
  );

  /**
   * Характеристики, которые спрашивают у этого типа, со значениями на выбор (план
   * `docs/office-equipment-specs-plan.md`, Р4). Ими форма модели строит поле «Цветность печати»;
   * пустой ответ означает, что у типа таких вопросов не задают вовсе.
   *
   * Ручкой ТИПА, а не среза справочника техники, и тип — в пути, а не в строке запроса. Второе
   * важнее, чем кажется: обязательный параметр строки запроса проверяется схемой ДО `preHandler`,
   * и запрос без права получал бы 400 про незаполненное поле вместо честного 403 (поймано
   * `access-conditions.test.ts`). В пути идентификатор проверяется тем же порядком, что у соседних
   * маршрутов, и отказ по правам приходит первым.
   *
   * Правом чтения справочника: «бывает ли у МФУ цветность» — вопрос про устройство справочника, а
   * не про парк, и области у него нет.
   */
  r.get(
    '/:id/specs',
    { preHandler: [app.authenticate, canRead], schema: { params: idParams } },
    async (req) => await listSpecsForType(req.params.id),
  );

  r.patch(
    '/:id',
    {
      preHandler: [app.authenticate, canWrite],
      schema: { params: idParams, body: updateOfficeEquipmentTypeSchema },
    },
    async (req) => {
      const p = requirePrincipal(req);
      const { id } = req.params;
      // Код правится: перечень наполняется руками, и опечатку в нём нужно исправлять, а не
      // заводить второй тип рядом. Проверка та же, что при заведении, — с исключением себя.
      if (req.body.code !== undefined) await assertCodeFree(req.body.code, id);
      const [updated] = await db
        .update(officeEquipmentTypes)
        .set({ ...req.body, updatedAt: new Date() })
        .where(eq(officeEquipmentTypes.id, id))
        .returning()
        // Вторая такая же дверь: правка кода на занятый соседом упирается в тот же индекс, и
        // проверка выше эту щель не закрывает — чужая незакоммиченная строка ей не видна.
        .catch((e: unknown) => {
          throw asTypeCodeConflict(e);
        });
      if (!updated) throw err.notFound('Тип оргтехники не найден');
      await writeAudit({
        actorUserId: p.id,
        action: 'officeEquipmentType.update',
        entityType: 'officeEquipmentType',
        entityId: id,
      });
      return toDto(updated);
    },
  );

  /**
   * Удаление строкой, а не мягкое (приём складов и категорий ТС): перечень ведут руками, и
   * заведённый по ошибке тип нужно вычищать, а не держать в списках неактивным мусором. Пауза у
   * типа выражается переключателем «Активен» — это другое состояние: «такая техника есть, новую не
   * заводим».
   *
   * Удаляется только тип, на который никто не ссылается, и удалённые единицы считаются наравне с
   * живыми: карточка из архива восстанавливается вместе со своим типом, и снести его сейчас значило
   * бы сделать восстановление невозможным. `ON DELETE RESTRICT` держит то же самое, но проверка до
   * удаления отвечает человеку понятным текстом, а не нарушением внешнего ключа.
   */
  r.delete(
    '/:id',
    { preHandler: [app.authenticate, canWrite], schema: { params: idParams } },
    async (req) => {
      const p = requirePrincipal(req);
      const { id } = req.params;
      const used = await db
        .select({ id: officeEquipment.id })
        .from(officeEquipment)
        .where(eq(officeEquipment.equipmentTypeId, id))
        .limit(1);
      if (used.length > 0) {
        throw err.conflict(
          'Тип используется в карточках оргтехники — вместо удаления снимите отметку «Активен»',
        );
      }
      const [row] = await db
        .delete(officeEquipmentTypes)
        .where(eq(officeEquipmentTypes.id, id))
        .returning({ code: officeEquipmentTypes.code, name: officeEquipmentTypes.name });
      if (!row) throw err.notFound('Тип оргтехники не найден');
      await writeAudit({
        actorUserId: p.id,
        action: 'officeEquipmentType.delete',
        entityType: 'officeEquipmentType',
        entityId: id,
        // Строки больше нет — в журнале остаётся то, чем её называли.
        metadata: { code: row.code, name: row.name },
      });
      return { ok: true };
    },
  );
}
