import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import {
  assignGrantSchema,
  GRANT_CONFLICT_CODES,
  grantAssignmentPreviewSchema,
  revokeGrantQuerySchema,
  roleLabels,
  validateGrantAssignment,
  type GrantAssignmentOperation,
  type GrantAssignmentResultDto,
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
import { grants, userGrants, type GrantRow } from '../db/schema';
import { writeAuditTx } from '../lib/audit';
import { err } from '../lib/errors';
import { pgErrorOf } from '../lib/pg-error';
import {
  assertImpactUnchanged,
  assignedGrantLimitIssue,
  assignmentImpactOf,
  bumpAuthVersions,
  compositionOfGrant,
  grantCardOf,
  grantImpactDtoOf,
  lockGrant,
  lockUsers,
  userGrantStateOf,
  type AssignmentImpact,
  type GrantComposition,
  type UserGrantState,
} from '../services/grant-catalog';

/**
 * Выдача и отзыв назначаемого полномочия учётке (ADR 0106, этап 3; план §12 — сценарий выдачи, §13.1 —
 * жизненный цикл) плюс предпросмотр последствий обеих операций.
 *
 * **Свой файл, но префикс учёток.** Цель этих операций — учётка: журнал пишется на неё, `authVersion`
 * поднимается ей, и находит их разбор «что меняли у этого человека». Поэтому адрес —
 * `/api/v1/users/:id/grants`, а не ветка каталога. Отдельным файлом от `routes/users.ts` потому, что
 * там 1800 строк общей правки учётки, и порядок блокировок «набор → учётка» в её транзакцию не
 * встраивается: правка учётки берёт свою строку первой, а выдача обязана взять первой строку набора
 * (§13.1). Двум разным порядкам захвата в одном обработчике места нет — это дедлок на первом
 * пересечении. Тем же приёмом на один префикс зарегистрированы три файла почтового контура.
 *
 * **Порядок операции — тот же, что у каталога, и обязан быть тем же** (решение 7):
 *
 * 1. строка **набора** `FOR UPDATE`;
 * 2. строка **учётки** `FOR UPDATE`;
 * 3. пересчёт эффективных прав под блокировками;
 * 4. сверка отпечатка последствий, затем барьеры выдачи по итогу;
 * 5. запись, `authVersion + 1`, журнал — одной транзакцией.
 *
 * Пятый шаг исполняется буквально: событие пишется `writeAuditTx` — тем же соединением и без
 * `catch`, — и сбой записи откатывает выдачу целиком (план «полномочия в окне учётки», §5.1).
 * Выданное полномочие, о котором в журнале нет строки, не отвечает на вопрос «кто это выдал», ради
 * которого реестр выдач и заведён.
 *
 * Порядок не переставляется даже там, где кажется естественнее наоборот («операция-то над учёткой»):
 * каталог берёт набор первым, и встречная выдача, начавшая с учётки, получила бы дедлок на первом же
 * пересечении держателей.
 *
 * **Точечной выдачи одного права здесь нет, и её нельзя изобразить.** Тело выдачи принимает только
 * `grantId` — выдать право мимо набора не даёт схема, а не проверка. «Выдано лично» появится второй
 * поставкой (§12), и до тех пор ни один ответ этого файла такой источник не называет: `origin`
 * назначения принимает два значения (`manual`, `migration`), и оба означают набор.
 */

const idParams = z.object({ id: z.string().uuid() });
const assignmentParams = idParams.extend({ grantId: z.string().uuid() });

/**
 * Отказ по барьерам выдачи — тот же 400 с тем же телом, что у каталога (`GrantValidationDetailsDto`):
 * экран раскладывает нарушения по форме, не разбирая текст обратно.
 *
 * Виновник у выдачи один — целевая учётка, — поэтому барьеры итога приходят единственной строкой в
 * `holders`. Собственного вида отказа для «одного держателя» не заводится: тело, у которого форма
 * зависит от числа затронутых, портал разбирал бы двумя ветками.
 */
function refuse(violations: readonly GrantViolation[], holders: GrantHolderViolationsDto[]): never {
  const first = violations[0] ?? holders[0]?.violations[0];
  const details: GrantValidationDetailsDto = { violations: [...violations], holders };
  throw err.badRequest(
    first?.message ?? 'Полномочие нельзя выдать этой учётной записи',
    undefined,
    details,
  );
}

/**
 * Барьеры выдачи по **итогу** (§13.1). Все пять считаются одним вызовом, и вход у него не случаен:
 *
 * - `roles` — роль **держателя**, а не список ролей набора: проверяется выдача конкретному человеку,
 *   и матрица осей обязана сработать на его оси. Отсюда же берётся отказ роли `driver`: кабинет
 *   открывает задание конкретного работника, и добавить к нему чужие права нельзя ни одним способом;
 * - `permissions` — состав выдаваемого набора: он декартово перемножается с ролью держателя;
 * - `subjectPermissionsAfter` — эффективные права **после** операции по всем источникам, а не состав
 *   набора: и «модуль закрывается чтением», и разделение обязанностей считаются только по итогу.
 *
 * У отзыва `roles` и `permissions` пустые, и это не экономия. Выдавать он ничего не выдаёт, поэтому
 * барьеры набора к нему неприменимы — а роль `driver` там означала бы, что снять ошибочно выданное
 * водителю полномочие нельзя. Барьеры итога при этом обязательны и у него: отзыв набора, дававшего
 * право чтения, оставляет держателя с действием в модуле, которого он больше не видит.
 */
function checkAssignment(params: {
  operation: GrantAssignmentOperation;
  state: UserGrantState;
  composition: GrantComposition;
  grantName: string;
  permissionsAfter: readonly Permission[];
}): GrantHolderViolationsDto[] {
  const granting = params.operation === 'assign';
  const violations = validateGrantAssignment({
    roles: granting && params.state.role !== null ? [params.state.role] : [],
    permissions: granting ? params.composition.permissions : [],
    subjectPermissionsAfter: params.permissionsAfter,
    subjectRole: params.state.role,
    grantLabel: params.grantName,
  });
  if (violations.length === 0) return [];
  return [
    {
      userId: params.state.userId,
      fullName: params.state.fullName,
      violations: [...violations],
    },
  ];
}

/**
 * Слагаемые отпечатка выдачи и отзыва (§13.1). Цель — учётка, поэтому в отпечаток входят **все** её
 * назначения и её `authVersion`; состав набора входит нынешним — выдача его не меняет, а версия
 * ловит чужую правку.
 *
 * Собирается одной функцией на предпросмотр и на операцию: разъехавшись, они дали бы отпечаток,
 * который не совпадает никогда.
 */
function assignmentImpactInput(params: {
  operation: GrantAssignmentOperation;
  grantId: string;
  version: number;
  composition: GrantComposition;
  state: UserGrantState;
}): GrantImpactInput {
  return {
    operation: params.operation,
    grantId: params.grantId,
    userId: params.state.userId,
    permissions: params.composition.permissions,
    roles: params.composition.roles,
    version: params.version,
    assignmentIds: params.state.assignments.map((assignment) => assignment.assignmentId),
    accounts: [{ userId: params.state.userId, authVersion: params.state.authVersion }],
  };
}

/** Затронутая учётка в предпросмотре: у выдачи и отзыва она всегда ровно одна. */
function impactUserOf(
  state: UserGrantState,
  composition: GrantComposition,
  impact: AssignmentImpact,
): GrantImpactUserDto[] {
  return [
    {
      userId: state.userId,
      fullName: state.fullName,
      role: state.role,
      added: impact.delta.added,
      removed: impact.delta.removed,
      // Роль вне `grant_roles`: набор такой учётке прав не даёт, и дельта у неё пустая. Пометка нужна
      // именно затем, чтобы пустая дельта не читалась как «операция ничего не делает».
      roleMismatch: state.role === null || !composition.roles.includes(state.role),
    },
  ];
}

/**
 * Набор, годный к выдаче: живой и не удалённый. Мягко удалённый отвечает 404 — он не действует ни у
 * кого, и выдавать в нём нечего.
 *
 * Системный набор выдаётся наравне с пользовательским, и это не упущение проверки: в коде живёт его
 * **состав** (решение 2), а не список держателей, — виза ИТ выдаётся людям так же, как любой другой
 * набор, иначе перенос надстроек оставил бы её невыдаваемой вовсе.
 */
async function grantForAssignment(grantId: string): Promise<GrantRow> {
  const [row] = await db.select().from(grants).where(eq(grants.id, grantId));
  if (!row || row.deletedAt) throw err.notFound('Полномочие не найдено');
  return row;
}

/**
 * Совместимость набора с ролью держателя — условие, которого нет среди пяти барьеров и не должно
 * быть: барьеры проверяют, что за права выдаются, а это — кому набор вообще положен (`grant_roles`).
 *
 * 409, а не 400: список наборов в карточке учётки отфильтрован совместимостью с её ролью (§12), и
 * пара, которой в списке быть не могло, означает устаревший экран — роль сменили либо роль убрали из
 * набора уже после того, как список показали.
 */
function assertRoleAllowed(state: UserGrantState, grant: GrantRow, roles: readonly Role[]): void {
  if (state.role === null) {
    throw err.conflict(
      'У учётной записи нет роли: полномочия выдаются поверх должности, и выдать их нерассмотренной заявке нельзя',
      { code: GRANT_CONFLICT_CODES.roleNotAllowed },
    );
  }
  if (roles.includes(state.role)) return;
  throw err.conflict(
    `Полномочие «${grant.name}» роли «${roleLabels[state.role]}» не выдаётся: её нет в списке совместимых. Добавьте роль в набор либо выберите другой набор.`,
    { code: GRANT_CONFLICT_CODES.roleNotAllowed },
  );
}

/**
 * Гонка двух выдач одного набора одной учётке доходит до уникального ограничения. Дойти она может
 * только в обход порядка блокировок (обе транзакции держат строку набора, и вторая ждёт первую), но
 * разбор `23505` стоит здесь по той же причине, по которой он стоит у кода набора: 500 на месте
 * идемпотентного ответа — худший из возможных исходов, а стоит проверка одну ветку.
 */
function asAssignmentConflict(e: unknown): unknown {
  const pg = pgErrorOf(e);
  if (pg?.code === '23505' && pg.constraint === 'user_grants_user_grant_unique') {
    return err.conflict('Полномочие выдавали этой учётке одновременно с вами — повторите попытку');
  }
  return e;
}

export default async function userGrantsRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  // То же невыдаваемое `users.manage`, что у учёток и каталога: собранное набором право, которым
  // набирают права, замкнуло бы модель саму на себя (решение 6, инвариант 1).
  const guards = { preHandler: [app.authenticate, app.requirePermission('users.manage')] };

  /**
   * Предпросмотр выдачи или отзыва: что изменится у учётки и отпечаток того, из чего это посчитано.
   *
   * **Блокировок не берёт** — это чтение. Держать строку набора и строку учётки между показом экрана и
   * нажатием кнопки нельзя: время между ними задаёт человек. Отсюда и весь смысл отпечатка — расчёт
   * показывается без блокировок, а применяется под ними.
   *
   * Нарушения барьеров приходят в теле, а не отказом: «так выдать нельзя» администратор должен
   * увидеть до нажатия вместе с причиной, а не вместо ответа.
   */
  r.post(
    '/:id/grants/preview',
    { ...guards, schema: { params: idParams, body: grantAssignmentPreviewSchema } },
    async (req) => {
      const { operation, grantId } = req.body;
      const grant = await grantForAssignment(grantId);
      const state = await userGrantStateOf(db, req.params.id);
      if (!state || state.isArchived) throw err.notFound('Пользователь не найден');
      const composition = await compositionOfGrant(db, grantId);
      const impact = assignmentImpactOf({
        state,
        operation,
        grantId,
        grantCode: grant.code,
        composition,
      });
      return grantImpactDtoOf({
        input: assignmentImpactInput({
          operation,
          grantId,
          version: grant.version,
          composition,
          state,
        }),
        grantCode: grant.code,
        grantName: grant.name,
        users: impactUserOf(state, composition, impact),
        // Барьеры набора у отзыва не считаются вовсе (см. `checkAssignment`), поэтому общая половина
        // отказа здесь всегда пуста: виновник у операции над одной учёткой один, и он в `holders`.
        violations: [],
        holders: checkAssignment({
          operation,
          state,
          composition,
          grantName: grant.name,
          permissionsAfter: impact.permissionsAfter,
        }),
      });
    },
  );

  /**
   * Выдача набора учётке.
   *
   * `origin: 'manual'` — выдал человек; `migration` зарезервирован за переводом ролей, и путь выдачи
   * его не пишет никогда: на этом различии держится откат перевода, который выданное вручную не
   * трогает.
   *
   * **Повторная выдача того же набора дубля не создаёт** (`UNIQUE (user_id, grant_id)`) и отвечает
   * прежней строкой — с прежним автором и прежним временем. Пересоздать её нельзя ни при каких
   * обстоятельствах: `id` назначения неизменяем, и откат перевода ролей ищет ровно свои
   * идентификаторы (решение 3). Токены при такой выдаче не гаснут и в журнал ничего не уходит:
   * ничего не произошло.
   */
  r.post(
    '/:id/grants',
    { ...guards, schema: { params: idParams, body: assignGrantSchema } },
    async (req, reply) => {
      const actor = requirePrincipal(req);
      const { id } = req.params;
      const { grantId, expectedImpactHash } = req.body;

      const result = await db.transaction(async (tx) => {
        // Шаг 1 порядка: строка набора. Первой — и первой у **всех** операций, меняющих доступ.
        const grant = await lockGrant(tx, grantId);
        if (!grant || grant.deletedAt) throw err.notFound('Полномочие не найдено');
        // Шаг 2: строка учётки. Одна, но тем же вызовом, что берёт держателей у каталога, — порядок
        // захвата обязан описываться одним местом.
        await lockUsers(tx, [id]);
        const state = await userGrantStateOf(tx, id);
        if (!state || state.isArchived) throw err.notFound('Пользователь не найден');
        const composition = await compositionOfGrant(tx, grantId);

        // Шаг 3: пересчёт под блокировками.
        const impact = assignmentImpactOf({
          state,
          operation: 'assign',
          grantId,
          grantCode: grant.code,
          composition,
        });
        // Шаг 4: отпечаток из присланного тела и свежего состояния, затем барьеры.
        assertImpactUnchanged(
          assignmentImpactInput({
            operation: 'assign',
            grantId,
            version: grant.version,
            composition,
            state,
          }),
          expectedImpactHash,
        );
        /*
         * Барьеры — до проверки «положен ли набор этой роли», и порядок здесь важен.
         *
         * Роль `driver` не входит в `grant_roles` ни одного набора (барьер 2 не даёт её туда
         * записать), поэтому проверка совместимости, стоящая первой, отвечала бы водителю «набора
         * нет в списке совместимых» — правдой о следствии вместо правды о причине. Барьер называет
         * причину: кабинет открывает задание конкретного работника, и добавить к нему чужие права
         * нельзя ни одним способом.
         */
        const holderViolations = checkAssignment({
          operation: 'assign',
          state,
          composition,
          grantName: grant.name,
          permissionsAfter: impact.permissionsAfter,
        });
        if (holderViolations.length > 0) refuse([], holderViolations);
        assertRoleAllowed(state, grant, composition.roles);

        if (impact.held) {
          return { assignmentId: impact.held.assignmentId, changed: false, delta: impact.delta };
        }

        /*
         * Предел назначений по итогу — **общий с формой учётки** и потому считается той же функцией
         * (план §4.2). Своей проверки здесь быть не должно: точечная выдача, не знающая границы
         * формы, набьёт учётке больше назначений, чем та способна высказать, — правило полноты
         * станет невыполнимым, и карточка такого человека перестанет сохраняться вовсе, включая
         * правку телефона.
         *
         * Считается после `impact.held`: повторная выдача уже выданного набора ничего не добавляет,
         * и отказывать держателю предела там, где операция и так ничего не делает, незачем.
         */
        const limit = assignedGrantLimitIssue(state.assignments.length + 1);
        if (limit !== null) throw err.badRequest(limit, { grantId: limit });

        let created: { id: string } | undefined;
        try {
          [created] = await tx
            .insert(userGrants)
            .values({
              userId: id,
              grantId,
              grantedBy: actor.id,
              origin: 'manual',
            })
            .returning({ id: userGrants.id });
        } catch (e) {
          throw asAssignmentConflict(e);
        }
        // Шаг 5: токены держателя гаснут той же транзакцией. Иначе выданный набор начал бы
        // действовать не тогда, когда его выдали, а когда истёк последний выданный токен.
        await bumpAuthVersions(tx, [id]);
        // Шаг 5 (окончание): событие — той же транзакцией и без глушителя ошибки. Выдача, которая
        // прошла бы мимо журнала, оставила бы реестр без ответа «кто и когда это выдал» — §5.1.
        await writeAuditTx(tx, {
          actorUserId: actor.id,
          action: 'grant.assign',
          // Цель события — учётка: так его находит разбор «что меняли у этого человека». Набор назван
          // в metadata (ADR 0106, реестр действий журнала).
          entityType: 'user',
          entityId: id,
          metadata: {
            grantId,
            grantCode: grant.code,
            grantName: grant.name,
            assignmentId: created!.id,
            origin: 'manual',
            permissions: composition.permissions,
            role: state.role,
            // Дельта в журнале — не дубль состава набора: она отвечает на «что человек получил», а
            // состав — на «чем выдали». Право, которое ему и так давала роль, есть во втором и нет в
            // первой.
            permissionsAdded: impact.delta.added,
            permissionsRemoved: impact.delta.removed,
          },
        });
        return { assignmentId: created!.id, changed: true, delta: impact.delta };
      });

      if (result.changed) {
        // Refresh-токены гасятся вне транзакции: сессии живут своей таблицей, и откатывать их вместе
        // с назначением нечем (тем же порядком правится состав набора). Журнал, в отличие от них,
        // лежит в этой же базе — и потому пишется внутри, до коммита.
        await revokeAllForUser(id);
        reply.code(201);
      }
      const body: GrantAssignmentResultDto = {
        assignmentId: result.assignmentId,
        userId: id,
        grantId,
        changed: result.changed,
        delta: result.delta,
        grant: (await grantCardOf(db, grantId))!,
      };
      return body;
    },
  );

  /**
   * Отзыв назначения.
   *
   * **Строка удаляется, а не помечается снятой.** Идентификатор назначения не переиспользуется ни
   * при каких обстоятельствах: на этом держится откат перевода ролей — он снимает свои строки по
   * идентификаторам и, не найдя их, не трогает ничего (решение 3). Повторная выдача того же набора
   * создаст **новую** строку с новым `id`.
   *
   * Барьеры итога считаются и здесь: отзыв набора, дававшего право чтения, оставляет держателя с
   * действием в модуле, которого он больше не видит. Лечится это отзывом второго набора — то есть
   * явным решением администратора, а не молчаливым снятием прав за него (§13.1).
   */
  r.delete(
    '/:id/grants/:grantId',
    { ...guards, schema: { params: assignmentParams, querystring: revokeGrantQuerySchema } },
    async (req) => {
      const actor = requirePrincipal(req);
      const { id, grantId } = req.params;
      const { expectedImpactHash } = req.query;

      const result = await db.transaction(async (tx) => {
        const grant = await lockGrant(tx, grantId);
        if (!grant || grant.deletedAt) throw err.notFound('Полномочие не найдено');
        await lockUsers(tx, [id]);
        const state = await userGrantStateOf(tx, id);
        if (!state) throw err.notFound('Пользователь не найден');
        const composition = await compositionOfGrant(tx, grantId);

        const impact = assignmentImpactOf({
          state,
          operation: 'revoke',
          grantId,
          grantCode: grant.code,
          composition,
        });
        // Отпечаток сверяется до проверки «выдано ли»: список назначений входит в него слагаемым, и
        // «уже отозвал кто-то другой» — это ровно тот случай, о котором отпечаток и должен сказать,
        // а не 404 «нечего отзывать».
        assertImpactUnchanged(
          assignmentImpactInput({
            operation: 'revoke',
            grantId,
            version: grant.version,
            composition,
            state,
          }),
          expectedImpactHash,
        );
        const held = impact.held;
        if (!held) throw err.notFound('Полномочие этой учётной записи не выдано');
        const holderViolations = checkAssignment({
          operation: 'revoke',
          state,
          composition,
          grantName: grant.name,
          permissionsAfter: impact.permissionsAfter,
        });
        if (holderViolations.length > 0) refuse([], holderViolations);

        await tx
          .delete(userGrants)
          .where(and(eq(userGrants.userId, id), eq(userGrants.grantId, grantId)));
        await bumpAuthVersions(tx, [id]);
        // Событие — той же транзакцией: строка назначения удаляется насовсем, и после коммита
        // восстановить по базе, что именно сняли, будет уже нечем (§5.1).
        await writeAuditTx(tx, {
          actorUserId: actor.id,
          action: 'grant.revoke',
          entityType: 'user',
          entityId: id,
          metadata: {
            grantId,
            grantCode: grant.code,
            grantName: grant.name,
            assignmentId: held.assignmentId,
            // Происхождение снятой строки: «снято выданное вручную» и «снято выданное переводом
            // ролей» — разные события, и после удаления строки различить их будет уже нечем.
            origin: held.origin,
            role: state.role,
            permissions: composition.permissions,
            permissionsAdded: impact.delta.added,
            permissionsRemoved: impact.delta.removed,
          },
        });
        return { assignmentId: held.assignmentId, delta: impact.delta };
      });

      // Сессии — после коммита и по той же причине, что у выдачи: своя таблица, откатывать её нечем.
      await revokeAllForUser(id);
      const body: GrantAssignmentResultDto = {
        assignmentId: result.assignmentId,
        userId: id,
        grantId,
        changed: true,
        delta: result.delta,
        grant: (await grantCardOf(db, grantId))!,
      };
      return body;
    },
  );
}
