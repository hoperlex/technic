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
import { calendarDayCount } from '../../utils/date';
import { EarlyEndTag, formatDateOnly, type useEarlyEnd } from './shared';

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
          <EarlyEndTag earlyEnd={r.earlyEnd} />
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
          <EarlyEndTag earlyEnd={r.earlyEnd} />
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
 * Что графа «Техника» говорит про строку: подпись машины и одна строка про неё мелким текстом.
 *
 * Ответов у строки два разной природы, и различает их само поле `dayVehicle` (ADR 0100 §12): у
 * нелинейного заказа его нет вовсе (`undefined`) — машина строки назначенная, и второго ответа на
 * этот вопрос не существует; у линейного оно приходит всегда — объектом (машина рейса **этого
 * дня**) либо `null` (день никуда не поставлен). Слить `undefined` с `null` значило бы объявить
 * нелинейной строке «машина не назначена» вместо её машины.
 *
 * Строка под подписью одна, а не две: марка и тот, с кем об этой машине говорят, стоят через
 * точку — иначе строка таблицы выросла бы втрое против соседних (Р15).
 */
export function onSiteVehicleLines(r: SpecialEquipmentRequestDto): {
  /** Чем машина подписана; `null` — машины на этот день нет вовсе. */
  title: string | null;
  /** Строка под подписью; у нераспланированного дня она и объясняет, почему подписи нет. */
  details: string | null;
} {
  // Линейный заказ отвечает машиной дня, а не назначением: назначение у него — машина по
  // умолчанию, и выдать её за вышедшую сегодня значило бы ответить догадкой (ADR 0100 §12).
  if (r.dayVehicle !== undefined) {
    const day = r.dayVehicle;
    // День никуда не поставлен — об этом и говорится словами: подставить сюда назначение значит
    // ответить не про сегодня.
    if (day === null) return { title: null, details: ON_SITE_DAY_UNPLANNED_MESSAGE };
    // Рейс дня и человек на нём — рядом с маркой: спрашивая, что стоит на площадке, спрашивают и
    // по какому рейсу оно там и кто в кабине. Водителя ставят утром, и до этого его строки нет.
    return {
      title: day.vehicleLabel,
      details: detailsLine(day.vehicleLabel, [
        day.vehicleModelName,
        day.routeDisplayNumber,
        day.driverName,
      ]),
    };
  }
  if (!r.assignment) return { title: null, details: null };
  // Арендодатель — тот, кому звонят и про простой, и про замену машины; у своей на его месте
  // стоит «Своя техника»: пустое место читалось бы как «арендодателя не заполнили».
  const title = assignmentTitle(r.assignment);
  return {
    title,
    details: detailsLine(title, [
      r.assignment.modelName,
      r.assignment.lessorName ?? 'Своя техника',
    ]),
  };
}

/**
 * Вторая строка — через точку и одной. Совпавшая с подписью марка из неё выпадает: у своей машины
 * с незаполненным госномером подписью становится сама марка (`vehicleLabel`), и «КамАЗ 65115 ·
 * КамАЗ 65115 · Своя техника» читалось бы как ошибка данных, а не как ответ.
 */
function detailsLine(title: string, parts: (string | null)[]): string | null {
  const shown = parts.filter((part): part is string => !!part && part !== title);
  return shown.length > 0 ? shown.join(' · ') : null;
}

/**
 * Графа «Техника» таблицы: подпись первой строкой, всё остальное — второй. Ячейка общая с
 * карточкой по составу (`onSiteVehicleLines`), потому что вопрос у них один: что стоит на площадке.
 */
export function vehicleCell(r: SpecialEquipmentRequestDto) {
  const { title, details } = onSiteVehicleLines(r);
  if (!title && !details) return dash;
  return (
    <div style={{ lineHeight: 1.35 }}>
      {title && <div>{title}</div>}
      {details && (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {details}
        </Typography.Text>
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
