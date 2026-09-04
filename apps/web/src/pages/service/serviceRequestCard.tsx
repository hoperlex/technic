import { Space } from 'antd';
import { EyeOutlined } from '@ant-design/icons';
import type { ServiceRequestDto } from '@technic/contracts';
import {
  serviceRequestEquipmentName,
  serviceRequestPlaceLine,
  serviceStatusLine,
  statusAgeLabel,
  UrgentTag,
} from '@entities/service-request';
import { ServiceChatMark } from '@features/service-chat';
import type { CardConfig } from '@shared/ui';
import { ServiceStatusCell } from './ServiceStatusCell';
import { cardListMenuItems } from './serviceMenuPlacement';
import type { ServiceGridOptions } from './serviceRequestGrid';
import { amountLabel } from './serviceRequestCells';

/**
 * Карточка заявки на телефоне (§9.7): номер и статус в шапке, дальше — техника и суть.
 *
 * Отдельным модулем от колонок: у списка два вида — таблица и карточки, — и вопросы у них разные.
 * Столбцы отвечают «что показать в ряд и какой ролью», карточка — «что уместится на 360 px и в
 * каком порядке это читают с телефона». Жили они одним файлом, пока файл не перерос предел длины
 * (`scripts/quality.mjs`): дробить его по строкам бессмысленно, а по этой границе он делится сам.
 */
export function serviceRequestCard(opts: ServiceGridOptions): CardConfig<ServiceRequestDto> {
  return {
    title: (r) => r.displayNumber,
    badge: (r) => (
      <Space size={4}>
        {/* Метка обсуждения и на телефоне у номера: тап по ней открывает переписку, тап по
            карточке — саму заявку. Второго места для непрочитанного здесь нет — колонок нет. */}
        <ServiceChatMark request={r} onOpen={opts.onChat} />
        {r.isUrgent && <UrgentTag reason="" />}
        {/* Тап по тегу открывает шит переходов, тап по карточке — саму заявку (ADR 0161). */}
        <ServiceStatusCell request={r} items={opts.actions(r)} pending={opts.pendingId === r.id} />
      </Space>
    ),
    primary: (r) =>
      [
        serviceRequestEquipmentName(r),
        r.equipment?.inventoryNumber && `инв. ${r.equipment.inventoryNumber}`,
      ]
        .filter(Boolean)
        .join(' · '),
    lines: [
      // Подсказок на телефоне нет, поэтому причина срочности выносится строкой — иначе красная
      // метка сообщала бы «срочно», не отвечая «почему».
      (r) => (r.isUrgent ? `Срочно: ${r.urgencyReason}` : null),
      // Площадки у заявки «от отдела» нет вовсе: строка пропускается целиком — пустые карточка не
      // рисует, — а прочерк на телефоне читался бы как недогруженная запись (Р8).
      (r) => serviceRequestPlaceLine(r),
      (r) => r.description,
      (r) => (r.service ? `Сервис: ${r.service.name}` : 'Сервис не назначен'),
      // Денежная строка карточки решается по аудитории САМОЙ СТРОКИ, а не по набору страницы
      // (ADR 0160, Р11): у карточек столбцов нет, ровнять здесь нечего — редуцированная заявка
      // просто не показывает строки, как не показывает её заявка без сметы.
      (r) => {
        const label = amountLabel(r);
        return !label || label.value === '—' ? null : `${label.value} ${label.hint}`;
      },
      // «Ждёт», а не «в статусе» (Р4): возраст меряет ожидание, а не статус.
      (r) => `Ждёт: ${statusAgeLabel(r.statusChangedAt)}`,
      // Подсказок на телефоне нет, поэтому состояние выносится строкой — той же, что во второй
      // строке столбца на десктопе. Текстом, а не ссылкой (Р117): тап по карточке открывает
      // карточку, и второй смысл у того же жеста спорил бы с первым — действия здесь в шите.
      (r) => serviceStatusLine(r, opts.user)?.text ?? null,
    ],
    onOpen: opts.onOpen,
    actions: (r) => [
      {
        key: 'open',
        label: 'Открыть карточку',
        icon: <EyeOutlined />,
        onClick: () => opts.onOpen(r),
      },
      ...cardListMenuItems(opts.actions(r)),
    ],
  };
}
