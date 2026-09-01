import { useMemo, useState, type ReactNode } from 'react';
import { Button, Dropdown, Spin, Tabs, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { mechRequestChangeLabels, type MechRequestDto } from '@technic/contracts';
import { mechRequestKeys, mechRequestsApi } from '@entities/mech-request';
import { ActionSheet, ViewFields, ViewModal, type ActionSheetItem } from '@shared/ui';
import { useIsMobile } from '@shared/lib';
import { type HistoryRow, RequestHistoryTable } from '../../components/RequestHistory';
import { mechRequestViewFields } from './mechRequestViewFields';

/**
 * Карточка аренды: «Заявка» и «История».
 *
 * Двумя вкладками, а не одним свитком: у аренды две стороны — что арендуем и что с ней было, — и
 * лента событий у неё длиннее, чем у соседей. Восемь действий модуля пишут историю (Р11), и
 * договорённость, выдача, снятие отметки и завершение читаются там, где их и ищут: прежняя ставка,
 * прежняя сумма и причина снятия не хранятся больше нигде.
 *
 * Ход заявки карточка не решает сама: набор действий ей строят барьеры контрактов — те же, что и
 * строке списка. Но открываются они отсюда, и потому окна действий карточки живут **внутри** неё
 * (ADR 0140): снаружи они делят слой с самой карточкой и прячутся под ней.
 */
export function MechRequestViewModal({
  request: row,
  today,
  onClose,
  onEdit,
  actions,
  modals,
}: {
  /** `null` — окно закрыто. Строка списка: с неё карточка рисуется, пока едет свежая. */
  request: MechRequestDto | null;
  /** Московский день: остаток срока считается тем же значением, что и в списке (Р12). */
  today: string;
  onClose: () => void;
  /** Не передан — правка этой заявки недоступна (роль, состояние или архив). */
  onEdit?: (request: MechRequestDto) => void;
  /** Ход заявки; не передан — карточка только на чтение (архив). */
  actions?: (request: MechRequestDto) => ActionSheetItem[];
  /** Окна действий карточки (ADR 0140): рендерятся внутри неё, иначе уходят под неё. */
  modals?: ReactNode;
}) {
  const isMobile = useIsMobile();
  const [sheetOpen, setSheetOpen] = useState(false);

  /**
   * Карточка спрашивает заявку сама, а не довольствуется строкой списка: отметка выдачи и
   * завершение должны появляться в открытом окне, а строка к этому моменту уже устарела. Свежая
   * версия здесь не роскошь, а условие работы: каждая мутация модуля шлёт `version` (Р21), и
   * действие по строке недельной давности кончилось бы 409.
   */
  const { data: fresh } = useQuery({
    queryKey: mechRequestKeys.detail(row?.id ?? ''),
    queryFn: () => mechRequestsApi.get(row!.id),
    enabled: !!row,
    placeholderData: row ?? undefined,
  });
  const request = row ? (fresh ?? row) : null;

  const { data: history, isPending } = useQuery({
    queryKey: mechRequestKeys.history(request?.id ?? ''),
    queryFn: () => mechRequestsApi.history(request!.id),
    enabled: !!request,
  });
  const rows = useMemo<HistoryRow[]>(
    () => (history ?? []).map((e) => ({ key: e.id, entry: e })),
    [history],
  );

  const items = request && actions ? actions(request) : [];
  const fields = request ? mechRequestViewFields({ request, today }) : [];

  return (
    <ViewModal
      title={request ? `Заявка ${request.displayNumber}` : 'Заявка'}
      open={!!request}
      onClose={onClose}
      width={900}
      // Окно переоткрывают на соседней заявке: вкладка и раскрытые строки прошлой к ней
      // отношения не имеют.
      destroyOnHidden
      footer={[
        ...(items.length > 0
          ? [
              // На телефоне действия открываются шитом снизу (ADR 0030), на десктопе — меню:
              // набор один и тот же, различается только способ до него дотянуться.
              isMobile ? (
                <Button key="actions" onClick={() => setSheetOpen(true)}>
                  Действия
                </Button>
              ) : (
                <Dropdown
                  key="actions"
                  trigger={['click']}
                  menu={{
                    items: items.map((item) => ({
                      key: item.key,
                      label: item.label,
                      danger: item.danger,
                      disabled: item.disabled,
                      title: item.disabledReason,
                    })),
                    onClick: ({ key }) => items.find((item) => item.key === key)?.onClick(),
                  }}
                >
                  <Button>Действия</Button>
                </Dropdown>
              ),
            ]
          : []),
        ...(request && onEdit
          ? [
              <Button key="edit" type="primary" onClick={() => onEdit(request)}>
                Редактировать
              </Button>,
            ]
          : []),
        <Button key="close" onClick={onClose}>
          Закрыть
        </Button>,
      ]}
    >
      {request && (
        <Tabs
          items={[
            { key: 'request', label: 'Заявка', children: <ViewFields items={fields} /> },
            {
              key: 'history',
              label: 'История',
              children: isPending ? (
                <Spin size="small" />
              ) : rows.length > 0 ? (
                // Подписи полей — модульные: сервер шлёт технические ключи, а читателю истории
                // нужны слова аренды («Ставка», «Выдана», «Причина снятия отметки»). Словарь
                // статусов общий: цикл у механизации тот же, что у соседних заявок.
                <RequestHistoryTable rows={rows} labels={mechRequestChangeLabels} />
              ) : (
                <Typography.Text type="secondary">История недоступна</Typography.Text>
              ),
            },
          ]}
        />
      )}

      <ActionSheet
        title="Действия по заявке"
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        items={items}
      />

      {/* Окна действий — внутри карточки, а не соседями по странице (ADR 0140): только так antd
          считает им слой сам, и окно выдачи не уходит под карточку, из которой его позвали. */}
      {modals}
    </ViewModal>
  );
}
