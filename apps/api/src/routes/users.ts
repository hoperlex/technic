import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { and, count, eq, exists, gte, isNotNull, isNull, lte, or, sql } from 'drizzle-orm';
import {
  can,
  type ChangeEmailResult,
  changeUserEmailSchema,
  type CounterpartyType,
  COUNTERPARTY_TYPES_WITH_ACCOUNTS,
  counterpartyTypeHasAccounts,
  counterpartyTypeLabels,
  createUserSchema,
  EMAIL_VERIFICATION_ENABLED,
  isCounterpartyScopedRole,
  isDepartmentScopedRole,
  isObjectScopedRole,
  rejectUserSchema,
  roleAddonIssue,
  roleLabels,
  setUserPasswordSchema,
  updateUserSchema,
  userListQuerySchema,
  type MailOutcome,
  type RoleAddon,
  type UserDto,
} from '@technic/contracts';
import { db } from '../db/client';
import { counterparties, userConstructionObjects, users } from '../db/schema';
import { config } from '../config';
import { queueMail, type MailKind } from '../services/mail';
import { maskEmail, type MailContent } from '../services/mail-templates';
import {
  ACCOUNT_CREATED_SUBJECT,
  accountCreatedContent,
  EMAIL_CHANGED_SUBJECT,
  emailChangedContent,
  emailChangedNoticeContent,
  REGISTRATION_APPROVED_SUBJECT,
  REGISTRATION_REJECTED_SUBJECT,
  registrationApprovedContent,
  registrationRejectedContent,
} from '../services/mail-auth';
import { revokeEmailTokens } from '../services/email-tokens';
import { err } from '../lib/errors';
import { writeAudit } from '../lib/audit';
import { requirePrincipal } from '../auth/plugin';
import { hashPassword, verifyPassword } from '../auth/password';
import { revokeAllForUser } from '../auth/sessions';
import { orderByFrom, pageParams, phoneSearchCondition, searchCondition } from '../lib/pagination';
import {
  addonsByUserIds,
  addonsOfUser,
  departmentIdsOfUser,
  departmentsByUserIds,
  objectIdsOfUser,
  objectsByUserIds,
  replaceUserAddons,
  replaceUserDepartments,
  replaceUserObjects,
} from '../services/user-scopes';
import { assertEmailFree, asEmailConflict } from '../services/user-email';
import { registerPurgeRoute } from '../services/directory-purge';

const idParams = z.object({ id: z.string().uuid() });

/** Транзакция drizzle: письмо о доступе ставится вместе с решением, ради которого отправляется. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Поставить письмо о решении по учётной записи и назвать исход отправки.
 *
 * Три письма — отказ, одобрение, заведение учётки — отличаются только содержимым, а правило
 * отправки у них одно, и живёт оно здесь, а не трижды в маршрутах. Правило такое: письма не было,
 * потому что его не просили; письмо поставлено; письмо просили, но почта выключена. Последний
 * случай нельзя проглотить молча — администратор уйдёт уверенным, что человека предупредили, —
 * и нельзя превратить в отказ: решение по учётке административное и от состояния почтового
 * контура зависеть не должно.
 *
 * Содержимое строится лениво: при выключенной почте собирать его незачем, а сборка письма о
 * доступе ещё и проверяет адрес портала (`assertOwnOrigin`) и падала бы на неверном
 * `PUBLIC_ORIGIN` там, где письма всё равно не будет.
 */
async function queueAccessMail(
  tx: Tx,
  input: {
    requested: boolean;
    kind: MailKind;
    dedupeKey: string;
    to: string;
    subject: string;
    content: () => MailContent;
    userId: string;
  },
): Promise<MailOutcome> {
  if (!input.requested) return 'not_requested';
  if (!config.mail.enabled) return 'mail_disabled';
  await queueMail(
    {
      kind: input.kind,
      dedupeKey: input.dedupeKey,
      to: input.to,
      subject: input.subject,
      content: input.content(),
      userId: input.userId,
      entityType: 'user',
      entityId: input.userId,
    },
    { tx },
  );
  return 'queued';
}

/**
 * Заявка на регистрацию: учётка, которую завёл сам пользователь и которую администратор ещё не
 * рассмотрел. Отличается от деактивированной именно отсутствием роли — роль назначают вместе с
 * активацией, а саморегистрация её не ставит (ADR 0034).
 */
const unreviewedRegistration = and(eq(users.isActive, false), isNull(users.role));

/**
 * То же среди действующих записей — для счётчика и для списка без архива. Отклонённая заявка
 * ушла в soft delete и в очереди не висит, но остаётся заявкой: с `includeDeleted` список
 * показывает и её, поэтому признак «удалена» стоит отдельным условием, а не внутри этого.
 */
const pendingRegistration = and(isNull(users.deletedAt), unreviewedRegistration);

interface UserRowJoined {
  id: string;
  email: string;
  lastName: string;
  firstName: string;
  middleName: string;
  fullName: string;
  phone: string;
  requestedRole: UserDto['requestedRole'];
  requestedObject: string;
  requestedCompany: string;
  role: UserDto['role'];
  isActive: boolean;
  mustChangePassword: boolean;
  emailVerifiedAt: Date | null;
  counterpartyId: string | null;
  counterpartyName: string | null;
  counterpartyType: CounterpartyType | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

function toDto(
  r: UserRowJoined,
  objects: UserDto['constructionObjects'],
  departments: UserDto['departments'],
  addons: UserDto['addons'],
): UserDto {
  return {
    id: r.id,
    email: r.email,
    lastName: r.lastName,
    firstName: r.firstName,
    middleName: r.middleName,
    fullName: r.fullName,
    phone: r.phone,
    requestedRole: r.requestedRole,
    requestedObject: r.requestedObject,
    requestedCompany: r.requestedCompany,
    role: r.role,
    isActive: r.isActive,
    mustChangePassword: r.mustChangePassword,
    emailVerifiedAt: r.emailVerifiedAt?.toISOString() ?? null,
    constructionObjects: objects,
    departments,
    addons,
    counterpartyId: r.counterpartyId,
    counterpartyName: r.counterpartyName,
    counterpartyType: r.counterpartyType,
    deletedAt: r.deletedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

const selectCols = {
  id: users.id,
  email: users.email,
  lastName: users.lastName,
  firstName: users.firstName,
  middleName: users.middleName,
  fullName: users.fullName,
  phone: users.phone,
  requestedRole: users.requestedRole,
  requestedObject: users.requestedObject,
  requestedCompany: users.requestedCompany,
  role: users.role,
  isActive: users.isActive,
  mustChangePassword: users.mustChangePassword,
  emailVerifiedAt: users.emailVerifiedAt,
  counterpartyId: users.counterpartyId,
  counterpartyName: counterparties.name,
  counterpartyType: counterparties.type,
  deletedAt: users.deletedAt,
  createdAt: users.createdAt,
  updatedAt: users.updatedAt,
};

function usersQuery() {
  return db
    .select(selectCols)
    .from(users)
    .leftJoin(counterparties, eq(users.counterpartyId, counterparties.id));
}

/** Карточка учётки всегда идёт с областью: клиент правит набор, а не отдельные привязки. */
async function fetchUserDto(id: string): Promise<UserDto | null> {
  const [row] = await usersQuery().where(eq(users.id, id));
  if (!row) return null;
  const [objects, departments, addons] = await Promise.all([
    objectsByUserIds([id]),
    departmentsByUserIds([id]),
    addonsByUserIds([id]),
  ]);
  return toDto(row, objects.get(id) ?? [], departments.get(id) ?? [], addons.get(id) ?? []);
}

/**
 * Контрагент учётки (ADR 0010, 0038). Для внешнего исполнителя он обязателен и задаёт сразу
 * две вещи: чьи заявки видны и в каком модуле учётка работает — модуль следует из типа
 * контрагента (оператор вывоза ведёт вывоз, арендодатель ТС — заказ техники).
 *
 * Годятся только типы, за которых в портале кто-то работает (`COUNTERPARTY_TYPES_WITH_ACCOUNTS`,
 * выводятся из матрицы прав): учётка на генподрядчике не получила бы ни одного модульного права
 * и вошла бы в портал, где ей нечего делать. Для остальных ролей поле пустое — область видимости
 * у них задаётся иначе (объект у «Штаба») или не ограничена.
 */
async function resolveCounterpartyId(
  role: UserDto['role'],
  counterpartyId: string | null | undefined,
): Promise<string | null> {
  if (!isCounterpartyScopedRole(role)) return null;
  if (!counterpartyId) {
    throw err.badRequest(`Для роли «${roleLabels[role!]}» обязателен контрагент`, {
      counterpartyId: 'Выберите контрагента',
    });
  }
  const [cp] = await db
    .select({
      type: counterparties.type,
      isActive: counterparties.isActive,
      deletedAt: counterparties.deletedAt,
    })
    .from(counterparties)
    .where(eq(counterparties.id, counterpartyId));
  if (!cp || cp.deletedAt) throw err.badRequest('Контрагент не найден');
  if (!counterpartyTypeHasAccounts(cp.type)) {
    const allowed = COUNTERPARTY_TYPES_WITH_ACCOUNTS.map(
      (t) => `«${counterpartyTypeLabels[t]}»`,
    ).join(' или ');
    throw err.badRequest(`Учётку исполнителя можно привязать к контрагенту типа ${allowed}`, {
      counterpartyId: `Нужен контрагент типа ${allowed}`,
    });
  }
  if (!cp.isActive) throw err.badRequest('Контрагент неактивен');
  return counterpartyId;
}

/**
 * Объекты учётки (ADR 0039). Инвариант «объектной роли обязателен объект» держится здесь:
 * с переходом на множественную привязку CHECK `users_rukstroy_object_check` снят — он читал
 * колонку своей строки, а набор лежит в отдельной таблице (миграция 0063).
 *
 * У остальных ролей набор пуст, как и контрагент: область у них задана иначе или не ограничена,
 * а привязка, ни на что не влияющая, в карточке читается как действующее ограничение.
 */
function resolveObjectIds(role: UserDto['role'], objectIds: string[]): string[] {
  if (!isObjectScopedRole(role)) return [];
  if (objectIds.length === 0) {
    throw err.badRequest(`Для роли «${roleLabels[role!]}» обязателен объект`, {
      constructionObjectIds: 'Укажите хотя бы один объект',
    });
  }
  return objectIds;
}

/**
 * Отделы учётки (ADR 0040) — вторая ось области, по тому же правилу, что объекты. Пустой набор
 * у остальных ролей означает и второй инвариант: объекты и отделы вместе не встречаются, потому
 * что роль работает ровно на одной оси — обнулением набора чужой оси он и держится.
 *
 * В БД это не выражается: CHECK читает колонки своей строки, а наборы лежат в двух отдельных
 * таблицах. Отсюда же требование к клиенту не присылать оба набора — оно проверяется схемой
 * (`createUserSchema`), чтобы ошибка указала на поле, а не пришла общим 400.
 */
function resolveDepartmentIds(role: UserDto['role'], departmentIds: string[]): string[] {
  if (!isDepartmentScopedRole(role)) return [];
  if (departmentIds.length === 0) {
    throw err.badRequest(`Для роли «${roleLabels[role!]}» обязателен отдел`, {
      departmentIds: 'Укажите хотя бы один отдел',
    });
  }
  return departmentIds;
}

/**
 * Надстройки учётки (ADR 0086) — третья ось субъекта доступа, а не третья ось области: набор
 * обнулять по роли, как это делают `resolve*` выше, здесь нечего. Проверяется одно — что каждая
 * надстройка прикрепляется к этой роли (`ROLE_ADDON_BASE_ROLES`).
 *
 * Сверяется **итоговое** состояние учётки: и присланный набор с присланной ролью, и оставшийся от
 * прежней правки набор с новой ролью. Поэтому смена роли на несовместимую при живой надстройке —
 * 400, а не тихое снятие: снять доступ молча значило бы отобрать его так, что этого никто не
 * заметит, и администратор снимает надстройку явно.
 */
function resolveAddons(role: UserDto['role'], addons: RoleAddon[]): RoleAddon[] {
  // Дубль убирается здесь, а не только при записи: этот же набор уходит в журнал, и «выдано
  // дважды» рассказывало бы о клиенте, а не о правах учётки.
  const next = [...new Set(addons)];
  const issue = roleAddonIssue(role, next);
  if (issue) throw err.badRequest(issue, { addons: issue });
  return next;
}

export default async function usersRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const guards = { preHandler: [app.authenticate, app.requirePermission('users.manage')] };

  r.get('/', { ...guards, schema: { querystring: userListQuerySchema } }, async (req) => {
    const q = req.query;
    // Архив просит право `archive.read`, как и в остальных списках: право вести учётки и право
    // видеть удалённое — разные, и одно другого не подразумевает.
    const showDeleted = q.includeDeleted && can(requirePrincipal(req), 'archive.read');
    const where = and(
      showDeleted ? undefined : isNull(users.deletedAt),
      q.role === undefined ? undefined : eq(users.role, q.role),
      q.isActive === undefined ? undefined : eq(users.isActive, q.isActive),
      q.pending ? unreviewedRegistration : undefined,
      // Объект в наборе учётки (ADR 0039): EXISTS, а не join, — иначе строка размножилась бы по
      // числу объектов и `total` считал бы привязки вместо людей.
      q.constructionObjectId === undefined
        ? undefined
        : exists(
            db
              .select({ one: sql`1` })
              .from(userConstructionObjects)
              .where(
                and(
                  eq(userConstructionObjects.userId, users.id),
                  eq(userConstructionObjects.constructionObjectId, q.constructionObjectId),
                ),
              ),
          ),
      q.counterpartyId === undefined ? undefined : eq(users.counterpartyId, q.counterpartyId),
      q.requestedRole === undefined ? undefined : eq(users.requestedRole, q.requestedRole),
      // Дата регистрации — календарные сутки Europe/Moscow: `created_at` хранит момент времени, и
      // без явных границ дня «с 1 июля» отрезало бы утро первого числа по UTC.
      q.createdFrom === undefined
        ? undefined
        : gte(users.createdAt, new Date(`${q.createdFrom}T00:00:00.000+03:00`)),
      q.createdTo === undefined
        ? undefined
        : lte(users.createdAt, new Date(`${q.createdTo}T23:59:59.999+03:00`)),
      // Поиск идёт по трём полям сразу: адрес и ФИО — подстрокой как есть, телефон — по цифрам,
      // потому что записан он свободно и «9261234567» обязано находить «+7 926 123-45-67».
      or(
        searchCondition(q.search, [users.email, users.fullName]),
        phoneSearchCondition(q.search, users.phone),
      ),
    );
    const sortCols = {
      email: users.email,
      fullName: users.fullName,
      role: users.role,
      counterpartyName: counterparties.name,
      isActive: users.isActive,
      createdAt: users.createdAt,
    };
    const p = pageParams(q);
    const [rows, totalRows] = await Promise.all([
      usersQuery()
        .where(where)
        .orderBy(orderByFrom(sortCols, q.sortBy, q.sortOrder, 'createdAt'))
        .limit(p.limit)
        .offset(p.offset),
      db.select({ c: count() }).from(users).where(where),
    ]);
    const ids = rows.map((row) => row.id);
    const [objects, departments, addons] = await Promise.all([
      objectsByUserIds(ids),
      departmentsByUserIds(ids),
      addonsByUserIds(ids),
    ]);
    return {
      items: rows.map((row) =>
        toDto(
          row,
          objects.get(row.id) ?? [],
          departments.get(row.id) ?? [],
          addons.get(row.id) ?? [],
        ),
      ),
      total: Number(totalRows[0]!.c),
      page: p.page,
      pageSize: p.pageSize,
    };
  });

  /**
   * Счётчик для бейджа в меню. Отдельным маршрутом, а не полем в списке: бейдж рисуется на
   * каждой странице портала, и тянуть ради него страницу пользователей — лишний трафик.
   */
  r.get('/pending-count', guards, async () => {
    const [row] = await db.select({ c: count() }).from(users).where(pendingRegistration);
    return { count: Number(row!.c) };
  });

  r.post('/', { ...guards, schema: { body: createUserSchema } }, async (req, reply) => {
    const actor = requirePrincipal(req);
    const body = req.body;
    const passwordHash = await hashPassword(body.password);
    const counterpartyId = await resolveCounterpartyId(body.role, body.counterpartyId);
    const objectIds = resolveObjectIds(body.role, body.constructionObjectIds);
    const departmentIds = resolveDepartmentIds(body.role, body.departmentIds);
    const addons = resolveAddons(body.role, body.addons);
    let created;
    let notified: MailOutcome = 'not_requested';
    try {
      created = await db.transaction(async (tx) => {
        // Архив адрес не занимает (ADR 0063) — та же проверка, что у саморегистрации.
        await assertEmailFree(tx, body.email);
        const [row] = await tx
          .insert(users)
          .values({
            email: body.email,
            lastName: body.lastName,
            firstName: body.firstName,
            middleName: body.middleName,
            phone: body.phone,
            role: body.role,
            passwordHash,
            isActive: body.isActive,
            counterpartyId,
            // Учётку завёл администратор — адрес он ввёл и проверил сам (ADR 0072). Требовать
            // подтверждения здесь значило бы блокировать активацию до того, как человек прочтёт
            // письмо, — а такие учётки и заводят затем, чтобы выдать доступ немедленно.
            emailVerifiedAt: new Date(),
          })
          .returning({ id: users.id });
        await replaceUserObjects(tx, row!.id, objectIds, actor.id);
        await replaceUserDepartments(tx, row!.id, departmentIds, actor.id);
        await replaceUserAddons(tx, row!.id, addons, actor.id);
        // Письмо только активной учётке: звать человека в портал, который его не пустит, хуже
        // молчания. Ключ без времени — учётку заводят один раз, различать в нём нечего.
        notified = await queueAccessMail(tx, {
          requested: body.notifyUser && body.isActive,
          kind: 'account_created',
          dedupeKey: `account-created:${row!.id}`,
          to: body.email,
          subject: ACCOUNT_CREATED_SUBJECT,
          content: () => accountCreatedContent(body.role),
          userId: row!.id,
        });
        return row!;
      });
    } catch (e) {
      throw asEmailConflict(e);
    }
    await writeAudit({
      actorUserId: actor.id,
      action: 'user.create',
      entityType: 'user',
      entityId: created.id,
      // Надстройка — выданный доступ (ADR 0086), и в журнале она стоит рядом с ролью: вопрос «кто
      // сделал человека оператором оргтехники» задают так же, как «кто выдал ему роль».
      // Активность записывается тут же: заведённая сразу активной учётка и заготовка «на потом» —
      // разные события, а по одной лишь роли они неразличимы.
      metadata: { role: body.role, addons, isActive: body.isActive, notified },
    });
    reply.code(201);
    return { user: (await fetchUserDto(created.id))!, notified };
  });

  r.patch(
    '/:id',
    { ...guards, schema: { params: idParams, body: updateUserSchema } },
    async (req) => {
      const actor = requirePrincipal(req);
      const { id } = req.params;
      const body = req.body;

      const {
        scopeChanged,
        addonsChanged,
        addons,
        roleChanged,
        counterpartyChanged,
        deactivated,
        approving,
        notified,
        roleBefore,
        roleAfter,
        activeBefore,
        activeAfter,
        activeChanged,
      } = await db.transaction(async (tx) => {
        // Строка учётки читается под блокировкой и внутри транзакции, а не перед ней: решение по
        // заявке считается по её состоянию, и снимок, взятый до транзакции, устаревает ровно в тот
        // момент, когда двое рассматривают одну заявку одновременно. Тот же приём — у номера
        // путевого листа и у состава рейса.
        const [existing] = await tx.select().from(users).where(eq(users.id, id)).for('update');
        if (!existing || existing.deletedAt) throw err.notFound('Пользователь не найден');

        // защита от самоблокировки
        if (actor.id === id) {
          if (body.isActive === false)
            throw err.badRequest('Нельзя деактивировать собственный аккаунт');
          if (body.role && body.role !== existing.role) {
            throw err.badRequest('Нельзя менять собственную роль');
          }
        }

        const nextRole = body.role ?? existing.role;
        const nextIsActive = body.isActive ?? existing.isActive;
        // Активная учётка без роли не попадает ни под одно ограничение доступа: проверки
        // сформулированы от конкретных ролей («штаб — свой объект», «оператор — свой контрагент»),
        // и учётка без роли видит все заявки вывоза. Роль назначается вместе с активацией.
        if (nextIsActive && !nextRole) {
          throw err.badRequest('Нельзя активировать учётку без роли', { role: 'Выберите роль' });
        }
        // Доступ выдаётся тому, кто доказал, что ящик его (ADR 0072). Иначе заявку мог подать кто
        // угодно на чужой адрес, и портал выдал бы права по одному лишь совпадению ФИО с ожидаемым.
        // Учётки, заведённые администратором, подтверждены по факту создания и сюда не упираются.
        // Пока подтверждение выключено (EMAIL_VERIFICATION_ENABLED), проверка снята — иначе заявки,
        // поданные до отключения, остались бы неактивируемыми.
        const activating = body.isActive === true && !existing.isActive;
        if (EMAIL_VERIFICATION_ENABLED && activating && !existing.emailVerifiedAt) {
          throw err.badRequest(
            'Адрес не подтверждён — активировать учётку нельзя. Попросите пользователя перейти по ссылке из письма.',
          );
        }

        // Рассмотрение заявки — объявленное намерение, а не догадка по телу запроса (ADR 0087).
        //
        // Одной блокировки мало: `PATCH` здесь маршрут общей правки, и второй администратор,
        // дождавшись первого, спокойно переписал бы его решение о роли и области, оставив в
        // журнале вторую запись. Поэтому намерение сверяется с состоянием строки и с итогом
        // правки, а не с одним лишь состоянием.
        const wasRegistration = !existing.isActive && existing.role === null;
        const approvingNow = wasRegistration && nextIsActive && nextRole !== null;
        // Назначить заявке роль, не активируя её, нельзя вместе с тем же запретом на активацию:
        // иначе запись перестала бы быть заявкой, а следующая правка активировала бы её уже как
        // обычную учётку — мимо журнала одобрения и мимо письма.
        const decidesRegistration =
          wasRegistration && (body.role !== undefined || body.isActive === true);
        if (body.approveRegistration) {
          if (!wasRegistration) {
            throw err.conflict('Заявку уже рассмотрел другой администратор — обновите список');
          }
          if (!approvingNow) {
            throw err.badRequest(
              'Заявку рассматривают целиком: назначьте роль и включите «Активен» — или оставьте заявку в очереди',
            );
          }
        } else if (decidesRegistration) {
          throw err.badRequest(
            'Роль и активность заявки меняются только её рассмотрением: откройте карточку заявки и рассмотрите её целиком',
          );
        }

        // Чтение справочника контрагентов идёт своим соединением и блокировок не ждёт: строка
        // `users` заблокирована нами, а `counterparties` эта операция не трогает вовсе.
        const nextCounterpartyId = await resolveCounterpartyId(
          nextRole,
          body.counterpartyId !== undefined ? body.counterpartyId : existing.counterpartyId,
        );

        const roleWasChanged = body.role !== undefined && body.role !== existing.role;
        const wasDeactivated = body.isActive === false && existing.isActive;
        // Смена контрагента у исполнителя — это смена и модуля, и области видимости (ADR 0038):
        // права учётки после неё другие, поэтому выданные токены гасятся так же, как при смене роли.
        const counterpartyWasChanged = nextCounterpartyId !== existing.counterpartyId;

        // Отсутствие поля — «не трогать привязки»; при этом смена роли на объектную или
        // отдельскую требует области и без поля: набор, оставшийся от прежней роли, проверяется
        // наравне с присланным. Смена оси при этом обнуляет чужой набор сама — `resolve*`
        // возвращают пустой список всем, кроме своей роли.
        const [currentObjects, currentDepartments, currentAddons] = await Promise.all([
          objectIdsOfUser(tx, id),
          departmentIdsOfUser(tx, id),
          addonsOfUser(tx, id),
        ]);
        const nextObjectIds = resolveObjectIds(
          nextRole,
          body.constructionObjectIds ?? currentObjects,
        );
        const nextDepartmentIds = resolveDepartmentIds(
          nextRole,
          body.departmentIds ?? currentDepartments,
        );
        // Тем же правилом, но с другим исходом: выданная надстройка от смены роли не отваливается,
        // а запрещает саму смену — 400 из `resolveAddons`. Транзакция при этом откатывается, и
        // учётка остаётся ровно такой, какой была.
        const nextAddons = resolveAddons(nextRole, body.addons ?? currentAddons);
        const objectsChanged = await replaceUserObjects(tx, id, nextObjectIds, actor.id);
        const departmentsChanged = await replaceUserDepartments(
          tx,
          id,
          nextDepartmentIds,
          actor.id,
        );
        const changed = objectsChanged || departmentsChanged;
        const addonsSetChanged = await replaceUserAddons(tx, id, nextAddons, actor.id);
        await tx
          .update(users)
          .set({
            lastName: body.lastName ?? existing.lastName,
            firstName: body.firstName ?? existing.firstName,
            middleName: body.middleName ?? existing.middleName,
            // Телефон правится как ФИО: поле не прислали — не трогаем, прислали пустым — стёрли.
            phone: body.phone ?? existing.phone,
            role: nextRole,
            isActive: nextIsActive,
            counterpartyId: nextCounterpartyId,
            authVersion:
              roleWasChanged ||
              counterpartyWasChanged ||
              wasDeactivated ||
              changed ||
              addonsSetChanged
                ? existing.authVersion + 1
                : existing.authVersion,
            updatedAt: new Date(),
          })
          .where(eq(users.id, id));

        // Письмо об открытом доступе — той же транзакцией, что и само одобрение: заявка,
        // рассмотренная без письма, и письмо по нерассмотренной заявке одинаково недопустимы.
        // Ключ дедупликации без времени: одобрение по построению однократно (после него роль уже
        // назначена), и постоянный ключ вдобавок ловит повтор, если строка успела измениться дважды.
        const mailed = await queueAccessMail(tx, {
          requested: approvingNow && body.notifyUser,
          kind: 'registration_approved',
          dedupeKey: `registration-approved:${id}`,
          to: existing.email,
          subject: REGISTRATION_APPROVED_SUBJECT,
          content: () => registrationApprovedContent(nextRole!),
          userId: id,
        });

        return {
          scopeChanged: changed,
          addonsChanged: addonsSetChanged,
          addons: nextAddons,
          roleChanged: roleWasChanged,
          counterpartyChanged: counterpartyWasChanged,
          deactivated: wasDeactivated,
          approving: approvingNow,
          notified: mailed,
          roleBefore: existing.role,
          roleAfter: nextRole,
          activeBefore: existing.isActive,
          activeAfter: nextIsActive,
          activeChanged: nextIsActive !== existing.isActive,
        };
      });

      // Сменившаяся область гасит токены наравне со сменой роли и контрагента: учётке стали
      // видны другие заявки. Сменившийся набор надстроек (ADR 0086) — то же самое с другой
      // стороны: заявки те же, но действий над ними стало больше или меньше.
      const bumpAuth =
        roleChanged || counterpartyChanged || deactivated || scopeChanged || addonsChanged;
      if (bumpAuth) await revokeAllForUser(id);
      // У рассмотрения заявки своё действие журнала, а не признак внутри общей правки: одобрение и
      // отказ — два исхода одного решения, и в журнале они обязаны стоять рядом и одинаково
      // фильтроваться. Заодно «одобрение было ровно одно» становится проверяемым в один запрос.
      await writeAudit({
        actorUserId: actor.id,
        action: approving ? 'user.approve_registration' : 'user.update',
        entityType: 'user',
        entityId: id,
        metadata: approving
          ? { role: roleAfter, addons, notified }
          : {
              roleChanged,
              counterpartyChanged,
              deactivated,
              scopeChanged,
              addonsChanged,
              // Не только «роль менялась», но и чем она была и стала: подвкладка аудита обязана
              // отвечать «кто сделал человека диспетчером», а по одному булеву флагу это вопрос
              // без ответа. Тем же правилом — активность: раньше в журнале была видна только
              // деактивация, и включение доступа не оставляло следа вовсе.
              ...(roleChanged ? { role: { from: roleBefore, to: roleAfter } } : {}),
              ...(activeChanged ? { isActive: { from: activeBefore, to: activeAfter } } : {}),
              // Что именно осталось у учётки — только когда набор менялся: снятие надстройки уносит
              // из `user_role_addons` и строку с `granted_by`, и без этой записи в журнале не
              // осталось бы следа, чем доступ был до правки.
              ...(addonsChanged ? { addons } : {}),
            },
      });
      return { user: (await fetchUserDto(id))!, notified };
    },
  );

  r.post(
    '/:id/password',
    { ...guards, schema: { params: idParams, body: setUserPasswordSchema } },
    async (req) => {
      const { id } = req.params;
      const [existing] = await db.select().from(users).where(eq(users.id, id));
      if (!existing || existing.deletedAt) throw err.notFound('Пользователь не найден');
      const passwordHash = await hashPassword(req.body.newPassword);
      await db
        .update(users)
        .set({
          passwordHash,
          mustChangePassword: true,
          authVersion: existing.authVersion + 1,
          updatedAt: new Date(),
        })
        .where(eq(users.id, id));
      await revokeAllForUser(id);
      await writeAudit({
        actorUserId: requirePrincipal(req).id,
        action: 'user.reset_password',
        entityType: 'user',
        entityId: id,
      });
      return { ok: true };
    },
  );

  /**
   * Смена адреса учётной записи (ADR 0092).
   *
   * Своей ручкой, а не полем `PATCH`: адрес — это логин, и смена тянет за собой отзыв сессий,
   * гашение живых ссылок из писем и два уведомления. Приехав «ещё одним полем формы», всё это
   * случалось бы мимоходом при сохранении телефона — и неотличимо от него в журнале.
   *
   * Порядок проверок здесь — это порядок отказов, который увидит администратор, и он выстроен от
   * «кого трогать нельзя» к «на что менять нельзя»: сперва запреты по самой учётке, потом по
   * новому адресу. Обратный порядок сообщал бы «адрес занят» про учётку, которую всё равно не
   * дали бы тронуть.
   */
  r.post(
    '/:id/email',
    { ...guards, schema: { params: idParams, body: changeUserEmailSchema } },
    async (req): Promise<ChangeEmailResult> => {
      const actor = requirePrincipal(req);
      const { id } = req.params;
      const { newEmail, currentPassword } = req.body;
      const self = actor.id === id;

      let result;
      try {
        result = await db.transaction(async (tx) => {
          // Под блокировкой и внутри транзакции — по той же причине, что и рассмотрение заявки:
          // решение принимается по состоянию строки, а снимок, взятый до транзакции, устаревает
          // ровно тогда, когда двое правят одну учётку одновременно.
          const [existing] = await tx.select().from(users).where(eq(users.id, id)).for('update');
          if (!existing || existing.deletedAt) throw err.notFound('Пользователь не найден');

          // Учётку с полными правами уводит только её владелец: смена логина отдаёт доступ
          // целиком и тихо — владелец узнаёт о ней лишь письмом, — а администраторов в портале
          // несколько. Роль читается из заблокированной строки, а не из карточки, показанной
          // порталу: роль, выданную секундой раньше параллельной правкой, снимок бы не увидел.
          // Потерявшему доступ к ящику администратору путь остаётся прежний: второй сбрасывает
          // ему пароль, тот входит и меняет адрес себе.
          if (!self && existing.role === 'admin') {
            throw err.forbidden(
              'Адрес учётной записи администратора меняет только её владелец. Если доступ к ящику утрачен — сбросьте пароль и попросите сменить адрес самостоятельно',
            );
          }

          // Заявка на регистрацию — утверждение заявителя о себе, включая ящик. Переписав адрес и
          // одобрив заявку, администратор выдал бы доступ ящику, который заявку не подавал, а
          // подтверждение адреса (ADR 0072) перестало бы что-либо значить. Такую заявку отклоняют.
          if (!existing.isActive && existing.role === null) {
            throw err.badRequest(
              'У заявки на регистрацию адрес не меняют: отклоните её — человек подаст новую со своего адреса',
            );
          }

          // Сравнение регистронезависимое: адрес лежит в `citext`, и «Ivan@su10.ru» — тот же
          // адрес, что и «ivan@su10.ru». Письмо о несостоявшейся смене и запись в журнале о ней
          // одинаково вводят в заблуждение, поэтому это отказ, а не тихий успех.
          if (existing.email.toLowerCase() === newEmail.toLowerCase()) {
            throw err.badRequest('Адрес совпадает с текущим', {
              newEmail: 'Это и есть текущий адрес',
            });
          }

          // Свой адрес — с подтверждением паролем: он удостоверяет, что за клавиатурой владелец
          // учётки, а не тот, кому досталась оставленная открытой сессия. Проверка идёт под уже
          // взятой блокировкой — строка своя же, и ждать её больше некому.
          if (self) {
            if (!currentPassword) {
              throw err.badRequest('Подтвердите смену своего адреса текущим паролем', {
                currentPassword: 'Введите текущий пароль',
              });
            }
            const ok = await verifyPassword(existing.passwordHash, currentPassword);
            if (!ok) {
              throw err.badRequest('Текущий пароль неверен', {
                currentPassword: 'Неверный пароль',
              });
            }
          }

          // Архив адрес не занимает (ADR 0063) — та же проверка, что у создания и восстановления.
          await assertEmailFree(tx, newEmail);
          // ...но архивная учётка с таким адресом после смены станет невосстановимой:
          // восстановление требует свободного адреса. Мешать этому незачем — адрес освободила она
          // сама, — а вот узнать об этом администратор должен в момент решения.
          const shadowed = await tx
            .select({ id: users.id })
            .from(users)
            .where(and(eq(users.email, newEmail), isNotNull(users.deletedAt)));

          const changedAt = new Date();
          await tx
            .update(users)
            .set({
              email: newEmail,
              // Адрес, который ввёл администратор, он же и проверил — то же правило, что при
              // заведении учётки (ADR 0072). Сброс в `null` тихо выключил бы человеку ролевые
              // дайджесты: они рассылаются только подтверждённым.
              emailVerifiedAt: changedAt,
              // Сменился логин — выданные токены гасятся, как при смене пароля: адрес меняют в
              // том числе тогда, когда прежний ящик потерян или скомпрометирован.
              authVersion: existing.authVersion + 1,
              updatedAt: changedAt,
            })
            .where(eq(users.id, id));

          // Живые ссылки из уже отправленных писем гасятся обе. Иначе ссылка сброса, ушедшая на
          // прежний ящик, остаётся действующим ключом от учётки — теперь уже с новым адресом.
          await revokeEmailTokens(id, 'password_reset', { tx });
          await revokeEmailTokens(id, 'verify_email', { tx });

          // Письма — правило, а не просьба администратора: на новый адрес человеку сообщают, чем
          // теперь входить, на прежний уходит сигнал владельцу ящика. Галочка «уведомить» здесь
          // превратила бы сигнал в необязательный — а снимут её как раз в том случае, ради
          // которого он и нужен. Время в ключе: адрес меняют и обратно, и это новое событие.
          const stamp = changedAt.getTime();
          const notifiedNew = await queueAccessMail(tx, {
            requested: true,
            kind: 'email_changed',
            dedupeKey: `email-changed:${id}:${stamp}:new`,
            to: newEmail,
            subject: EMAIL_CHANGED_SUBJECT,
            content: () => emailChangedContent(newEmail),
            userId: id,
          });
          const notifiedOld = await queueAccessMail(tx, {
            requested: true,
            kind: 'email_changed',
            dedupeKey: `email-changed:${id}:${stamp}:old`,
            to: existing.email,
            subject: EMAIL_CHANGED_SUBJECT,
            content: () => emailChangedNoticeContent(maskEmail(newEmail)),
            userId: id,
          });

          return {
            oldEmail: existing.email,
            notifiedNew,
            notifiedOld,
            shadowsArchived: shadowed.length > 0,
          };
        });
      } catch (e) {
        // Между проверкой и записью адрес мог занять параллельный запрос — удержать это может
        // только сам индекс, и человеку нужно то же сообщение, что и при обычном дубле.
        throw asEmailConflict(e);
      }

      // Сессии отзываются после фиксации: они живут своей транзакцией, и откат основной не должен
      // оставлять учётку без них. Сменивший адрес себе выходит из портала здесь же — и входит
      // заново уже по новому адресу.
      await revokeAllForUser(id);
      await writeAudit({
        actorUserId: actor.id,
        action: 'user.change_email',
        entityType: 'user',
        entityId: id,
        // Оба адреса: прежнего после смены нет больше нигде — в учётке лежит уже новый, — а
        // вопрос разбора звучит «с какого адреса и на какой увели вход». Тем же составом пишется
        // удаление учётки насовсем.
        metadata: {
          oldEmail: result.oldEmail,
          newEmail,
          notifiedNew: result.notifiedNew,
          notifiedOld: result.notifiedOld,
          shadowsArchived: result.shadowsArchived,
          self,
        },
      });

      return {
        user: (await fetchUserDto(id))!,
        notifiedNew: result.notifiedNew,
        notifiedOld: result.notifiedOld,
        shadowsArchived: result.shadowsArchived,
      };
    },
  );

  /**
   * Отказ по заявке на регистрацию. Технически это тот же soft delete, что и удаление учётки,
   * но отдельным действием: в аудите «отклонена заявка, потому что <причина>» и «удалён
   * сотрудник» — разные события, и разбирать их потом приходится по-разному.
   */
  r.post(
    '/:id/reject',
    { ...guards, schema: { params: idParams, body: rejectUserSchema } },
    async (req) => {
      const actor = requirePrincipal(req);
      const { id } = req.params;
      const { reason, notifyApplicant, applicantMessage } = req.body;

      const { email, notified } = await db.transaction(async (tx) => {
        // Под блокировкой и внутри транзакции — по той же причине, что и правка учётки: два
        // одновременных отказа иначе прошли бы оба и поставили два письма. Дедупликация здесь не
        // спасает — ключ содержит время отказа, и у двух запросов оно разное.
        const [existing] = await tx.select().from(users).where(eq(users.id, id)).for('update');
        if (!existing || existing.deletedAt) throw err.notFound('Пользователь не найден');
        // Отклонять можно только нерассмотренную заявку: у действующей учётки для этого есть
        // деактивация и удаление, и подменять их отказом — терять смысл записи в аудите.
        if (existing.isActive || existing.role) {
          throw err.badRequest('Отклонить можно только заявку, которая ещё не рассмотрена');
        }
        const rejectedAt = new Date();
        await tx
          .update(users)
          .set({
            deletedAt: rejectedAt,
            authVersion: existing.authVersion + 1,
            updatedAt: rejectedAt,
          })
          .where(eq(users.id, id));
        // Время отказа в ключе: восстановленную из архива заявку (ADR 0063) могут отклонить снова,
        // и это новое событие с новым письмом. От одновременных запросов защищает блокировка выше.
        const mailed = await queueAccessMail(tx, {
          requested: notifyApplicant,
          kind: 'registration_rejected',
          dedupeKey: `registration-rejected:${id}:${rejectedAt.getTime()}`,
          to: existing.email,
          subject: REGISTRATION_REJECTED_SUBJECT,
          content: () => registrationRejectedContent(applicantMessage!),
          userId: id,
        });
        return { email: existing.email, notified: mailed };
      });

      await revokeAllForUser(id);
      await writeAudit({
        actorUserId: actor.id,
        action: 'user.reject_registration',
        entityType: 'user',
        entityId: id,
        // Текст ответа — только если он действительно ушёл: сохранённая формулировка, которой
        // никто не получил, в разборе означала бы обратное тому, что было.
        metadata: {
          reason,
          email,
          notified,
          ...(notified === 'queued' ? { applicantMessage } : {}),
        },
      });
      return { ok: true, notified };
    },
  );

  r.delete('/:id', { ...guards, schema: { params: idParams } }, async (req) => {
    const actor = requirePrincipal(req);
    const { id } = req.params;
    if (actor.id === id) throw err.badRequest('Нельзя удалить собственный аккаунт');
    const [existing] = await db.select().from(users).where(eq(users.id, id));
    if (!existing || existing.deletedAt) throw err.notFound('Пользователь не найден');
    await db
      .update(users)
      .set({
        isActive: false,
        deletedAt: new Date(),
        authVersion: existing.authVersion + 1,
        updatedAt: new Date(),
      })
      .where(eq(users.id, id));
    await revokeAllForUser(id);
    await writeAudit({
      actorUserId: actor.id,
      action: 'user.delete',
      entityType: 'user',
      entityId: id,
    });
    return { ok: true };
  });

  /**
   * Возврат учётки из архива (ADR 0063) — отдельной ручкой и отдельным правом (`archive.restore`),
   * как у контрагентов и техники: вести учётки и распоряжаться архивом — разные полномочия.
   *
   * Активность не поднимается. Восстановленный отказ снова становится нерассмотренной заявкой и
   * возвращается в очередь администратора — то есть проходит рассмотрение заново, а не получает
   * доступ обходным путём; у восстановленного сотрудника учётка деактивирована, и включает её
   * обычная правка карточки.
   */
  r.post(
    '/:id/restore',
    {
      preHandler: [app.authenticate, app.requirePermission('archive.restore')],
      schema: { params: idParams },
    },
    async (req) => {
      const actor = requirePrincipal(req);
      const { id } = req.params;
      await db.transaction(async (tx) => {
        const [existing] = await tx.select().from(users).where(eq(users.id, id));
        if (!existing) throw err.notFound('Пользователь не найден');
        if (!existing.deletedAt) return;
        // Пока учётка лежала в архиве, её адрес мог занять другой человек (ADR 0063 решение 1):
        // восстанавливать вслепую нельзя — упрёмся в тот же индекс, но уже пятисоткой.
        await assertEmailFree(tx, existing.email, {
          exceptId: id,
          message: `Email ${existing.email} занят другой учётной записью — восстановить нельзя`,
        });
        await tx
          .update(users)
          .set({
            deletedAt: null,
            // Строка побывала в архиве: выданных до неё токенов у неё быть не должно.
            authVersion: existing.authVersion + 1,
            updatedAt: new Date(),
          })
          .where(eq(users.id, id));
      });
      await writeAudit({
        actorUserId: actor.id,
        action: 'user.restore',
        entityType: 'user',
        entityId: id,
      });
      return (await fetchUserDto(id))!;
    },
  );

  /**
   * Удаление учётки насовсем (ADR 0063) — общая механика справочников (ADR 0060), право
   * `records.purge`, только из архива.
   *
   * Кто держит учётку, решает БД: заявки, история статусов, назначения, путевые листы и рейсы
   * ссылаются на неё `ON DELETE RESTRICT` — учётка работавшего человека не удалится, и это
   * правильно. Объекты, отделы, надстройки роли и refresh-сессии уходят каскадом: они существуют
   * только при ней.
   */
  registerPurgeRoute(app, {
    load: async (id) => {
      const [row] = await db.select().from(users).where(eq(users.id, id));
      return row;
    },
    isDown: (row) => !!row.deletedAt,
    remove: async (tx, row) => {
      await tx.delete(users).where(eq(users.id, row.id));
    },
    notFound: 'Пользователь не найден',
    stillLive: 'Учётная запись не в архиве — сначала удалите её',
    subject: 'учётную запись',
    audit: {
      action: 'user.purge',
      entityType: 'user',
      // Адрес и ФИО — то, чем человека называют: после удаления по entityId искать уже нечего,
      // а вопрос «куда делась учётка Иванова» задают именно так.
      metadata: (row) => ({ email: row.email, fullName: row.fullName, role: row.role }),
    },
  });
}
