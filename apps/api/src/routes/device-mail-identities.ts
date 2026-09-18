import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { and, desc, eq, ilike, inArray, isNull, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import {
  decodeDeviceCursor,
  deviceIdentityCreateSchema,
  deviceIdentityQuerySchema,
  deviceIdentityRevokeSchema,
  encodeDeviceCursor,
  equipmentCursorInstantIsExact,
  isIdentifyingKind,
  normalizeIdentityValue,
  officeEquipmentTitle,
  type DeviceIdentityApplyResultDto,
  type DeviceIdentityDto,
  type DeviceIdentityKind,
  type DeviceTelemetryPageDto,
} from '@technic/contracts';
import { db } from '../db/client';
import { constructionObjects, deviceMailIdentities, officeEquipment, users } from '../db/schema';
import { requirePrincipal } from '../auth/plugin';
import { err } from '../lib/errors';
import { bindDeviceMailIdentity, countBindTargets } from '../services/device-mail/apply';

/**
 * РЕЕСТР КЛЮЧЕЙ ОПОЗНАНИЯ — вторая дверь к резолву (план
 * `docs/office-equipment-mail-identity-ui-plan.md`, §6.1).
 *
 * ЗАЧЕМ ОН, ЕСЛИ ПРИВЯЗАТЬ МОЖНО ИЗ ОЧЕРЕДИ. Привязка из очереди требует ПИСЬМА: сначала аппарат
 * должен написать, и только потом человек вправе сказать, чей он. Для парка в три сотни карточек
 * это означает три сотни писем в очереди и три сотни нажатий — при том, что ИТ-служба знает
 * серийники заранее и держит их в учёте. Здесь ключ заводится ДО первого письма, а заодно
 * появляется то, чего у привязки не было вовсе: возможность увидеть её и снять.
 *
 * РЕЗОЛВ ЭТИ РУЧКИ НЕ МЕНЯЮТ НИ НА СТРОКУ (ADR 0197 в силе): они кормят ту же первую ступень, что
 * и привязка из очереди, и пишут в ту же таблицу тем же слоем `apply.ts`. Второй писатель привязок
 * был бы вторым носителем правила «один живой ключ ведёт к одному аппарату».
 *
 * ПРАВО ОДНО — `officeEquipment.telemetry`, и на чтение тоже: строка реестра несёт серийный номер
 * и сетевое имя аппарата, то есть тот же срез парка в обход области видимости карточек, что и
 * очередь.
 */

const idParams = z.object({ id: z.string().uuid() });

/** Та же ловушка микросекунд, что у очереди: `Date` в JS заканчивается миллисекундой. */
function exactInstant(column: typeof deviceMailIdentities.confirmedAt): SQL<string> {
  return sql<string>`to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}

const registryCursorForm = z.object({
  observedAt: z.string().datetime(),
  id: z.string().uuid(),
});

/** `null` — курсор чужой ленты, битый или с неразбираемыми кусками. Ответ один: `422`. */
function readRegistryCursor(raw: string): { observedAt: string; id: string } | null {
  const decoded = decodeDeviceCursor('device-mail-identities', raw);
  if (!decoded) return null;
  const parsed = registryCursorForm.safeParse(decoded);
  return parsed.success ? parsed.data : null;
}

/**
 * «Строго СТАРШЕ того, на котором остановились»: реестр идёт свежими сверху.
 *
 * Порядок здесь обратный очереди, и это не разнобой. У очереди вопрос «чья очередь» — там старые
 * сверху. У реестра вопрос «что заведено», и заводят его пачками: свежая пачка сверху — это ответ
 * на «применилось ли то, что я только что залил».
 */
function afterCursor(cursor: { observedAt: string; id: string }): SQL {
  const anchor = sql`${cursor.id}::uuid`;
  if (equipmentCursorInstantIsExact(cursor.observedAt)) {
    return sql`(${deviceMailIdentities.confirmedAt}, ${deviceMailIdentities.id})
             < (${cursor.observedAt}::timestamptz, ${anchor})`;
  }
  // Курсор без микросекунд прийти неоткуда, но граница расширяется осознанно: молча потерять
  // строку хуже, чем один раз её повторить.
  return and(
    sql`${deviceMailIdentities.confirmedAt} < ${cursor.observedAt}::timestamptz + interval '1 millisecond'`,
    sql`${deviceMailIdentities.id} <> ${anchor}`,
  )!;
}

/** Живая привязка: снятая остаётся видимой только по просьбе и не опознаёт ничего. */
function liveOnly(): SQL {
  return isNull(deviceMailIdentities.revokedAt);
}

async function loadIdentity(id: string): Promise<{
  id: string;
  kind: DeviceIdentityKind;
  value: string;
  equipmentId: string;
  revokedAt: Date | null;
}> {
  const [row] = await db
    .select({
      id: deviceMailIdentities.id,
      kind: deviceMailIdentities.keyKind,
      value: deviceMailIdentities.keyValue,
      equipmentId: deviceMailIdentities.equipmentId,
      revokedAt: deviceMailIdentities.revokedAt,
    })
    .from(deviceMailIdentities)
    .where(eq(deviceMailIdentities.id, id));
  if (!row) throw err.notFound('Привязка не найдена');
  return { ...row, kind: row.kind as DeviceIdentityKind };
}

/**
 * Отказ слоя применения — словами человеку, а не пятисоткой. Разбирается по приставке, тем же
 * приёмом, что и в очереди: слой применения общий и для будущего коллектора, и своего класса
 * ошибок ради одной ручки в нём не заводят.
 */
function bindRefusal(e: unknown): never {
  if (e instanceof Error && e.message.startsWith('привязка: ')) {
    throw err.unprocessable(e.message.slice('привязка: '.length));
  }
  throw e;
}

export default async function deviceMailIdentityRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const canReview = app.requirePermission('officeEquipment.telemetry');

  /** Реестр: что заведено, кем, когда и к какому аппарату ведёт. */
  r.get(
    '/identities',
    {
      preHandler: [app.authenticate, canReview],
      schema: { querystring: deviceIdentityQuerySchema },
    },
    async (req): Promise<DeviceTelemetryPageDto<DeviceIdentityDto>> => {
      const raw = req.query.cursor;
      const cursor = raw ? readRegistryCursor(raw) : null;
      if (raw && !cursor) {
        throw err.unprocessable('Ссылка на продолжение реестра не читается — откройте её заново', {
          cursor: 'Некорректный курсор',
        });
      }

      const confirmedBy = users;

      const filters: (SQL | undefined)[] = [
        req.query.includeRevoked ? undefined : liveOnly(),
        req.query.kind ? eq(deviceMailIdentities.keyKind, req.query.kind) : undefined,
        req.query.equipmentId
          ? eq(deviceMailIdentities.equipmentId, req.query.equipmentId)
          : undefined,
        // Поиск по значению ключа — по той же нормализованной форме, в которой ключ и лежит:
        // человек вводит серийник как он написан на корпусе, регистр значения не решает.
        req.query.search
          ? ilike(deviceMailIdentities.keyValue, `%${normalizeIdentityValue(req.query.search)}%`)
          : undefined,
        cursor ? afterCursor(cursor) : undefined,
      ];

      const pageSize = req.query.pageSize;
      const rows = await db
        .select({
          id: deviceMailIdentities.id,
          kind: deviceMailIdentities.keyKind,
          value: deviceMailIdentities.keyValue,
          equipmentId: deviceMailIdentities.equipmentId,
          equipmentName: officeEquipment.name,
          equipmentInventory: officeEquipment.inventoryNumber,
          equipmentSerial: officeEquipment.serialNumber,
          objectName: constructionObjects.name,
          confirmedName: confirmedBy.fullName,
          confirmedAt: exactInstant(deviceMailIdentities.confirmedAt),
          note: deviceMailIdentities.note,
          revokedAt: deviceMailIdentities.revokedAt,
          revokeNote: deviceMailIdentities.revokeNote,
          revokedById: deviceMailIdentities.revokedBy,
        })
        .from(deviceMailIdentities)
        .innerJoin(officeEquipment, eq(officeEquipment.id, deviceMailIdentities.equipmentId))
        .leftJoin(constructionObjects, eq(constructionObjects.id, officeEquipment.objectId))
        .leftJoin(confirmedBy, eq(confirmedBy.id, deviceMailIdentities.confirmedBy))
        .where(and(...filters))
        .orderBy(desc(deviceMailIdentities.confirmedAt), desc(deviceMailIdentities.id))
        .limit(pageSize + 1);

      const page = rows.slice(0, pageSize);
      // Имена снявших — вторым запросом, а не третьим join: снятых строк единицы, а join ради них
      // усложнил бы горячий отбор реестра, который смотрят каждый день.
      const revokerIds = page
        .map((row) => row.revokedById)
        .filter((value): value is string => value !== null);
      const revokerNames = new Map<string, string>();
      if (revokerIds.length > 0) {
        const names = await db
          .select({ id: users.id, fullName: users.fullName })
          .from(users)
          .where(inArray(users.id, revokerIds));
        for (const row of names) revokerNames.set(row.id, row.fullName);
      }

      const items: DeviceIdentityDto[] = page.map((row) => ({
        id: row.id,
        kind: row.kind as DeviceIdentityKind,
        value: row.value,
        equipmentId: row.equipmentId,
        equipmentTitle: officeEquipmentTitle({
          name: row.equipmentName,
          inventoryNumber: row.equipmentInventory,
          serialNumber: row.equipmentSerial,
        }),
        equipmentInventoryNumber: row.equipmentInventory,
        objectName: row.objectName ?? '',
        confirmedByName: row.confirmedName ?? '',
        confirmedAt: row.confirmedAt,
        note: row.note,
        revokedAt: row.revokedAt?.toISOString() ?? null,
        revokedByName: row.revokedById ? (revokerNames.get(row.revokedById) ?? '') : '',
        revokeNote: row.revokeNote,
      }));

      const last = page.at(-1);
      const hasMore = rows.length > pageSize;
      return {
        items,
        hasMore,
        nextCursor:
          hasMore && last
            ? encodeDeviceCursor('device-mail-identities', {
                observedAt: last.confirmedAt,
                id: last.id,
              })
            : null,
      };
    },
  );

  /**
   * Завести ключ карточке — БЕЗ ПИСЬМА.
   *
   * Тем же слоем, что и привязка из очереди, поэтому накопленные письма этого аппарата применяются
   * тут же: ключ, заведённый задним числом, обязан подобрать то, что уже лежит непривязанным, —
   * иначе человек заводил бы его дважды, здесь и в очереди.
   */
  r.post(
    '/identities',
    {
      preHandler: [app.authenticate, canReview],
      schema: { body: deviceIdentityCreateSchema },
    },
    async (req, reply): Promise<DeviceIdentityApplyResultDto> => {
      const principal = requirePrincipal(req);
      const body = req.body;
      const outcome = await bindDeviceMailIdentity({
        // Письма нет вовсе: применяется только пачка по опознающему ключу.
        messageId: null,
        equipmentId: body.equipmentId,
        kind: body.kind,
        value: body.value,
        note: body.note,
        confirmedBy: principal.id,
      }).catch(bindRefusal);
      reply.code(201);
      return { ...outcome, kind: body.kind, value: normalizeIdentityValue(body.value) };
    },
  );

  /**
   * Сколько накопленных писем подберёт ключ — до того, как его завели. Тем же отбором, что и
   * применение: второй отбор показывал бы одно число, а применял другое.
   */
  r.get(
    '/identities/targets',
    {
      preHandler: [app.authenticate, canReview],
      schema: {
        querystring: z.object({
          kind: deviceIdentityCreateSchema.shape.kind,
          value: z.string().min(1).max(200),
        }),
      },
    },
    async (req): Promise<{ messages: number; batch: boolean }> => ({
      messages: await countBindTargets(db, {
        messageId: null,
        kind: req.query.kind,
        value: req.query.value,
      }),
      batch: isIdentifyingKind(req.query.kind),
    }),
  );

  /**
   * Снять привязку. НЕОБРАТИМО В ОДНУ СТОРОНУ: строка остаётся видимой, но перестаёт опознавать —
   * и уже записанные показания при этом НЕ откатываются (план §5.1, названная граница). Сказать об
   * этом обязано окно подтверждения, а не журнал.
   */
  r.post(
    '/identities/:id/revoke',
    {
      preHandler: [app.authenticate, canReview],
      schema: { params: idParams, body: deviceIdentityRevokeSchema },
    },
    async (req): Promise<{ ok: true }> => {
      const principal = requirePrincipal(req);
      const identity = await loadIdentity(req.params.id);
      // Повторное снятие — отказ словами, а не тихий успех: «сняли ещё раз» означает, что человек
      // видит не то состояние, которое есть, и молчание здесь оставило бы его в этой уверенности.
      if (identity.revokedAt) throw err.unprocessable('Эта привязка уже снята');
      await db
        .update(deviceMailIdentities)
        .set({
          revokedAt: new Date(),
          revokedBy: principal.id,
          revokeNote: req.body.note,
        })
        .where(
          and(eq(deviceMailIdentities.id, req.params.id), isNull(deviceMailIdentities.revokedAt)),
        );
      return { ok: true };
    },
  );

  /**
   * Применить живой ключ к накопленным непривязанным письмам.
   *
   * Отдельным действием, а не частью заливки файлом: заливка на три сотни строк, каждая из которых
   * тянет пачку писем и запись наблюдений, — это транзакция, которую нельзя ни объяснить, ни
   * отменить. Здесь же человек видит число заранее и нажимает сам.
   */
  r.post(
    '/identities/:id/apply',
    {
      preHandler: [app.authenticate, canReview],
      schema: { params: idParams },
    },
    async (req): Promise<DeviceIdentityApplyResultDto> => {
      const principal = requirePrincipal(req);
      const identity = await loadIdentity(req.params.id);
      if (identity.revokedAt) {
        throw err.unprocessable('Снятая привязка ничего не применяет — заведите ключ заново');
      }
      const outcome = await bindDeviceMailIdentity({
        messageId: null,
        equipmentId: identity.equipmentId,
        kind: identity.kind,
        value: identity.value,
        confirmedBy: principal.id,
      }).catch(bindRefusal);
      return { ...outcome, kind: identity.kind, value: identity.value };
    },
  );
}
