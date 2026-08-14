import {
  equipmentHistoryKindLabels,
  officeEquipmentStateLabels,
  officeEquipmentTitle,
  serviceRequestStatusLabels,
  type EquipmentHistoryEventDto,
} from '@technic/contracts';
import { writeWorkbook } from '../lib/xlsx';
import { officeEquipmentFieldLabels } from './office-equipment-diff';

/**
 * Выгрузка истории единицы (план `office-equipment-mail-and-history-plan.md`, Р80).
 *
 * Книга собирается той же лентой, что и экран, и той же областью: расхождение здесь означало бы
 * файл, показывающий больше, чем портал, — то есть утечку через выгрузку.
 *
 * Событие ложится в файл **словами**, а не набором колонок под каждый вид: у шести видов поля
 * разные, и таблица из объединения полей была бы наполовину пустой в каждой строке. Инвентаризация
 * и спор с подрядчиком читают колонку «что произошло», а не сверяют идентификаторы.
 */

/** Дата без времени в человеческом виде; через JS Date она бы поехала на день. */
function ru(date: string | null): string {
  if (!date) return '';
  const [y, m, d] = date.slice(0, 10).split('-');
  return y && m && d ? `${d}.${m}.${y}` : date;
}

function money(value: number | null): string {
  return value === null ? '' : `${value.toFixed(2)} ₽`;
}

/** Место одной строкой: объект, уточнение внутри него и состояние — по ним технику и ищут. */
function placeOf(objectCode: string, location: string, state: string): string {
  return [objectCode, location, state].filter(Boolean).join(' · ');
}

function textOf(event: EquipmentHistoryEventDto): string {
  switch (event.kind) {
    case 'card_lifecycle':
      return event.action === 'created'
        ? 'Карточка заведена'
        : event.action === 'archived'
          ? 'Карточка отправлена в архив'
          : 'Карточка восстановлена из архива';
    case 'movement': {
      const from = placeOf(
        event.fromObject.code,
        event.fromLocation,
        event.fromState === 'on_site' ? '' : officeEquipmentStateLabels[event.fromState],
      );
      const to = placeOf(
        event.toObject.code,
        event.toLocation,
        event.toState === 'on_site' ? '' : officeEquipmentStateLabels[event.toState],
      );
      return `${from} → ${to}`;
    }
    case 'service_request':
      return `${event.displayNumber}: ${serviceRequestStatusLabels[event.status]}`;
    case 'service_step':
      return `${event.displayNumber}: ${serviceRequestStatusLabels[event.toStatus]}`;
    case 'card_change':
      return event.changes
        .map(
          (change) =>
            `${officeEquipmentFieldLabels[change.field] ?? change.field}: ${change.from ?? ''} → ${change.to ?? ''}`,
        )
        .join('; ');
    case 'warranty':
      switch (event.action) {
        case 'set':
          return `Гарантия на «${event.subject}» до ${ru(event.until)}`;
        case 'moved':
          return `Гарантия на «${event.subject}»: ${ru(event.from)} → ${ru(event.until)}`;
        case 'cleared':
          return `Гарантия на «${event.subject}» снята (была до ${ru(event.from)})`;
        case 'expired':
          return `Гарантия на «${event.subject}» истекла`;
      }
  }
}

/** Подробности: то, что не влезло в «что произошло», но нужно при разборе. */
function detailsOf(event: EquipmentHistoryEventDto): string {
  switch (event.kind) {
    case 'movement':
      return [
        event.reason,
        event.comment,
        event.toDepartmentName ? `отдел: ${event.toDepartmentName}` : '',
        event.serviceRequestNum ? `по заявке СО-${event.serviceRequestNum}` : '',
      ]
        .filter(Boolean)
        .join('; ');
    case 'service_request':
      return [
        event.description,
        event.serviceName ?? 'сервис не назначен',
        money(event.totalAmount),
      ]
        .filter(Boolean)
        .join('; ');
    case 'service_step':
      return event.comment;
    case 'warranty':
      return event.displayNumber ? `заявка ${event.displayNumber}` : '';
    default:
      return '';
  }
}

const HEADER = ['Дата', 'Событие', 'Что произошло', 'Подробности', 'Кто'];

export function equipmentHistoryWorkbook(
  equipment: { name: string; inventoryNumber: string; serialNumber: string },
  events: EquipmentHistoryEventDto[],
  truncated: boolean,
): Uint8Array {
  const rows: string[][] = [
    HEADER,
    ...events.map((event) => [
      ru(event.occurredOn),
      equipmentHistoryKindLabels[event.kind],
      textOf(event),
      detailsOf(event),
      event.actorName ?? '',
    ]),
  ];

  // Обрезанный отчёт обязан говорить, что он обрезан: молча урезанная выгрузка читается как полная
  // история, и спор с подрядчиком строят на ней.
  if (truncated) {
    rows.push(['', '', 'Показаны не все события: выгрузка ограничена по объёму', '', '']);
  }

  return writeWorkbook([
    {
      name: `История ${officeEquipmentTitle(equipment)}`.slice(0, 31),
      rows,
      widths: [12, 18, 60, 50, 24],
      freezeHeader: true,
    },
  ]);
}
