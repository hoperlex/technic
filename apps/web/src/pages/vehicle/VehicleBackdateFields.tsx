import { useQuery } from '@tanstack/react-query';
import { Form, Input, Typography } from 'antd';
import {
  esm2Mode,
  esm2Periods,
  isShiftDayInTerm,
  moscowDateKeyOf,
  type RequestCalendar,
  routeDateMismatch,
  type VehicleRequestDto,
} from '@technic/contracts';
import { vehicleRequestsApi } from '../../api/resources';
import { formatDateOnly } from '../../utils/date';

/**
 * Задним числом (ADR 0101, Р6 и Р15): причина правки и её цена — в той же форме, где выбрали дату.
 *
 * Блок появляется ровно тогда, когда операция уходит в прошлое, и делает две вещи.
 *
 * **Спрашивает причину.** Она не украшение и не поле «комментарий»: причина уезжает в запись
 * операции (`waybill_corrections`) и остаётся единственным объяснением того, почему заявка
 * заведена вчерашним днём, — через два месяца её прочтёт бухгалтерия, а не автор.
 *
 * **Называет последствия до нажатия.** Дата заявки тянет за собой рейс, бумагу и подписи объекта, и
 * узнавать об этом из журнала на следующий день поздно. Каждая строка считается тем же контрактом,
 * которым её считает сервер, — расходиться им здесь нельзя: обещание портала и поведение ручки
 * должны совпадать дословно.
 */
/**
 * Причина заднего числа одним полем — для дверей, у которых последствий перечислять нечего
 * (ADR 0101 п. 4): выписка ЭСМ-2 за прошедшую неделю, перегон и день заказа прошедшим числом.
 *
 * Отдельно от `VehicleBackdateFields`, а не флагом «без последствий»: тот блок держит расчёт цены
 * правки — недели ЭСМ-2, смены за новым сроком, расхождение с днём рейса, — и ни одна из этих
 * строк к этим трём дверям не относится. Общим у них остаётся только само поле, и оно здесь.
 *
 * Имя поля — `reason`: так его называет и тело запроса у всех трёх ручек (у правки заявки поле
 * зовётся `backdateReason`, потому что рядом с ним живёт комментарий заявки).
 */
export function BackdateReasonField({
  effectiveDate,
  /** Чем обернётся операция — одной строкой под полем: «лист уйдёт в журнал коррекций» и т. п. */
  consequence,
  placeholder,
}: {
  effectiveDate: string;
  consequence: string;
  placeholder: string;
}) {
  return (
    <Form.Item
      name="reason"
      label="Причина заднего числа"
      // Обязательна на сервере (`backdateGuard` вернёт 422 без неё) — значит обязательна и здесь:
      // отправлять заведомо отклоняемое тело форма не должна.
      rules={[{ required: true, message: 'Укажите причину' }]}
      extra={`Дата ${formatDateOnly(effectiveDate)} уже прошла: ${consequence}`}
    >
      <Input.TextArea rows={2} maxLength={2000} showCount placeholder={placeholder} />
    </Form.Item>
  );
}

interface Props {
  /** Правимая заявка; `null` — заведение: последствий у него нет, есть только объяснение. */
  record: VehicleRequestDto | null;
  /** Календарь, каким его показывает форма прямо сейчас. */
  next: RequestCalendar;
  /**
   * Эффективная дата операции — та, по которой сервер спросит право (`movedRequestDateKey` у
   * правки, выбранный день у заведения). Блок показывается только с датой в прошлом.
   */
  effectiveDate: string;
}

export function VehicleBackdateFields({ record, next, effectiveDate }: Props) {
  const today = moscowDateKeyOf(new Date());
  const term =
    record?.requestType === 'special_equipment'
      ? {
          dateFrom: next.dateFrom ?? record.dateFrom,
          dateTo: next.dateTo === undefined ? record.dateTo : next.dateTo,
        }
      : null;

  /*
   * Смены, выпадающие за новый срок (Р23). Строки не удаляются — вернув дату, вернём и часы, — но
   * из таблицы смен они исчезнут, а вместе с ними и подписи объекта под ними. Сколько именно дней
   * уходит, знает только сам список смен: сводка заявки отвечает числами «согласовано / ждёт», а
   * не датами.
   *
   * Ключ тот же, что у окна смен и у карточки: таблица одна и та же, и тянуть её второй раз
   * незачем.
   */
  const { data: shifts } = useQuery({
    queryKey: ['vehicle-requests', 'shifts', record?.id],
    queryFn: () => vehicleRequestsApi.shifts(record!.id),
    enabled: !!record && !!term && (record.status === 'confirmed' || record.status === 'done'),
  });

  const notes: string[] = [];

  /*
   * Расхождение с днём рейса (ADR 0082 п. 3). Портал такую правку не запрещает — заявку и рейс
   * правят разные люди в разное время, — но сказать о ней обязан до нажатия, а не после: тем же
   * текстом, каким об этом говорит окно после сохранения.
   */
  if (record?.requestType === 'freight_transport' && record.route && next.scheduledDay) {
    const mismatch = routeDateMismatch(
      { tripDate: next.scheduledDay },
      { displayNumber: record.route.displayNumber, routeDate: record.route.routeDate },
    );
    if (mismatch) notes.push(mismatch);
  }

  /*
   * Недели ЭСМ-2, которые правка срока задевает в уже прошедшем (Р8, Р21). Это не предупреждение, а
   * предсказанный отказ: сверка не выпишет лист за неделю, которая кончилась, и не спишет
   * отработанный — сервер такую правку отклоняет целиком (этап 6 плана переоформит их коррекцией
   * недельного бланка). Портал обязан сказать это до нажатия, иначе человек напишет причину и
   * получит 422 на ровном месте.
   *
   * Считается для заявок, которым портал ведёт листы сам (`auto`). У линейного заказа набор недель
   * задают уже выписанные листы (ADR 0100 §5), а их в форме нет — там строку даёт сервер отказом.
   */
  if (record?.requestType === 'special_equipment' && term) {
    const mode = esm2Mode({
      requestType: record.requestType,
      status: record.status,
      ownership: record.assignment?.ownership ?? null,
      deletedAt: record.deletedAt,
      isLinear: record.isLinear,
    });
    if (mode === 'auto') {
      const key = (p: { from: string; to: string }): string => `${p.from}|${p.to}`;
      const was = esm2Periods(record.dateFrom, record.dateTo);
      const now = esm2Periods(term.dateFrom, term.dateTo);
      const wasKeys = new Set(was.map(key));
      const nowKeys = new Set(now.map(key));
      const touched = [
        ...was.filter((p) => !nowKeys.has(key(p))),
        ...now.filter((p) => !wasKeys.has(key(p))),
      ].filter((p) => p.to < today);
      if (touched.length > 0) {
        notes.push(
          `Задевает недельные листы ЭСМ-2 за прошедшие недели (${touched
            .map((w) => `${formatDateOnly(w.from)} – ${formatDateOnly(w.to)}`)
            .join(
              ', ',
            )}) — такую правку сервер отклонит: бумагу отработанной недели переоформляют коррекцией недельного бланка`,
        );
      }
    }
  }

  // Дни с внесёнными часами, уходящие за новый срок: часы и подписи под ними уцелеют в базе, но
  // из таблицы смен пропадут — и заявка закроется без них.
  if (term && shifts) {
    const lost = shifts.items.filter((s) => s.filledAt && !isShiftDayInTerm(term, s.date));
    if (lost.length > 0) {
      const approved = lost.filter((s) => s.approvedAt).length;
      notes.push(
        `За новым сроком остаётся ${lost.length} дн. с внесёнными часами${
          approved > 0 ? ` (из них согласовано объектом: ${approved})` : ''
        }: часы сохранятся, но из таблицы смен уйдут — вернув дату, вернёте и их`,
      );
    }
  }

  return (
    <>
      <Form.Item
        name="backdateReason"
        label="Причина заднего числа"
        // Обязательна на сервере (`backdateGuard` вернёт 422 без неё) — значит обязательна и здесь:
        // отправлять заведомо отклоняемое тело форма не должна.
        rules={[{ required: true, message: 'Укажите причину' }]}
        extra={`Дата ${formatDateOnly(effectiveDate)} уже прошла: правка уйдёт в журнал коррекций с вашим именем и этой причиной`}
      >
        <Input.TextArea
          rows={2}
          maxLength={2000}
          showCount
          placeholder="Например: техника вышла во вторник, заявку оформили в среду"
        />
      </Form.Item>
      {notes.length > 0 && (
        <div style={{ marginTop: -8, marginBottom: 8, lineHeight: 1.5 }}>
          {notes.map((note) => (
            <div key={note}>
              <Typography.Text type="warning">{note}</Typography.Text>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
