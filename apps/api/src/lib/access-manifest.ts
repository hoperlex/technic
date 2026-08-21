import type { Permission } from '@technic/contracts';

/**
 * Манифест доступа маршрутов — **ожидаемое** условие доступа для каждой пары «метод + путь».
 *
 * Зачем отдельный файл, если условие и так объявлено на маршруте. Тест, построенный на пометке
 * `guard.authz`, проверяет код его же собственным утверждением: разработчик, привязавший к
 * маршруту не то право, получит от стража это же неверное право — тест сойдётся и промолчит.
 * Поэтому сторон две: здесь **ожидание**, которое пишут и ревьюят руками, а факт снимается с
 * собранного приложения (`test/access-manifest.test.ts`). Строка «здесь теперь другое право»
 * обязана быть видна в диффе рядом с правкой маршрута — это то место, где ревьюер спрашивает
 * «почему» (см. docs/permissions-restructure-plan.md §14).
 *
 * Почему в `src`, а не рядом с тестом: `apps/api/tsconfig.json` не включает каталог `test/`, и
 * ожидание, положенное туда, перестало бы быть типизированным — ни опечатка в праве, ни лишний
 * ключ не поймались бы компилятором, а вся конструкция держится ровно на этом. Доказательство
 * уже было в репозитории: union ключей профилей в `access-matrix.test.ts` писался руками и молча
 * отстал от контрактов.
 *
 * Чего манифест НЕ описывает: область видимости («над какими строками») и проверки внутри
 * обработчиков, которые уточняют поведение, а не открывают маршрут (`archive.read`,
 * `files.manageAny`, `waybills.issueBlank`, `waybills.correctBeyondLimit`). Условие здесь — это
 * «что нужно, чтобы обработчик вообще начал работать».
 */

/** Методы, которыми регистрируются маршруты API. `HEAD` Fastify заводит к каждому `GET` сам. */
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/**
 * Ключ строки манифеста: «метод + пробел + путь», как его показывает само приложение (с
 * параметрами Fastify — `/:id`). Шаблонный тип ловит перепутанный регистр метода и путь без
 * ведущего слеша; повтор ключа компилятор ловит сам как дубль свойства объекта.
 */
export type RouteKey = `${HttpMethod} /${string}`;

/**
 * Непустой набор прав: «прав не нужно» выражается отдельным типом условия, а не пустым списком.
 * Пустой `allOf` означал бы «пройдёт кто угодно вошедший» — то есть `authenticated`, только
 * незаметно.
 */
export type PermissionSet = readonly [Permission, ...Permission[]];

/** Право, которое требуется только при определённом поле в теле запроса. */
export interface ConditionalRequirement {
  /**
   * Имя поля тела запроса. Условие срабатывает по **присутствию** поля (`!== undefined`), а не по
   * истинности значения: присланный `null` (снятие исполнителя) — такое же назначение и требует
   * того же права.
   */
  readonly when: string;
  readonly allOf: PermissionSet;
}

/**
 * Шесть типов условия. Пять простых и шестой, условный: без него правило «строка на каждый
 * маршрут» несовместимо с маршрутами, у которых права нет законно, а условное право попало бы в
 * манифест постоянным `allOf` — и половина законных запросов оказалась бы в нём запрещённой.
 */
export type AccessCondition =
  /** Доступ без входа: вход, регистрация, ссылки из писем, health. */
  | { readonly kind: 'public'; readonly why: string }
  /** Внутренняя ручка по общему секрету `INTERNAL_API_TOKEN`: человека за ней нет. */
  | { readonly kind: 'internalToken'; readonly why: string }
  /** Нужен вход, права не спрашиваются: self-service, `/auth/me`, журнал выпусков. */
  | { readonly kind: 'authenticated'; readonly why: string }
  /** Обычный случай: конъюнкция прав из одного, двух или трёх членов. */
  | { readonly kind: 'permissions'; readonly allOf: PermissionSet }
  /** Базовые права плюс те, что требуются только при определённом поле тела запроса. */
  | {
      readonly kind: 'conditionalPermissions';
      readonly baseAllOf: PermissionSet;
      readonly conditionalAllOf: readonly ConditionalRequirement[];
      /**
       * Объявлено ли условие структурно на самом маршруте. Пока `false`, условие живёт внутри
       * обработчика (`assertCan`) и в `guard.authz` не попадает вовсе — сверять с фактом можно
       * только `baseAllOf`, а условная половина доказывается сценариями HTTP-перебора. Пометка
       * явная, а не подразумеваемая: маршрут с непереведённым условием видно в диффе.
       */
      readonly conditionDeclaredOnRoute: boolean;
    }
  /** Решает обработчик по самой записи: доступ к файлу выводится из связанной заявки. */
  | {
      readonly kind: 'handlerAuthorized';
      readonly why: string;
      /** Тест, который доказывает правило вместо перебора прав. */
      readonly provenBy: string;
    };

export type AccessConditionKind = AccessCondition['kind'];

/**
 * Права, которые обязан объявить страж маршрута для этого условия. У условного типа — только
 * базовая половина: условная применяется к телу запроса, а не к маршруту целиком.
 */
export function guardPermissionsOf(condition: AccessCondition): readonly Permission[] {
  switch (condition.kind) {
    case 'permissions':
      return condition.allOf;
    case 'conditionalPermissions':
      return condition.baseAllOf;
    default:
      return [];
  }
}

/** Все права, упомянутые условием, — включая условные (для перебора сценариев на будущих этапах). */
export function allPermissionsOf(condition: AccessCondition): readonly Permission[] {
  if (condition.kind !== 'conditionalPermissions') return guardPermissionsOf(condition);
  return [...condition.baseAllOf, ...condition.conditionalAllOf.flatMap((c) => [...c.allOf])];
}

/**
 * Ожидание по каждому маршруту приложения. `satisfies` вместо аннотации типа намеренно: ключи
 * остаются литералами (тест сверяет их с фактом по именам), но шаблонный тип и union условий
 * проверяются компилятором.
 */
export const ACCESS_MANIFEST = {
  // ── Служебные ручки ──
  // Живость и готовность спрашивает nginx и деплой, метрики — сборщик. Ни у одного из них нет
  // человека, от чьего имени они ходят, поэтому права здесь не бывает вовсе.
  'GET /health/live': { kind: 'public', why: 'проверка живости для nginx и деплоя' },
  'GET /health/ready': { kind: 'public', why: 'проверка готовности для nginx и деплоя' },
  'GET /metrics': {
    kind: 'public',
    why: 'метрики процесса; наружу префикс не проксируется (deploy/nginx/spa.conf)',
  },

  // ── Внутренние ручки планировщика (ADR 0075) ──
  // Ими worker просит API собрать рассылку и отдаёт результат. Доступ закрыт общим секретом
  // `INTERNAL_API_TOKEN`, который обработчик проверяет первым делом; наружу префикс `/internal/`
  // не проксируется (`deploy/nginx/spa.conf`).
  'POST /internal/mail/runs': {
    kind: 'internalToken',
    why: 'планировщик отдаёт результат отправки (ADR 0075)',
  },
  'GET /internal/mail/schedules/due': {
    kind: 'internalToken',
    why: 'планировщик из worker спрашивает, какие рассылки пора собрать (ADR 0075)',
  },

  // ── Вход, письма и self-service ──
  // Публичны те ручки, по которым ходит ещё не вошедший: сам вход, регистрация, ссылки из писем
  // (ADR 0072). «Про себя» — вошедший без всякого права: роль здесь ничего не различает.
  'GET /api/v1/auth/captcha': {
    kind: 'public',
    why: 'картинка капчи выдаётся до входа — ею и закрыта регистрация',
  },
  'POST /api/v1/auth/change-password': {
    kind: 'authenticated',
    why: 'смена собственного пароля — self-service',
  },
  'POST /api/v1/auth/login': { kind: 'public', why: 'сам вход' },
  'POST /api/v1/auth/logout': {
    kind: 'public',
    why: 'выход гасит cookie и работает даже с истёкшим токеном',
  },
  'GET /api/v1/auth/me': {
    kind: 'authenticated',
    why: 'учётка спрашивает про себя: роль, область и эффективные права',
  },
  'POST /api/v1/auth/password-reset/confirm': {
    kind: 'public',
    why: 'смена пароля по одноразовому токену из письма',
  },
  'POST /api/v1/auth/password-reset/request': {
    kind: 'public',
    why: 'восстановление пароля: войти как раз нельзя',
  },
  'POST /api/v1/auth/refresh': {
    kind: 'public',
    why: 'обновление пары токенов по cookie: доступ истёк, права спрашивать нечем',
  },
  'POST /api/v1/auth/register': {
    kind: 'public',
    why: 'заявка на регистрацию: учётки у заявителя ещё нет (закрыта капчей и лимитом)',
  },
  'POST /api/v1/auth/verify-email': {
    kind: 'public',
    why: 'ссылка из письма (ADR 0072): по ней ходит тот, кто ещё не вошёл',
  },
  'POST /api/v1/auth/verify-email/resend': {
    kind: 'public',
    why: 'повторное письмо подтверждения — тому же невошедшему',
  },

  // ── Журнал выпусков портала (ADR 0077) ──
  'GET /api/v1/releases': {
    kind: 'authenticated',
    why: 'журнал выпусков портала (ADR 0077): ПДн не содержит, а право пришлось бы выдать всем',
  },

  // ── Руководства пользователя (`docs/manuals-plan.md`) ──
  // Единственный префикс портала, где чтение и запись расходятся по условию: список читает любой
  // вошедший, а ведёт его держатель `manuals.manage`. Строки здесь и разделены по методам — на
  // одном пути `GET` без права и `POST` под правом.
  'GET /api/v1/manuals': {
    kind: 'authenticated',
    why: 'список руководств: право, закрывающее «как пользоваться порталом», выдали бы всем',
  },
  'POST /api/v1/manuals': { kind: 'permissions', allOf: ['manuals.manage'] },
  'PATCH /api/v1/manuals/:id': { kind: 'permissions', allOf: ['manuals.manage'] },
  // Удаление насовсем, но не `records.purge` (план §3.4): ссылок на строку нет и восстанавливать
  // нечего — ошибочно вставленную ссылку убирает тот же, кто её вставил.
  'DELETE /api/v1/manuals/:id': { kind: 'permissions', allOf: ['manuals.manage'] },

  // ── Учётные записи ──
  // `users.manage` невыдаваемое (ADR 0106): учётками распоряжается только администратор.
  'GET /api/v1/users': { kind: 'permissions', allOf: ['users.manage'] },
  'POST /api/v1/users': { kind: 'permissions', allOf: ['users.manage'] },
  'GET /api/v1/users/:id': { kind: 'permissions', allOf: ['users.manage'] },
  'PATCH /api/v1/users/:id': { kind: 'permissions', allOf: ['users.manage'] },
  'DELETE /api/v1/users/:id': { kind: 'permissions', allOf: ['users.manage'] },
  'POST /api/v1/users/:id/email': { kind: 'permissions', allOf: ['users.manage'] },
  'POST /api/v1/users/:id/password': { kind: 'permissions', allOf: ['users.manage'] },
  'DELETE /api/v1/users/:id/purge': { kind: 'permissions', allOf: ['records.purge'] },
  'POST /api/v1/users/:id/reject': { kind: 'permissions', allOf: ['users.manage'] },
  'POST /api/v1/users/:id/restore': { kind: 'permissions', allOf: ['archive.restore'] },
  'GET /api/v1/users/pending-count': { kind: 'permissions', allOf: ['users.manage'] },
  'GET /api/v1/users/person-candidates': { kind: 'permissions', allOf: ['users.manage'] },
  // Выдача и отзыв полномочия учётке (ADR 0106, этап 3) — префикс учёток, потому что цель операции
  // человек, но право то же невыдаваемое: собранный набор, дающий право выдавать наборы, замкнул бы
  // модель саму на себя (решение 6, инвариант 1).
  'POST /api/v1/users/:id/grants': { kind: 'permissions', allOf: ['users.manage'] },
  // Предпросмотр — чтение, и своего права у него нет: он показывает, что операция сделает с
  // доступом, то есть ровно то, что и сама операция. Право «посмотреть, но не менять» открыло бы
  // расчёт эффективных прав чужой учётки тому, кто учётками не ведает.
  'POST /api/v1/users/:id/grants/preview': { kind: 'permissions', allOf: ['users.manage'] },
  'DELETE /api/v1/users/:id/grants/:grantId': { kind: 'permissions', allOf: ['users.manage'] },

  // ── Каталог назначаемых полномочий (ADR 0106, этап 3) ──
  // То же невыдаваемое `users.manage`, что у учёток, и отдельного права каталог не заводит
  // намеренно: право, которым набирают права, собранное набором, замкнуло бы модель саму на себя
  // (решение 6, инвариант 1). «Только администратор» здесь означает ровно это, а не проверку роли
  // по имени.
  'GET /api/v1/grants': { kind: 'permissions', allOf: ['users.manage'] },
  'POST /api/v1/grants': { kind: 'permissions', allOf: ['users.manage'] },
  'GET /api/v1/grants/:id': { kind: 'permissions', allOf: ['users.manage'] },
  'PATCH /api/v1/grants/:id': { kind: 'permissions', allOf: ['users.manage'] },
  'POST /api/v1/grants/:id/preview': { kind: 'permissions', allOf: ['users.manage'] },
  'DELETE /api/v1/grants/:id': { kind: 'permissions', allOf: ['users.manage'] },

  // ── Журнал действий ──
  'GET /api/v1/audit': { kind: 'permissions', allOf: ['audit.read'] },

  // ── Почтовый контур: аккаунты, рассылки по ролям, адресаты модулей ──
  // Три файла маршрутов на один префикс `/api/v1/admin/mail` (`admin-mail`, `admin-mailings`,
  // `module-mail`), но пара прав у них общая: смотрит `mailings.read`, правит `mailings.manage`.
  'GET /api/v1/admin/mail/accounts': { kind: 'permissions', allOf: ['mailings.read'] },
  'GET /api/v1/admin/mail/digest-sample-users': { kind: 'permissions', allOf: ['mailings.read'] },
  'GET /api/v1/admin/mail/drivers-with-routes': { kind: 'permissions', allOf: ['mailings.read'] },
  // Единственное чтение контура под правом правки: список кандидатов нужен только форме
  // добавления адресата, и в нём ФИО с адресами тех, кого ещё не выбрали.
  'GET /api/v1/admin/mail/recipient-candidates': {
    kind: 'permissions',
    allOf: ['mailings.manage'],
  },
  'GET /api/v1/admin/mail/recipients': { kind: 'permissions', allOf: ['mailings.read'] },
  'POST /api/v1/admin/mail/recipients': { kind: 'permissions', allOf: ['mailings.manage'] },
  'PATCH /api/v1/admin/mail/recipients/:id': { kind: 'permissions', allOf: ['mailings.manage'] },
  'DELETE /api/v1/admin/mail/recipients/:id': { kind: 'permissions', allOf: ['mailings.manage'] },
  'GET /api/v1/admin/mail/runs': { kind: 'permissions', allOf: ['mailings.read'] },
  'GET /api/v1/admin/mail/schedules': { kind: 'permissions', allOf: ['mailings.read'] },
  'POST /api/v1/admin/mail/schedules': { kind: 'permissions', allOf: ['mailings.manage'] },
  'PATCH /api/v1/admin/mail/schedules/:id': { kind: 'permissions', allOf: ['mailings.manage'] },
  'DELETE /api/v1/admin/mail/schedules/:id': { kind: 'permissions', allOf: ['mailings.manage'] },
  'POST /api/v1/admin/mail/schedules/:id/run': { kind: 'permissions', allOf: ['mailings.manage'] },
  'POST /api/v1/admin/mail/test': { kind: 'permissions', allOf: ['mailings.manage'] },
  'GET /api/v1/admin/mail/test-recipients': { kind: 'permissions', allOf: ['mailings.read'] },

  // ── Справочники ──
  // Модуль закрыт парой прав на весь раздел, а не по вкладкам: `directories.read` нужен всем
  // ролям (без него не заполнить форму заявки), `directories.write` — тем, кто ведёт справочники.
  // Удаление насовсем везде уходит под `records.purge` (ADR 0060), восстановление — под
  // `archive.restore`.
  'GET /api/v1/objects': { kind: 'permissions', allOf: ['directories.read'] },
  'POST /api/v1/objects': { kind: 'permissions', allOf: ['directories.write'] },
  'PATCH /api/v1/objects/:id': { kind: 'permissions', allOf: ['directories.write'] },
  'DELETE /api/v1/objects/:id': { kind: 'permissions', allOf: ['directories.write'] },
  'DELETE /api/v1/objects/:id/purge': { kind: 'permissions', allOf: ['records.purge'] },
  'GET /api/v1/departments': { kind: 'permissions', allOf: ['directories.read'] },
  'POST /api/v1/departments': { kind: 'permissions', allOf: ['directories.write'] },
  'PATCH /api/v1/departments/:id': { kind: 'permissions', allOf: ['directories.write'] },
  'DELETE /api/v1/departments/:id': { kind: 'permissions', allOf: ['directories.write'] },
  'DELETE /api/v1/departments/:id/purge': { kind: 'permissions', allOf: ['records.purge'] },
  'GET /api/v1/counterparties': { kind: 'permissions', allOf: ['directories.read'] },
  'POST /api/v1/counterparties': { kind: 'permissions', allOf: ['directories.write'] },
  'GET /api/v1/counterparties/:id': { kind: 'permissions', allOf: ['directories.read'] },
  'PATCH /api/v1/counterparties/:id': { kind: 'permissions', allOf: ['directories.write'] },
  'DELETE /api/v1/counterparties/:id': { kind: 'permissions', allOf: ['directories.write'] },
  'DELETE /api/v1/counterparties/:id/purge': { kind: 'permissions', allOf: ['records.purge'] },
  'POST /api/v1/counterparties/:id/restore': { kind: 'permissions', allOf: ['archive.restore'] },
  'GET /api/v1/counterparties/resolve': { kind: 'permissions', allOf: ['directories.read'] },
  'GET /api/v1/warehouses': { kind: 'permissions', allOf: ['directories.read'] },
  'POST /api/v1/warehouses': { kind: 'permissions', allOf: ['directories.write'] },
  'GET /api/v1/warehouses/:id': { kind: 'permissions', allOf: ['directories.read'] },
  'PATCH /api/v1/warehouses/:id': { kind: 'permissions', allOf: ['directories.write'] },
  'DELETE /api/v1/warehouses/:id': { kind: 'permissions', allOf: ['directories.write'] },
  'GET /api/v1/container-types': { kind: 'permissions', allOf: ['directories.read'] },
  'POST /api/v1/container-types': { kind: 'permissions', allOf: ['directories.write'] },
  'PATCH /api/v1/container-types/:id': { kind: 'permissions', allOf: ['directories.write'] },
  'DELETE /api/v1/container-types/:id/purge': { kind: 'permissions', allOf: ['records.purge'] },
  'GET /api/v1/waste-types': { kind: 'permissions', allOf: ['directories.read'] },
  'PATCH /api/v1/waste-types/:id': { kind: 'permissions', allOf: ['directories.write'] },
  'DELETE /api/v1/waste-types/:id/purge': { kind: 'permissions', allOf: ['records.purge'] },
  'GET /api/v1/waste-tariffs': { kind: 'permissions', allOf: ['directories.read'] },
  'POST /api/v1/waste-tariffs': { kind: 'permissions', allOf: ['directories.write'] },
  'PATCH /api/v1/waste-tariffs/:id': { kind: 'permissions', allOf: ['directories.write'] },
  'DELETE /api/v1/waste-tariffs/:id/purge': { kind: 'permissions', allOf: ['records.purge'] },
  'GET /api/v1/waste-tariffs/resolve': { kind: 'permissions', allOf: ['directories.read'] },
  'GET /api/v1/vehicle-kinds': { kind: 'permissions', allOf: ['directories.read'] },
  'GET /api/v1/vehicle-types': { kind: 'permissions', allOf: ['directories.read'] },
  'POST /api/v1/vehicle-types': { kind: 'permissions', allOf: ['directories.write'] },
  'GET /api/v1/vehicle-types/:id': { kind: 'permissions', allOf: ['directories.read'] },
  'PATCH /api/v1/vehicle-types/:id': { kind: 'permissions', allOf: ['directories.write'] },
  'POST /api/v1/vehicle-types/:id/linear': { kind: 'permissions', allOf: ['directories.write'] },
  // Чтение под правом правки — намеренно: предпросмотр существует только для диалога
  // переключения признака «Линейная техника», а переключает его тот, кто ведёт типы.
  'GET /api/v1/vehicle-types/:id/linear-switch-preview': {
    kind: 'permissions',
    allOf: ['directories.write'],
  },
  'DELETE /api/v1/vehicle-types/:id/purge': { kind: 'permissions', allOf: ['records.purge'] },
  'GET /api/v1/vehicle-types/:id/specs': { kind: 'permissions', allOf: ['directories.read'] },
  'POST /api/v1/vehicle-types/:id/specs': { kind: 'permissions', allOf: ['directories.write'] },
  'PATCH /api/v1/vehicle-types/:id/specs/:specId': {
    kind: 'permissions',
    allOf: ['directories.write'],
  },
  'DELETE /api/v1/vehicle-types/:id/specs/:specId': {
    kind: 'permissions',
    allOf: ['directories.write'],
  },
  'GET /api/v1/vehicle-specs': { kind: 'permissions', allOf: ['directories.read'] },
  'POST /api/v1/vehicle-specs': { kind: 'permissions', allOf: ['directories.write'] },
  'GET /api/v1/vehicle-specs/:id': { kind: 'permissions', allOf: ['directories.read'] },
  'PATCH /api/v1/vehicle-specs/:id': { kind: 'permissions', allOf: ['directories.write'] },
  'DELETE /api/v1/vehicle-specs/:id/purge': { kind: 'permissions', allOf: ['records.purge'] },
  'GET /api/v1/vehicle-categories': { kind: 'permissions', allOf: ['directories.read'] },
  'POST /api/v1/vehicle-categories': { kind: 'permissions', allOf: ['directories.write'] },
  'GET /api/v1/vehicle-categories/:id': { kind: 'permissions', allOf: ['directories.read'] },
  'PATCH /api/v1/vehicle-categories/:id': { kind: 'permissions', allOf: ['directories.write'] },
  'DELETE /api/v1/vehicle-categories/:id': { kind: 'permissions', allOf: ['directories.write'] },
  'GET /api/v1/vehicle-classifications': { kind: 'permissions', allOf: ['directories.read'] },
  'GET /api/v1/vehicle-models': { kind: 'permissions', allOf: ['directories.read'] },
  'GET /api/v1/vehicles': { kind: 'permissions', allOf: ['directories.read'] },
  'POST /api/v1/vehicles': { kind: 'permissions', allOf: ['directories.write'] },
  'PATCH /api/v1/vehicles/:id': { kind: 'permissions', allOf: ['directories.write'] },
  'DELETE /api/v1/vehicles/:id': { kind: 'permissions', allOf: ['directories.write'] },
  'DELETE /api/v1/vehicles/:id/purge': { kind: 'permissions', allOf: ['records.purge'] },
  'POST /api/v1/vehicles/:id/restore': { kind: 'permissions', allOf: ['archive.restore'] },

  // ── Справочник водителей ──
  // Своя пара прав, а не `directories.*`: в карточке ФИО и СНИЛС. Удаление документа — тоже
  // `records.purge`: аннулирование его не заменяет (см. комментарий у маршрута в `drivers.ts`).
  'GET /api/v1/drivers': { kind: 'permissions', allOf: ['drivers.read'] },
  'POST /api/v1/drivers': { kind: 'permissions', allOf: ['drivers.write'] },
  'GET /api/v1/drivers/:id': { kind: 'permissions', allOf: ['drivers.read'] },
  'PATCH /api/v1/drivers/:id': { kind: 'permissions', allOf: ['drivers.write'] },
  'DELETE /api/v1/drivers/:id': { kind: 'permissions', allOf: ['drivers.write'] },
  'POST /api/v1/drivers/:id/licenses': { kind: 'permissions', allOf: ['drivers.write'] },
  'DELETE /api/v1/drivers/:id/licenses/:licenseId': {
    kind: 'permissions',
    allOf: ['records.purge'],
  },
  'POST /api/v1/drivers/:id/licenses/:licenseId/revoke': {
    kind: 'permissions',
    allOf: ['drivers.write'],
  },
  'POST /api/v1/drivers/:id/licenses/:licenseId/verify': {
    kind: 'permissions',
    allOf: ['drivers.write'],
  },
  'DELETE /api/v1/drivers/:id/purge': { kind: 'permissions', allOf: ['records.purge'] },
  'GET /api/v1/drivers/available': { kind: 'permissions', allOf: ['drivers.read'] },
  'GET /api/v1/drivers/job-titles': { kind: 'permissions', allOf: ['drivers.read'] },
  'GET /api/v1/drivers/license-categories': { kind: 'permissions', allOf: ['drivers.read'] },

  // ── Обмен справочниками файлом Excel (ADR 0073) ──
  // Выгрузка и загрузка разведены двумя правами: риск у них разный. Витрина обмена (`GET /`)
  // закрыта правом выгрузки — она перечисляет то, что можно вынести.
  'GET /api/v1/directories': { kind: 'permissions', allOf: ['directories.export'] },
  'GET /api/v1/directories/:key/export': { kind: 'permissions', allOf: ['directories.export'] },
  'POST /api/v1/directories/:key/import': { kind: 'permissions', allOf: ['directories.import'] },

  // ── Орг.техника ──
  'GET /api/v1/office-equipment-types': { kind: 'permissions', allOf: ['officeEquipment.read'] },
  'POST /api/v1/office-equipment-types': { kind: 'permissions', allOf: ['officeEquipment.write'] },
  'PATCH /api/v1/office-equipment-types/:id': {
    kind: 'permissions',
    allOf: ['officeEquipment.write'],
  },
  'DELETE /api/v1/office-equipment-types/:id': {
    kind: 'permissions',
    allOf: ['officeEquipment.write'],
  },
  'GET /api/v1/office-equipment': { kind: 'permissions', allOf: ['officeEquipment.read'] },
  'POST /api/v1/office-equipment': { kind: 'permissions', allOf: ['officeEquipment.write'] },
  'GET /api/v1/office-equipment/:id': { kind: 'permissions', allOf: ['officeEquipment.read'] },
  'PATCH /api/v1/office-equipment/:id': { kind: 'permissions', allOf: ['officeEquipment.write'] },
  'DELETE /api/v1/office-equipment/:id': { kind: 'permissions', allOf: ['officeEquipment.write'] },
  'GET /api/v1/office-equipment/:id/history': {
    kind: 'permissions',
    allOf: ['officeEquipment.read'],
  },
  'GET /api/v1/office-equipment/:id/history.xlsx': {
    kind: 'permissions',
    allOf: ['officeEquipment.read'],
  },
  'POST /api/v1/office-equipment/:id/move': {
    kind: 'permissions',
    allOf: ['officeEquipment.write'],
  },
  'DELETE /api/v1/office-equipment/:id/purge': { kind: 'permissions', allOf: ['records.purge'] },
  'POST /api/v1/office-equipment/:id/restore': { kind: 'permissions', allOf: ['archive.restore'] },

  // ── Заявки на обслуживание ──
  // Права нарезаны по сторонам процесса, а не по глаголам HTTP: `serviceRequests.estimate` — это
  // «служба работает по заявке» (смета, её подача и переоткрытие, закрытие работ, примечание
  // сервиса), `serviceRequests.status` — ход заявки, `approveEstimate` и `approveIt` — две визы.
  'GET /api/v1/service-requests': { kind: 'permissions', allOf: ['serviceRequests.read'] },
  'POST /api/v1/service-requests': { kind: 'permissions', allOf: ['serviceRequests.create'] },
  'GET /api/v1/service-requests/:id': { kind: 'permissions', allOf: ['serviceRequests.read'] },
  'PATCH /api/v1/service-requests/:id': { kind: 'permissions', allOf: ['serviceRequests.update'] },
  'DELETE /api/v1/service-requests/:id': { kind: 'permissions', allOf: ['serviceRequests.delete'] },
  'PATCH /api/v1/service-requests/:id/accept': {
    kind: 'permissions',
    allOf: ['serviceRequests.status'],
  },
  'PATCH /api/v1/service-requests/:id/complete': {
    kind: 'permissions',
    allOf: ['serviceRequests.estimate'],
  },
  'PATCH /api/v1/service-requests/:id/decline': {
    kind: 'permissions',
    allOf: ['serviceRequests.status'],
  },
  'PUT /api/v1/service-requests/:id/estimate': {
    kind: 'permissions',
    allOf: ['serviceRequests.estimate'],
  },
  'PATCH /api/v1/service-requests/:id/estimate/approval': {
    kind: 'permissions',
    allOf: ['serviceRequests.approveEstimate'],
  },
  'PATCH /api/v1/service-requests/:id/estimate/reopen': {
    kind: 'permissions',
    allOf: ['serviceRequests.estimate'],
  },
  'PATCH /api/v1/service-requests/:id/estimate/submit': {
    kind: 'permissions',
    allOf: ['serviceRequests.estimate'],
  },
  'POST /api/v1/service-requests/:id/files': {
    kind: 'permissions',
    allOf: ['serviceRequests.files'],
  },
  'DELETE /api/v1/service-requests/:id/files/:fileId': {
    kind: 'permissions',
    allOf: ['serviceRequests.files'],
  },
  'GET /api/v1/service-requests/:id/history': {
    kind: 'permissions',
    allOf: ['serviceRequests.read'],
  },
  'PATCH /api/v1/service-requests/:id/hold': {
    kind: 'permissions',
    allOf: ['serviceRequests.status'],
  },
  'PATCH /api/v1/service-requests/:id/it-approval': {
    kind: 'permissions',
    allOf: ['serviceRequests.approveIt'],
  },
  'POST /api/v1/service-requests/:id/notify': {
    kind: 'permissions',
    allOf: ['serviceRequests.status'],
  },
  'DELETE /api/v1/service-requests/:id/purge': { kind: 'permissions', allOf: ['records.purge'] },
  'PATCH /api/v1/service-requests/:id/resume': {
    kind: 'permissions',
    allOf: ['serviceRequests.status'],
  },
  'POST /api/v1/service-requests/:id/restore': { kind: 'permissions', allOf: ['archive.restore'] },
  'PATCH /api/v1/service-requests/:id/rework': {
    kind: 'permissions',
    allOf: ['serviceRequests.status'],
  },
  'PATCH /api/v1/service-requests/:id/service': {
    kind: 'permissions',
    allOf: ['serviceRequests.assign'],
  },
  'PATCH /api/v1/service-requests/:id/service-comment': {
    kind: 'permissions',
    allOf: ['serviceRequests.estimate'],
  },
  'PATCH /api/v1/service-requests/:id/start': {
    kind: 'permissions',
    allOf: ['serviceRequests.status'],
  },
  'PATCH /api/v1/service-requests/:id/status': {
    kind: 'permissions',
    allOf: ['serviceRequests.status'],
  },
  'PATCH /api/v1/service-requests/:id/urgency': {
    kind: 'permissions',
    allOf: ['serviceRequests.update'],
  },
  'GET /api/v1/service-requests/waiting-count': {
    kind: 'permissions',
    allOf: ['serviceRequests.read'],
  },
  'GET /api/v1/service-requests/warranties': {
    kind: 'permissions',
    allOf: ['serviceRequests.read'],
  },

  // ── Вывоз мусора ──
  // Два маршрута условные: назначить исполнителя прямо в форме заявки — то же назначение
  // оператора, что и `PATCH /:id/operator`, поэтому право спрашивается по факту присутствия поля.
  'GET /api/v1/waste-requests': { kind: 'permissions', allOf: ['wasteRequests.read'] },
  // Условие живёт в обработчике (`routes/waste-requests.ts`, `assertCan` после
  // `if (body.operatorCounterpartyId !== undefined)`), поэтому страж объявляет только базовое
  // право: сверять с фактом можно `baseAllOf`, условная половина — за сценариями перебора.
  // Схема заведения принимает `uuidSchema.optional()`, значит сценариев два: без поля и с
  // идентификатором. `null` Zod отклонит раньше всякой проверки права.
  'POST /api/v1/waste-requests': {
    kind: 'conditionalPermissions',
    baseAllOf: ['wasteRequests.create'],
    conditionalAllOf: [{ when: 'operatorCounterpartyId', allOf: ['wasteRequests.assignOperator'] }],
    conditionDeclaredOnRoute: false,
  },
  'GET /api/v1/waste-requests/:id': { kind: 'permissions', allOf: ['wasteRequests.read'] },
  // То же условие у правки, но схема здесь `uuidSchema.nullable().optional()` — сценариев три:
  // без поля, с идентификатором и `null`. Снять назначенного исполнителя — такое же назначение,
  // и право спрашивается по `!== undefined`, а не по истинности значения.
  'PATCH /api/v1/waste-requests/:id': {
    kind: 'conditionalPermissions',
    baseAllOf: ['wasteRequests.update'],
    conditionalAllOf: [{ when: 'operatorCounterpartyId', allOf: ['wasteRequests.assignOperator'] }],
    conditionDeclaredOnRoute: false,
  },
  'DELETE /api/v1/waste-requests/:id': { kind: 'permissions', allOf: ['wasteRequests.delete'] },
  'PATCH /api/v1/waste-requests/:id/comment': {
    kind: 'permissions',
    allOf: ['wasteRequests.operatorComment'],
  },
  'GET /api/v1/waste-requests/:id/history': { kind: 'permissions', allOf: ['wasteRequests.read'] },
  'PATCH /api/v1/waste-requests/:id/operator': {
    kind: 'permissions',
    allOf: ['wasteRequests.assignOperator'],
  },
  'DELETE /api/v1/waste-requests/:id/purge': { kind: 'permissions', allOf: ['records.purge'] },
  'POST /api/v1/waste-requests/:id/restore': { kind: 'permissions', allOf: ['archive.restore'] },
  'PATCH /api/v1/waste-requests/:id/status': {
    kind: 'permissions',
    allOf: ['wasteRequests.status'],
  },
  'GET /api/v1/waste-requests/present': { kind: 'permissions', allOf: ['wasteRequests.read'] },
  'GET /api/v1/waste-requests/present-groups': {
    kind: 'permissions',
    allOf: ['wasteRequests.read'],
  },
  'GET /api/v1/waste-requests/summary': { kind: 'permissions', allOf: ['wasteRequests.read'] },

  // ── Недельная заявка на технику ──
  // Своего права на статус у модуля нет: смену состояния ведёт `weeklyRequests.update`, визу —
  // `weeklyRequests.approve` у будущей недели и `waybills.correct` у просроченной (см. строку
  // `/approval` ниже: право выбирается по неделе, и потому спрашивается в обработчике).
  'POST /api/v1/weekly-vehicle-requests': { kind: 'permissions', allOf: ['weeklyRequests.create'] },
  'GET /api/v1/weekly-vehicle-requests/:id': {
    kind: 'permissions',
    allOf: ['weeklyRequests.read'],
  },
  'PATCH /api/v1/weekly-vehicle-requests/:id': {
    kind: 'permissions',
    allOf: ['weeklyRequests.update'],
  },
  /*
   * Решение по заявке закрыто чтением модуля, а само право визы спрашивает обработчик, и это
   * единственное место манифеста, где так сделано намеренно.
   *
   * Прав у визы два, и какое требуется, решает **неделя заявки** (ADR 0101,
   * `weeklyApprovalPermission`): у будущей — `weeklyRequests.approve`, у уже начавшейся или
   * прошедшей — право прошлого `waybills.correct`. Конъюнкцией это не пишется: жёсткое
   * `weeklyRequests.approve` на страже закрыло бы просроченную неделю ровно тому, кто её проводит
   * (диспетчеру), а жёсткое `waybills.correct` отняло бы обычную визу у руководителя строительства.
   * Условным правом (`conditionalPermissions`) — тоже: там право **добавляется** по полю тела, а
   * здесь оно **заменяется**, и решает это не тело, а неделя из шапки заявки.
   *
   * Что остаётся проверенным: без `weeklyRequests.read` маршрут не начинает работу вовсе, а оба
   * права визы вместе с областью площадки спрашивает `canApproveWeeklyRequest` первым делом в
   * обработчике. Доказывается это сценариями db-теста визы, а не перебором прав.
   */
  'POST /api/v1/weekly-vehicle-requests/:id/approval': {
    kind: 'permissions',
    allOf: ['weeklyRequests.read'],
  },
  // Предпросмотр проведения просроченной недели — под чтением карточки: понять, почему кнопка
  // недоступна, должен и тот, кто провести неделю не вправе. Отказ маршрута объяснил бы
  // отсутствие права, но не то, что делать дальше, — это отвечают поля ответа.
  'GET /api/v1/weekly-vehicle-requests/:id/correction': {
    kind: 'permissions',
    allOf: ['weeklyRequests.read'],
  },
  'GET /api/v1/weekly-vehicle-requests/:id/documents': {
    kind: 'permissions',
    allOf: ['weeklyRequests.read'],
  },
  'GET /api/v1/weekly-vehicle-requests/:id/history': {
    kind: 'permissions',
    allOf: ['weeklyRequests.read'],
  },
  'POST /api/v1/weekly-vehicle-requests/:id/status': {
    kind: 'permissions',
    allOf: ['weeklyRequests.update'],
  },
  // Подсказка по прошлой неделе — под правом заведения: её спрашивает форма новой заявки, и
  // читателю (`weeklyRequests.read`) она не нужна.
  'GET /api/v1/weekly-vehicle-requests/suggestion': {
    kind: 'permissions',
    allOf: ['weeklyRequests.create'],
  },

  // ── Заказ ТС ──
  // Часть маршрутов заявки живёт по правам рейсов, а не заявки: план по дням, водитель, рейсы и
  // листы показывают ФИО собственного парка и номера бланков, которых заказчику со стороны
  // объекта не видно (ADR 0037 п. 13), поэтому там `waybills.read`, а у действий над рейсом —
  // пара `waybills.read` + `vehicleRequests.status`, объявленная инлайн у каждого (ADR 0050 п. 11).
  'GET /api/v1/vehicle-requests': { kind: 'permissions', allOf: ['vehicleRequests.read'] },
  'POST /api/v1/vehicle-requests': { kind: 'permissions', allOf: ['vehicleRequests.create'] },
  'GET /api/v1/vehicle-requests/:id': { kind: 'permissions', allOf: ['vehicleRequests.read'] },
  'PATCH /api/v1/vehicle-requests/:id': { kind: 'permissions', allOf: ['vehicleRequests.update'] },
  'DELETE /api/v1/vehicle-requests/:id': { kind: 'permissions', allOf: ['vehicleRequests.delete'] },
  'PATCH /api/v1/vehicle-requests/:id/approval': {
    kind: 'permissions',
    allOf: ['vehicleRequests.approve'],
  },
  'PATCH /api/v1/vehicle-requests/:id/assignment': {
    kind: 'permissions',
    allOf: ['vehicleRequests.status'],
  },
  /*
   * История назначения — команда машиниста (`docs/assignment-periods-plan.md` §8, этап 3).
   *
   * Чтение и предпросмотр закрыты парой «видит заявку + видит бланки»: состав по датам показывает
   * фамилии парка и номера ЭСМ-2, и без `waybills.read` показывать его нечем. Боевая команда меняет
   * второе право на `vehicleRequests.status`: смотреть состав вправе тот, кто видит заявку, а
   * менять — тот, кто ведёт её состояние.
   *
   * Коррекционные права (`waybills.correct`, `waybills.correctBeyondLimit`) в манифест не попадают,
   * и это то же решение, что у визы недельной заявки выше: право спрашивает **обработчик**, потому
   * что нужно оно не всегда. Плановая смена машиниста с понедельника — обычная работа диспетчера, а
   * та же команда мартовской датой переоформляет выданную бумагу; исход считается под блокировкой
   * (Р32), из тела он не виден, и страж, потребовавший коррекционного права у всех, закрыл бы
   * обычную работу тому, кому она и поручена. Условным правом это тоже не пишется: там право
   * добавляется **по полю тела**, а здесь — по посчитанному исходу. Доказывается сценариями
   * db-теста команды (`test/assignment-crew.db.test.ts`).
   */
  'GET /api/v1/vehicle-requests/:id/assignment-changes': {
    kind: 'permissions',
    allOf: ['vehicleRequests.read', 'waybills.read'],
  },
  'POST /api/v1/vehicle-requests/:id/assignment-changes': {
    kind: 'permissions',
    allOf: ['vehicleRequests.status', 'waybills.read'],
  },
  'POST /api/v1/vehicle-requests/:id/assignment-changes/preview': {
    kind: 'permissions',
    allOf: ['vehicleRequests.read', 'waybills.read'],
  },
  /*
   * Дверь ремонта истории (Р29) — безусловная пара та же, а всё остальное её условный контракт, и
   * ни одна его часть манифестом не выражается. `waybills.correct` и `correctBeyondLimit`
   * спрашиваются по посчитанному под блокировкой исходу (Р32), а не по полю тела. `archive.restore`
   * добавляется полем `restore`, но условным правом здесь тоже не пишется: манифест сверяется с
   * `guard.authz`, а это право спрашивает шаг 9 канона вместе с проверкой «а заявка вообще в
   * архиве». И, наконец, архивная заявка открывается **по идентификатору без `archive.read`**
   * (Ц3) — отступление, у которого в манифесте нет строки по построению: манифест описывает то,
   * что нужно, а не то, чего намеренно не спрашивают. Всё это доказывается сценариями
   * `test/assignment-repair.db.test.ts`.
   */
  'POST /api/v1/vehicle-requests/:id/assignment-changes/repair': {
    kind: 'permissions',
    allOf: ['vehicleRequests.status', 'waybills.read'],
  },
  'POST /api/v1/vehicle-requests/:id/assignment-changes/repair/preview': {
    kind: 'permissions',
    allOf: ['vehicleRequests.status', 'waybills.read'],
  },
  'GET /api/v1/vehicle-requests/:id/days': {
    kind: 'permissions',
    allOf: ['vehicleRequests.read'],
  },
  'POST /api/v1/vehicle-requests/:id/days/:date/route': {
    kind: 'permissions',
    allOf: ['waybills.read', 'vehicleRequests.status'],
  },
  'DELETE /api/v1/vehicle-requests/:id/days/:date/route': {
    kind: 'permissions',
    allOf: ['waybills.read', 'vehicleRequests.status'],
  },
  'GET /api/v1/vehicle-requests/:id/driver': {
    kind: 'permissions',
    allOf: ['vehicleRequests.read'],
  },
  'POST /api/v1/vehicle-requests/:id/early-end': {
    kind: 'permissions',
    allOf: ['vehicleRequests.update'],
  },
  'PATCH /api/v1/vehicle-requests/:id/early-end': {
    kind: 'permissions',
    allOf: ['vehicleRequests.approve'],
  },
  'DELETE /api/v1/vehicle-requests/:id/early-end': {
    kind: 'permissions',
    allOf: ['vehicleRequests.update'],
  },
  'POST /api/v1/vehicle-requests/:id/esm2': {
    kind: 'permissions',
    allOf: ['waybills.read', 'vehicleRequests.status'],
  },
  'GET /api/v1/vehicle-requests/:id/history': {
    kind: 'permissions',
    allOf: ['vehicleRequests.read'],
  },
  'DELETE /api/v1/vehicle-requests/:id/purge': { kind: 'permissions', allOf: ['records.purge'] },
  'GET /api/v1/vehicle-requests/:id/relocations': { kind: 'permissions', allOf: ['waybills.read'] },
  'POST /api/v1/vehicle-requests/:id/relocations': {
    kind: 'permissions',
    allOf: ['waybills.read', 'vehicleRequests.status'],
  },
  'PATCH /api/v1/vehicle-requests/:id/request-type': {
    kind: 'permissions',
    allOf: ['vehicleRequests.update'],
  },
  'POST /api/v1/vehicle-requests/:id/restore': { kind: 'permissions', allOf: ['archive.restore'] },
  'GET /api/v1/vehicle-requests/:id/route-prefill': {
    kind: 'permissions',
    allOf: ['waybills.read', 'vehicleRequests.status'],
  },
  'GET /api/v1/vehicle-requests/:id/shifts': {
    kind: 'permissions',
    allOf: ['vehicleRequests.read'],
  },
  'PUT /api/v1/vehicle-requests/:id/shifts/:date': {
    kind: 'permissions',
    allOf: ['vehicleRequests.update'],
  },
  'DELETE /api/v1/vehicle-requests/:id/shifts/:date': {
    kind: 'permissions',
    allOf: ['vehicleRequests.update'],
  },
  // Не `update`, хотя соседние ручки смен — под ним: подпись объекта под днём работы принимает
  // тот, кто мог бы эту заявку завести (ADR 0025 п. 6), — заказчик, а не тот, кто её правит.
  'POST /api/v1/vehicle-requests/:id/shifts/:date/approval': {
    kind: 'permissions',
    allOf: ['vehicleRequests.create'],
  },
  'PATCH /api/v1/vehicle-requests/:id/status': {
    kind: 'permissions',
    allOf: ['vehicleRequests.status'],
  },
  'POST /api/v1/vehicle-requests/:id/status/preview': {
    kind: 'permissions',
    allOf: ['waybills.read', 'vehicleRequests.status'],
  },
  'GET /api/v1/vehicle-requests/:id/waybills': { kind: 'permissions', allOf: ['waybills.read'] },
  'GET /api/v1/vehicle-requests/feed': { kind: 'permissions', allOf: ['vehicleRequests.read'] },
  'GET /api/v1/vehicle-requests/history': { kind: 'permissions', allOf: ['vehicleRequests.read'] },
  'GET /api/v1/vehicle-requests/history/summary': {
    kind: 'permissions',
    allOf: ['vehicleRequests.read'],
  },
  'GET /api/v1/vehicle-requests/on-site': { kind: 'permissions', allOf: ['vehicleRequests.read'] },
  'GET /api/v1/vehicle-requests/on-site/summary': {
    kind: 'permissions',
    allOf: ['vehicleRequests.read'],
  },
  'GET /api/v1/vehicle-requests/summary': { kind: 'permissions', allOf: ['vehicleRequests.read'] },

  // ── Рейсы и точки маршрута ──
  // Общий страж модуля — пара `waybills.read` + `vehicleRequests.status`; три ручки коррекции
  // задним числом добавляют к ней `waybills.correct` (ADR 0101). Глубину коррекции
  // (`waybills.correctBeyondLimit`) страж не решает — она зависит от даты рейса.
  'GET /api/v1/vehicle-routes': {
    kind: 'permissions',
    allOf: ['waybills.read', 'vehicleRequests.status'],
  },
  'POST /api/v1/vehicle-routes': {
    kind: 'permissions',
    allOf: ['waybills.read', 'vehicleRequests.status'],
  },
  'GET /api/v1/vehicle-routes/:id': {
    kind: 'permissions',
    allOf: ['waybills.read', 'vehicleRequests.status'],
  },
  'PATCH /api/v1/vehicle-routes/:id': {
    kind: 'permissions',
    allOf: ['waybills.read', 'vehicleRequests.status'],
  },
  'DELETE /api/v1/vehicle-routes/:id': {
    kind: 'permissions',
    allOf: ['waybills.read', 'vehicleRequests.status'],
  },
  'GET /api/v1/vehicle-routes/:id/correction': {
    kind: 'permissions',
    allOf: ['waybills.read', 'vehicleRequests.status', 'waybills.correct'],
  },
  'POST /api/v1/vehicle-routes/:id/correction': {
    kind: 'permissions',
    allOf: ['waybills.read', 'vehicleRequests.status', 'waybills.correct'],
  },
  'POST /api/v1/vehicle-routes/:id/correction/transfer': {
    kind: 'permissions',
    allOf: ['waybills.read', 'vehicleRequests.status', 'waybills.correct'],
  },
  'PUT /api/v1/vehicle-routes/:id/order': {
    kind: 'permissions',
    allOf: ['waybills.read', 'vehicleRequests.status'],
  },
  'POST /api/v1/vehicle-routes/:id/points': {
    kind: 'permissions',
    allOf: ['waybills.read', 'vehicleRequests.status'],
  },
  'PATCH /api/v1/vehicle-routes/:id/points/:pointId': {
    kind: 'permissions',
    allOf: ['waybills.read', 'vehicleRequests.status'],
  },
  'DELETE /api/v1/vehicle-routes/:id/points/:pointId': {
    kind: 'permissions',
    allOf: ['waybills.read', 'vehicleRequests.status'],
  },
  'PUT /api/v1/vehicle-routes/:id/points/:pointId/roles/order': {
    kind: 'permissions',
    allOf: ['waybills.read', 'vehicleRequests.status'],
  },
  'POST /api/v1/vehicle-routes/:id/points/:pointId/split': {
    kind: 'permissions',
    allOf: ['waybills.read', 'vehicleRequests.status'],
  },
  'POST /api/v1/vehicle-routes/:id/points/merge': {
    kind: 'permissions',
    allOf: ['waybills.read', 'vehicleRequests.status'],
  },
  'PUT /api/v1/vehicle-routes/:id/points/order': {
    kind: 'permissions',
    allOf: ['waybills.read', 'vehicleRequests.status'],
  },
  'POST /api/v1/vehicle-routes/:id/requests': {
    kind: 'permissions',
    allOf: ['waybills.read', 'vehicleRequests.status'],
  },
  'DELETE /api/v1/vehicle-routes/:id/requests/:requestId': {
    kind: 'permissions',
    allOf: ['waybills.read', 'vehicleRequests.status'],
  },
  'POST /api/v1/vehicle-routes/:id/waybill': {
    kind: 'permissions',
    allOf: ['waybills.read', 'vehicleRequests.status'],
  },
  'GET /api/v1/vehicle-routes/suggest': {
    kind: 'permissions',
    allOf: ['waybills.read', 'vehicleRequests.status'],
  },

  // ── Путевые листы ──
  'GET /api/v1/waybills': { kind: 'permissions', allOf: ['waybills.read'] },
  'GET /api/v1/waybills/:id': { kind: 'permissions', allOf: ['waybills.read'] },
  'POST /api/v1/waybills/:id/cancel': { kind: 'permissions', allOf: ['waybills.cancel'] },
  'GET /api/v1/waybills/:id/export': { kind: 'permissions', allOf: ['waybills.read'] },
  'POST /api/v1/waybills/:id/files': { kind: 'permissions', allOf: ['waybills.files'] },
  'DELETE /api/v1/waybills/:id/files/:fileId': { kind: 'permissions', allOf: ['waybills.files'] },
  'GET /api/v1/waybills/:id/print': { kind: 'permissions', allOf: ['waybills.read'] },
  // `POST` ради списка листов в теле, а действие — чтение: право то же, что у печати одного.
  'POST /api/v1/waybills/print-batch': { kind: 'permissions', allOf: ['waybills.read'] },

  // ── Гараж (ADR 0076) ──
  'GET /api/v1/garage/drivers': { kind: 'permissions', allOf: ['garage.read'] },
  'GET /api/v1/garage/drivers/summary': { kind: 'permissions', allOf: ['garage.read'] },
  'GET /api/v1/garage/vehicles': { kind: 'permissions', allOf: ['garage.read'] },
  'GET /api/v1/garage/vehicles/summary': { kind: 'permissions', allOf: ['garage.read'] },

  // ── Кабинет водителя (ADR 0102/0103) ──
  // Права `driverCabinet.*` невыдаваемые (ADR 0106): они приходят только с ролью `driver`.
  'GET /api/v1/driver/assignment': { kind: 'permissions', allOf: ['driverCabinet.read'] },
  'GET /api/v1/driver/reports/:date': { kind: 'permissions', allOf: ['driverCabinet.read'] },
  'POST /api/v1/driver/reports/:date/open': {
    kind: 'permissions',
    allOf: ['driverCabinet.submit'],
  },
  'POST /api/v1/driver/reports/:date/submit': {
    kind: 'permissions',
    allOf: ['driverCabinet.submit'],
  },

  // ── Показания одометра: приём и статистика ──
  /**
   * Выгрузки (план «Показания техники», Р18): одна ручка на шесть книг, вариант параметром.
   * Условие — то же чтение показаний: выгружают ровно то, что видят на экране. Колонки ТО в
   * варианте «Срез на дату» приходят под `vehicleMaintenance.read` уже внутри обработчика (Р14а),
   * и правом маршрута это право не является: без него книга просто идёт без колонок ТО.
   */
  'GET /api/v1/vehicle-readings/export': {
    kind: 'permissions',
    allOf: ['vehicleReadings.read'],
  },
  'POST /api/v1/vehicle-readings/items/:id/rebase': {
    kind: 'permissions',
    allOf: ['vehicleReadings.write'],
  },
  'GET /api/v1/vehicle-readings/intake': {
    kind: 'permissions',
    allOf: ['vehicleReadings.read'],
  },
  'GET /api/v1/vehicle-readings/journal/:vehicleId': {
    kind: 'permissions',
    allOf: ['vehicleReadings.read'],
  },
  'GET /api/v1/vehicle-readings/reports/:id': {
    kind: 'permissions',
    allOf: ['vehicleReadings.read'],
  },
  'POST /api/v1/vehicle-readings/reports/accept-batch': {
    kind: 'permissions',
    allOf: ['vehicleReadings.write'],
  },
  'POST /api/v1/vehicle-readings/reports/:id/accept': {
    kind: 'permissions',
    allOf: ['vehicleReadings.write'],
  },
  'POST /api/v1/vehicle-readings/reports/:id/discrepancies': {
    kind: 'permissions',
    allOf: ['vehicleReadings.write'],
  },
  'GET /api/v1/vehicle-readings/reports/:personId/:date': {
    kind: 'permissions',
    allOf: ['vehicleReadings.read'],
  },
  'POST /api/v1/vehicle-readings/reports/:personId/:date/open': {
    kind: 'permissions',
    allOf: ['vehicleReadings.write'],
  },
  'POST /api/v1/vehicle-readings/reports/:personId/:date/submit': {
    kind: 'permissions',
    allOf: ['vehicleReadings.write'],
  },
  'PATCH /api/v1/vehicle-readings/shift-order': {
    kind: 'permissions',
    allOf: ['vehicleReadings.write'],
  },
  'GET /api/v1/vehicle-readings/stats': { kind: 'permissions', allOf: ['vehicleReadings.read'] },
  'GET /api/v1/vehicle-readings/stats/export': {
    kind: 'permissions',
    allOf: ['vehicleReadings.read'],
  },
  'GET /api/v1/vehicle-readings/vehicles/:id/card': {
    kind: 'permissions',
    allOf: ['vehicleReadings.read'],
  },

  // ── Техническое обслуживание ──
  'PATCH /api/v1/vehicle-maintenance/:id': {
    kind: 'permissions',
    allOf: ['vehicleMaintenance.write'],
  },
  'DELETE /api/v1/vehicle-maintenance/:id': {
    kind: 'permissions',
    allOf: ['vehicleMaintenance.write'],
  },
  'GET /api/v1/vehicle-maintenance/snapshot': {
    kind: 'permissions',
    allOf: ['vehicleMaintenance.read'],
  },
  'POST /api/v1/vehicle-maintenance/vehicles/:id': {
    kind: 'permissions',
    allOf: ['vehicleMaintenance.write'],
  },
  'GET /api/v1/vehicle-maintenance/vehicles/:id/history': {
    kind: 'permissions',
    allOf: ['vehicleMaintenance.read'],
  },
  'GET /api/v1/vehicle-maintenance/vehicles/:id/summary': {
    kind: 'permissions',
    allOf: ['vehicleMaintenance.read'],
  },

  // ── Файлы: доступ по самой записи, а не по роли ──
  // Право на файл выводится из связанной заявки: кому видна заявка, тому виден и её файл.
  // Перебором прав это не проверяется, поэтому четыре маршрута объявлены `handlerAuthorized` —
  // и остаются перечислимыми: `route-authorization.test.ts` держит инвариант «`handler:` бывает
  // только у файлов», а само правило доказывает `test/file-access.test.ts`.
  'DELETE /api/v1/files/:id': {
    kind: 'handlerAuthorized',
    why: 'файл виден тому, кому видна связанная заявка',
    provenBy: 'test/file-access.test.ts',
  },
  'POST /api/v1/files/:id/complete': {
    kind: 'handlerAuthorized',
    why: 'файл виден тому, кому видна связанная заявка',
    provenBy: 'test/file-access.test.ts',
  },
  'GET /api/v1/files/:id/download': {
    kind: 'handlerAuthorized',
    why: 'файл виден тому, кому видна связанная заявка',
    provenBy: 'test/file-access.test.ts',
  },
  'POST /api/v1/files/upload-session': {
    kind: 'handlerAuthorized',
    why: 'файл виден тому, кому видна связанная заявка',
    provenBy: 'test/file-access.test.ts',
  },
} as const satisfies Record<RouteKey, AccessCondition>;

/** Ключи манифеста как литеральный union — чтобы ссылка на маршрут не разъезжалась молча. */
export type ManifestRouteKey = keyof typeof ACCESS_MANIFEST;
