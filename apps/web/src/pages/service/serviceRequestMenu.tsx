import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
  RollbackOutlined,
  StopOutlined,
  UndoOutlined,
  UserSwitchOutlined,
} from '@ant-design/icons';
import {
  allowedServiceStatusTransitions,
  can as hasPermission,
  canAssignServiceExecutors,
  canStartServiceWork,
  canDeclineServiceRequest,
  canResumeService,
  hasServiceClosingDocument,
  serviceIsFirstAssignment,
  serviceRequestNeedsClosingDocument,
  type AuthUser,
  type ServiceRequestDto,
} from '@technic/contracts';
import type { HoldMode } from '@features/service-hold';
import { serviceAcceptLock, type ServiceMenuItem } from './serviceStatusChoices';
import type { ServiceRequestModals } from './serviceRequestModals';
import { serviceEstimateMenuItems } from './serviceRequestEstimateMenu';
import { serviceRequestExtraItems } from './serviceRequestExtras';
import { serviceReasonPrompts } from './serviceRequestPrompts';
import {
  mayActOnServiceRequest,
  serviceActionRow,
  serviceExecutorAssignment,
} from './serviceRequestRow';

/**
 * Перечень действий заявки: что субъекту доступно и как это подписано.
 *
 * Отдельно от хука (`serviceRequestActions`), потому что это два разных предмета. Там живут
 * мутации, подтверждения и владение окнами — **чем** действие делается; здесь — **что доступно и
 * как называется**. Разрез появился вместе с Р11: доступность уехала в предикаты контрактов, и
 * перечень пунктов перестал зависеть от чего-либо, кроме заявки и субъекта, — то есть стал чистой
 * функцией, которую можно прочитать целиком, не разбираясь в кэше запросов.
 *
 * Ищутся действия двумя способами, и это не разнобой. Там, где действие осталось переходом
 * (принять в работу, закрыть работы, приёмка, отмена, заморозка), спрашивается **коридор**
 * `allowedServiceStatusTransitions` — одна функция на сервер и портал. Там, где действие переходом
 * быть перестало (назначение, отказ, предъявление объёма работ, согласование, возврат в правку),
 * дуги нет вовсе, и спрашивается **свой предикат** Р11. Ищи мы их по-прежнему в коридоре —
 * `has('assigned')`, `has('new')`, `has('estimate_review')`, — пункты просто исчезли бы с экрана, и
 * ошибка была бы молчаливой: сервер разрешает, портал не рисует.
 *
 * Второй карты правил портал не держит ни в одном из двух случаев: разойдись она с сервером, кнопка
 * вела бы в 403 либо пропадала бы у того, кому действие разрешено, — и обнаружилось бы это на
 * экране, а не в тестах.
 *
 * Здесь — только **ход заявки по циклу**. Всё, что делают вокруг неё, не двигая, живёт соседним
 * модулем (`serviceRequestExtras`): состав номенклатуры, отметка выдачи, срочность, обсуждение,
 * перемещение техники. Граница проведена по смыслу, а не по длине файла — ход
 * заявки меняется вместе с циклом, обстоятельства живут своей жизнью, — и порядок пунктов ей
 * следует: сперва ход, затем обстоятельства, и отмена последней, потому что она отнимает работу
 * целиком.
 */

/** Чем перечень пользуется помимо самой заявки: смотрящий, окна и действия без окна. */
export interface ServiceMenuContext {
  /** Смотрящий: от него зависят и права, и сторона исполнителя на этой заявке. */
  user: AuthUser | null;
  /** Окна заявки: какое открыть — решает пункт, чем оно устроено — набор окон. */
  modals: ServiceRequestModals;
  /**
   * Действия, у которых нет ни окна, ни причины: они уходят прямо в мутацию хука. Передаются
   * обработчиками, а не мутациями, чтобы перечень пунктов не знал ни про кэш запросов, ни про
   * подтверждения — иначе разрез потерял бы смысл.
   */
  run: {
    /** «Принять в работу» (Р6): содержания у хода нет вовсе — только версия заявки. */
    start: (request: ServiceRequestDto) => void;
    /** «Согласовано» (Р8): подтверждение с суммой и ревизией живёт в хуке, рядом с мутацией. */
    approve: (request: ServiceRequestDto) => void;
    /**
     * Откат «принял в работу» (Р13): `in_work → new`, причины переход не требует
     * (`serviceStatusChangeRequiresReason` о нём молчит), поэтому и подтверждение живёт в хуке.
     */
    rollbackStart: (request: ServiceRequestDto) => void;
  };
}

/*
 * Признак `primary` — главный шаг текущего состояния (Р117): к нему ведёт подпись «Вам: …» в
 * столбце состояния, и он же становится быстрой кнопкой. Он живёт прямо здесь, у пункта, а не
 * второй картой «статус → окно»: карта разошлась бы с набором действий на первом же изменении
 * цикла — строка звала бы к действию, которого в меню уже нет.
 */
export function serviceRequestMenuItems(
  request: ServiceRequestDto,
  ctx: ServiceMenuContext,
): ServiceMenuItem[] {
  // Архивной заявке ход не положен: её либо восстанавливают, либо сносят — это действия архива.
  if (request.deletedAt) return [];

  const assignment = serviceExecutorAssignment(request, ctx.user);
  /*
   * Строка заявки для предикатов Р11: состав исполнителей и непогашенное предъявление в том виде, в
   * каком их читают контракты. Считается один раз на весь набор — спрашивающих её пятеро.
   */
  const row = serviceActionRow(request);
  /*
   * ОБЛАСТЬ ДЕЙСТВИЙ — ПЕРВЫЙ СОМНОЖИТЕЛЬ КАЖДОГО ИЗМЕНЯЮЩЕГО ПУНКТА (план
   * `docs/office-equipment-free-estimate-and-executor-scope-plan.md`, Р11). Прежде набор спрашивал
   * только право и статус: предикаты вроде `canAssignServiceExecutors` про отношение субъекта к
   * ЭТОЙ заявке не знают вовсе — и бывшему исполнителю рисовалась бы кнопка «Изменить
   * исполнителей», на которую сервер отвечает 403. Обещаний, которых сервер не выполняет, модуль
   * избегает предикатами с ADR 0162, и это из того же ряда.
   *
   * Признак считается ОДИН РАЗ на весь набор и уходит соседним модулям параметром — ровно как
   * `row` и `assignment` рядом: второй его разбор внутри `serviceRequestExtras` разошёлся бы с
   * ходом заявки молча.
   *
   * Ветку «набор пуст» здесь не заводят: чтение и обсуждение областью действий не закрываются
   * (ответ В11), а пункт «Обсуждение» живёт как раз в наборе — верни мы отсюда пустой список,
   * снятый исполнитель потерял бы единственный вход в переписку по заявке, которую видит.
   */
  const mayAct = mayActOnServiceRequest(request, ctx.user);
  const allowed = allowedServiceStatusTransitions(request.status, ctx.user, assignment);
  const has = (status: (typeof allowed)[number]) => allowed.includes(status);
  const items: ServiceMenuItem[] = [];
  const ask = ctx.modals.ask;
  // Действия «только с причиной» собраны отдельно: их четыре, и различаются они подписями, а не
  // поведением (`serviceRequestPrompts.ts`). Отмена в набор не входит — у неё своё окно (Р10).
  const prompts = serviceReasonPrompts(request);

  /*
   * Назначение переходом быть перестало (Р5): состав исполнителей пишет `PUT /:id/executors`, а
   * видно ли действие — отвечает предикат. Он же держит запрет переназначения под висящим
   * предъявлением: прежде его держал статус «Смета на согласовании», и, сняв статус, мы потеряли бы
   * запрет молча.
   */
  if (mayAct && canAssignServiceExecutors(row, ctx.user)) {
    // Первое назначение — главный шаг «Новой»; дальше это уже переназначение, то есть разбор
    // ошибки, а не ожидаемый ход. Признак читается по составу исполнителей, а не по статусу (Р11):
    // статус с ним лишь СОВПАДАЛ, и совпадать больше нечему.
    const first = serviceIsFirstAssignment(row);
    items.push({
      key: 'assign',
      label: first ? 'Назначить исполнителей' : 'Изменить исполнителей',
      icon: <UserSwitchOutlined />,
      primary: first,
      onClick: () => ctx.modals.assign(request),
    });
  }

  /*
   * «Принять в работу» (Р6) — из «Новой»: промежуточной «Назначенной» между заведением и работой
   * больше нет.
   *
   * Спрашивается ПРЕДИКАТОМ, а не коридором, хотя ход и остался переходом. Прежний комментарий тут
   * утверждал, что коридора достаточно — «факт назначения сам закрывает ход у нераспределённой
   * заявки, предикат исполнителя ложен при любом праве», — и это неверно наполовину: коридор
   * открывает дизъюнкция, вторая половина которой (право на объём работ) назначения не спрашивает.
   * По коридору пункт рисовался бы у нераспределённой заявки администратору, а сервер отвечал бы
   * отказом — то самое расхождение портала с сервером, от которого модуль защищается предикатами.
   * Оговорка про оператора подрядчика снята вместе с приближением (Р8): портал теперь знает, какой
   * компании отдана заявка (`counterpartyId` в `AuthUser`), и по нераспределённой предикат
   * исполнителя ложен у него так же, как на сервере, — границу держит признак, а не соседнее
   * правило области.
   * Найдено db-тестами при реализации.
   *
   * Пункт остаётся в меню и после того, как действие вышло быстрой кнопкой в строку списка и в
   * шапку карточки: убери мы его, действие пропало бы на телефоне, где меню открывается шитом.
   */
  if (mayAct && canStartServiceWork(row, ctx.user, assignment)) {
    items.push({
      key: 'start',
      label: 'Принять в работу',
      icon: <PlayCircleOutlined />,
      primary: true,
      toStatus: 'in_work',
      onClick: () => ctx.run.start(request),
    });
  }

  /*
   * Отказ переходом быть перестал вместе с назначением (Р7): отказавшийся стоит в «Новой», и
   * статуса заявке менять не нужно — меняется только состав. Частичный отказ от полного предикат не
   * отличает и отличать не должен: кого снимать — свою строку или всю компанию — решает ручка, а
   * «остался ли кто-то ещё» отвечает уже очередь.
   */
  if (mayAct && canDeclineServiceRequest(row, ctx.user, assignment)) {
    items.push({
      key: 'decline',
      label: 'Отказаться от заявки',
      icon: <CloseCircleOutlined />,
      danger: true,
      onClick: () => ask(prompts.decline),
    });
  }

  /*
   * Объём работ — четыре пункта соседним модулем (`serviceRequestEstimateMenu`). Разрез по
   * предмету, а не по длине: это разговор о деньгах внутри одного статуса, и заявку он не двигает —
   * ровно та граница, по которой рядом отделены обстоятельства (`serviceRequestExtras`). Волна
   * «внутренний ремонт без объёма работ» это и подтвердила: весь набор целиком стал условным, не
   * тронув ни одного перехода.
   */
  items.push(...serviceEstimateMenuItems(request, ctx, assignment, row, prompts, mayAct));

  if (mayAct && request.status === 'in_work' && has('done')) {
    /*
     * Планка закрывающего документа переехала с приёмки на «Решена» (Н8) и стоит только у
     * сервисного ремонта — предикат контрактов, а не своя копия правила. Кнопка при этом остаётся
     * видимой и неактивной: спрятанная, она читалась бы как «мне это не положено», а причина
     * запрета — «бумаги нет», и она написана рядом.
     *
     * Предикат берёт вид заявки и назначенного контрагента; в DTO компания лежит объектом
     * (`service`), поэтому сюда передаётся её идентификатор, а правило остаётся одно на портал и
     * сервер.
     */
    const needsDoc =
      serviceRequestNeedsClosingDocument({
        kind: request.kind,
        serviceCounterpartyId: request.service?.id ?? null,
      }) && !hasServiceClosingDocument(request, request.estimateFormat ?? null);
    items.push({
      key: 'complete',
      label: 'Закрыть работы',
      icon: <CheckCircleOutlined />,
      primary: !needsDoc,
      toStatus: 'done',
      disabled: needsDoc,
      disabledReason: needsDoc
        ? 'Сначала подшейте акт, счёт или гарантийный талон — без документа заявка не уходит в «Решена»'
        : undefined,
      onClick: () => ctx.modals.complete(request),
    });
  }

  if (mayAct && request.status === 'done') {
    if (has('accepted')) {
      items.push({
        key: 'accept',
        label: 'Принять работу',
        icon: <CheckCircleOutlined />,
        toStatus: 'accepted',
        // Сюда же ведёт подпись «Вам: нужен закрывающий документ» (Р120): бумагу подшивают в том
        // же окне. Замок непроверенного предмета (Р16) снимает и подпись, и саму кнопку.
        ...serviceAcceptLock(request),
        onClick: () => ctx.modals.accept(request, 'accept'),
      });
    }
    if (has('in_work')) {
      items.push({
        key: 'rework',
        label: 'Вернуть на доработку',
        icon: <RollbackOutlined />,
        danger: true,
        toStatus: 'in_work',
        onClick: () => ctx.modals.accept(request, 'rework'),
      });
    }
  }

  /*
   * Откат «принял в работу» (Р13) — единственный ход по живой дуге `in_work → new`, и пункта у неё
   * не было: прежний «Вернуть в «Новую»» висел на `assigned`, снятом вместе со статусом.
   *
   * Это НЕ «отмотать назначение». Матрица сброса на этой дуге не снимает ничего
   * (`serviceResetOnTransition`), исполнители остаются на заявке, и она возвращается к ним же —
   * дальше «Принять в работу» нажимают заново. Отсюда и подпись, и подтверждение: скажи они
   * «вернуть заявку оператору», человек ждал бы освобождённой заявки, а получил бы прежний состав.
   *
   * Причины переход не требует, и выдумывать её нельзя: она требовалась дуге `assigned → new`,
   * которая снимала исполнителя, — а этот откат не снимает.
   *
   * ПРАВО СПРАШИВАЕТСЯ ОТДЕЛЬНО ОТ ДУГИ, и это единственный пункт файла, которому одного коридора
   * мало. Дуга `in_work → new` приходит в коридор от `SERVICE_ASSIGNER_TRANSITIONS`, то есть по
   * праву `serviceRequests.assign`, а сам пункт уходит в `PATCH /:id/status`, за которым стоит
   * страж `serviceRequests.status`. У профиля «Системный администратор» (`assign` и `hold` есть,
   * `status` нет) пункт поэтому рисовался и отвечал 403 «Недостаточно прав для смены статуса» —
   * проверено прямым опросом сервера. Спрашиваем ровно то, что спросит ручка: правило то же, что у
   * соседей в `serviceRequestExtras` («несбывающееся действие в меню — это обещание, за которым
   * пусто»).
   *
   * Прежде та же дуга обслуживала и ПЕРЕназначение — `PUT /:id/executors` сам возвращал работающую
   * заявку в «Новую». Больше не возвращает (ADR 0187), и у дуги остался один ход: этот. Само
   * переназначение при этом никуда не делось — «Изменить исполнителей» живёт своим пунктом со своим
   * предикатом и коридора не спрашивает вовсе.
   */
  if (
    mayAct &&
    request.status === 'in_work' &&
    has('new') &&
    hasPermission(ctx.user, 'serviceRequests.status')
  ) {
    items.push({
      key: 'rollback-start',
      label: 'Вернуть в «Новую»',
      icon: <UndoOutlined />,
      danger: true,
      toStatus: 'new',
      // В списке переходов имя статуса уже стоит первым словом: «Новая · вернуть в «Новую»»
      // заставляло бы искать разницу между половинами подписи.
      transitionLabel: 'откатить приём в работу',
      onClick: () => ctx.run.rollbackStart(request),
    });
  }

  if (mayAct && request.status === 'accepted' && has('done')) {
    items.push({
      key: 'rollback-accept',
      label: 'Отменить приёмку',
      icon: <UndoOutlined />,
      danger: true,
      toStatus: 'done',
      onClick: () => ask(prompts.rollbackAcceptance),
    });
  }

  if (mayAct && request.status === 'cancelled' && has('new')) {
    items.push({
      key: 'reopen-request',
      label: 'Вернуть в работу',
      icon: <UndoOutlined />,
      toStatus: 'new',
      transitionLabel: 'вернуть отменённую заявку в работу',
      onClick: () => ask(prompts.reopenRequest),
    });
  }

  /*
   * Заморозка и выход из неё (Р103) — одним пунктом: это два конца одной остановки, и в каждом
   * статусе доступен ровно один из них. Дугу в `on_hold` выдаёт коридор — исполнителю её там нет
   * (Р105), и спрашивать роль здесь незачем; возврат коридором не выражается вовсе: цель у него
   * динамическая — статус, из которого заявку отложили (Р104), — поэтому право спрашивается тем же
   * предикатом, что и на сервере.
   */
  const holdMode: HoldMode | null = !mayAct
    ? null
    : request.status === 'on_hold'
      ? canResumeService(ctx.user)
        ? 'resume'
        : null
      : has('on_hold')
        ? 'hold'
        : null;
  if (holdMode) {
    items.push({
      key: holdMode,
      label: holdMode === 'resume' ? 'Возобновить' : 'Отложить',
      icon: holdMode === 'resume' ? <PlayCircleOutlined /> : <PauseCircleOutlined />,
      // У возврата цель динамическая и считается по заявке (`serviceResumeTarget`) — её подставляет
      // сама проекция: здесь про неё известно только то, что она есть.
      toStatus: holdMode === 'hold' ? 'on_hold' : undefined,
      onClick: () => ctx.modals.hold(request, holdMode),
    });
  }

  // Обстоятельства заявки — после её хода: сперва «что с ней делать дальше», потом «что при ней
  // поправить». Тем же порядком, каким набор действий записи вообще читается сверху вниз.
  items.push(...serviceRequestExtraItems(request, ctx, assignment, row, mayAct));

  // Отмена — последней и красной: она отнимает работу целиком, и место рядом с ходами по циклу
  // предлагало бы её наравне с ними. Окно у неё своё (Р10): у ремонта спрашивают ещё и решение
  // «что делаем вместо» с пометкой замены — единственный оставшийся вход для «чинить
  // нецелесообразно» там, где отказа по объёму работ больше не бывает.
  if (mayAct && has('cancelled')) {
    items.push({
      key: 'cancel',
      label: 'Отменить заявку',
      icon: <StopOutlined />,
      danger: true,
      toStatus: 'cancelled',
      onClick: () => ctx.modals.cancel(request),
    });
  }

  return items;
}
