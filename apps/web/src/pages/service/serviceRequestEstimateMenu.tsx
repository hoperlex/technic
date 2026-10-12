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
  type ServiceActionRequest,
  type ServiceEstimateDisputeFacts,
  type ServiceExecutorAssignment,
  type ServiceRequestDto,
} from '@technic/contracts';
import type { ServiceMenuContext } from './serviceRequestModals';
import type { serviceReasonPrompts } from './serviceRequestPrompts';
import type { ServiceMenuItem } from './serviceStatusChoices';

/**
 * THE FACTS THE DISPUTE IS DECIDED BY (Р9) — collected from the card, not computed by a rule of the
 * portal's own.
 *
 * The dispute predicates take them ready-made precisely because two sides ask: the server reads the
 * tables (`disputeFactsOf`), the portal reads the DTO fields. The terms here are the same and in the
 * same composition as on the server, and each cuts off its own state:
 *
 *   · a declaration with the outcome `applied` on the CURRENT revision — an `observed` one is not an
 *     exemption at all, and a declaration on a past revision was superseded by a re-issue;
 *   · the signature stands under the same revision — the return for editing removes it without
 *     raising the revision;
 *   · the signature source is `auto`: an estimate signed by a person is returned for editing, not
 *     disputed, otherwise the dispute would circle around the very signature it demanded.
 *
 * The source is read as the server sends it. Since release B (ADR 0183) a signature always comes
 * with its source — the database pairs them (`service_requests_estimate_approval_source_check`) — so
 * there is no "empty means a person" rule left to apply here.
 *
 * FOUR TERMS — FOUR CARD FIELDS, AND THE SERVER SENDS ALL FOUR: `exemption` (the outcome and its
 * revision), `approval.revision`, `approval.source` and `dispute.state`. This is a condition of the
 * item's existence, not bookkeeping: drop the source from the server's answer and
 * `exemptionApplied` would be false on EVERY request, so «Оспорить освобождение» would never appear —
 * an item drawn but unreachable by construction. The open-dispute fact rests on the same: `holdKind`
 * is not sent to the card at all, and there is nothing to infer a dispute from «Отложена» with — a
 * request waiting for a spare part is on hold too, and «Разрешить спор» on it would be a second
 * opinion of the portal about rights.
 *
 * HENCE THE RULE FOR EDITS: before removing or renaming any of the four fields on the server, ask
 * this item — it disappears silently, and the one to notice is not a test run but «Ведение», left
 * without its only entry into after-the-fact control.
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
      approval.source === 'auto',
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
