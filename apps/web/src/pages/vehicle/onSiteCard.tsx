import {
  CheckOutlined,
  CloseOutlined,
  EyeOutlined,
  FieldTimeOutlined,
  ScheduleOutlined,
} from '@ant-design/icons';
import { type SpecialEquipmentRequestDto, vehicleClassificationLabel } from '@technic/contracts';
import type { CardConfig } from '@shared/ui';
import {
  decidable,
  earlyEndAllowed,
  type OnSiteRowArgs,
  onSiteVehicleLines,
  presenceCell,
  shiftsCell,
  termCell,
} from './onSiteCells';

/**
 * Карточка среза для телефона — фабрикой, тем же приёмом и на тех же аргументах, что и колонки:
 * оба представления рисуют одну строку, и состав действий у них обязан совпадать.
 */

/**
 * Карточка среза на телефоне (ADR 0030): объект и машина — то, ради чего вкладку открывают на
 * ходу, а тег присутствия отвечает, приехала она сегодня или уезжает.
 */
export function onSiteCard({
  onDate,
  canRequest,
  canDecide,
  earlyEnd,
  onView,
  onShifts,
}: OnSiteRowArgs): CardConfig<SpecialEquipmentRequestDto> {
  return {
    title: (r) => r.objectName,
    badge: (r) => (onDate ? presenceCell(r, onDate) : null),
    // Машина — тем же составом, что и в таблице (`onSiteVehicleLines`): у линейного заказа это
    // машина дня, а не назначение, и нераспланированный день говорит о себе словами. Крупной
    // строкой стоит подпись, а когда машины на этот день нет — сами слова: карточку открывают
    // ради ответа «что на площадке», и прочерк на его месте ответом не был бы.
    primary: (r) => {
      const { title, details } = onSiteVehicleLines(r);
      return title ?? details ?? '—';
    },
    lines: [
      (r) =>
        vehicleClassificationLabel({
          typeName: r.vehicleTypeName,
          categoryName: r.vehicleCategoryName,
        }),
      // Марка перед арендодателем: без неё на телефоне видно только, чья машина, но не какая —
      // ровно то, на что жаловались (Р15). При нераспланированном дне строка уже сказана крупной.
      (r) => {
        const { title, details } = onSiteVehicleLines(r);
        return title ? details : null;
      },
      (r) => termCell(r),
      (r) => shiftsCell(r),
      (r) => r.comment || null,
      (r) => `${r.displayNumber} · ${r.createdByName}`,
    ],
    onOpen: (r) => onView(r),
    // Подписи в шите остаются словами (ADR 0030): подсказка на иконке по касанию не открывается.
    // Иконки идут рядом с ними — те же, что в колонке действий на десктопе.
    actions: (r) => [
      {
        key: 'view',
        label: 'Открыть карточку',
        icon: <EyeOutlined />,
        onClick: () => onView(r),
      },
      {
        key: 'shifts',
        label: 'Смены',
        icon: <ScheduleOutlined />,
        onClick: () => onShifts(r),
      },
      ...(decidable(r, canDecide)
        ? [
            {
              key: 'approve-early-end',
              label: 'Согласовать досрочное завершение',
              icon: <CheckOutlined />,
              onClick: () => earlyEnd.approve(r),
            },
            {
              key: 'reject-early-end',
              label: 'Отклонить досрочное завершение',
              icon: <CloseOutlined />,
              danger: true,
              onClick: () => earlyEnd.reject(r),
            },
          ]
        : []),
      ...(earlyEndAllowed(r, onDate, canRequest)
        ? [
            {
              key: 'early-end',
              label: 'Завершить досрочно',
              icon: <FieldTimeOutlined />,
              onClick: () => earlyEnd.open(r),
            },
          ]
        : []),
    ],
  };
}
