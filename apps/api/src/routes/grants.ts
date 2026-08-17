import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { and, count, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import {
  createGrantSchema,
  GRANT_CONFLICT_CODES,
  grantListQuerySchema,
  grantUpdatePreviewSchema,
  updateGrantSchema,
  validateGrantAssignment,
  type GrantDto,
  type GrantHoldersConflictDetailsDto,
  type GrantHolderViolationsDto,
  type GrantImpactInput,
  type GrantImpactUserDto,
  type GrantValidationDetailsDto,
  type GrantViolation,
  type Permission,
  type Role,
} from '@technic/contracts';
import { requirePrincipal } from '../auth/plugin';
import { revokeAllForUser } from '../auth/sessions';
import { db } from '../db/client';
import { grantPermissions, grantRoles, grants } from '../db/schema';
import { writeAudit } from '../lib/audit';
import { err } from '../lib/errors';
import { orderByFrom, pageParams, searchCondition } from '../lib/pagination';
import { pgErrorOf } from '../lib/pg-error';
import {
  assertImpactUnchanged,
  bumpAuthVersions,
  compositionByGrantIds,
  compositionOfGrant,
  grantCardOf,
  grantDtoOf,
  grantImpactDtoOf,
  holderCountByGrantIds,
  holderDtoOf,
  holdersOfGrant,
  lockGrant,
  lockUsers,
  outcomesOfHolders,
  type GrantComposition,
  type HolderOutcome,
  type HolderRow,
} from '../services/grant-catalog';

/**
 * Каталог назначаемых полномочий (ADR 0106, этап 3 плана реструктуризации; §12 — экраны, §13.1 —
 * жизненный цикл): список, карточка с реестром выдач, конструктор пользовательского набора, правка
 * и мягкое удаление.
 *
 * **Закрыт `users.manage` целиком, и другого права здесь не бывает.** Право невыдаваемое
 * (`NON_GRANTABLE_PERMISSIONS`), то есть достаётся только роли администратора, — а собственного
 * права каталог не заводит намеренно: право, которым набирают права, собранное набором, замыкает
 * модель саму на себя (решение 6, инвариант 1). Роль по имени страж при этом не спрашивает: условие
 * доступа маршрута выражается правом, и «только `admin`» здесь означает ровно «только тот, у кого
 * есть невыдаваемое право» (план §16, решение о конструкторе).
 *
 * **Выдача и отзыв назначения живут не здесь** (`routes/user-grants.ts`): их цель — учётка, и
 * правятся они из её карточки. Пересекаются две волны на одном правиле блокировок и на одном
 * отпечатке последствий — то и другое поэтому лежит в `services/grant-catalog.ts`.
 *
 * **Порядок операции один на все ручки** (решение 7): строка набора `FOR UPDATE` → строки держателей
 * по возрастанию `user_id` → пересчёт эффективных прав под блокировками → сверка отпечатка → барьеры →
 * запись, `authVersion + 1` и журнал одной транзакцией.
 */

const idParams = z.object({ id: z.string().uuid() });

/** Сортируемые колонки каталога — ровно те, что объявлены в `GRANT_SORT_FIELDS`. */
const sortCols = {
  code: grants.code,
  name: grants.name,
  isSystem: grants.isSystem,
  createdAt: grants.createdAt,
};

/**
 * Какое поле конструктора виновато в нарушении. Пометка поля идёт рядом со списком нарушений по той
 * же причине, по которой несовместимая надстройка помечает `addons` в форме учётки: перечень прав в
 * конструкторе один на все роли, и «почему не подошло» из общего текста не видно.
 */
function fieldOf(violation: GrantViolation): 'permissions' | 'roles' {
  return violation.code === 'role_not_grantable' ? 'roles' : 'permissions';
}

/**
 * Отказ по барьерам выдачи. 400 со списком нарушений, а не 409: запрос не устарел и повторять его
 * незачем — он описывает набор, которого модель не допускает. Сообщение — текст первого нарушения:
 * оно уже написано словами («право „Ведение учётных записей“ не выдаётся полномочиями…»), и второй
 * общий текст поверх него читатель увидел бы вместо причины.
 */
function refuse(violations: readonly GrantViolation[], holders: GrantHolderViolationsDto[]): never {
  const first = violations[0] ?? holders[0]?.violations[0];
  const details: GrantValidationDetailsDto = { violations: [...violations], holders };
  const fields: Record<string, string> = {};
  for (const violation of violations) {
    const field = fieldOf(violation);
    if (!fields[field]) fields[field] = violation.message;
  }
  throw err.badRequest(
    first?.message ?? 'Набор нарушает правила выдачи полномочия',
    Object.keys(fields).length > 0 ? fields : undefined,
    details,
  );
}

/** Барьеры набора: невыдаваемое право, роль `driver`, запрещённая клетка матрицы осей. */
function checkComposition(params: {
  name: string;
  permissions: readonly Permission[];
  roles: readonly Role[];
}): readonly GrantViolation[] {
  return validateGrantAssignment({
    roles: params.roles,
    permissions: params.permissions,
    // Субъекта в этой проверке нет — и `null` здесь осознанный ответ, а не пропуск: барьеры итога
    // считаются отдельно, по каждому держателю. У создания держателей нет вовсе.
    subjectPermissionsAfter: null,
    subjectRole: null,
    grantLabel: params.name,
  });
}

/**
 * Барьеры итога — по эффективным правам каждого держателя после операции (§13.1).
 *
 * Состав и роли в вызов не передаются (`permissions: []`, `roles: []`): барьеры набора уже
 * посчитаны выше, один раз, и повтор дал бы то же нарушение по разу на держателя. Держателю
 * остаются требования прав друг к другу и разделение обязанностей — то, что вне итога не считается.
 */
function checkOutcomes(
  name: string,
  outcomes: readonly {
    userId: string;
    fullName: string;
    role: Role | null;
    permissionsAfter: Permission[];
  }[],
): GrantHolderViolationsDto[] {
  const out: GrantHolderViolationsDto[] = [];
  for (const outcome of outcomes) {
    const violations = validateGrantAssignment({
      roles: [],
      permissions: [],
      subjectPermissionsAfter: outcome.permissionsAfter,
      subjectRole: outcome.role,
      grantLabel: name,
    });
    if (violations.length > 0) {
      out.push({ userId: outcome.userId, fullName: outcome.fullName, violations: [...violations] });
    }
  }
  return out;
}

/**
 * Гонка двух заведений доходит до уникального индекса: проверка по `SELECT` её не ловит — между
 * чтением и записью код мог занять параллельный запрос. Без разбора `23505` администратор получил бы
 * 500 там, где ему нужно то же сообщение, что и при обычной занятости кода (тем же приёмом
 * разбирается гонка привязки работника в `routes/users.ts`).
 */
function asCodeConflict(e: unknown): unknown {
  const pg = pgErrorOf(e);
  if (pg?.code === '23505' && pg.constraint === 'grants_code_unique') {
    return err.conflict('Полномочие с таким кодом уже существует', {
      code: GRANT_CONFLICT_CODES.codeTaken,
    });
  }
  return e;
}

/**
 * Достройка присланного состава из строки набора: отсутствие поля — «не трогать».
 *
 * Одна функция на предпросмотр и на сохранение, и это обязательное свойство: пост-состав входит в
 * отпечаток, поэтому достраивать пропущенные поля они должны **одинаково** — разойдись они, отпечаток
 * не совпал бы никогда, и правка стала бы невыполнимой.
 *
 * Дубликаты снимаются здесь же. Форма прислать их не должна, но если пришлют — отпечаток их не
 * различает (каноническая строка считается по множеству), а `INSERT` различает и падает на первичном
 * ключе `grant_permissions`.
 */
function resolveProposal(
  row: { name: string },
  composition: GrantComposition,
  body: { name?: string; permissions?: Permission[]; roles?: Role[] },
): { name: string; permissions: Permission[]; roles: Role[] } {
  return {
    name: body.name ?? row.name,
    permissions: body.permissions ? [...new Set(body.permissions)] : composition.permissions,
    roles: body.roles ? [...new Set(body.roles)] : composition.roles,
  };
}

/** Разница двух составов: что появилось и что ушло. Порядок сохраняется — он словарный. */
function diffOf<T>(before: readonly T[], after: readonly T[]): { added: T[]; removed: T[] } {
  const had = new Set(before);
  const has = new Set(after);
  return {
    added: after.filter((v) => !had.has(v)),
    removed: before.filter((v) => !has.has(v)),
  };
}

/**
 * Набор под блокировкой вместе с его нынешним составом — общее начало правки и удаления.
 *
 * Мягко удалённый набор отвечает 404, а не 410 и не карточкой: удалённый набор не действует ни у
 * кого (`grantCodesExpr` отсекает его по `deleted_at`), и править или удалять в нём нечего. Строка
 * при этом остаётся навсегда — реестр выдач обязан объяснять прошлые назначения.
 */
async function lockForWrite(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  id: string,
): Promise<{
  row: NonNullable<Awaited<ReturnType<typeof lockGrant>>>;
  composition: GrantComposition;
}> {
  const row = await lockGrant(tx, id);
  if (!row || row.deletedAt) throw err.notFound('Полномочие не найдено');
  return { row, composition: await compositionOfGrant(tx, id) };
}

/**
 * Держатели под блокировкой — шаг 2 порядка, с перечитыванием списка.
 *
 * Перечитывание — страховка на случай операции, которая нарушит порядок захвата. Выдача и отзыв
 * берут строку набора первыми (`routes/user-grants.ts`), поэтому новый держатель между чтением
 * списка и блокировкой его строки появиться не может, и списки сходятся всегда. Проверка остаётся
 * именно затем, что это свойство держится на дисциплине чужого файла: обойди её кто-нибудь — правка
 * применит состав к держателю, которого не видела и не пересчитала, и увидим мы это как 409 с
 * просьбой повторить, а не как молча разошедшийся доступ.
 */
async function lockHolders(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  grantId: string,
  roles: readonly Role[],
): Promise<HolderRow[]> {
  const before = await holdersOfGrant(tx, grantId, roles);
  await lockUsers(
    tx,
    before.map((holder) => holder.userId),
  );
  const after = await holdersOfGrant(tx, grantId, roles);
  const ids = (list: readonly HolderRow[]): string => list.map((h) => h.assignmentId).join('|');
  if (ids(before) !== ids(after)) {
    throw err.conflict('Полномочие выдавали, пока мы его брали, — повторите попытку');
  }
  return after;
}

/**
 * Слагаемые отпечатка правки набора: подтверждаемый пост-состав плюс всё, от чего зависел расчёт, —
 * версия, назначения держателей и `authVersion` каждого из них (§13.1).
 *
 * Собирается одной функцией на предпросмотр и на сохранение: две копии этого списка означали бы, что
 * предпросмотр считает отпечаток по четырём слагаемым, а проверка — по пяти, и подтверждение не
 * сошлось бы никогда.
 */
function updateImpactInput(params: {
  grantId: string;
  version: number;
  permissions: readonly Permission[];
  roles: readonly Role[];
  holders: readonly HolderRow[];
}): GrantImpactInput {
  return {
    operation: 'update',
    grantId: params.grantId,
    // Цель правки — сам набор: одного пострадавшего у неё нет, их столько, сколько держателей.
    userId: null,
    permissions: params.permissions,
    roles: params.roles,
    version: params.version,
    assignmentIds: params.holders.map((holder) => holder.assignmentId),
    accounts: params.holders.map((holder) => ({
      userId: holder.userId,
      authVersion: holder.authVersion,
    })),
  };
}

/**
 * Держатели в предпросмотре — все, включая тех, у кого дельта пустая: «затронет 7 учёток» и «у трёх
 * из них ничего не изменится» — разные утверждения, и второе администратору нужно не меньше.
 */
function impactUsersOf(
  outcomes: readonly HolderOutcome[],
  holders: readonly HolderRow[],
): GrantImpactUserDto[] {
  const mismatched = new Map(holders.map((holder) => [holder.userId, holder.roleMismatch]));
  return outcomes.map((outcome) => ({
    userId: outcome.userId,
    fullName: outcome.fullName,
    role: outcome.role,
    added: outcome.delta.added,
    removed: outcome.delta.removed,
    roleMismatch: mismatched.get(outcome.userId) ?? false,
  }));
}

export default async function grantsRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const guards = { preHandler: [app.authenticate, app.requirePermission('users.manage')] };

  /**
   * Каталог: состав, совместимые роли и число держателей у каждого набора.
   *
   * Число держателей считается отдельным агрегатом, а не соединением в основном запросе: строка
   * набора размножилась бы по числу выдач, и `total` считал бы назначения вместо наборов — тем же
   * приёмом отбираются объекты учётки в списке пользователей.
   */
  r.get('/', { ...guards, schema: { querystring: grantListQuerySchema } }, async (req) => {
    const q = req.query;
    const where = and(
      // Удалённые наборы каталог не показывает: они не действуют ни у кого, а строка живёт ради
      // прошлых назначений. Фильтра «показать архив» здесь нет намеренно — реестр выдач читает
      // назначения, а не каталог.
      isNull(grants.deletedAt),
      q.kind === 'all' ? undefined : eq(grants.isSystem, q.kind === 'system'),
      searchCondition(q.search, [grants.code, grants.name]),
    );
    const p = pageParams(q);
    const [rows, totalRows] = await Promise.all([
      db
        .select()
        .from(grants)
        .where(where)
        .orderBy(orderByFrom(sortCols, q.sortBy, q.sortOrder, 'name'))
        .limit(p.limit)
        .offset(p.offset),
      db.select({ c: count() }).from(grants).where(where),
    ]);
    const ids = rows.map((row) => row.id);
    const [composition, holderCounts] = await Promise.all([
      compositionByGrantIds(db, ids),
      holderCountByGrantIds(db, ids),
    ]);
    const items: GrantDto[] = rows.map((row) =>
      grantDtoOf(
        row,
        composition.get(row.id) ?? { permissions: [], unknownPermissions: [], roles: [] },
        holderCounts.get(row.id) ?? 0,
      ),
    );
    return { items, total: Number(totalRows[0]!.c), page: p.page, pageSize: p.pageSize };
  });

  /** Карточка набора вместе с реестром его выдач (§12): кому выдано, кем, когда и на чём. */
  r.get('/:id', { ...guards, schema: { params: idParams } }, async (req) => {
    const card = await grantCardOf(db, req.params.id);
    if (!card) throw err.notFound('Полномочие не найдено');
    return card;
  });

  /**
   * Конструктор: пользовательский набор целиком (§12.2 — «Новое полномочие целиком: конструктор,
   * да»).
   *
   * Системным набор здесь стать не может — признака в теле нет вовсе, а код из
   * `SYSTEM_GRANT_CODES` схема не принимает: сквозную область таблица кода ищет по коду, и
   * пользовательская строка под кодом визы ИТ получила бы область двух модулей оргтехники.
   *
   * Держателей у нового набора нет по построению, поэтому барьеры итога здесь не считаются: считать
   * их не по кому, а `subjectPermissionsAfter: null` — это и есть «субъекта в операции нет».
   * Блокировок по той же причине не берётся: строки, которую надо сериализовать, ещё не существует,
   * а уникальность кода держит индекс.
   */
  r.post('/', { ...guards, schema: { body: createGrantSchema } }, async (req, reply) => {
    const actor = requirePrincipal(req);
    const body = req.body;
    const violations = checkComposition(body);
    if (violations.length > 0) refuse(violations, []);

    const created = await db.transaction(async (tx) => {
      const [dup] = await tx
        .select({ id: grants.id })
        .from(grants)
        .where(eq(grants.code, body.code));
      // Код держится за набором навсегда, в том числе за удалённым (`grants_code_unique` без
      // `WHERE deleted_at IS NULL`): новый набор под кодом удалённого рассказывал бы историю за него.
      if (dup) {
        throw err.conflict('Полномочие с таким кодом уже существует', {
          code: GRANT_CONFLICT_CODES.codeTaken,
        });
      }
      let created: { id: string } | undefined;
      try {
        [created] = await tx
          .insert(grants)
          .values({
            code: body.code,
            name: body.name,
            description: body.description,
            createdBy: actor.id,
          })
          .returning({ id: grants.id });
      } catch (e) {
        throw asCodeConflict(e);
      }
      const grantId = created!.id;
      if (body.permissions.length > 0) {
        await tx
          .insert(grantPermissions)
          .values([...new Set(body.permissions)].map((permission) => ({ grantId, permission })));
      }
      if (body.roles.length > 0) {
        await tx
          .insert(grantRoles)
          .values([...new Set(body.roles)].map((role) => ({ grantId, role })));
      }
      return grantId;
    });

    await writeAudit({
      actorUserId: actor.id,
      action: 'grant.create',
      entityType: 'grant',
      entityId: created,
      metadata: {
        grantCode: body.code,
        grantName: body.name,
        permissions: body.permissions,
        roles: body.roles,
      },
    });
    reply.code(201);
    return (await grantCardOf(db, created))!;
  });

  /**
   * Предпросмотр правки набора (решение 7): что изменится у каждого держателя и отпечаток того, из
   * чего это посчитано.
   *
   * **Это чтение, и блокировок оно не берёт.** Держать строку набора и строки держателей между
   * показом экрана и нажатием кнопки нельзя — правка одного администратора остановила бы работу всех
   * остальных на время, которое задаёт человек. Отсюда и весь смысл отпечатка: расчёт показывается
   * без блокировок, а применяется под ними, и несовпадение отпечатка — это ответ «за это время
   * изменилось то, от чего расчёт зависел».
   *
   * Нарушения барьеров возвращаются **в теле**, а не отказом: предпросмотр обязан сказать «так
   * сохранить нельзя» до нажатия, и отказ вместо ответа лишил бы экран и дельты, и причины сразу.
   */
  r.post(
    '/:id/preview',
    { ...guards, schema: { params: idParams, body: grantUpdatePreviewSchema } },
    async (req) => {
      const { id } = req.params;
      const [row] = await db.select().from(grants).where(eq(grants.id, id));
      if (!row || row.deletedAt) throw err.notFound('Полномочие не найдено');
      const composition = await compositionOfGrant(db, id);
      const proposal = resolveProposal(row, composition, req.body);

      // Держатели читаются по **предлагаемым** ролям: пометка «роль не в списке» — это как раз то,
      // что администратор должен увидеть до сохранения, а не после.
      const holders = await holdersOfGrant(db, id, proposal.roles);
      const outcomes = await outcomesOfHolders(db, {
        grantId: id,
        holders,
        before: composition,
        after: proposal,
      });
      return grantImpactDtoOf({
        input: updateImpactInput({
          grantId: id,
          version: row.version,
          permissions: proposal.permissions,
          roles: proposal.roles,
          holders,
        }),
        grantCode: row.code,
        grantName: proposal.name,
        users: impactUsersOf(outcomes, holders),
        violations: checkComposition(proposal),
        holders: checkOutcomes(proposal.name, outcomes),
      });
    },
  );

  /**
   * Правка набора — единственная операция портала, которая меняет доступ сразу многим (§12).
   *
   * Системный набор не редактируется вовсе (решение 2): его состав и код живут в коде, а строка в
   * базе — их отражение. Отказ поэтому 409 со своим кодом, а не 403: запрет не в правах
   * запрашивающего — у администратора они есть, — а в самой строке.
   *
   * Всё остальное — порядок решения 7: набор `FOR UPDATE`, держатели по возрастанию `user_id`,
   * пересчёт итога под блокировками, сверка отпечатка, барьеры, запись и `authVersion` одной
   * транзакцией.
   *
   * **Порядок проверок объявлен и не случаен.** Барьеры присланного состава идут до блокировок: они
   * не зависят от состояния базы вовсе, и отвечать на невыдаваемое право «данные устарели» было бы
   * неправдой о причине. Отпечаток — сразу после блокировок и **до** барьеров итога: приговор итога
   * считается по тому же состоянию, что и отпечаток, и назвать администратору виновного держателя из
   * данных, которых он не видел, значило бы отправить его исправлять не то.
   */
  r.patch(
    '/:id',
    { ...guards, schema: { params: idParams, body: updateGrantSchema } },
    async (req) => {
      const actor = requirePrincipal(req);
      const { id } = req.params;
      const body = req.body;

      const result = await db.transaction(async (tx) => {
        const { row, composition } = await lockForWrite(tx, id);
        if (row.isSystem) {
          throw err.conflict(
            'Системное полномочие не редактируется: его состав и код живут в коде портала. Создайте пользовательскую копию.',
            { code: GRANT_CONFLICT_CODES.isSystem },
          );
        }
        if (row.version !== body.expectedVersion) {
          throw err.conflict(
            `Полномочие изменил другой администратор (версия ${row.version}, а не ${body.expectedVersion}) — откройте карточку заново`,
          );
        }

        const { name, permissions, roles } = resolveProposal(row, composition, body);
        const description = body.description ?? row.description;
        /*
         * Строки-сироты (право, снятое из словаря выкатом) уносит только правка **состава**:
         * присланный состав заменяет прежний целиком, а право, которого портал больше не знает, в
         * присланном быть не может — администратор отметил галочками то, что ему показали.
         *
         * Правка одного названия сироту не трогает намеренно: доступа она не даёт, и снести её
         * «заодно» значило бы поменять состав набора там, где никто состав не открывал, — а заодно
         * поднять всем держателям `authVersion` за переименование.
         */
        const orphans = body.permissions === undefined ? [] : composition.unknownPermissions;

        const violations = checkComposition({ name, permissions, roles });
        if (violations.length > 0) refuse(violations, []);

        const holders = await lockHolders(tx, id, roles);
        // Отпечаток пересчитывается здесь — уже под блокировками и из **присланного** тела: версия
        // ловит чужую правку состава, а этот хеш — то, чего версия не ловит вовсе (набор выдали ещё
        // одному человеку, держателю сменили роль или другой набор).
        assertImpactUnchanged(
          updateImpactInput({ grantId: id, version: row.version, permissions, roles, holders }),
          body.expectedImpactHash,
        );
        const outcomes = await outcomesOfHolders(tx, {
          grantId: id,
          holders,
          before: composition,
          after: { permissions, roles },
        });
        const holderViolations = checkOutcomes(name, outcomes);
        if (holderViolations.length > 0) refuse([], holderViolations);

        const permissionDiff = diffOf(composition.permissions, permissions);
        const roleDiff = diffOf(composition.roles, roles);
        // Доступ держателей меняют обе половины состава: права — прямо, роли — гейтом совместимости
        // (набор, чью роль убрали из списка, перестаёт давать права её держателям). Название и
        // описание не меняют ничего, и гасить за них выданные токены незачем.
        const accessChanged =
          permissionDiff.added.length > 0 ||
          permissionDiff.removed.length > 0 ||
          orphans.length > 0 ||
          roleDiff.added.length > 0 ||
          roleDiff.removed.length > 0;

        await tx
          .update(grants)
          .set({
            name,
            description,
            // Версия растёт на каждой принятой правке, а не только на правке состава: `expectedVersion`
            // отвечает на «то ли я правлю, что видел», и переименование делает прежнюю карточку
            // такой же устаревшей.
            version: row.version + 1,
            updatedAt: new Date(),
          })
          .where(eq(grants.id, id));

        for (const permission of permissionDiff.removed) {
          await tx
            .delete(grantPermissions)
            .where(
              and(eq(grantPermissions.grantId, id), eq(grantPermissions.permission, permission)),
            );
        }
        // Сироты — тем же `DELETE`, но списком, посчитанным выше: оставленная строка молча дожила бы
        // до выката, вернувшего право в словарь, и набор стал бы другим сам собой.
        for (const permission of orphans) {
          await tx
            .delete(grantPermissions)
            .where(
              and(eq(grantPermissions.grantId, id), eq(grantPermissions.permission, permission)),
            );
        }
        if (permissionDiff.added.length > 0) {
          await tx
            .insert(grantPermissions)
            .values(permissionDiff.added.map((permission) => ({ grantId: id, permission })));
        }
        for (const role of roleDiff.removed) {
          await tx
            .delete(grantRoles)
            .where(and(eq(grantRoles.grantId, id), eq(grantRoles.role, role)));
        }
        if (roleDiff.added.length > 0) {
          await tx.insert(grantRoles).values(roleDiff.added.map((role) => ({ grantId: id, role })));
        }

        const affected = accessChanged ? holders.map((holder) => holder.userId) : [];
        await bumpAuthVersions(tx, affected);

        return {
          affected,
          audit: {
            grantCode: row.code,
            grantName: name,
            version: { from: row.version, to: row.version + 1 },
            ...(name === row.name ? {} : { name: { from: row.name, to: name } }),
            descriptionChanged: description !== row.description,
            permissionsAdded: permissionDiff.added,
            permissionsRemoved: [...permissionDiff.removed, ...orphans],
            rolesAdded: roleDiff.added,
            rolesRemoved: roleDiff.removed,
            holders: holders.length,
            accessChanged,
          },
        };
      });

      // Выданные refresh-токены гасятся вне транзакции — сессии живут своей таблицей, и откатывать
      // их вместе с составом нечем (тем же порядком правится область в справочнике отделов).
      for (const userId of result.affected) await revokeAllForUser(userId);
      await writeAudit({
        actorUserId: actor.id,
        action: 'grant.update',
        entityType: 'grant',
        entityId: id,
        metadata: result.audit,
      });
      return (await grantCardOf(db, id))!;
    },
  );

  /**
   * Мягкое удаление пользовательского набора (§13.1).
   *
   * Выданный набор не удаляется: 409 со списком держателей, сначала отзыв. Каскадом это делать
   * нельзя — `user_grants.grant_id` стоит под `RESTRICT` именно затем, чтобы снятие доступа у живых
   * учёток не прошло мимо пересчёта прав, `authVersion` и журнала.
   *
   * Системный набор не удаляется никогда (§10): его код — ключ таблиц кода, и удаление сделало бы
   * двойную запись переходных шагов вставкой в никуда.
   */
  r.delete('/:id', { ...guards, schema: { params: idParams } }, async (req) => {
    const actor = requirePrincipal(req);
    const { id } = req.params;

    const removed = await db.transaction(async (tx) => {
      const { row, composition } = await lockForWrite(tx, id);
      if (row.isSystem) {
        throw err.conflict(
          'Системное полномочие не удаляется: оно заведено кодом портала и на него ссылается таблица сквозной области',
          { code: GRANT_CONFLICT_CODES.isSystem },
        );
      }
      // Держатели берутся под блокировку до отказа, а не после: без блокировки «держателей нет»
      // могло бы разойтись с состоянием на момент удаления — выдача, легшая между проверкой и
      // `UPDATE`, оставила бы назначение на удалённый набор.
      const holders = await lockHolders(tx, id, composition.roles);
      if (holders.length > 0) {
        // Список держателей идёт в теле отказа целиком: §13.1 требует именно его — «сначала отзыв,
        // потом удаление» без имён означало бы поиск держателей по карточкам учёток.
        const details: GrantHoldersConflictDetailsDto = { holders: holders.map(holderDtoOf) };
        throw err.conflict(
          `Полномочие выдано учётным записям (${holders.length}) — сначала отзовите выдачи, затем удаляйте`,
          { code: GRANT_CONFLICT_CODES.hasHolders, details },
        );
      }
      await tx
        .update(grants)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(eq(grants.id, id));
      return { code: row.code, name: row.name, composition };
    });

    await writeAudit({
      actorUserId: actor.id,
      action: 'grant.delete',
      entityType: 'grant',
      entityId: id,
      metadata: {
        grantCode: removed.code,
        grantName: removed.name,
        permissions: removed.composition.permissions,
        roles: removed.composition.roles,
      },
    });
    return { id, deleted: true };
  });
}
