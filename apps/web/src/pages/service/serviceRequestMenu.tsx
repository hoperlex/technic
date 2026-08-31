import {
  AuditOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  CloseSquareOutlined,
  FileTextOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
  RollbackOutlined,
  StopOutlined,
  UndoOutlined,
  UserSwitchOutlined,
} from '@ant-design/icons';
import {
  allowedServiceStatusTransitions,
  canApproveServiceEstimate,
  canAssignServiceExecutors,
  canStartServiceWork,
  canDeclineServiceRequest,
  canReopenServiceEstimate,
  canResumeService,
  canSubmitServiceEstimate,
  hasServiceClosingDocument,
  serviceIsFirstAssignment,
  serviceRequestNeedsClosingDocument,
  type AuthUser,
  type ServiceRequestDto,
} from '@technic/contracts';
import type { HoldMode } from '@features/service-hold';
import type { ActionSheetItem } from '@shared/ui';
import type { ServiceRequestModals } from './serviceRequestModals';
import { serviceRequestExtraItems } from './serviceRequestExtras';
import { serviceReasonPrompts } from './serviceRequestPrompts';
import { serviceActionRow, serviceExecutorAssignment } from './serviceRequestRow';

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
 * перемещение техники, повтор письма. Граница проведена по смыслу, а не по длине файла — ход
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
    /** Повтор письма службе (Р70): ключ идемпотентности тоже держит хук. */
    notify: (request: ServiceRequestDto) => void;
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
): ActionSheetItem[] {
  // Архивной заявке ход не положен: её либо восстанавливают, либо сносят — это действия архива.
  if (request.deletedAt) return [];

  const assignment = serviceExecutorAssignment(request, ctx.user);
  /*
   * Строка заявки для предикатов Р11: состав исполнителей и непогашенное предъявление в том виде, в
   * каком их читают контракты. Считается один раз на весь набор — спрашивающих её пятеро.
   */
  const row = serviceActionRow(request);
  const allowed = allowedServiceStatusTransitions(request.status, ctx.user, assignment);
  const has = (status: (typeof allowed)[number]) => allowed.includes(status);
  const items: ActionSheetItem[] = [];
  const ask = ctx.modals.ask;
  // Действия «только с причиной» собраны отдельно: их пять, и различаются они подписями, а не
  // поведением (`serviceRequestPrompts.ts`).
  const prompts = serviceReasonPrompts(request);

  /*
   * Назначение переходом быть перестало (Р5): состав исполнителей пишет `PUT /:id/executors`, а
   * видно ли действие — отвечает предикат. Он же держит запрет переназначения под висящим
   * предъявлением: прежде его держал статус «Смета на согласовании», и, сняв статус, мы потеряли бы
   * запрет молча.
   */
  if (canAssignServiceExecutors(row, ctx.user)) {
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
   * Оговорка про оператора подрядчика: у него предикат исполнителя истинен и по нераспределённой
   * заявке (портал не знает, какой компании она отдана, — см. `serviceRequestRow.ts`), и границу
   * там держит область видимости, а не признак.
   * Найдено db-тестами при реализации.
   *
   * Пункт остаётся в меню и после того, как действие вышло быстрой кнопкой в строку списка и в
   * шапку карточки: убери мы его, действие пропало бы на телефоне, где меню открывается шитом.
   */
  if (canStartServiceWork(row, ctx.user, assignment)) {
    items.push({
      key: 'start',
      label: 'Принять в работу',
      icon: <PlayCircleOutlined />,
      primary: true,
      onClick: () => ctx.run.start(request),
    });
  }

  /*
   * Отказ переходом быть перестал вместе с назначением (Р7): отказавшийся стоит в «Новой», и
   * статуса заявке менять не нужно — меняется только состав. Частичный отказ от полного предикат не
   * отличает и отличать не должен: кого снимать — свою строку или всю компанию — решает ручка, а
   * «остался ли кто-то ещё» отвечает уже очередь.
   */
  if (canDeclineServiceRequest(row, ctx.user, assignment)) {
    items.push({
      key: 'decline',
      label: 'Отказаться от заявки',
      icon: <CloseCircleOutlined />,
      danger: true,
      onClick: () => ask(prompts.decline),
    });
  }

  /*
   * Предъявление объёма работ (Р8): поднимает ревизию и открывает ожидание подписи, оставляя заявку
   * в «В работе». Предикат держит и первый замок Р9 — пока предъявление висит, повторное запрещено:
   * иначе исполнитель подменил бы снимок суммы под уже открытым окном согласования.
   *
   * У расходников объёма работ нет вовсе: картридж берут со своего склада, согласовывать по нему
   * нечего и не у кого, — и вид заявки предикат проверяет сам.
   */
  if (canSubmitServiceEstimate(row, ctx.user, assignment)) {
    items.push({
      key: 'estimate',
      label: 'Объём работ',
      icon: <FileTextOutlined />,
      // Главный шаг, пока объём работ ни разу не предъявляли: дальше главное — закрыть работы.
      primary: !request.estimateSubmittedAt,
      onClick: () => ctx.modals.estimate(request),
    });
  }

  /*
   * Согласование (Р8, Р11) — двумя пунктами, а не одним «Согласование объёма работ»: исходы у него
   * разные и по цене ошибки, и по содержанию. «Согласовано» ничего не спрашивает и статуса не
   * меняет; «не согласовано» уводит заявку в «Отменена» с обязательными причиной и решением (В1).
   *
   * Те же два действия стоят кнопками под таблицей объёма работ (просьба заказчика дословно), и это
   * не дублирование: оба входа спрашивают один предикат, а карточку открывают и с телефона, где
   * вкладку надо сперва найти.
   *
   * Сторону согласующего считает предикат: право «Ведения» либо поимённое назначение (Р3). Оператор
   * подрядчика исключён им же — подпись под собственным счётом не согласование, а его копия.
   */
  if (canApproveServiceEstimate(row, ctx.user, assignment)) {
    items.push({
      key: 'approve',
      label: 'Согласовать объём работ',
      icon: <AuditOutlined />,
      primary: true, // пока подписи нет, работы стоят: это и есть главный шаг «В работе»
      onClick: () => ctx.run.approve(request),
    });
    items.push({
      key: 'reject',
      label: 'Не согласовать объём работ',
      icon: <CloseSquareOutlined />,
      danger: true,
      onClick: () => ctx.modals.approval(request),
    });
  }

  /*
   * «Вернуть объём работ в правку» (Р9) — ключ от обоих замков: ручка снимает и снимок
   * согласования, и само предъявление. Отсюда и предусловие предиката «есть что снимать» — подпись
   * ЛИБО непогашенное предъявление; прежнего «согласование есть» после Р9 мало, иначе отозвать
   * собственное предъявление было бы нечем.
   */
  if (canReopenServiceEstimate(row, ctx.user, assignment)) {
    items.push({
      key: 'reopen',
      label: 'Вернуть объём в правку',
      icon: <UndoOutlined />,
      onClick: () => ask(prompts.reopenEstimate),
    });
  }

  if (request.status === 'in_work' && has('done')) {
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
      }) && !hasServiceClosingDocument(request);
    items.push({
      key: 'complete',
      label: 'Закрыть работы',
      icon: <CheckCircleOutlined />,
      primary: !needsDoc,
      disabled: needsDoc,
      disabledReason: needsDoc
        ? 'Сначала подшейте акт, счёт или гарантийный талон — без документа заявка не уходит в «Решена»'
        : undefined,
      onClick: () => ctx.modals.complete(request),
    });
  }

  if (request.status === 'done') {
    if (has('accepted')) {
      items.push({
        key: 'accept',
        label: 'Принять работу',
        icon: <CheckCircleOutlined />,
        // Сюда же ведёт подпись «Вам: нужен закрывающий документ» (Р120): бумагу подшивают в том же
        // окне, и второго адреса у этого шага нет.
        primary: true,
        onClick: () => ctx.modals.accept(request, 'accept'),
      });
    }
    if (has('in_work')) {
      items.push({
        key: 'rework',
        label: 'Вернуть на доработку',
        icon: <RollbackOutlined />,
        danger: true,
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
   */
  if (request.status === 'in_work' && has('new')) {
    items.push({
      key: 'rollback-start',
      label: 'Вернуть в «Новую»',
      icon: <UndoOutlined />,
      danger: true,
      onClick: () => ctx.run.rollbackStart(request),
    });
  }

  if (request.status === 'accepted' && has('done')) {
    items.push({
      key: 'rollback-accept',
      label: 'Отменить приёмку',
      icon: <UndoOutlined />,
      danger: true,
      onClick: () => ask(prompts.rollbackAcceptance),
    });
  }

  if (request.status === 'cancelled' && has('new')) {
    items.push({
      key: 'reopen-request',
      label: 'Вернуть в работу',
      icon: <UndoOutlined />,
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
  const holdMode: HoldMode | null =
    request.status === 'on_hold'
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
      onClick: () => ctx.modals.hold(request, holdMode),
    });
  }

  // Обстоятельства заявки — после её хода: сперва «что с ней делать дальше», потом «что при ней
  // поправить». Тем же порядком, каким набор действий записи вообще читается сверху вниз.
  items.push(...serviceRequestExtraItems(request, ctx, assignment, row));

  // Отмена — последней и красной: она отнимает работу целиком, и место рядом с ходами по циклу
  // предлагало бы её наравне с ними.
  if (has('cancelled')) {
    items.push({
      key: 'cancel',
      label: 'Отменить заявку',
      icon: <StopOutlined />,
      danger: true,
      onClick: () => ask(prompts.cancel),
    });
  }

  return items;
}
