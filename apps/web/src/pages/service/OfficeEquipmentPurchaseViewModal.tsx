import { useState } from 'react';
import { App, Button, Input, Space, Table, Tag, Typography } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  officeEquipmentPurchaseStatusLabels,
  type OfficeEquipmentPurchaseDetailDto,
  type OfficeEquipmentPurchaseItemDto,
} from '@technic/contracts';
import { FormModal, ViewFields, ViewModal, type ViewField } from '@shared/ui';
import { errorMessage } from '@shared/lib';
import {
  officeEquipmentConsumableKeys,
  officeEquipmentPurchaseKeys,
  officeEquipmentPurchasesApi,
} from '@entities/office-equipment';
import { formatDateTime } from '../../utils/format';
import { purchaseConflictOf, statusConflictOf } from './officeEquipmentPurchaseConflicts';
import { OfficeEquipmentPurchaseCloseModal } from './OfficeEquipmentPurchaseCloseModal';
import { OfficeEquipmentPurchaseFormModal } from './OfficeEquipmentPurchaseFormModal';

/**
 * Карточка плановой закупки: состав, лента жизненного пути и ходы по ней (план
 * `docs/office-equipment-consumables-and-purchase-plan.md`, Р10, Р11, Р18).
 *
 * ЛЕНТА СТРОИТСЯ ИЗ КОЛОНОК ДОКУМЕНТА, А НЕ ИЗ ЖУРНАЛА АУДИТА, и это не мелочь показа. Общий
 * помощник аудита глушит ошибку записи (пишет в лог и идёт дальше) — то есть гарантией истории он
 * не является; это осознанный компромисс портала (журнал не должен ронять выписанный документ), но
 * карточка, показывающая путь документа из такого источника, показывала бы его с дырами. Поэтому у
 * каждого перехода своя пара колонок, и лента здесь — просто их чтение.
 *
 * ХОДЫ РАЗЛИЧАЮТ ДВА 409, и это требование Р18: «уже провели» (документ ушёл дальше) и «правил
 * другой» (черновик тот же, версия не та). Первый лечится перечитыванием, второй — просмотром
 * чужого состава, и общий тост «конфликт версий» не годится ни тому, ни другому.
 */

const STATUS_COLORS: Record<string, string> = {
  new: 'default',
  in_work: 'processing',
  closed: 'success',
  cancelled: 'error',
};

interface Props {
  /** Закупка, которую открыли; `null` — окно закрыто. */
  purchaseId: string | null;
  onClose: () => void;
}

const ITEM_COLUMNS = [
  {
    key: 'name',
    title: 'Позиция',
    render: (_v: unknown, r: OfficeEquipmentPurchaseItemDto) => (
      <>
        <div>{r.name}</div>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {r.color ? `${r.code} · ${r.color}` : r.code}
        </Typography.Text>
      </>
    ),
  },
  {
    key: 'snapshot',
    // Снимок лежит в строке и не пересчитывается (Р17): потребность плавающая, остаток движется
    // каждый день, и через месяц на вопрос «почему заказали двенадцать» отвечает только он.
    title: 'Из чего сложилось',
    width: 300,
    render: (_v: unknown, r: OfficeEquipmentPurchaseItemDto) => (
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        потребность {r.requiredSnapshot} · на складе {r.stockSnapshot} · уже заказано{' '}
        {r.alreadyOrderedSnapshot} · предложено {r.suggestedQuantity}
      </Typography.Text>
    ),
  },
  {
    key: 'quantity',
    title: 'Заказано',
    width: 110,
    render: (_v: unknown, r: OfficeEquipmentPurchaseItemDto) => (
      <Typography.Text strong>{r.quantity}</Typography.Text>
    ),
  },
  {
    key: 'currentStock',
    title: 'На складе сейчас',
    width: 150,
    render: (_v: unknown, r: OfficeEquipmentPurchaseItemDto) => r.currentStock,
  },
];

/** Лента переходов: показывается только то, что случилось, — пустых строк «ещё не закрыта» нет. */
function lifecycleFields(p: OfficeEquipmentPurchaseDetailDto): ViewField[] {
  const steps: ViewField[] = [
    {
      key: 'created',
      label: 'Заведена',
      children: `${p.createdByName}, ${formatDateTime(p.createdAt)}`,
    },
  ];
  if (p.submittedAt) {
    steps.push({
      key: 'submitted',
      label: 'Проведена',
      children: `${p.submittedByName}, ${formatDateTime(p.submittedAt)}`,
    });
  }
  if (p.closedAt) {
    steps.push({
      key: 'closed',
      label: 'Закрыта',
      children: `${p.closedByName}, ${formatDateTime(p.closedAt)}`,
    });
  }
  if (p.cancelledAt) {
    steps.push({
      key: 'cancelled',
      label: 'Отменена',
      full: true,
      // Причина стоит рядом с отменой, а не отдельным полем: «отменена» без объяснения через месяц
      // читается как «передумали», а отменяют обычно потому, что заказ ушёл другим путём.
      children: `${p.cancelledByName}, ${formatDateTime(p.cancelledAt)} — ${p.cancelReason}`,
    });
  }
  return steps;
}

export function OfficeEquipmentPurchaseViewModal({ purchaseId, onClose }: Props) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [editing, setEditing] = useState<OfficeEquipmentPurchaseDetailDto | null>(null);
  const [closing, setClosing] = useState<OfficeEquipmentPurchaseDetailDto | null>(null);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [reason, setReason] = useState('');

  const { data } = useQuery({
    queryKey: officeEquipmentPurchaseKeys.detail(purchaseId ?? ''),
    queryFn: () => officeEquipmentPurchasesApi.get(purchaseId!),
    enabled: !!purchaseId,
  });

  /** Общий разбор отказа ходов: «уже провели/закрыли/отменили» — не сбой, а исход гонки. */
  const onTransitionError = (e: unknown) => {
    const conflict = purchaseConflictOf(e);
    if (statusConflictOf(conflict)) {
      message.warning(conflict!.message);
      void qc.invalidateQueries({ queryKey: officeEquipmentPurchaseKeys.root });
      return;
    }
    message.error(errorMessage(e));
  };

  const invalidateAll = () => {
    void qc.invalidateQueries({ queryKey: officeEquipmentPurchaseKeys.root });
    // Переход двигает «уже заказано» и дефицит: открытая закупка вычитается, закрытая и
    // отменённая — нет (Р15).
    void qc.invalidateQueries({ queryKey: officeEquipmentConsumableKeys.root });
  };

  const submitMut = useMutation({
    // Версия содержимого едет с проведением (Р18): в снабжение обязан уехать тот состав, который
    // человек видел на экране, а не тот, который сосед дописал минуту назад.
    mutationFn: () =>
      officeEquipmentPurchasesApi.submit(data!.id, { expectedVersion: data!.contentVersion }),
    onSuccess: (saved) => {
      message.success(`Закупка ${saved.displayNumber} передана в снабжение`);
      invalidateAll();
    },
    onError: onTransitionError,
  });

  const cancelMut = useMutation({
    mutationFn: () => officeEquipmentPurchasesApi.cancel(data!.id, { reason: reason.trim() }),
    onSuccess: (saved) => {
      message.success(`Закупка ${saved.displayNumber} отменена`);
      setCancelOpen(false);
      setReason('');
      invalidateAll();
    },
    onError: onTransitionError,
  });

  const fields: ViewField[] = data
    ? [
        {
          key: 'status',
          label: 'Состояние',
          children: (
            <Tag color={STATUS_COLORS[data.status]}>
              {officeEquipmentPurchaseStatusLabels[data.status]}
            </Tag>
          ),
        },
        {
          key: 'totals',
          label: 'Всего',
          children: `${data.itemCount} позиций · ${data.totalQuantity} шт`,
        },
        ...lifecycleFields(data),
        ...(data.comment
          ? [{ key: 'comment', label: 'Комментарий', full: true, children: data.comment }]
          : []),
      ]
    : [];

  return (
    <ViewModal
      title={data ? `Плановая закупка ${data.displayNumber}` : 'Плановая закупка'}
      open={!!purchaseId}
      onClose={onClose}
      width={900}
      destroyOnHidden
      footer={
        data && (
          <Space wrap>
            {/* Правка — только в «Новой» (Р18): после проведения бумага у снабжения, и
                переписанный задним числом состав разошёлся бы с тем, по чему заказывают. */}
            {data.status === 'new' && <Button onClick={() => setEditing(data)}>Править</Button>}
            {data.status === 'new' && (
              <Button
                type="primary"
                loading={submitMut.isPending}
                onClick={() => submitMut.mutate()}
              >
                Провести
              </Button>
            )}
            {data.status === 'in_work' && (
              <Button type="primary" onClick={() => setClosing(data)}>
                Закрыть
              </Button>
            )}
            {(data.status === 'new' || data.status === 'in_work') && (
              <Button danger onClick={() => setCancelOpen(true)}>
                Отменить
              </Button>
            )}
          </Space>
        )
      }
    >
      <ViewFields items={fields} />
      <Table<OfficeEquipmentPurchaseItemDto>
        rowKey="id"
        size="small"
        style={{ marginTop: 12 }}
        pagination={false}
        columns={ITEM_COLUMNS}
        dataSource={data?.items ?? []}
      />

      {/* Окна живут внутри карточки (ADR 0140): antd поднимает z-index вложенного окна над
          родительским по контексту, а соседнее осталось бы под затемнением. */}
      <OfficeEquipmentPurchaseFormModal
        open={!!editing}
        purchase={editing}
        onClose={() => setEditing(null)}
      />
      <OfficeEquipmentPurchaseCloseModal purchase={closing} onClose={() => setClosing(null)} />
      <FormModal
        title="Отменить закупку"
        open={cancelOpen}
        onCancel={() => setCancelOpen(false)}
        onSubmit={() => cancelMut.mutate()}
        confirmLoading={cancelMut.isPending}
        okText="Отменить закупку"
        okDanger
        // Минимум из контракта: причина обязательна и в схеме, и в базе — отменённая без
        // объяснения через месяц читается как «передумали».
        okDisabled={reason.trim().length < 3}
        width={520}
      >
        <Typography.Paragraph type="secondary">
          Отменённую закупку не возвращают: ошибку исправляют новой. Причина попадёт в карточку и
          останется тому, кто будет заводить следующую.
        </Typography.Paragraph>
        <Input.TextArea
          rows={3}
          maxLength={1000}
          value={reason}
          aria-label="Причина отмены"
          placeholder="Например: заказали напрямую у поставщика по счёту 1245"
          onChange={(e) => setReason(e.target.value)}
        />
      </FormModal>
    </ViewModal>
  );
}
