import { useState } from 'react';
import { Button, Empty, Space, Spin, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { officeEquipmentApi, officeEquipmentKeys } from '@entities/office-equipment';
import {
  EquipmentHistoryModal,
  EquipmentRequestLine,
  REQUESTS_EMPTY_TEXT,
  REQUESTS_PREVIEW_LIMIT,
  useEquipmentRequestsPreview,
} from '@features/equipment-history';
import { useAuth } from '../../auth/AuthContext';

/**
 * История обслуживания единицы и гарантии её ремонтов (§8.2) — первые строки блока «Связанные
 * заявки» (план `docs/office-equipment-history-blocks-plan.md`, Р7).
 *
 * Секция отвечает на вопрос, с которого начинается работа с чужой техникой: чинили ли уже этот
 * аппарат, что в нём меняли и на что ещё действует гарантия. Без неё карточка знает про технику
 * всё, кроме единственного, ради чего её открывают перед назначением сервиса.
 *
 * ТОТ ЖЕ БЛОК, А НЕ ВТОРОЙ РАССКАЗ (Н1, К7). Раньше строки приезжали срезом `serviceHistory` в
 * ответе карточки — последними десятью, без ответа «а было ли больше» и в своём формате строки.
 * Теперь секция спрашивает ту же ручку `GET /:id/requests`, что и вкладка окна, с пределом пять и
 * ссылкой «Все заявки по аппарату» в блок: место, рассказывающее про заявки по аппарату, одно, и
 * правило обрезки у него одно.
 *
 * Область по-прежнему считает сервер (Р5): собирать её на портале значило бы завести второе
 * правило видимости рядом с серверным. Без `serviceRequests.read` ручка отвечает `403`, поэтому
 * секции у такого читателя нет вовсе — пустой список сказал бы «ремонтов не было», а это другое
 * утверждение.
 */
export function OfficeEquipmentServiceHistory({ equipmentId }: { equipmentId: string }) {
  const { can } = useAuth();
  const canRequests = can('serviceRequests.read');
  const pages = useEquipmentRequestsPreview(equipmentId, canRequests);

  /**
   * Карточка единицы — ради шапки окна истории («где сейчас», гарантия, выгрузка), а не ради
   * самих строк. Ключ тот же, каким её спрашивают соседняя секция «Чем заправлять» и само окно
   * правки: react-query отдаёт всем один ответ, и второго похода на сервер ссылка не стоит.
   */
  const { data: card } = useQuery({
    queryKey: officeEquipmentKeys.detail(equipmentId),
    queryFn: () => officeEquipmentApi.get(equipmentId),
    enabled: canRequests,
  });
  const [historyOpen, setHistoryOpen] = useState(false);

  if (!canRequests) return null;

  return (
    <>
      <Typography.Title level={5} style={{ marginTop: 8 }}>
        Обслуживание и гарантии
      </Typography.Title>
      {pages.isLoading ? (
        <Spin size="small" />
      ) : pages.items.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={REQUESTS_EMPTY_TEXT} />
      ) : (
        <>
          <Space orientation="vertical" size={12} style={{ width: '100%' }}>
            {pages.items.slice(0, REQUESTS_PREVIEW_LIMIT).map((row) => (
              <EquipmentRequestLine key={row.id} row={row} />
            ))}
          </Space>
          {/* Ссылка стоит и тогда, когда заявок ровно пять: «есть ли ещё» человек узнаёт в блоке,
              а не по длине списка — молчаливая обрезка ровно этим и была плоха (§2.3). Окно
              открывается ВНУТРИ карточки (ADR 0140): снаружи оно ушло бы под неё. */}
          <Button
            type="link"
            size="small"
            style={{ padding: 0 }}
            disabled={!card}
            onClick={() => setHistoryOpen(true)}
          >
            Все заявки по аппарату
          </Button>
        </>
      )}

      <EquipmentHistoryModal
        equipment={historyOpen ? (card ?? null) : null}
        onClose={() => setHistoryOpen(false)}
        initialBlock="requests"
      />
    </>
  );
}
