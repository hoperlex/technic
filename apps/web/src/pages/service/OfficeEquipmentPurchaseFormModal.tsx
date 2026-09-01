import { useEffect, useRef, useState } from 'react';
import { Alert, App, Button, Input, Select, Space, Table, Typography } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { OfficeEquipmentPurchaseDetailDto } from '@technic/contracts';
import { FormModal } from '@shared/ui';
import { errorMessage, newIdempotencyKey } from '@shared/lib';
import {
  officeEquipmentActiveConsumablesQuery,
  officeEquipmentConsumableKeys,
  officeEquipmentPurchaseKeys,
  officeEquipmentPurchasesApi,
} from '@entities/office-equipment';
import {
  purchaseConflictOf,
  snapshotConflictOf,
  statusConflictOf,
  versionConflictOf,
  type PurchaseConflict,
} from './officeEquipmentPurchaseConflicts';
import {
  applySnapshotConflict,
  purchaseRowColumns,
  rowFromConsumable,
  rowFromItem,
  rowFromPrefill,
  toItemsInput,
  type PurchaseFormRow,
} from './officeEquipmentPurchaseRows';

/**
 * Форма плановой закупки — заведение и правка черновика одним окном (план
 * `docs/office-equipment-consumables-and-purchase-plan.md`, Р16, Р17, Р18).
 *
 * ОДНО ОКНО НА ДВА ДЕЙСТВИЯ, потому что предмет у них один: состав документа и комментарий. Разница
 * только в том, откуда берутся строки (предзаполнение или сама закупка) и что уезжает на сервер
 * (ключ отправки или версия содержимого). Разведи их по двум формам — разошлись бы правила
 * количества, подбор позиций и, главное, разбор трёх 409.
 *
 * ЧЕГО ЗДЕСЬ НЕТ: ФИО, телефона, срочности и подразделения (Р16). Это реквизиты заявки на
 * обслуживание, где к человеку едут; у закупки один адресат — снабжение, и он известен.
 *
 * КЛЮЧ ОТПРАВКИ ЖИВЁТ ОТ ОТКРЫТИЯ ДО ЗАКРЫТИЯ ФОРМЫ, а не рождается на каждое нажатие, и это самое
 * важное свойство этого файла. Смысл ключа — «та же попытка»: человек нажал «Завести», ответ
 * потерялся, он нажал ещё раз — и второй запрос обязан попасть в тот же ключ, чтобы сервер вернул
 * уже созданную закупку, а не завёл вторую. Ключ на нажатие означал бы, что защиты нет вовсе.
 */

interface Props {
  open: boolean;
  /**
   * Правка черновика; `null` — заведение (Р18: править можно только «Новую»).
   *
   * СНИМКОМ, А НЕ ЖИВЫМ ОТВЕТОМ ЗАПРОСА: поля формы заполняются один раз, при открытии, и каждая
   * новая копия карточки из кэша стирала бы набранное человеком. Свежесть здесь приходит не
   * подстановкой, а ответом 409 — и приходит вместе с рассказом о том, что изменилось.
   */
  purchase: OfficeEquipmentPurchaseDetailDto | null;
  onClose: () => void;
  /** Куда идти после сохранения: список открывает карточку заведённой закупки. */
  onSaved?: (purchase: OfficeEquipmentPurchaseDetailDto) => void;
}

export function OfficeEquipmentPurchaseFormModal({ open, purchase, onClose, onSaved }: Props) {
  const { message } = App.useApp();
  const qc = useQueryClient();

  const [rows, setRows] = useState<PurchaseFormRow[]>([]);
  const [comment, setComment] = useState('');
  const [conflict, setConflict] = useState<PurchaseConflict | null>(null);
  /** Свежий состав, приехавший с 409 «правил другой» (Р18): показываем и даём взять его в форму. */
  const [fresh, setFresh] = useState<OfficeEquipmentPurchaseDetailDto | null>(null);
  /** Версия содержимого, с которой уйдёт правка: растёт, когда человек берёт чужой состав. */
  const [version, setVersion] = useState(1);

  /** UUID попытки: один на всё время, пока форма открыта (см. шапку файла). */
  const attemptKey = useRef('');
  /** Строки уже подставлены — второй раз предзаполнение их не перезапишет. */
  const seeded = useRef(false);

  const prefill = useQuery({
    queryKey: officeEquipmentPurchaseKeys.prefill(),
    queryFn: () => officeEquipmentPurchasesApi.prefill(),
    // Предзаполнение нужно только заведению: у правки состав свой, и подставлять ему дефицит
    // значило бы вернуть снятые строки при каждом открытии.
    enabled: open && !purchase,
    /*
     * Числа стареют от каждой выдачи со склада, поэтому кэш здесь не просто «свежий», а
     * ОДНОРАЗОВЫЙ: `gcTime: 0` выбрасывает ответ, как только форму закрыли. Без этого второе
     * открытие подставило бы строки прошлого захода — на мгновение, пока не пришёл новый ответ, —
     * и подставило бы их насовсем: строки садятся в состояние формы один раз, и свежий ответ их
     * уже не тронет.
     */
    staleTime: 0,
    gcTime: 0,
  });

  const { data: catalog = [] } = useQuery({
    ...officeEquipmentActiveConsumablesQuery(),
    enabled: open,
  });

  const openedId = purchase?.id;
  useEffect(() => {
    if (!open) {
      seeded.current = false;
      return;
    }
    attemptKey.current = newIdempotencyKey();
    setConflict(null);
    setFresh(null);
    setComment(purchase?.comment ?? '');
    setVersion(purchase?.contentVersion ?? 1);
    setRows(purchase ? purchase.items.map(rowFromItem) : []);
    // У правки состав известен сразу; заведение ждёт предзаполнения — его подставит эффект ниже.
    seeded.current = !!purchase;
    // Зависимость по идентификатору, а не по объекту: перечитанная карточка приходит новой копией,
    // и форма сбрасывала бы набранное каждый раз, когда список под ней обновляется.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, openedId]);

  useEffect(() => {
    if (!open || purchase || seeded.current || !prefill.data) return;
    setRows(prefill.data.rows.map(rowFromPrefill));
    seeded.current = true;
  }, [open, purchase, prefill.data]);

  const setQuantity = (consumableId: string, quantity: number) =>
    setRows((rs) => rs.map((r) => (r.consumableId === consumableId ? { ...r, quantity } : r)));
  const removeRow = (consumableId: string) =>
    setRows((rs) => rs.filter((r) => r.consumableId !== consumableId));

  /**
   * Подбор дописываемой строки: только действующие позиции (Р13) и только те, которых в форме ещё
   * нет — повтор позиции схема отбивает, и предлагать его значило бы звать на отказ.
   */
  const options = catalog
    .filter((c) => !rows.some((r) => r.consumableId === c.id))
    .map((c) => ({ value: c.id, label: `${c.name} · ${c.code}` }));

  const addRow = (id: string) => {
    const found = catalog.find((c) => c.id === id);
    if (found) setRows((rs) => [...rs, rowFromConsumable(found)]);
  };

  const saveMut = useMutation({
    mutationFn: () => {
      const body = { comment: comment.trim(), items: toItemsInput(rows) };
      return purchase
        ? officeEquipmentPurchasesApi.update(purchase.id, { ...body, contentVersion: version })
        : officeEquipmentPurchasesApi.create(body, attemptKey.current);
    },
    onSuccess: (saved) => {
      message.success(
        purchase ? 'Состав закупки сохранён' : `Закупка ${saved.displayNumber} заведена`,
      );
      void qc.invalidateQueries({ queryKey: officeEquipmentPurchaseKeys.root });
      // Матрица Р15: заведённая закупка поднимает «уже заказано» и опускает дефицит у своих
      // позиций — перечень расходников после этого показывает вчерашние числа.
      void qc.invalidateQueries({ queryKey: officeEquipmentConsumableKeys.root });
      onSaved?.(saved);
      onClose();
    },
    onError: (e) => {
      const found = purchaseConflictOf(e);
      if (!found) {
        message.error(errorMessage(e));
        return;
      }
      setConflict(found);
      const snapshot = snapshotConflictOf(found);
      // Новые числа встают прямо в строки: отказ не по полю — человек ничего не написал неверно,
      // у него устарели данные, и переспрашивать то же самое незачем (Р17, шаг 6).
      if (snapshot) setRows((rs) => applySnapshotConflict(rs, snapshot));
      const mismatch = versionConflictOf(found);
      if (mismatch) setFresh(mismatch.purchase);
      // «Уже провели» означает, что документ ушёл дальше: список и карточка под окном врут.
      if (statusConflictOf(found)) {
        void qc.invalidateQueries({ queryKey: officeEquipmentPurchaseKeys.root });
      }
    },
  });

  /** Взять чужой состав в форму: с ним же приезжает и версия, под которой уйдёт следующая правка. */
  const adoptFresh = () => {
    if (!fresh) return;
    setRows(fresh.items.map(rowFromItem));
    setComment(fresh.comment);
    setVersion(fresh.contentVersion);
    setFresh(null);
    setConflict(null);
  };

  const total = rows.reduce((sum, r) => sum + r.quantity, 0);

  return (
    <FormModal
      title={purchase ? `Состав закупки ${purchase.displayNumber}` : 'Плановая закупка'}
      open={open}
      onCancel={onClose}
      onSubmit={() => saveMut.mutate()}
      confirmLoading={saveMut.isPending}
      okText={purchase ? 'Сохранить' : 'Завести закупку'}
      // Пустая закупка не заводится (Р16): закупка без строк — это отсутствие закупки, а не
      // документ «мы подумали и решили ничего не брать».
      okDisabled={rows.length === 0}
      width={980}
    >
      {conflict?.idempotency && (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 12 }}
          title="Ключ этой отправки уже занят другой командой"
          /*
           * Единственный из трёх отказов, который повторной отправкой не лечится: ключ описывает
           * попытку, и если под ним уже принято другое тело, повторять нечего — нужна новая
           * попытка. Поэтому текст зовёт закрыть форму, а не нажать ещё раз.
           */
          description={`${conflict.message}. Закройте окно и откройте форму заново — у новой попытки будет свой ключ. Проверьте перед этим список закупок: возможно, предыдущая отправка уже дошла.`}
        />
      )}
      {conflict && statusConflictOf(conflict) && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          title="Закупку уже провели"
          description={`${conflict.message}. Состав правится только в «Новой»: закройте окно и посмотрите карточку — там видно, кто и когда её провёл.`}
        />
      )}
      {fresh && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          title="Черновик изменил другой человек"
          description={
            <>
              <div>
                {conflict?.message} Сейчас в закупке {fresh.itemCount} позиций на{' '}
                {fresh.totalQuantity} шт.
              </div>
              {/* Кнопка, а не молчаливая подстановка: набранное человеком стирать без спроса
                  нельзя — он мог править состав полчаса. */}
              <Button size="small" style={{ marginTop: 8 }} onClick={adoptFresh}>
                Взять свежий состав
              </Button>
            </>
          }
        />
      )}
      {conflict && snapshotConflictOf(conflict) && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          title="Числа по складу изменились, пока форма была открыта"
          /*
           * Отдельной галочки «подтверждаю» нет намеренно (Р17): повторная отправка со свежим
           * снимком и есть подтверждение. Поэтому текст говорит ровно это — посмотрите новые числа
           * и нажмите ту же кнопку, если решение не поменялось.
           */
          description="Новые числа уже стоят в строках, рядом с прежними. Проверьте количества и отправьте ещё раз: заказать больше, чем предлагает портал, можно — это и будет вашим подтверждением."
        />
      )}

      {rows.length === 0 ? (
        <Alert
          type="info"
          showIcon
          title="Заказывать нечего"
          /*
           * Законный ответ, а не пустой экран (Р16): дефицита нет — значит по всем позициям, за
           * которыми следят, потребность закрыта остатком и уже сделанными заказами. Позиции с
           * нулевой потребностью сюда не попадают вовсе — за ними не следят.
           */
          description="По действующим позициям дефицита нет: потребность закрыта остатком и открытыми закупками. Пустую закупку портал не заводит — если заказ всё же нужен, допишите позицию подбором ниже."
        />
      ) : (
        <Table<PurchaseFormRow>
          rowKey="consumableId"
          size="small"
          pagination={false}
          scroll={{ y: 340 }}
          columns={purchaseRowColumns(setQuantity, removeRow)}
          dataSource={rows}
          loading={prefill.isFetching}
          summary={() => (
            <Table.Summary.Row>
              <Table.Summary.Cell index={0} colSpan={3}>
                <Typography.Text strong>Итого позиций: {rows.length}</Typography.Text>
              </Table.Summary.Cell>
              <Table.Summary.Cell index={1} colSpan={2}>
                <Typography.Text strong>{total} шт</Typography.Text>
              </Table.Summary.Cell>
            </Table.Summary.Row>
          )}
        />
      )}

      <Space orientation="vertical" size={8} style={{ width: '100%', marginTop: 12 }}>
        <Select
          showSearch
          allowClear
          optionFilterProp="label"
          placeholder="Дописать позицию (только действующие)"
          style={{ width: '100%' }}
          options={options}
          // Значения у поля нет: выбор — это действие «добавить строку», а не состояние поля.
          value={null}
          onChange={(v: string | null) => v && addRow(v)}
        />
        <Input.TextArea
          rows={2}
          maxLength={2000}
          value={comment}
          // Единственный текст документа и необязательный (Р16): «к чему закупка» читает снабжение.
          placeholder="К чему закупка — необязательно"
          aria-label="Комментарий к закупке"
          onChange={(e) => setComment(e.target.value)}
        />
      </Space>
    </FormModal>
  );
}
