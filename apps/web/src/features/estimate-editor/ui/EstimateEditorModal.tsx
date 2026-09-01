import { useEffect, useState } from 'react';
import { Alert, App, Button, Input, Space, Tooltip, Typography } from 'antd';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  serviceEstimatePending,
  type ServiceItemKind,
  type ServiceRequestDto,
} from '@technic/contracts';
import { serviceRequestKeys, serviceRequestsApi } from '@entities/service-request';
import { officeEquipmentKeys } from '@entities/office-equipment';
import { ViewModal } from '@shared/ui';
import { errorMessage } from '@shared/lib';
import {
  estimateIssue,
  newEstimateRow,
  rowsChanged,
  rowsFromItems,
  rowsToPayload,
  rowsTotal,
  type EstimateRow,
} from '../model/rows';
import { EstimateRowsGroup } from './EstimateRows';

/**
 * Что окно не даст сделать, пока висит предъявление (Р9). Одна строка на оба замка, потому что
 * замок один по смыслу: согласующий подписывает то, что видит.
 *
 * Ключ от него тоже один — «Вернуть объём работ в правку»: ручка возврата снимает и подпись, и
 * само предъявление, и потому названа здесь дословно. Скажи мы просто «нельзя» — исполнитель
 * искал бы выход в кнопках этого окна, где его нет вовсе.
 */
const LOCKED_HINT =
  'Отзовите его действием «Вернуть объём работ в правку» — оно снимает и предъявление, и подпись, — и правка откроется снова.';

/**
 * Редактор объёма работ у исполнителя (§9.3): две группы, количество, цена, срок гарантии, итог
 * на лету.
 *
 * Состав уходит на сервер целиком (`PUT`), поэтому строки живут состоянием окна, а не формой с
 * `Form.List`: считать итог на каждое нажатие клавиши и показывать его тут же — главное, что
 * окно делает; объём работ — это разговор о деньгах, и сумма не должна появляться только после
 * отправки.
 *
 * Версия заявки держится своим состоянием: сохранение состава её поднимает, и предъявление
 * сразу после сохранения ушло бы со старой версией — то есть получило бы 409 на ровном месте
 * (Р30).
 *
 * **Пока предъявление висит, окно не пускает никуда** (Р9). Прежде эту дверь запирал статус:
 * предъявленная смета стояла в «Смете на согласовании», где ни правка состава, ни повторное
 * предъявление были недоступны. Статуса больше нет, замок остался — и оба его засова сервер
 * держит одним признаком `serviceEstimatePending`, отвечая 409. Здесь про это сказано словами и
 * до нажатия: «ошибка сервера» на кнопке «Сохранить» читалась бы как поломка портала, а не как
 * «сначала отзовите предъявление».
 */
export function EstimateEditorModal({
  request,
  onClose,
}: {
  /**
   * `null` — окно закрыто. Открывается в «В работе»: до неё объёму работ взяться неоткуда, а
   * после закрытия работ он уже не правится.
   */
  request: ServiceRequestDto | null;
  onClose: () => void;
}) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [rows, setRows] = useState<EstimateRow[]>([]);
  const [comment, setComment] = useState('');
  const [version, setVersion] = useState(0);

  useEffect(() => {
    if (!request) return;
    setRows(rowsFromItems(request.items));
    setVersion(request.version);
    setComment('');
  }, [request]);

  const total = rowsTotal(rows);
  const issue = estimateIssue(rows);
  const warrantyMode = !!request?.warrantyClaim;
  /*
   * Оба замка Р9 сразу: и правка состава, и повторное предъявление закрыты одним признаком —
   * непогашенным предъявлением. Признак спрашивается у контрактов, а не выводится из даты
   * предъявления: у отозванного `estimateSubmittedAt` непуста, и окно заперлось бы навсегда.
   */
  const locked = !!request && serviceEstimatePending(request);

  const addRow = (kind: ServiceItemKind) => setRows((prev) => [...prev, newEstimateRow(kind)]);
  const changeRow = (key: string, patch: Partial<EstimateRow>) =>
    setRows((prev) => prev.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  const removeRow = (key: string) => setRows((prev) => prev.filter((row) => row.key !== key));

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: serviceRequestKeys.root });
    void qc.invalidateQueries({ queryKey: officeEquipmentKeys.root });
  };

  /**
   * Сохранение и предъявление — одна цепочка, а не две кнопки с одинаковым телом: предъявить
   * можно только то, что лежит на сервере, и «сохранить, потом отправить» руками означало бы
   * ревизию, разошедшуюся с экраном исполнителя.
   */
  const saveMutation = useMutation({
    mutationFn: async (submit: boolean) => {
      let current = version;
      if (rowsChanged(rows, request!.items)) {
        const saved = await serviceRequestsApi.saveEstimate(request!.id, {
          items: rowsToPayload(rows),
          version: current,
        });
        current = saved.version;
      }
      if (!submit) return { version: current, submitted: false };
      const sent = await serviceRequestsApi.submitEstimate(request!.id, {
        warrantyRepair: false,
        comment: comment.trim(),
        version: current,
      });
      return { version: sent.version, submitted: true };
    },
    onSuccess: (result) => {
      setVersion(result.version);
      refresh();
      if (result.submitted) {
        // Не «отправлена»: заявка никуда не уехала — она осталась «В работе» и ждёт подписи (Р8).
        message.success('Объём работ предъявлен на согласование');
        onClose();
      } else {
        message.success('Объём работ сохранён');
      }
    },
    // 409 здесь — обычный ответ: заявку подвинули, пока объём работ набирали. Второй его повод —
    // предъявление, повисшее с чужого экрана: замок ниже гасит кнопки, но между открытием окна и
    // нажатием помещается чужое действие, и объяснение этому даёт уже сервер.
    onError: (e) => message.error(errorMessage(e)),
  });

  /** Гарантийный ремонт (Р27): объём работ из служебной нулевой строки, его собирает сервер. */
  const warrantyMutation = useMutation({
    mutationFn: () =>
      serviceRequestsApi.submitEstimate(request!.id, {
        warrantyRepair: true,
        comment: comment.trim(),
        version,
      }),
    onSuccess: () => {
      message.success('Гарантийный ремонт предъявлен без оплаты');
      refresh();
      onClose();
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const pending = saveMutation.isPending || warrantyMutation.isPending;
  const submit = (asDraft: boolean) => {
    if (!asDraft && issue) {
      message.warning(issue);
      return;
    }
    saveMutation.mutate(!asDraft);
  };

  return (
    <ViewModal
      title={request ? `Объём работ заявки ${request.displayNumber}` : 'Объём работ'}
      open={!!request}
      onClose={onClose}
      width={860}
      destroyOnHidden
      footer={[
        ...(warrantyMode
          ? [
              <Tooltip
                key="warranty"
                title={
                  locked
                    ? 'Объём работ уже предъявлен: пока идёт согласование, предъявить заново нельзя'
                    : rows.length > 0
                      ? 'Уберите строки: гарантийный ремонт предъявляется без оплаты'
                      : 'Работы по гарантии: заявка уйдёт на согласование с нулевой суммой'
                }
              >
                <span>
                  <Button
                    disabled={locked || rows.length > 0 || pending}
                    loading={warrantyMutation.isPending}
                    onClick={() => warrantyMutation.mutate()}
                  >
                    Гарантийный ремонт без оплаты
                  </Button>
                </span>
              </Tooltip>,
            ]
          : []),
        <Button key="draft" disabled={locked || pending} onClick={() => submit(true)}>
          Сохранить черновик
        </Button>,
        <Button
          key="submit"
          type="primary"
          loading={saveMutation.isPending}
          disabled={locked || warrantyMutation.isPending}
          onClick={() => submit(false)}
        >
          Предъявить на согласование
        </Button>,
      ]}
    >
      {request && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {locked ? (
            /*
             * Замок объясняется до нажатия, а не 409-й в ответ. Поля и кнопки погашены, и без этой
             * врезки окно выглядело бы сломанным: состав виден, а тронуть его нечем — причину
             * этого портал обязан назвать сам, ответ сервера сюда уже не придёт.
             */
            <Alert
              type="warning"
              showIcon
              title={`Ревизия ${request.estimatePendingRevision} предъявлена и ждёт ответа — правка закрыта`}
              description={`Пока предъявление висит, сервер не примет ни изменённый состав, ни повторное предъявление: согласующий подписывает то, что видит. ${LOCKED_HINT}`}
            />
          ) : (
            <Alert
              type="info"
              showIcon
              title={
                request.estimateRevision > 0
                  ? `Ревизия ${request.estimateRevision} уже предъявлялась — следующее предъявление уйдёт ревизией ${request.estimateRevision + 1}`
                  : 'Черновик можно сохранять сколько угодно: на согласование уйдёт то, что предъявите'
              }
              description={
                [
                  warrantyMode
                    ? 'Заявка заведена как гарантийная — работы можно предъявить без оплаты.'
                    : null,
                  // Подпись обесценивается новым предъявлением (ревизии сверяются при закрытии
                  // работ), и узнать об этом надо до нажатия, а не по отказу на закрытии.
                  request.approval
                    ? `Согласована ревизия ${request.approval.revision}: новое предъявление снимет эту подпись — объём работ придётся согласовать заново.`
                    : null,
                ]
                  .filter(Boolean)
                  .join(' ') || undefined
              }
            />
          )}

          <EstimateRowsGroup
            kind="part"
            disabled={locked}
            rows={rows.filter((row) => row.kind === 'part')}
            onAdd={addRow}
            onChange={changeRow}
            onRemove={removeRow}
          />
          <EstimateRowsGroup
            kind="service"
            disabled={locked}
            rows={rows.filter((row) => row.kind === 'service')}
            onAdd={addRow}
            onChange={changeRow}
            onRemove={removeRow}
          />

          {/* Итог — строка, а не поле: его считает сумма строк, и разойтись с ней он не может. */}
          <Space size={8} style={{ justifyContent: 'flex-end', width: '100%' }}>
            <Typography.Text type="secondary">Итого по объёму работ:</Typography.Text>
            <Typography.Text strong style={{ fontSize: 16 }}>
              {total.toLocaleString('ru-RU', {
                minimumFractionDigits: 2,
                maximumFractionDigits: 2,
              })}{' '}
              ₽
            </Typography.Text>
          </Space>

          <Input.TextArea
            rows={2}
            maxLength={1000}
            disabled={locked}
            value={comment}
            placeholder="Комментарий к объёму работ: что нашли при диагностике"
            onChange={(e) => setComment(e.target.value)}
          />
          {issue && <Typography.Text type="warning">{issue}</Typography.Text>}
        </div>
      )}
    </ViewModal>
  );
}
