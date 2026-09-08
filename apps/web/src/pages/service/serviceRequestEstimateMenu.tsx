import {
  AuditOutlined,
  CloseSquareOutlined,
  FileTextOutlined,
  UndoOutlined,
} from '@ant-design/icons';
import {
  canApproveServiceEstimate,
  canReopenServiceEstimate,
  canSubmitServiceEstimate,
  type ServiceActionRequest,
  type ServiceExecutorAssignment,
  type ServiceRequestDto,
} from '@technic/contracts';
import type { ServiceMenuContext } from './serviceRequestMenu';
import type { serviceReasonPrompts } from './serviceRequestPrompts';
import type { ServiceMenuItem } from './serviceStatusChoices';

/**
 * Четыре пункта объёма работ: предъявить, согласовать, не согласовать, вернуть в правку.
 *
 * Отдельным модулем от хода заявки (`serviceRequestMenu`), и граница здесь та же, по которой рядом
 * отделены обстоятельства (`serviceRequestExtras`), — по предмету разговора. Объём работ это
 * разговор о ДЕНЬГАХ внутри одного статуса «В работе»: заявка при нём с места не двигается, все
 * четыре действия меняют колонки предъявления и подписи, а не статус (Р8, Р9). Ход по циклу живёт
 * своей жизнью и переживает переделки денежной части без единой правки — так и вышло этой волной:
 * внутренний ремонт перестал составлять объём работ, и весь набор целиком стал условным, не тронув
 * ни одного перехода.
 *
 * Признаки заявки (`row`) и назначения приходят готовыми, как и у соседа: их считает вызывающий, и
 * второй разбор тех же полей здесь разошёлся бы с ходом молча.
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
): ServiceMenuItem[] {
  const items: ServiceMenuItem[] = [];

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

  return items;
}
