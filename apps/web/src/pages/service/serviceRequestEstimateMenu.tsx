import {
  AuditOutlined,
  CheckCircleOutlined,
  CloseSquareOutlined,
  FileTextOutlined,
  FlagOutlined,
  SolutionOutlined,
  UndoOutlined,
} from '@ant-design/icons';
import {
  canApproveServiceEstimate,
  canDeclareExemption,
  canOpenServiceEstimateDispute,
  canReopenServiceEstimate,
  canResolveServiceEstimateDispute,
  canSubmitServiceEstimate,
  evaluateExemption,
  hasFeature,
  serviceEstimateApprovalSourceOf,
  type ServiceActionRequest,
  type ServiceEstimateDisputeFacts,
  type ServiceExecutorAssignment,
  type ServiceRequestDto,
} from '@technic/contracts';
import type { ServiceMenuContext } from './serviceRequestModals';
import type { serviceReasonPrompts } from './serviceRequestPrompts';
import type { ServiceMenuItem } from './serviceStatusChoices';

/**
 * ПРИЗНАКИ, КОТОРЫМИ РЕШАЕТСЯ СПОР (Р9), — собранные из карточки, а не посчитанные своим правилом.
 *
 * Предикаты спора принимают их готовыми именно затем, что спрашивают его двое: сервер читает
 * таблицы (`disputeFactsOf`), портал — поля DTO. Слагаемые здесь те же и в том же составе, что на
 * сервере, и каждое отсекает своё состояние:
 *
 *   · заявление с исходом `applied` по ДЕЙСТВУЮЩЕЙ ревизии — наблюдённое (`observed`) освобождением
 *     не является вовсе, а заявление по прошлой ревизии снято переизданием;
 *   · подпись стоит под той же ревизией — возврат в правку снимает её, ревизии не поднимая;
 *   · источник подписи — `auto`: подписанный человеком объём работ возвращают в правку, а не
 *     оспаривают, иначе спор шёл бы по кругу вокруг подписи, которую сам же спор и потребовал.
 *
 * Источник читается ЕДИНСТВЕННЫМ носителем правила «пусто = человек»
 * (`serviceEstimateApprovalSourceOf`), а не сравнением с `'auto'` по месту: расхождение здесь
 * выглядит как «принято без согласования» у заявки, которую подписал живой человек, — то есть как
 * обвинение.
 *
 * ЧЕТЫРЕ СЛАГАЕМЫХ — ЧЕТЫРЕ ПОЛЯ КАРТОЧКИ, И ВСЕ ЧЕТЫРЕ СЕРВЕР ОТДАЁТ: `exemption` (исход и его
 * ревизия), `approval.revision`, `approval.source` и `dispute.state`. Это не мелочь учёта, а условие
 * существования пункта: не отдай сервер источник подписи, правило «пусто = человек» ответило бы
 * `human` на КАЖДОЙ заявке, `exemptionApplied` был бы ложен всегда, и «Оспорить освобождение» не
 * появилось бы никогда — нарисованный пункт, недостижимый по построению. Признак открытого спора
 * держится на том же: `holdKind` в карточку не отдаётся вовсе, а выводить спор из «Отложена» нечем —
 * отложенной бывает и заявка, ждущая запчасть, и «Разрешить спор» на ней был бы вторым мнением
 * портала о правах.
 *
 * ОТСЮДА И ПРАВИЛО ДЛЯ ПРАВОК: убирая или переименовывая любое из четырёх полей на сервере, сперва
 * спросите этот пункт — он исчезает молча, и заметит это не прогон, а «Ведение», оставшееся без
 * единственного входа в контроль постфактум.
 */
export function serviceEstimateDisputeFacts(
  request: ServiceRequestDto,
): ServiceEstimateDisputeFacts {
  const exemption = request.exemption ?? null;
  const approval = request.approval ?? null;
  return {
    exemptionApplied:
      exemption?.outcome === 'applied' &&
      exemption.revision === request.estimateRevision &&
      approval?.revision === request.estimateRevision &&
      serviceEstimateApprovalSourceOf(approval) === 'auto',
    disputeOpen: request.dispute?.state === 'open',
  };
}

/**
 * Шесть пунктов объёма работ: предъявить, согласовать, не согласовать, вернуть в правку — и два
 * пункта спора об освобождении от подписи (Р9): оспорить и разрешить.
 *
 * Отдельным модулем от хода заявки (`serviceRequestMenu`), и граница здесь та же, по которой рядом
 * отделены обстоятельства (`serviceRequestExtras`), — по предмету разговора. Объём работ это
 * разговор о ДЕНЬГАХ, и первые четыре действия заявку с места не двигают вовсе: меняют колонки
 * предъявления и подписи, а не статус (Р8, Р9). Спор её останавливает — и это не исключение из
 * границы, а её подтверждение: останавливают заявку ровно из-за денег, и разрешают спор там же,
 * где читают, кем и на каком основании они были приняты. Ход по циклу при этом живёт своей жизнью
 * и переживает переделки денежной части без единой правки — так и вышло прошлой волной: внутренний
 * ремонт перестал составлять объём работ, и весь набор целиком стал условным, не тронув ни одного
 * перехода.
 *
 * Признаки заявки (`row`), назначения и области действий приходят готовыми, как и у соседа: их
 * считает вызывающий, и второй разбор тех же полей здесь разошёлся бы с ходом молча.
 *
 * ДОСТУПНОСТЬ СЧИТАЮТ ПРЕДИКАТЫ КОНТРАКТОВ, а не этот модуль. После Р4/Р5 они спрашивают ещё и
 * «положен ли этой заявке объём работ» — у внутреннего ремонта его не бывает, — и пункты пропадают
 * сами. Своей проверки «есть ли подрядчик» здесь нет намеренно: вторая карта правил разошлась бы с
 * сервером, и меню предлагало бы действие, на которое придёт отказ.
 */
export function serviceEstimateMenuItems(
  request: ServiceRequestDto,
  ctx: ServiceMenuContext,
  assignment: ServiceExecutorAssignment,
  row: ServiceActionRequest,
  prompts: ReturnType<typeof serviceReasonPrompts>,
  /**
   * Область действий (план `docs/office-equipment-free-estimate-and-executor-scope-plan.md`, Р11):
   * первый сомножитель каждого пункта набора. Объём работ — деньги заявки, и трогать их вправе
   * только тот, кто вправе трогать саму заявку: бывшему исполнителю сервер отвечает 403 и на
   * предъявление, и на согласование, и на возврат в правку.
   */
  mayAct: boolean,
): ServiceMenuItem[] {
  const items: ServiceMenuItem[] = [];
  if (!mayAct) return items;

  /*
   * Предъявление объёма работ (Р8): поднимает ревизию и открывает ожидание подписи, оставляя заявку
   * в «В работе». Предикат держит и первый замок Р9 — пока предъявление висит, повторное запрещено:
   * иначе исполнитель подменил бы снимок суммы под уже открытым окном согласования.
   *
   * У расходников объёма работ нет вовсе: картридж берут со своего склада, согласовывать по нему
   * нечего и не у кого, — и вид заявки предикат проверяет сам.
   */
  if (canSubmitServiceEstimate(row, ctx.user, assignment)) {
    const documentEnabled = hasFeature(ctx.user, 'service_estimate_document_mode');
    const automaticallyApproved =
      documentEnabled &&
      canDeclareExemption(row, ctx.user, assignment) &&
      evaluateExemption({
        flagEnabled: hasFeature(ctx.user, 'service_estimate_exemption'),
        disputeRequiresSignature:
          request.dispute?.state === 'resolved' && request.dispute.outcome === 'require_signature',
      }) === 'applied';
    if (documentEnabled) {
      items.push({
        key: 'estimate',
        label: automaticallyApproved ? 'Работы выполнены' : 'Передать документ на согласование',
        icon: automaticallyApproved ? <CheckCircleOutlined /> : <FileTextOutlined />,
        // This is the primary step until the executor has submitted the first work document.
        primary: !request.estimateSubmittedAt,
        onClick: () =>
          ctx.modals.estimate(request, automaticallyApproved ? 'work_done' : 'document'),
      });
    }
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
      // Отказ по объёму работ — вторая дуга в «Отменена» (В1): различает их не пара статусов, а
      // содержание, поэтому в списке переходов их два.
      toStatus: 'cancelled',
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
      onClick: () => ctx.modals.ask(prompts.reopenEstimate),
    });
  }

  /*
   * СПОР ОБ ОСВОБОЖДЕНИИ (Р9) — два пункта, и оба доступны только «Ведению»: освобождение заявил
   * оператор сервиса, и спор с самим собой — не контроль, а его имитация. Проверяет это предикат
   * контрактов, здесь его условия не повторяются.
   *
   * ЦЕЛЕВОГО СТАТУСА У ОБОИХ НЕТ НАМЕРЕННО, хотя заявку они двигают. Открытие останавливает её
   * заморозкой, но приходит эта дверь не коридором: коридор в «Отложена» открывает право
   * `serviceRequests.hold`, а спор ведёт держатель `serviceRequests.assign`, и сервер здесь
   * коридор не спрашивает вовсе. Поставь мы `toStatus`, тег статуса предлагал бы ход, которого в
   * коридоре смотрящего нет, — и караул соответствия покраснел бы по делу. У разрешения цель и
   * вовсе динамическая: куда вернётся заявка, решает матрица «откуда открыт × исход» на сервере.
   */
  const disputeFacts = serviceEstimateDisputeFacts(request);
  if (canOpenServiceEstimateDispute(row, ctx.user, disputeFacts)) {
    items.push({
      key: 'estimate-dispute',
      label: 'Оспорить освобождение',
      icon: <FlagOutlined />,
      danger: true,
      onClick: () => ctx.modals.ask(prompts.openEstimateDispute),
    });
  }
  if (canResolveServiceEstimateDispute(row, ctx.user, disputeFacts)) {
    items.push({
      key: 'estimate-dispute-resolve',
      label: 'Разрешить спор',
      icon: <SolutionOutlined />,
      // Главный шаг остановленной спором заявки: пока спор не разрешён, по ней заперты и возврат из
      // заморозки, и закрытие работ, и приёмка.
      primary: true,
      onClick: () => ctx.modals.disputeResolution(request),
    });
  }

  return items;
}
