import { Button, Space, Tag, Typography } from 'antd';
import { DeleteOutlined, SwapOutlined } from '@ant-design/icons';
import {
  requestStatusColors,
  requestStatusLabels,
  type VehicleRouteRequestDto,
} from '@technic/contracts';
import { EntityLink } from '@shared/ui';
import { useAuth } from '../../auth/AuthContext';
import { vehicleRequestViewLink } from '../../utils/links';
import { useRouteModal } from './routeModal';
import { formatDateOnly } from './shared';

/**
 * Заявка в составе: номер, заказчик и то, ради чего строка в рейсе стоит.
 *
 * Стрелок у неё больше нет, и это не упрощение, а исправление: порядок печати задают точки (Р11), а
 * позиция состава осталась порядком **талонов** и входом коррекции. Оставь стрелки здесь — и они
 * двигали бы номер талона, ничего не меняя в задании, то есть обещали бы человеку не то действие,
 * которое он совершает. Пометки «доп. задание, без талона» тут тоже больше нет: талон принадлежит
 * строке задания (Р12), а не заявке, и живёт он в блоке «Задание листа» — у заявки с шестью
 * ездками одна её половина с талоном, а другая без.
 *
 * Отменённая или закрытая заявка остаётся в рейсе историей (лист по ней уже выписан) — её помечает
 * тег, и она же не даёт выписать новый лист, пока её не убрали.
 *
 * Номер заявки — ссылка (ADR 0120, план `docs/vehicle-routes-modal-plan.md` §1). Текстом он был
 * потому, что заявка жила соседней вкладкой: переход стоил бы ухода из рейса, который как раз
 * собирают, — и номер вместо этого искали руками в списке. Теперь заявка открывается окном поверх
 * карточки, и вопрос «а что там за работа» закрывается, не разбирая рейс. Ради этого строка и
 * перестала быть чистой: `can` и `openRequest` спрашиваются здесь, а не приходят пропами, — состав
 * рисуется в одном месте, и протаскивать через него два поля ради одного номера значило бы
 * повторить их в карточке рейса, ничего ими там не решая.
 */
export function RouteRequestRow({
  item,
  frozen,
  busy,
  onDetach,
  onTransfer,
}: {
  item: VehicleRouteRequestDto;
  frozen: boolean;
  busy: boolean;
  onDetach: () => void;
  /**
   * Перенос талона в рейс другого дня задним числом (ADR 0101, Р30); `null` — рейс сегодняшний
   * либо права коррекции нет. Кнопка стоит у строки, а не в подвале карточки, потому что переносят
   * **талон**, а не рейс: в замороженном рейсе это единственный способ что-то с ним сделать.
   */
  onTransfer: { disabledReason: string | null; onClick: () => void } | null;
}) {
  const { can } = useAuth();
  const { openRequest } = useRouteModal();

  return (
    <div
      style={{
        display: 'flex',
        gap: 8,
        alignItems: 'flex-start',
        border: '1px solid var(--ant-color-border)',
        borderRadius: 8,
        padding: 8,
      }}
    >
      <Tag style={{ marginTop: 2 }}>{item.position}</Tag>
      <div style={{ flex: 1, minWidth: 0 }}>
        <Space size={8} wrap>
          {/* Начертание остаётся жирным: номер — якорь строки, по нему её и находят глазами в
            составе из семи. Без права на заявки `vehicleRequestViewLink` вернёт `null`, и номер
            останется прежним текстом, а окно не откроется вовсе (см. `EntityLink`). */}
          <EntityLink
            to={vehicleRequestViewLink(can, item.requestId)}
            title="Открыть заявку"
            onActivate={() => openRequest(item.requestId)}
          >
            <strong>{item.displayNumber}</strong>
          </EntityLink>
          <span>{item.customerName}</span>
          {/* День линейного заказа (ADR 0100 §2): строка стоит в рейсе ради одного дня срока, и
            читаться она обязана днём заказа, а не безымянной строкой задания. Дата совпадает с
            днём рейса по построению — она здесь затем, чтобы состав отвечал «что это за работа»
            без похода в заявку. */}
          {item.workDate && <Tag color="blue">день заказа {formatDateOnly(item.workDate)}</Tag>}
          {item.status !== 'confirmed' && (
            <Tag color={requestStatusColors[item.status]}>{requestStatusLabels[item.status]}</Tag>
          )}
        </Space>
        <div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {/* У заказа техники на объект нет ни погрузки с разгрузкой, ни тонн: в задание дня
              печатаются объект и характер работ из самой заявки (ADR 0100 решение 10). Общая
              строка показала бы голую стрелку между двумя пустыми адресами. */}
            {item.workDate
              ? 'День работ на объекте: в задание печатаются адрес площадки и характер работ'
              : `${item.loadingLocation} → ${item.unloadingLocation}${item.cargoLabel ? ` · ${item.cargoLabel}` : ''}`}
          </Typography.Text>
        </div>
      </div>
      {/* Перенос задним числом виден и в замороженном рейсе — там он и нужен: бумага выписана, а
        заявка ехала не этим днём. Линейный день этой дверью не ходит (ADR 0100 п. 8): день равен
        дню своего рейса, и «перенести» его значит распланировать другой — из карточки заявки. */}
      {onTransfer && !item.workDate && (
        <Button
          size="small"
          icon={<SwapOutlined />}
          title={onTransfer.disabledReason ?? 'Заявка ехала другим рейсом: перенести задним числом'}
          aria-label={`Перенести ${item.displayNumber} задним числом`}
          disabled={busy || !!onTransfer.disabledReason}
          onClick={onTransfer.onClick}
        />
      )}
      {!frozen && (
        <Space>
          <Button
            size="small"
            danger
            icon={<DeleteOutlined />}
            // Линейный день со стороны рейса снимается, но не добавляется (ADR 0100 решение 8):
            // «убрать заявку» о нём неправда — заявка остаётся, уходит один её день.
            title={item.workDate ? 'Снять день с рейса' : 'Убрать из маршрута'}
            aria-label={`Убрать ${item.displayNumber}`}
            disabled={busy}
            onClick={onDetach}
          />
        </Space>
      )}
    </div>
  );
}
