import { useEffect, useState } from 'react';
import { Alert, App, Checkbox, Table, Typography } from 'antd';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type {
  OfficeEquipmentPurchaseDetailDto,
  OfficeEquipmentPurchaseItemDto,
} from '@technic/contracts';
import { FormModal } from '@shared/ui';
import { errorMessage } from '@shared/lib';
import {
  officeEquipmentConsumableKeys,
  officeEquipmentPurchaseKeys,
  officeEquipmentPurchasesApi,
} from '@entities/office-equipment';
import { purchaseConflictOf, statusConflictOf } from './officeEquipmentPurchaseConflicts';

/**
 * Закрытие плановой закупки с подтверждением «приход занесён» (план
 * `docs/office-equipment-consumables-and-purchase-plan.md`, Р11).
 *
 * ГАЛОЧКА ОБЯЗАТЕЛЬНА И НИЧЕГО НЕ ДОКАЗЫВАЕТ — обе половины этой фразы важны, и текст окна обязан
 * говорить именно так. Проверить порядок «сначала приход, потом закрытие» портал НЕ может: текущий
 * остаток не доказывает, что приход именно по ЭТОЙ закупке, — между открытием и закрытием были
 * выдачи по заявкам, ручные корректировки и, возможно, приход по соседней закупке. Сопоставить
 * движение с закупкой нечем, пока у журнала нет вида события «приход со ссылкой на закупку», а его
 * на альфе нет по решению заказчика.
 *
 * Поэтому подтверждение делает ровно две вещи: заставляет прочитать правило в момент, когда оно
 * применяется, и оставляет имя того, кто это утверждал. Своих колонок у него нет — след
 * подтверждения это сама пара закрытия: закупка закрыта, значит подтверждение было.
 *
 * ПОЧЕМУ ПОРЯДОК ВАЖЕН, а не «желателен»: закрытая закупка перестаёт вычитаться из дефицита (Р15).
 * Закрой её раньше прихода — и портал вернёт дефицит на экран и позовёт заказать второй раз то, что
 * уже стоит на полке.
 *
 * Текущий остаток по каждой строке показан ровно для этого: человеку нечем проверить себя, кроме
 * этого числа, и портал обязан дать хотя бы его.
 */

interface Props {
  /** Закупка, которую закрывают; `null` — окно закрыто. */
  purchase: OfficeEquipmentPurchaseDetailDto | null;
  onClose: () => void;
}

const COLUMNS = [
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
    key: 'quantity',
    title: 'Заказано',
    width: 110,
    render: (_v: unknown, r: OfficeEquipmentPurchaseItemDto) => r.quantity,
  },
  {
    key: 'currentStock',
    // «Сейчас», а не «Остаток»: соседний столбец снимка отвечает «сколько было, когда заказывали»,
    // и подменять один ответ другим нельзя — по этому числу человек и решает, занесён ли приход.
    title: 'На складе сейчас',
    width: 150,
    render: (_v: unknown, r: OfficeEquipmentPurchaseItemDto) => (
      <Typography.Text strong>{r.currentStock}</Typography.Text>
    ),
  },
];

export function OfficeEquipmentPurchaseCloseModal({ purchase, onClose }: Props) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [confirmed, setConfirmed] = useState(false);

  const openedId = purchase?.id;
  useEffect(() => {
    // Галочка снимается при каждом открытии: подтверждение относится к этому закрытию, а не к
    // прошлому — иначе второе окно открывалось бы уже «подтверждённым».
    setConfirmed(false);
  }, [openedId]);

  const closeMut = useMutation({
    mutationFn: () =>
      officeEquipmentPurchasesApi.close(purchase!.id, { stockReceiptConfirmed: true }),
    onSuccess: (saved) => {
      message.success(`Закупка ${saved.displayNumber} закрыта`);
      void qc.invalidateQueries({ queryKey: officeEquipmentPurchaseKeys.root });
      // Закрытая перестаёт вычитаться из дефицита (Р15) — перечень позиций после этого другой.
      void qc.invalidateQueries({ queryKey: officeEquipmentConsumableKeys.root });
      onClose();
    },
    onError: (e) => {
      const conflict = purchaseConflictOf(e);
      const status = statusConflictOf(conflict);
      if (status) {
        // «Закрыть» против «Отменить» на одном документе: один ход проходит, второй получает 409 с
        // текущим состоянием. Это нормальный исход одновременной работы двоих, а не сбой.
        message.warning(conflict!.message);
        void qc.invalidateQueries({ queryKey: officeEquipmentPurchaseKeys.root });
        onClose();
        return;
      }
      message.error(errorMessage(e));
    },
  });

  return (
    <FormModal
      title={`Закрыть закупку ${purchase?.displayNumber ?? ''}`}
      open={!!purchase}
      onCancel={onClose}
      onSubmit={() => closeMut.mutate()}
      confirmLoading={closeMut.isPending}
      okText="Закрыть закупку"
      // Снятая галочка — это «не закрывать», а не «закрыть без подтверждения»: схема принимает
      // только `true`, и включённая кнопка звала бы на 422.
      okDisabled={!confirmed}
      width={640}
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="Сначала приход, потом закрытие"
        /*
         * Правило проговаривается словами, а не подразумевается: закрытая закупка перестаёт
         * вычитаться из дефицита, и порядок здесь — не формальность, а условие того, чтобы портал
         * не позвал заказывать второй раз.
         */
        description="Занесите приход в остатки ручной правкой («Изменить остаток» в перечне расходников), и только потом закрывайте закупку: закрытая перестаёт вычитаться из дефицита, и незанесённый приход вернёт позицию в план закупки."
      />
      <Table<OfficeEquipmentPurchaseItemDto>
        rowKey="id"
        size="small"
        pagination={false}
        columns={COLUMNS}
        dataSource={purchase?.items ?? []}
      />
      <Checkbox
        style={{ marginTop: 12 }}
        checked={confirmed}
        onChange={(e) => setConfirmed(e.target.checked)}
      >
        Приход по этой закупке занесён в остатки
      </Checkbox>
      {/*
       * Честная оговорка рядом с галочкой, а не мелким шрифтом внизу. Портал не может проверить
       * это утверждение и не притворяется, что может: остаток на складе не доказывает, по какой
       * закупке он вырос. Это принятый операционный риск, и человек, который ставит галочку,
       * должен видеть, что отвечает за неё он, а не проверка.
       */}
      <div>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          Портал это не проверяет и проверить не может: остаток на складе не показывает, по какой
          именно закупке он вырос — между заказом и закрытием были и выдачи, и соседние поступления.
          Галочка остаётся вашим утверждением, и рядом с закрытием сохранится ваше имя.
        </Typography.Text>
      </div>
    </FormModal>
  );
}
