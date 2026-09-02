import { useEffect, useState } from 'react';
import { Alert, App, Button, Skeleton, Space, Table, Typography } from 'antd';
import dayjs from 'dayjs';
import { useMutation, useQuery } from '@tanstack/react-query';
import type { AutoPartReceiptDto, AutoPartReceiptLineDto } from '@technic/contracts';
import { autoPartReceiptApi, autoPartReceiptKeys } from '@entities/auto-part-receipt';
import { EntityLink, ViewFields, ViewModal, type ViewField } from '@shared/ui';
import { errorMessage, type AddressParam } from '@shared/lib';
import { useAuth } from '../../auth/AuthContext';
import { FileLinkList } from '../../components/FileLinks';
import { formatMoney } from '../../utils/format';
import { AutoPartReceiptFormModal } from './AutoPartReceiptFormModal';
import { ReceiptDeletionMarkModal } from './ReceiptDeletionMarkModal';
import { receiptErrorText, receiptVehicleIds, useReceiptInvalidation } from './receiptMutations';

/**
 * Карточка чека `?receipt=<id>` (план `docs/auto-part-receipts-plan.md`, §8, Р8, Р11, Р12).
 *
 * Карточка отвечает на три вопроса и ровно в этом порядке: что за бумага (реквизиты и сканы), что
 * по ней куплено (строки) и сколько это стоило (три числа под таблицей).
 *
 * **Итогов три, а не один.** «Всего по чеку» — вся бумага, «не отнесено» — та её часть, которую не
 * привязали к машинам: строка без машины это законное состояние (Р8) — общий инструмент,
 * расходники гаража, позиция, которую механик не стал разбирать. Сумма по машинам законно меньше
 * суммы чека, и объяснять разницу должна карточка, а не читатель.
 *
 * Ни одно из чисел карточка не считает по строкам: `total` и `unassignedTotal` приходят из ответа
 * (Р11), а «по машинам» — их разность. Второй формулы для одной и той же суммы в портале быть не
 * должно: она разошлась бы с серверной на первом же округлении.
 *
 * **Читают карточку все, кому виден гараж** (Р5), а кнопки внизу зависят от права (Р12): держатель
 * ведения меняет чек и просит его удалить, администратор удаляет или отказывает, сняв пометку.
 * Окна, открываемые отсюда, живут внутри карточки (ADR 0140) — вызванное снаружи, оно иногда
 * открывалось бы под ней, и это неотличимо от неработающей кнопки.
 */

const SHOWN_DATE = 'DD.MM.YYYY';
const SHOWN_DATETIME = 'DD.MM.YYYY HH:mm';

const dash = <Typography.Text type="secondary">—</Typography.Text>;

/**
 * «По машинам» — разность двух серверных чисел, а не третья сумма по строкам (Р11): портал не
 * заводит второй формулы для той же величины. Округление до копейки здесь про двоичную дробь, а не
 * про деньги: `3512.2 - 1240.1` даёт хвост, которого нет ни в одном из слагаемых.
 */
function assignedTotal(receipt: AutoPartReceiptDto): number {
  return Math.round((receipt.total - receipt.unassignedTotal) * 100) / 100;
}

/** Полоса помеченного чека (Р12): просьба, её автор и дата — то, на что отвечает администратор. */
function DeletionBanner({ receipt }: { receipt: AutoPartReceiptDto }) {
  const { deletion } = receipt;
  if (!deletion) return null;
  return (
    <Alert
      type="warning"
      showIcon
      style={{ marginBottom: 16 }}
      title={`Помечен к удалению ${dayjs(deletion.requestedAt).format(SHOWN_DATE)} — ${deletion.requestedByName}`}
      description={`«${deletion.reason}»`}
    />
  );
}

/** Реквизиты чека. Даты две, и обе названы своими словами (Р13): бумаги и внесения в портал. */
function receiptFields(receipt: AutoPartReceiptDto): ViewField[] {
  return [
    {
      key: 'purchasedOn',
      label: 'Дата чека',
      children: dayjs(receipt.purchasedOn).format(SHOWN_DATE),
    },
    { key: 'documentNumber', label: 'Номер', children: receipt.documentNumber },
    // Продавца может не быть вовсе: название магазина на ленте бывает нечитаемо (Р1а).
    { key: 'sellerName', label: 'Продавец', children: receipt.sellerName || dash },
    {
      key: 'createdBy',
      label: 'Внёс',
      children: `${receipt.createdByName} · ${dayjs(receipt.createdAt).format(SHOWN_DATETIME)}`,
    },
    ...(receipt.updatedByName
      ? [
          {
            key: 'updatedBy',
            label: 'Изменил',
            children: `${receipt.updatedByName} · ${dayjs(receipt.updatedAt).format(SHOWN_DATETIME)}`,
          },
        ]
      : []),
    ...(receipt.note
      ? [{ key: 'note', label: 'Примечание', full: true, children: receipt.note }]
      : []),
    {
      key: 'files',
      label: 'Сканы',
      full: true,
      // Картинки и PDF открываются окном просмотра прямо здесь (`FileLink`): чек сверяют с
      // экраном, не уходя на домен хранилища.
      children: <FileLinkList files={receipt.files} />,
    },
  ];
}

export function AutoPartReceiptCardModal({
  receiptId,
  onClose,
  vehicleSpend,
}: {
  /** `null` — окно закрыто: чек назван в адресе вкладки (`?receipt=<id>`). */
  receiptId: string | null;
  onClose: () => void;
  /**
   * Вход в окно «Запчасти машины» (Р15). Приходит от вкладки, а не спрашивается здесь: ключ
   * `?spend=` читают трое, и отвечать на него обязан ровно тот, кто сейчас на виду, — иначе
   * присланная ссылка открыла бы два одинаковых окна друг поверх друга.
   */
  vehicleSpend: Pick<AddressParam, 'href' | 'open'>;
}) {
  const { message, modal } = App.useApp();
  const { can } = useAuth();
  const invalidate = useReceiptInvalidation();
  const canManage = can('autoParts.manage');
  const canDelete = can('autoParts.delete');

  const [editing, setEditing] = useState(false);
  const [marking, setMarking] = useState(false);

  const { data: receipt, error } = useQuery({
    queryKey: autoPartReceiptKeys.detail(receiptId ?? ''),
    queryFn: () => autoPartReceiptApi.get(receiptId!),
    enabled: !!receiptId,
  });

  useEffect(() => {
    if (!error) return;
    // Чек не читается (удалён администратором, пока карточка висела; чужая ссылка): адрес
    // чистится, иначе он открывал бы пустоту при каждом возвращении.
    message.error(errorMessage(error));
    onClose();
  }, [error, message, onClose]);

  /** Снятие пометки: версией в адресе (`DELETE ?version=`) — тела у запроса нет (Р12). */
  const unmark = useMutation({
    mutationFn: (r: AutoPartReceiptDto) => autoPartReceiptApi.unmarkDeletion(r.id, r.version),
    onSuccess: (r) => {
      message.success('Пометка снята');
      invalidate({ kind: 'mark', id: r.id });
    },
    onError: (e, r) => {
      message.error(receiptErrorText(e));
      // И расхождение версий, и «пометки уже нет» лечатся перечиткой: карточка на экране устарела.
      invalidate({ kind: 'mark', id: r.id });
    },
  });

  const remove = useMutation({
    mutationFn: (r: AutoPartReceiptDto) => autoPartReceiptApi.remove(r.id, r.version),
    onSuccess: (_result, r) => {
      message.success('Чек удалён');
      /*
       * Сначала закрыть, потом гасить: гашение задевает и карточку этого чека, а её перечитка на
       * ещё открытом окне пришла бы 404 — вторым сообщением «чек не найден» поверх «чек удалён».
       * Суммы машин гасятся вместе со списком: удалён весь документ, а не пометка.
       */
      onClose();
      invalidate({ kind: 'write', id: r.id, vehicleIds: receiptVehicleIds(r.lines) });
    },
    onError: (e, r) => {
      message.error(receiptErrorText(e));
      invalidate({ kind: 'write', id: r.id, vehicleIds: receiptVehicleIds(r.lines) });
    },
  });

  /**
   * Подтверждение называет чек целиком — дату, номер, продавца и сумму (§8): после нажатия от него
   * не остаётся ничего, кроме следа в аудите, и «удалить запись?» на такой вопрос не ответ.
   */
  const confirmRemove = (r: AutoPartReceiptDto) =>
    modal.confirm({
      title: `Удалить чек № ${r.documentNumber} от ${dayjs(r.purchasedOn).format(SHOWN_DATE)}?`,
      content: `${r.sellerName || 'Продавец не указан'} · ${formatMoney(r.total)}. Чек удаляется насовсем — со строками и сканами; суммы по машинам пересчитаются без него.`,
      okText: 'Удалить',
      okButtonProps: { danger: true },
      cancelText: 'Отмена',
      // Отказ гасится здесь: объяснение уже показано `onError`, а оставленное открытым
      // подтверждение предлагало бы нажать «Удалить» второй раз — с тем же исходом.
      onOk: () => remove.mutateAsync(r).catch(() => undefined),
    });

  const columns = [
    { key: 'seq', title: '№', dataIndex: 'seq', width: 56 },
    {
      key: 'vehicle',
      title: 'Техника',
      width: 220,
      render: (_v: unknown, line: AutoPartReceiptLineDto) =>
        line.vehicleId ? (
          // Ссылка настоящая: её открывают средним щелчком соседней вкладкой, а обычный клик
          // открывает окно «Запчасти машины» поверх карточки (Р15).
          <EntityLink
            to={vehicleSpend.href(line.vehicleId)}
            title="Что купили на эту машину"
            onActivate={() => vehicleSpend.open(line.vehicleId!)}
          >
            {line.vehicleLabel}
          </EntityLink>
        ) : (
          // Не прочерк: «не отнесено» — ответ, а не пропущенное поле (Р8).
          <Typography.Text type="secondary">не отнесено</Typography.Text>
        ),
    },
    { key: 'name', title: 'Наименование', dataIndex: 'name' },
    {
      key: 'quantity',
      title: 'Кол-во',
      width: 110,
      render: (_v: unknown, line: AutoPartReceiptLineDto) => `${line.quantity} ${line.unit}`,
    },
    {
      key: 'unitPrice',
      // Цена за единицу — производная (Р9): её считает сервер делением суммы на количество, и
      // стоит она справочно. Хранится и сверяется с бумагой сумма.
      title: 'Цена за ед.',
      width: 130,
      render: (_v: unknown, line: AutoPartReceiptLineDto) => formatMoney(line.unitPrice),
    },
    {
      key: 'amount',
      title: 'Сумма',
      width: 130,
      render: (_v: unknown, line: AutoPartReceiptLineDto) => (
        <Typography.Text strong>{formatMoney(line.amount)}</Typography.Text>
      ),
    },
    {
      key: 'note',
      title: 'Примечание',
      dataIndex: 'note',
      render: (value: unknown) => (value as string) || dash,
    },
  ];

  const busy = remove.isPending || unmark.isPending;
  const footer = receipt
    ? [
        ...(canManage
          ? [
              <Button key="edit" disabled={busy} onClick={() => setEditing(true)}>
                Изменить
              </Button>,
              receipt.deletion ? (
                <Button
                  key="unmark"
                  disabled={busy}
                  loading={unmark.isPending}
                  onClick={() => unmark.mutate(receipt)}
                >
                  Снять пометку
                </Button>
              ) : (
                <Button key="mark" disabled={busy} onClick={() => setMarking(true)}>
                  Пометить к удалению
                </Button>
              ),
            ]
          : []),
        ...(canDelete
          ? [
              <Button key="remove" danger disabled={busy} onClick={() => confirmRemove(receipt)}>
                Удалить
              </Button>,
            ]
          : []),
        <Button key="close" type="primary" onClick={onClose}>
          Закрыть
        </Button>,
      ]
    : [
        <Button key="close" type="primary" onClick={onClose}>
          Закрыть
        </Button>,
      ];

  return (
    <ViewModal
      title={receipt ? `Чек № ${receipt.documentNumber}` : 'Чек'}
      open={!!receiptId}
      onClose={onClose}
      width={980}
      footer={footer}
    >
      {!receipt ? (
        <Skeleton active paragraph={{ rows: 6 }} />
      ) : (
        <Space orientation="vertical" size={16} style={{ display: 'flex' }}>
          <div>
            <DeletionBanner receipt={receipt} />
            <ViewFields items={receiptFields(receipt)} />
          </div>

          <Table<AutoPartReceiptLineDto>
            rowKey="id"
            size="small"
            columns={columns}
            dataSource={receipt.lines}
            pagination={false}
            scroll={{ x: 'max-content' }}
            locale={{ emptyText: 'Строк нет' }}
          />

          <Space size={24} wrap style={{ justifyContent: 'flex-end', width: '100%' }}>
            <Typography.Text strong>Всего по чеку: {formatMoney(receipt.total)}</Typography.Text>
            <Typography.Text>По машинам: {formatMoney(assignedTotal(receipt))}</Typography.Text>
            <Typography.Text type="secondary">
              Не отнесено: {formatMoney(receipt.unassignedTotal)}
            </Typography.Text>
          </Space>

          {/* Окна карточки — внутри неё (ADR 0140). */}
          <AutoPartReceiptFormModal
            receipt={receipt}
            open={editing}
            onClose={() => setEditing(false)}
          />
          <ReceiptDeletionMarkModal
            receipt={marking ? receipt : null}
            onClose={() => setMarking(false)}
          />
        </Space>
      )}
    </ViewModal>
  );
}
