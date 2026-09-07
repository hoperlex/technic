import { App, Button, Descriptions, Tabs } from 'antd';
import { DownloadOutlined } from '@ant-design/icons';
import { officeEquipmentTitle, type OfficeEquipmentDto } from '@technic/contracts';
import { officeEquipmentApi, WarrantyTag } from '@entities/office-equipment';
import { ViewModal } from '@shared/ui';
import { useAuth } from '../../../auth/AuthContext';
import { errorMessage, formatDate } from '../../../utils/format';
import { ChangesBlock } from './ChangesBlock';
import { FullHistoryBlock } from './FullHistoryBlock';
import { MovementsBlock } from './MovementsBlock';
import { placeOf, stateOf } from './place';
import { RequestsBlock } from './RequestsBlock';

/**
 * История единицы оргтехники: три бизнес-блока и полная лента (план
 * `docs/office-equipment-history-blocks-plan.md`, Р11).
 *
 * «Заявки · Правки · Перемещения» отвечают на три разных вопроса — «что с аппаратом делали и чем
 * кончилось», «кто и что поправил в карточке», «где стоял и почему уехал», — а четвёртая вкладка
 * оставляет нетронутой событийную ленту шести источников: она канонический аудит, и в споре
 * смотрят её (К2).
 *
 * УМОЛЧАНИЕ — «ЗАЯВКИ»: с них начинают в девяти случаях из десяти. ВЫБРАННАЯ ВКЛАДКА МЕЖДУ
 * ОТКРЫТИЯМИ НЕ ЗАПОМИНАЕТСЯ — окно открывают по конкретному вопросу, и прошлый выбор чаще мешает,
 * чем помогает. Держится это не хитростью, а устройством: тело живёт внутри `ViewModal` с
 * `destroyOnHidden`, то есть собирается заново на каждое открытие вместе со своим состоянием.
 *
 * Шапка отвечает на вопрос, который задают до истории: где аппарат сейчас, за кем закреплён, до
 * какого числа гарантия и когда карточку завели. Без неё история начинается с прошлого, а
 * спрашивают обычно про настоящее.
 */
export type EquipmentHistoryBlock = 'requests' | 'changes' | 'movements' | 'full';

export function EquipmentHistoryModal({
  equipment,
  onClose,
  initialBlock = 'requests',
}: {
  /** `null` — окно закрыто. */
  equipment: OfficeEquipmentDto | null;
  onClose: () => void;
  /** С какой вкладки открыть: секция карточки ведёт прямо в заявки (Р7). */
  initialBlock?: EquipmentHistoryBlock;
}) {
  const { message } = App.useApp();
  const { can } = useAuth();

  /**
   * Блок заявок просит ДВА права: карточку открывает `officeEquipment.read`, а заявки по ней —
   * `serviceRequests.read` со своей областью (Р1). Без второго ручка отвечает `403`, и вкладки у
   * такого читателя нет вовсе — ровно как сегодня у ленты, где ремонтная часть просто не
   * приходит. Спрашивать сервер, чтобы показать человеку отказ, незачем.
   */
  const canRequests = can('serviceRequests.read');
  const defaultBlock: EquipmentHistoryBlock =
    initialBlock === 'requests' && !canRequests ? 'changes' : initialBlock;

  const exportHistory = () => {
    if (!equipment) return;
    void officeEquipmentApi
      .historyExport(equipment.id, officeEquipmentTitle(equipment))
      .catch((e: unknown) => message.error(errorMessage(e)));
  };

  return (
    <ViewModal
      title={equipment ? `История · ${officeEquipmentTitle(equipment)}` : 'История'}
      open={!!equipment}
      onClose={onClose}
      width={860}
      destroyOnHidden
    >
      {equipment && (
        <>
          <Descriptions size="small" column={2} style={{ marginBottom: 8 }}>
            <Descriptions.Item label="Где сейчас">
              {placeOf(
                `${equipment.object.code} — ${equipment.object.name}`,
                equipment.location,
                stateOf(equipment.state, equipment.stateNote),
              )}
            </Descriptions.Item>
            <Descriptions.Item label="Отдел">
              {equipment.department?.name ?? 'не закреплена'}
            </Descriptions.Item>
            <Descriptions.Item label="Гарантия">
              {equipment.warrantyUntil ? <WarrantyTag until={equipment.warrantyUntil} /> : '—'}
            </Descriptions.Item>
            {/* Жизненный цикл карточки — в шапку, а не отдельным блоком (Р6): за жизнь карточки
                этих событий два-три, и вопрос «откуда взялась» задают до истории, а не внутри
                неё. Имени заводившего в карточке нет — оно живёт только событием полной ленты, —
                и придумывать его портал не станет: дата отвечает на вопрос, ради которого поле и
                стоит в шапке. */}
            <Descriptions.Item label="Заведена">
              {formatDate(equipment.createdAt)}
            </Descriptions.Item>
            <Descriptions.Item label="Выгрузка">
              <Button size="small" icon={<DownloadOutlined />} onClick={exportHistory}>
                Скачать историю
              </Button>
            </Descriptions.Item>
          </Descriptions>

          <Tabs
            defaultActiveKey={defaultBlock}
            items={[
              ...(canRequests
                ? [
                    {
                      key: 'requests',
                      label: 'Заявки',
                      children: <RequestsBlock equipmentId={equipment.id} />,
                    },
                  ]
                : []),
              {
                key: 'changes',
                label: 'Правки',
                children: <ChangesBlock equipmentId={equipment.id} />,
              },
              {
                key: 'movements',
                label: 'Перемещения',
                children: <MovementsBlock equipmentId={equipment.id} />,
              },
              {
                key: 'full',
                label: 'Полная история',
                children: <FullHistoryBlock equipmentId={equipment.id} />,
              },
            ]}
          />
        </>
      )}
    </ViewModal>
  );
}
