import type { HttpMethod } from './access-manifest';

/**
 * Манифест ОБЛАСТИ и СТОРОНЫ маршрутов заявок на обслуживание оргтехники — вторая ось ожидания,
 * рядом с манифестом прав (`access-manifest.ts`).
 *
 * ЗАЧЕМ ВТОРОЙ ФАЙЛ, ЕСЛИ МАНИФЕСТ ДОСТУПА УЖЕ ЕСТЬ. Тот описывает ровно одно: «что нужно, чтобы
 * обработчик вообще начал работать», и прямо оговаривает, что область видимости и проверки внутри
 * обработчика в него не входят. Именно там, где живут находки аудита Н1–Н4, доказательства и нет:
 * ни один тест не утверждает, что у ручки `X` стоит проверка области, а у ручки `Y` — сторона
 * (находка Н5 плана `docs/office-equipment-executor-access-audit-plan.md`). Дописать поля в
 * `AccessCondition` нельзя: условие маршрута — свойство ВСЕГО портала, а область и сторона —
 * понятия этого модуля, и третье поле у трёхсот чужих строк означало бы «не применимо» в двухстах
 * девяноста из них.
 *
 * ЧТО ЗДЕСЬ НЕ ОПИСЫВАЕТСЯ: право маршрута. Оно живёт в `ACCESS_MANIFEST` и сверяется своим тестом;
 * повтори мы его здесь — получили бы два ожидания одного факта, и первая же правка одного из них
 * разошлась бы со вторым молча.
 *
 * ПОЧЕМУ В `src`, А НЕ РЯДОМ С ТЕСТОМ: та же причина, что у манифеста прав, — `apps/api/tsconfig.json`
 * не включает каталог `test/`, и ожидание, положенное туда, перестало бы быть типизированным: ни
 * опечатка в имени предиката, ни ключ чужого модуля не поймались бы компилятором.
 *
 * ЭТАП Э1 ЗАФИКСИРОВАЛ СТАТУС-КВО И НИЧЕГО НЕ ЧИНИЛ. Строки были написаны по тогдашнему коду вместе
 * с его дырами: `POST /:id/files` объявлялась `side: 'any'`, потому что стороны не спрашивала вовсе
 * (находка Н2), а `DELETE /:id/purge` — `scope: 'none'`, потому что области у общей ручки удаления
 * насовсем нет (Н8). Первая строка изменилась на Э5 вместе с кодом (`side: 'executor'`, Р3) — ровно
 * так это и задумано: «здесь теперь другая сторона» обязано быть видно в диффе рядом с правкой
 * маршрута, это то место, где ревьюер спрашивает «почему». Вторая осталась решением.
 *
 * ОТКУДА ВЗЯТЫ СТРОКИ: чтением кода вместе с машинным инвентарём этапа Э0
 * (`pnpm --filter @technic/api report:service-access`) — он печатает по каждой ручке модуля её
 * стража и проверки, встреченные в теле. Карта §2.2 плана — пересказ того же, и расхождение с ней
 * считается находкой, а не опечаткой манифеста.
 *
 * ЧЕМ ЭТО ДОКАЗЫВАЕТСЯ. `test/service-access-manifest.test.ts` (без базы) сверяет полноту перечня с
 * собранным приложением и объявленную область — со статическим разбором файла маршрутов. Что
 * заявленная сторона и правда отбивает чужого субъекта, доказывает прогон запросов — он принадлежит
 * этапу Э2 и требует базы; до него `side` и `state` остаются объявлением, которое читает ревьюер, а
 * не проверкой.
 */

/**
 * Ключ строки: «метод + пробел + путь», как его показывает само приложение. Шаблон уже, чем у
 * манифеста прав: сюда попадают только два префикса модуля — маршрут соседнего модуля, случайно
 * вписанный в этот файл, обязан упереться в компилятор, а не в прогон теста.
 */
export type ServiceRouteKey =
  | `${HttpMethod} /api/v1/service-requests${string}`
  | `${HttpMethod} /internal/service-requests/${string}`;

/**
 * Чья это дверь ПО ФАКТУ сегодняшнего кода.
 *
 * Правило чтения одно на все строки: сторона — это либо та, которую ручка спрашивает В ТЕЛЕ
 * (предикатом стороны: `assertExecutorSide`, `canStartServiceWork`, `assertSideAllowed` и прочие),
 * либо — если такой проверки в теле нет — та, которую ОДНОЗНАЧНО задаёт право маршрута.
 * `'any'` означает «сторона не спрашивается ничем»: ни телом, ни правом, потому что право есть у
 * нескольких сторон сразу.
 *
 * АДМИНИСТРАТОР СТОРОНОЙ НЕ СЧИТАЕТСЯ. Права у него все, и учитывай мы его — каждая дверь модуля
 * оказалась бы `'any'`, а поле перестало бы отвечать хоть на что-нибудь. По той же причине не
 * считается стороной и «Ведение», доводящее заявку за исполнителя по праву `serviceRequests.estimate`
 * (`assertExecutorSide`): такие ходы объявлены `'executor'` — это дверь исполнителя, у которой есть
 * ключ у того, кто разбирает застрявшее.
 */
export type ServiceSide =
  /** Ход исполнителя: назначенный подрядчик либо поимённый исполнитель (`isServiceExecutor`). */
  | 'executor'
  /** Тот, кто распределяет заявки: право `serviceRequests.assign`. */
  | 'assigner'
  /** «Ведение» — тот, кто ведёт заявку по циклу: `status`, `hold`, `urgency`, `approveEstimate`. */
  | 'operator'
  /** Заказчик: заводит, правит и удаляет свою заявку (`SERVICE_REQUEST_CUSTOMER_PERMISSIONS`). */
  | 'customer'
  /** Сторона не спрашивается вовсе — включая места, где это находка, а не решение (Н2, Н8). */
  | 'any';

/**
 * Все стороны, перечисленные для прогона. Union рантайму не виден, а тест обязан уметь сказать
 * «сторон пять», — поэтому реестр записан руками, а полноту его держит компилятор (`sideListed`
 * ниже): сторона, заведённая в union и забытая здесь, уронит сборку, а не прогон.
 */
export const SERVICE_SIDES = [
  'executor',
  'assigner',
  'operator',
  'customer',
  'any',
] as const satisfies readonly ServiceSide[];

/** Стороны, забытые в реестре. Пусто (`never`) — все перечислены. */
type SidesNotListed = Exclude<ServiceSide, (typeof SERVICE_SIDES)[number]>;
const sideListed: SidesNotListed extends never ? true : SidesNotListed = true;
void sideListed;

/**
 * Имя предиката состояния — то, чем ручка отвечает на вопрос «может ли этот ход состояться сейчас».
 *
 * ЗАКРЫТЫМ UNION'ОМ, А НЕ СВОБОДНОЙ СТРОКОЙ: имя тут — ссылка в код, и переименованный предикат
 * обязан ронять сборку этого файла, а не оставлять в манифесте слово, которого больше нет.
 *
 * ИМЯ ОДНО, ХОТЯ ПРОВЕРОК В РУЧКЕ БЫВАЕТ НЕСКОЛЬКО. Названа та, что отвечает полнее прочих; вид
 * заявки (`assertRepairKind` — 422 «заявка на расходники объёма работ не имеет») сюда не попадает
 * ни разу намеренно: это про ПРЕДМЕТ заявки, а не про её состояние, и у каждой сметной ручки рядом
 * есть предикат, отвечающий и про состояние, и про сторону.
 *
 * Три имени из перечня — не идентификаторы кода, и это оговорено отдельно у каждого: коридор,
 * записанный перечнем статусов прямо в теле, называть в коде нечем.
 */
export type ServiceStateGate =
  /** Отбор списка прячет архив (`archiveWhere` в `listWhere`). */
  | 'archiveWhere'
  /** Архивная строка отвечает 404, а не 403 (`assertArchiveVisible`). */
  | 'assertArchiveVisible'
  /** Заказчик правит заявку только до назначения (`isServiceRequestEditable`). */
  | 'assertServiceRequestEditable'
  /** Заказчик удаляет заявку, пока по ней не начали работать (`isServiceRequestDeletable`). */
  | 'assertServiceRequestDeletable'
  /** Коридор переходов контрактов (`allowedServiceStatusTransitions`). */
  | 'assertTransition'
  /** Таблица «вид документа × статус» при подшивке. */
  | 'assertFileKindAllowed'
  /** Предикаты действий Р11: состояние и сторона одним ответом. */
  | 'canStartServiceWork'
  | 'canDeclineServiceRequest'
  | 'canSubmitServiceEstimate'
  | 'canApproveServiceEstimate'
  | 'canReopenServiceEstimate'
  | 'canAssignServiceExecutors'
  /** Участие в разговоре и закрытость заявки — внутри транзакции, под блокировкой (ADR 0141). */
  | 'canWriteChat'
  /** Куда возвращается отложенная заявка; `null` означает «она не отложена». */
  | 'serviceResumeTarget'
  /** Непогашенное предъявление объёма работ — замок Р9. */
  | 'serviceEstimatePending'
  /** У статуса есть повторяемое письмо (Р70). */
  | 'serviceMailRepeatable'
  /** Заявка закрыта — правке конец. */
  | 'isServiceRequestClosed'
  /** Заявка «мертва»: `isDown` общей ручки удаления насовсем (`services/directory-purge.ts`). */
  | 'isDown'
  /** Созревшая для автозакрытия строка — условие `MATURE` (`routes/internal-service-requests.ts`). */
  | 'MATURE'
  /**
   * НЕ ИДЕНТИФИКАТОР: коридор записан перечнем статусов прямо в теле ручки («состав правят в
   * „Новой“ и „В работе“»), и назвать его в коде нечем. Слово выбрано так, чтобы не притворяться
   * ссылкой на функцию.
   */
  | 'statusList'
  /**
   * НЕ ИДЕНТИФИКАТОР: ручка работает только над архивной строкой (`if (!row.deletedAt) return
   * false`) — своего предиката у этого условия нет.
   */
  | 'archivedOnly';

/**
 * Строка манифеста. Область — размеченный union, а не пара полей: `why` обязан быть у каждой
 * `'none'` по типу, а не по договорённости. «Область не спрашивается» — это всегда решение либо
 * находка, и молчащей такая строка быть не должна.
 */
export type ServiceRouteAccess =
  | {
      /** Ручка спрашивает область заявки: `requireEditable`/`assertScope` либо `visibility()` в выборке. */
      readonly scope: 'visibility';
      readonly side: ServiceSide;
      readonly state: ServiceStateGate | null;
    }
  | {
      /** Ручка область НЕ спрашивает. */
      readonly scope: 'none';
      /** Почему не спрашивает — словами, а не ссылкой на строку кода. */
      readonly why: string;
      readonly side: ServiceSide;
      readonly state: ServiceStateGate | null;
    };

/**
 * Ожидание по каждой ручке модуля. `satisfies` вместо аннотации типа намеренно: ключи остаются
 * литералами (тест сверяет их с фактом по именам), но шаблон ключа и union полей проверяет
 * компилятор.
 */
export const SERVICE_ACCESS_MANIFEST = {
  // ── Списки и счётчики ──
  // Область у всех четырёх — предикат выборки `visibility()` (обе оси: заказчик заявки и
  // назначенный исполнитель), а не проверка по строке: спрятать чужое здесь дешевле, чем отвечать
  // 403 на каждую вторую строку. Сторона у них не спрашивается — право `serviceRequests.read` есть
  // у всех сторон сразу, и это правильно: список показывает СВОЁ каждому.
  'GET /api/v1/service-requests': { scope: 'visibility', side: 'any', state: 'archiveWhere' },
  // Реестр действующих гарантий (§9.5). Состояния заявки он не спрашивает вовсе: отбирает
  // непросроченные гарантии, а не ход заявки, — отсюда `state: null`.
  'GET /api/v1/service-requests/warranties': {
    scope: 'visibility',
    side: 'any',
    state: null,
  },
  // «Ждут меня» и бейдж непрочитанного. Очередь считается ПО СТОРОНЕ (`waitingOnMeWhere`,
  // `namedExecutorHere`), но дверь этим не сужается ни на строку: спрашивать счётчик вправе любой,
  // кому открыт модуль, а ответ у каждого свой. Поэтому `side: 'any'`, а не «исполнитель».
  'GET /api/v1/service-requests/waiting-count': {
    scope: 'visibility',
    side: 'any',
    state: null,
  },
  'GET /api/v1/service-requests/unread-count': {
    scope: 'visibility',
    side: 'any',
    state: null,
  },
  // «Отметить все прочитанными» по текущему отбору: область приходит тем же `listWhere`, что и у
  // списка, — кнопка обязана гасить ровно то, что человек видит.
  'POST /api/v1/service-requests/messages/read-all': {
    scope: 'visibility',
    side: 'any',
    state: null,
  },
  /*
   * Кандидаты в поимённые исполнители. НАХОДКА Н8 ЗАКРЫТА (Р7), и строка изменилась вместе с кодом:
   * `scope: 'none'` означало, что ручка отвечает «кого вообще можно назначить» — без заявки, а
   * значит и без области, — и из этого списка назначали «мёртвых» исполнителей (Н1.2). Теперь
   * заявка в запросе обязательна, область спрашивается у НАЗЫВАЮЩЕГО (`requireEditable`), а
   * пригодность кандидата — тем же предикатом, которым её проверяет само назначение.
   *
   * Область КАНДИДАТА при этом не спрашивается ни здесь, ни в назначении, и это не пропуск, а Р1:
   * назначение как раз и открывает заявку сисадмину соседней площадки. Спроси мы её — третья ось
   * видимости отменялась бы в единственном месте, где она и нужна.
   *
   * `state: null` — своего состояния у ручки нет: живость заявки приносит `requireEditable`
   * (архивная отвечает 404), а «живая учётка с действующим `execute`» — это состояние КАНДИДАТА, а
   * не заявки, и полем, которое отвечает про заявку, оно не выражается.
   */
  'GET /api/v1/service-requests/executor-candidates': {
    scope: 'visibility',
    side: 'assigner',
    state: null,
  },

  // ── Карточка, история и обсуждение ──
  // Карточку достают по id, минуя условия списка, поэтому область спрашивается по строке
  // (`assertScope`), а архив отвечает 404: удалённую заявку не показывают и по известному id.
  'GET /api/v1/service-requests/:id': {
    scope: 'visibility',
    side: 'any',
    state: 'assertArchiveVisible',
  },
  'GET /api/v1/service-requests/:id/history': {
    scope: 'visibility',
    side: 'any',
    state: 'assertArchiveVisible',
  },
  'GET /api/v1/service-requests/:id/messages': {
    scope: 'visibility',
    side: 'any',
    state: 'assertArchiveVisible',
  },
  // Отправка реплики. `side: 'any'` — не оговорка: `canWriteChat` спрашивает УЧАСТИЕ В РАЗГОВОРЕ
  // (автор заявки, область заказчика, назначенный подрядчик, поимённый исполнитель), а это не
  // сторона цикла: писать вправе каждая из них, и закрыт разговор только наблюдателю. Единственное
  // место модуля, где сторона считается внутри транзакции, под блокировкой, — эталон для Р4.
  'POST /api/v1/service-requests/:id/messages': {
    scope: 'visibility',
    side: 'any',
    state: 'canWriteChat',
  },
  'POST /api/v1/service-requests/:id/messages/read': {
    scope: 'visibility',
    side: 'any',
    state: 'assertArchiveVisible',
  },

  // ── Заведение, правка, удаление: сторона заказчика ──
  // У заведения область спрашивается не по заявке (её ещё нет), а по ПРЕДМЕТУ будущей:
  // `resolveRequestSubject` зовёт `assertServiceRequestScope` по площадке и отделу-заказчику.
  // Ручка объявлена `'visibility'` именно поэтому: вопрос «моя ли это область» здесь задаётся.
  'POST /api/v1/service-requests': { scope: 'visibility', side: 'customer', state: null },
  'PATCH /api/v1/service-requests/:id': {
    scope: 'visibility',
    side: 'customer',
    state: 'assertServiceRequestEditable',
  },
  // Срочность — своё право (Н12 плана переработки цикла), и держит его только «Ведение»: у
  // заказчика и у подрядчика его нет вовсе, поэтому дверь операторская, хотя стороны в теле нет.
  'PATCH /api/v1/service-requests/:id/urgency': {
    scope: 'visibility',
    side: 'operator',
    state: 'isServiceRequestClosed',
  },
  'DELETE /api/v1/service-requests/:id': {
    scope: 'visibility',
    side: 'customer',
    state: 'assertServiceRequestDeletable',
  },

  // ── Распределение ──
  'PUT /api/v1/service-requests/:id/executors': {
    scope: 'visibility',
    side: 'assigner',
    state: 'canAssignServiceExecutors',
  },

  // ── Ходы исполнителя ──
  // Все семь спрашивают сторону в теле, а не стражем: маршрут открыт «одному из прав»
  // (`estimate`/`status` ∨ `execute`), и назначение на ЭТУ заявку решает предикат. Признаки
  // назначения считаются ДО транзакции и в ней не пересчитываются — находка Н3, закрывает Р4.
  'PATCH /api/v1/service-requests/:id/decline': {
    scope: 'visibility',
    side: 'executor',
    state: 'canDeclineServiceRequest',
  },
  'PATCH /api/v1/service-requests/:id/start': {
    scope: 'visibility',
    side: 'executor',
    state: 'canStartServiceWork',
  },
  // Правка состава объёма работ: сторону спрашивает `assertExecutorSide`, состояние — замок Р9
  // («предъявление не висит»); статус `in_work` и вид «ремонт» проверяются там же.
  'PUT /api/v1/service-requests/:id/estimate': {
    scope: 'visibility',
    side: 'executor',
    state: 'serviceEstimatePending',
  },
  'PATCH /api/v1/service-requests/:id/estimate/submit': {
    scope: 'visibility',
    side: 'executor',
    state: 'canSubmitServiceEstimate',
  },
  /*
   * Согласование объёма работ — ЕДИНСТВЕННАЯ строка модуля, где сторон у двери две сразу, а поле
   * однозначно по построению. `canApproveServiceEstimate` пускает держателя
   * `serviceRequests.approveEstimate` («Ведение») ЛИБО поимённого исполнителя (Р3 плана упрощения
   * цикла, ADR 0145) и явно отбивает оператора контрагента-сервиса: подпись под собственным счётом
   * — не согласование.
   *
   * Названа сторона, ради которой ручка существует; вторая записана здесь словами, и прогон Э2
   * обязан проверить ОБЕ — иначе строка манифеста доказывала бы половину правила.
   */
  'PATCH /api/v1/service-requests/:id/estimate/approval': {
    scope: 'visibility',
    side: 'operator',
    state: 'canApproveServiceEstimate',
  },
  'PATCH /api/v1/service-requests/:id/estimate/reopen': {
    scope: 'visibility',
    side: 'executor',
    state: 'canReopenServiceEstimate',
  },
  // Состав расходников подбирает исполнитель, а не заявитель (Р15 плана упрощения цикла).
  // Состояние — перечень статусов поимённо («Новая» и «В работе»), своего предиката у него нет.
  'PUT /api/v1/service-requests/:id/consumables': {
    scope: 'visibility',
    side: 'executor',
    state: 'statusList',
  },
  // Факт выдачи: `assertConsumableIssuer` пускает назначенного исполнителя ЛИБО держателя
  // `serviceRequests.status` — то есть «Ведение», отмечающее выдачу за него. Дверь названа по
  // тому, кто картриджи вёз; вторая ветка — тот же приём «довести за исполнителя», что у
  // `assertExecutorSide`.
  'PATCH /api/v1/service-requests/:id/consumables/issued': {
    scope: 'visibility',
    side: 'executor',
    state: 'statusList',
  },
  // Закрытие работ: дуга `in_work → done` есть только у стороны исполнителя, и спрашивают её
  // `assertSideAllowed` до чтения строки и `assertTransition` с признаками назначения — после.
  // Названа дуга, а не равенство ревизий и не планка закрывающего документа: те две проверки
  // записаны в теле условиями без имени, а коридор отвечает и «из какого состояния», и «чей ход».
  'PATCH /api/v1/service-requests/:id/complete': {
    scope: 'visibility',
    side: 'executor',
    state: 'assertTransition',
  },
  // Примечание сервиса — ход исполнителя, не меняющий статуса: коридора у него нет, сторона та же.
  'PATCH /api/v1/service-requests/:id/service-comment': {
    scope: 'visibility',
    side: 'executor',
    state: 'isServiceRequestClosed',
  },

  // ── Ходы «Ведения» ──
  // Приёмка и возврат на доработку: дуги `done → accepted` и `done → in_work` есть только в
  // операторском коридоре (`SERVICE_OPERATOR_TRANSITIONS`), и подрядчик своей работы не принимает.
  'PATCH /api/v1/service-requests/:id/accept': {
    scope: 'visibility',
    side: 'operator',
    state: 'assertTransition',
  },
  'PATCH /api/v1/service-requests/:id/rework': {
    scope: 'visibility',
    side: 'operator',
    state: 'assertTransition',
  },
  // Отмена и административные откаты. Целевой статус называет тело, поэтому сторона спрашивается
  // дважды: `assertSideAllowed` по одной цели и `assertTransition` по паре «откуда → куда».
  'PATCH /api/v1/service-requests/:id/status': {
    scope: 'visibility',
    side: 'operator',
    state: 'assertTransition',
  },
  // Заморозка и возврат: право спрашивает обработчик (`canHoldService`/`canResumeService`), а не
  // страж — на маршруте стоит чтение модуля. Держит и отпускает заявку тот, кто её ведёт;
  // исполнителю заморозка закрыта при любом праве.
  'PATCH /api/v1/service-requests/:id/hold': {
    scope: 'visibility',
    side: 'operator',
    state: 'assertTransition',
  },
  'PATCH /api/v1/service-requests/:id/resume': {
    scope: 'visibility',
    side: 'operator',
    state: 'serviceResumeTarget',
  },
  /*
   * Повторная отправка письма службе. НАХОДКА Н8 ЗАКРЫТА (Р9), и строка изменилась вместе с кодом:
   * `side: 'any'` означало, что стороны у ручки нет вовсе, — а право `serviceRequests.status` есть
   * и у «Ведения», и у типа контрагента `service`, то есть повтор служебной рассылки заводил
   * всякий, у кого это право, включая подрядчика по СВОЕЙ заявке. Спасала его только область: оба
   * повторяемых события исполнителя не сохраняют, и до стороны дело не доходило.
   *
   * Теперь сторона спрашивается в теле (`assertServiceOperatorSide` → `actsAsServiceOperator`):
   * администратор либо держатель набора «Ведение», по коду набора, а не по сумме прав. Ни
   * назначение, ни `serviceRequests.execute` двери не открывают — письмо зовёт службу РАЗОБРАТЬ
   * заявку, и повторяет его тот, кто её ведёт.
   */
  'POST /api/v1/service-requests/:id/notify': {
    scope: 'visibility',
    side: 'operator',
    state: 'serviceMailRepeatable',
  },

  // ── Документы ──
  /*
   * Подшивка. НАХОДКА Н2 ЗАКРЫТА (Р3), и строка изменилась вместе с кодом: `side: 'any'` означало,
   * что стороны ручка не спрашивает вовсе, — а право `serviceRequests.files` есть и у заказчика, и
   * у сервисной компании, и у ИТ-службы по всей компании. Виды `act`, `invoice`, `warranty_card`
   * разрешены уже в «В работе», и наличие любого снимает планку закрывающего документа: основание
   * платежа вправе был подшить любой, кому заявка видна.
   *
   * Теперь сторона спрашивается в теле (`assertFileKindAllowed` → `canAttachServiceFileSide`), и
   * объявлена она `'executor'` — по главному виду, закрывающему документу. Вторая сторона у него
   * есть и записана здесь же, комментарием, как у `estimate/approval`: `act`, `invoice` и
   * `warranty_card` кладёт ещё и «Ведение» (`serviceRequests.status`) — акт приходит почтой, и
   * сканирует его тот, кто ведёт заявку. У `attachment` стороны нет вовсе (фотографию поломки
   * грузит заказчик), у `estimate` — только исполнитель. Пятизначный `side` этого не выражает, и
   * доказывает разницу прогон §6.11–§6.13, а не одно это поле.
   */
  'POST /api/v1/service-requests/:id/files': {
    scope: 'visibility',
    side: 'executor',
    state: 'assertFileKindAllowed',
  },
  // Снятие документа стороны тоже не спрашивает, но по другой причине, и находкой это не является:
  // здесь проверяется АВТОРСТВО вложения (снимает тот, кто приложил) либо `files.manageAny`, а
  // авторство — не сторона цикла. Все проверки стоят под `FOR UPDATE` по строке заявки.
  'DELETE /api/v1/service-requests/:id/files/:fileId': {
    scope: 'visibility',
    side: 'any',
    state: 'serviceEstimatePending',
  },

  // ── Архив ──
  // Возврат из архива: область спрашивается ДО разбора состояния — иначе чужую живую заявку можно
  // было бы прочитать этой ручкой в обход `serviceRequests.read`.
  'POST /api/v1/service-requests/:id/restore': {
    scope: 'visibility',
    side: 'any',
    state: 'archivedOnly',
  },
  // Удаление насовсем — общая ручка `registerPurgeRoute`, области у неё нет ни у одного модуля.
  // Записано как ЗАФИКСИРОВАННОЕ РЕШЕНИЕ (Н8): право `records.purge` невыдаваемое, за ручкой
  // администратор, и заводить ради него область в общей ручке дороже, чем назвать это вслух.
  'DELETE /api/v1/service-requests/:id/purge': {
    scope: 'none',
    why:
      'общая ручка удаления насовсем (`registerPurgeRoute`) области не спрашивает ни в одном ' +
      'модуле; за `records.purge` стоит администратор (Н8)',
    side: 'any',
    state: 'isDown',
  },

  // ── Внутренняя ручка планировщика ──
  // Автозакрытие «Решена» → «Закрыта»: за ней нет человека, от чьего имени она действует, — доступ
  // по общему секрету. Спрашивать область не у кого и не за кого.
  'POST /internal/service-requests/auto-close': {
    scope: 'none',
    why: 'системный субъект по общему секрету: человека за ручкой нет, и области у него не бывает',
    side: 'any',
    state: 'MATURE',
  },
} as const satisfies Record<ServiceRouteKey, ServiceRouteAccess>;

/** Ключи манифеста как литеральный union — чтобы ссылка на ручку модуля не разъезжалась молча. */
export type ServiceManifestRouteKey = keyof typeof SERVICE_ACCESS_MANIFEST;
