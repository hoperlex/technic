import { Tag, Typography } from 'antd';
import {
  assignmentTitle,
  canRequestEarlyEnd,
  ON_SITE_DAY_UNPLANNED_MESSAGE,
  onSiteDayLabel,
  onSitePresence,
  shiftDaysOf,
  type SpecialEquipmentRequestDto,
  vehicleOnSitePresenceColors,
  vehicleOnSitePresenceLabels,
} from '@technic/contracts';
import { calendarDayCount, formatDateOnly } from '@shared/lib';
import { VehicleRequestEarlyEndTag } from '@entities/vehicle-request';
import type { useEarlyEnd } from './earlyEndActions';

/**
 * Строка среза «На объекте» по частям: ячейки «Сегодня», «Срок» и «Смены», два правила
 * доступности досрочного завершения и общий набор, которым их кормят.
 *
 * Отдельным файлом, потому что одну и ту же строку рисуют два представления — колонки таблицы и
 * карточка телефона (ADR 0030), — и отвечать они обязаны одинаково: разъехавшись, ячейка и
 * строка карточки начали бы считать смены и присутствие по-разному. Самой вкладке остаются
 * список, запросы и окна.
 */

/** Строка «Сегодня»: чем этот день является для заявки и который он по счёту в её сроке. */
export function presenceCell(r: SpecialEquipmentRequestDto, onDate: string) {
  const presence = onSitePresence(r, onDate);
  const dayLabel = onSiteDayLabel(r, onDate);
  return (
    <div style={{ lineHeight: 1.35 }}>
      <Tag color={vehicleOnSitePresenceColors[presence]} style={{ marginInlineEnd: 0 }}>
        {vehicleOnSitePresenceLabels[presence]}
      </Tag>
      {dayLabel && (
        <div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {dayLabel}
          </Typography.Text>
        </div>
      )}
      {/* Запрошенный досрочный отъезд (ADR 0044) — здесь же: до визы срок заявки прежний, и
        без тега площадка узнала бы об отъезде техники в день отъезда. */}
      {r.earlyEnd?.status === 'pending' && (
        <div style={{ marginTop: 2 }}>
          <VehicleRequestEarlyEndTag earlyEnd={r.earlyEnd} />
        </div>
      )}
    </div>
  );
}

/**
 * Срок работ: период заказа и сколько дней заказано — тем же счётом, что в форме и карточке.
 * Согласованное сокращение (ADR 0044) уже сидит в самом сроке, поэтому рядом стоит приписка «с
 * какого числа сократили»: без неё непонятно, почему заказ на две недели кончается послезавтра.
 */
export function termCell(r: SpecialEquipmentRequestDto) {
  const days = calendarDayCount(r.dateFrom, r.dateTo);
  return (
    <div style={{ lineHeight: 1.35 }}>
      <div>
        {r.dateTo
          ? `${formatDateOnly(r.dateFrom)} – ${formatDateOnly(r.dateTo)}`
          : formatDateOnly(r.dateFrom)}
      </div>
      {days != null && (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          заказано {days} дн.
        </Typography.Text>
      )}
      {r.earlyEnd?.status === 'approved' && (
        <div>
          <VehicleRequestEarlyEndTag earlyEnd={r.earlyEnd} />
        </div>
      )}
    </div>
  );
}

/**
 * Приёмка работы по дням: сколько смен объект подтвердил из заказанных и сколько наступивших
 * дней ещё ждёт подписи. Долг выделен красным — пока он есть, машину у заявки не сменить, а её
 * закрытие предупреждает, что работу принимают без подписи площадки.
 */
export function shiftsCell(r: SpecialEquipmentRequestDto) {
  const total = shiftDaysOf(r).length;
  const pending = r.shifts.unapprovedPastDays;
  return (
    <div style={{ lineHeight: 1.35 }}>
      <div>
        согласовано {r.shifts.approvedDays} из {total}
      </div>
      {pending > 0 && (
        <Tag color="red" style={{ marginInlineEnd: 0 }}>
          не согласовано дней: {pending}
        </Tag>
      )}
    </div>
  );
}

export const dash = <Typography.Text type="secondary">—</Typography.Text>;

/**
 * The vehicle label, compact detail line and trailer line shared by table and mobile card.
 * A present `dayVehicle` names the route vehicle or assignment-history vehicle for this day;
 * null means an unplanned linear day. An absent field means the standing assignment remains
 * the answer. Collapsing null and absent would show a default assignment as today's vehicle.
 * The route's trailer stays beside that vehicle, never beside a different assignment (ADR 0221).
 */
export function onSiteVehicleLines(r: SpecialEquipmentRequestDto): {
  /** Null when no vehicle is assigned to this day. */
  title: string | null;
  /** For an unplanned day, the detail line explains why there is no title. */
  details: string | null;
  /** The route's recorded trailer composition, distinct from the driver and vehicle model. */
  trailer: string | null;
} {
  // A planned day answers from its route, even when the order has another default vehicle.
  if (r.dayVehicle !== undefined) {
    const day = r.dayVehicle;
    // An unplanned linear day cannot borrow the default assignment as a claim about today.
    if (day === null) return { title: null, details: ON_SITE_DAY_UNPLANNED_MESSAGE, trailer: null };
    // Keep route, driver and trailer together: they describe one day's vehicle composition.
    return {
      title: day.vehicleLabel,
      details: detailsLine(day.vehicleLabel, [
        day.vehicleModelName,
        day.routeDisplayNumber,
        // A removed driver still works on the vehicle but needs a visible warning (ADR 0190).
        day.driverCardRemovedOn ? `${day.driverName} (карточка снята)` : day.driverName,
      ]),
      trailer: day.trailerLabel ? `Прицеп: ${day.trailerLabel}` : null,
    };
  }
  if (!r.assignment) return { title: null, details: null, trailer: null };
  // A lessor is the contact for downtime or replacement; own vehicles say so explicitly.
  const title = assignmentTitle(r.assignment);
  return {
    title,
    details: detailsLine(title, [
      r.assignment.modelName,
      r.assignment.lessorName ?? 'Своя техника',
    ]),
    trailer: null,
  };
}

/** The label fallback can equal the model; repeating it in the detail line suggests bad data. */
function detailsLine(title: string, parts: (string | null)[]): string | null {
  const shown = parts.filter((part): part is string => !!part && part !== title);
  return shown.length > 0 ? shown.join(' · ') : null;
}

/** The table and mobile card use one vehicle composition through `onSiteVehicleLines`. */
export function vehicleCell(r: SpecialEquipmentRequestDto) {
  const { title, details, trailer } = onSiteVehicleLines(r);
  if (!title && !details && !trailer) return dash;
  return (
    <div style={{ lineHeight: 1.35 }}>
      {title && <div>{title}</div>}
      {details && (
        <div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {details}
          </Typography.Text>
        </div>
      )}
      {trailer && (
        <div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {trailer}
          </Typography.Text>
        </div>
      )}
    </div>
  );
}

/** Действие доступно тем же условием, что проверяет сервер, — и по дню среза, а не по часам браузера. */
export function earlyEndAllowed(
  r: SpecialEquipmentRequestDto,
  onDate: string | undefined,
  canRequest: boolean,
) {
  return (
    canRequest && !!onDate && canRequestEarlyEnd(r, onDate) && r.earlyEnd?.status !== 'pending'
  );
}

export function decidable(r: SpecialEquipmentRequestDto, canDecide: boolean) {
  return canDecide && r.earlyEnd?.status === 'pending';
}

/**
 * Чем строку кормят: день среза, права и окна вкладки. Набор один на оба представления — иначе
 * колонки и карточка разошлись бы не разметкой, а составом действий.
 */
export type OnSiteRowArgs = {
  /** День среза от сервера (ADR 0036): пока его нет, присутствие не подписывается. */
  onDate: string | undefined;
  canRequest: boolean;
  canDecide: boolean;
  earlyEnd: ReturnType<typeof useEarlyEnd>;
  /** Открыть карточку заявки. */
  onView: (r: SpecialEquipmentRequestDto) => void;
  /** Открыть окно подтверждения смен. */
  onShifts: (r: SpecialEquipmentRequestDto) => void;
};
