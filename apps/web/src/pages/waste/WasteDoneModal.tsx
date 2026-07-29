import { App, Button, Form, Input, Space, Typography, Upload } from 'antd';
import { UploadOutlined } from '@ant-design/icons';
import { useEffect, useState } from 'react';
import { useQueries } from '@tanstack/react-query';
import {
  calcWasteAmount,
  type FileDto,
  MAX_TICKETS_PER_REQUEST,
  requestTypeShort,
  requiresWasteVehicles,
  type WasteRequestDto,
  type WasteRequestVehicleInput,
  type WasteVehicleCountInput,
} from '@technic/contracts';
import { filesApi, wasteTariffsApi } from '../../api/resources';
import { FileLinkList } from '../../components/FileLinks';
import { FormModal } from '../../components/FormModal';
import {
  changedCounts,
  draftsToInput,
  draftVolume,
  emptyVehicleDraft,
  existingVehicleDraft,
  type PriceLookup,
  sumDraftVolume,
  validateVehicleDrafts,
  type VehicleDraft,
  type VehicleTypeOption,
  VolumeSummary,
  WasteVehiclesEditor,
} from '../../components/WasteVehiclesEditor';
import { errorMessage, formatMoney } from '../../utils/format';

const FILE_MAX_SIZE = 52_428_800; // 50 МБ

/**
 * Закрытие заявки: факт предъявляется вместе со сменой статуса, а не после неё.
 *  - вывоз мусора — чем вывезли: строки «тип машины × количество» (ADR 0024). Объём считается из
 *    вместимости типа, стоимость — по справочнику цен: заявку оформляли планом, платят за факт;
 *  - контейнерные операции — только талон: ходка одна, и машине взяться неоткуда (ADR 0013).
 * Талон обязателен в обоих случаях (ADR 0020) и с ADR 0024 крепится к самой заявке общим пулом:
 * оператор отдаёт бумаги пачкой за всё закрытие. Комментарий уходит в историю заявки.
 */
interface Props {
  /** null — окно закрыто; заявка берётся из строки списка. */
  request: WasteRequestDto | null;
  typeOptions: VehicleTypeOption[];
  confirmLoading: boolean;
  onCancel: () => void;
  onSubmit: (v: {
    comment: string;
    vehicles: WasteRequestVehicleInput[];
    /** Правка количества у машин прошлого закрытия — вместо второй строки того же типа. */
    vehicleCounts: WasteVehicleCountInput[];
    ticketFileIds: string[];
  }) => void;
}

export function WasteDoneModal({
  request,
  typeOptions,
  confirmLoading,
  onCancel,
  onSubmit,
}: Props) {
  const { message } = App.useApp();
  const [drafts, setDrafts] = useState<VehicleDraft[]>([]);
  const [tickets, setTickets] = useState<FileDto[]>([]);
  const [comment, setComment] = useState('');
  const [uploading, setUploading] = useState(false);

  const byVehicles = request ? requiresWasteVehicles(request.requestType) : false;
  const activeVehicles = request?.vehicles.filter((v) => !v.isDeleted) ?? [];

  // Окно переиспользуется под разные заявки, поэтому строки сбрасываются при смене цели, а не
  // при размонтировании. Машины прошлого закрытия (после отката) показываются готовыми строками:
  // у них правится количество — второй строки того же типа в заявке не бывает.
  const targetId = request?.id ?? null;
  useEffect(() => {
    if (!request) return;
    const existing = request.vehicles.filter((v) => !v.isDeleted).map(existingVehicleDraft);
    setDrafts(
      requiresWasteVehicles(request.requestType)
        ? existing.length > 0
          ? existing
          : [emptyVehicleDraft()]
        : [],
    );
    setTickets([]);
    setComment('');
    // Зависимость — идентификатор заявки, а не сама заявка: перерисовка той же заявки (invalidate
    // списка после соседнего действия) приходит новым объектом и стёрла бы уже набранное.
  }, [targetId]);

  /**
   * Предварительный расчёт по справочнику цен (ADR 0024): тариф для каждого выбранного типа
   * подбирает сервер — той же ручкой, что считает цену при сохранении заявки, и для оператора
   * этой заявки (прайс у каждого свой, ADR 0023). Считать на клиенте по списку тарифов нельзя:
   * правило подбора (точный тип побеждает вид техники) должно быть одно на обе стороны.
   */
  const selectedTypeIds = [
    ...new Set(drafts.map((d) => d.containerTypeId).filter((id): id is string => !!id)),
  ];
  const wasteTypeId = request?.wasteTypeId ?? null;
  const operatorId = request?.operatorCounterpartyId ?? null;
  const priceQueries = useQueries({
    queries: selectedTypeIds.map((containerTypeId) => ({
      queryKey: ['waste-tariffs', 'resolve', wasteTypeId, containerTypeId, operatorId],
      queryFn: () => wasteTariffsApi.resolve(wasteTypeId!, { containerTypeId }, operatorId),
      enabled: !!wasteTypeId,
      staleTime: 60_000,
    })),
  });
  const priceByType = new Map<string, number | null | undefined>();
  selectedTypeIds.forEach((id, i) => {
    const q = priceQueries[i];
    // undefined — цена ещё грузится (или тип мусора неизвестен), null — тарифа для типа нет.
    priceByType.set(id, q?.isSuccess ? (q.data.tariff?.pricePerM3 ?? null) : undefined);
  });
  const priceOf: PriceLookup = (id) => priceByType.get(id);
  const pricesPending = priceQueries.some((q) => q.isPending);
  /** Цена «от»: оператор не назначен, и подбор взял минимальную среди операторов (ADR 0023). */
  const priceIsMinimum = priceQueries.some((q) => q.data?.tariff?.isMinimum);

  const filledDrafts = drafts.filter((d) => d.containerTypeId);
  const missingPrice = filledDrafts.some((d) => priceByType.get(d.containerTypeId!) === null);
  const factVolume = sumDraftVolume(drafts, typeOptions);
  /** Итог расчёта; null — не все цены известны, и складывать было бы нечего. */
  const factAmount = (() => {
    if (filledDrafts.length === 0) return null;
    let sum = 0;
    for (const d of filledDrafts) {
      const price = priceByType.get(d.containerTypeId!);
      if (price == null) return null;
      sum += calcWasteAmount(draftVolume(d, typeOptions), price);
    }
    return Math.round(sum * 100) / 100;
  })();

  /** Файлы, не дошедшие до заявки, удаляем сразу: иначе они повиснут в S3 ничьими. */
  const discardUploads = () => {
    tickets.forEach((f) => void filesApi.remove(f.id).catch(() => {}));
    setTickets([]);
  };

  const uploadTicket = async (file: File) => {
    setUploading(true);
    try {
      const uploaded = await filesApi.upload(file);
      setTickets((prev) => [...prev, uploaded]);
    } catch (e) {
      message.error(errorMessage(e));
    } finally {
      setUploading(false);
    }
  };

  const removeTicket = (f: FileDto) => {
    void filesApi.remove(f.id).catch(() => {});
    setTickets((prev) => prev.filter((t) => t.id !== f.id));
  };

  const cancel = () => {
    discardUploads();
    onCancel();
  };

  const submit = () => {
    if (!request) return;
    if (byVehicles) {
      const error = validateVehicleDrafts(drafts);
      if (error) {
        message.warning(error);
        return;
      }
      if (drafts.length === 0) {
        message.warning('Добавьте хотя бы одну машину');
        return;
      }
      // Без цены сумма по факту вышла бы неполной — такое закрытие сервер и не проведёт.
      if (missingPrice) {
        message.warning('Для выбранного типа цена в прайсе не задана — заполните прайс');
        return;
      }
    }
    // Талон обязателен у заявки любого типа; приложенные прошлым закрытием засчитываются.
    if (request.tickets.length + tickets.length === 0) {
      message.warning('Приложите талон — без него заявка не закрывается');
      return;
    }
    onSubmit({
      comment: comment.trim(),
      vehicles: byVehicles ? draftsToInput(drafts) : [],
      vehicleCounts: byVehicles ? changedCounts(drafts, activeVehicles) : [],
      ticketFileIds: tickets.map((f) => f.id),
    });
  };

  const noTicketYet = !!request && request.tickets.length + tickets.length === 0;

  return (
    <FormModal
      title="Выполнение заявки"
      open={!!request}
      onCancel={cancel}
      onSubmit={submit}
      confirmLoading={confirmLoading}
      okText="Выполнена"
      width={760}
    >
      {request && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Typography.Text type="secondary">
            Заявка № {request.num}-{requestTypeShort[request.requestType]}, {request.objectName}
            {request.volumeM3 != null ? ` · заявлено ${request.volumeM3} м³` : ''}
            {request.amount != null ? ` на ${formatMoney(request.amount)}` : ''}
          </Typography.Text>

          {byVehicles && (
            <>
              <Typography.Text strong>Чем вывезли</Typography.Text>
              <WasteVehiclesEditor
                value={drafts}
                onChange={setDrafts}
                typeOptions={typeOptions}
                priceOf={priceOf}
              />
              <VolumeSummary planned={request.volumeM3} actual={factVolume} />
              {/* Предварительный расчёт по прайсу: им же считается сумма закрытой заявки, и
                  человек видит её до того, как нажмёт «Выполнена». */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <Typography.Text>
                  {'Стоимость по прайсу: '}
                  {factAmount != null ? (
                    <Typography.Text strong>
                      {priceIsMinimum ? 'от ' : ''}
                      {formatMoney(factAmount)}
                    </Typography.Text>
                  ) : pricesPending ? (
                    <Typography.Text type="secondary">считаем…</Typography.Text>
                  ) : (
                    <Typography.Text type="secondary">—</Typography.Text>
                  )}
                </Typography.Text>
                {factAmount != null && request.amount != null && factAmount !== request.amount && (
                  <Typography.Text type="warning" style={{ fontSize: 12 }}>
                    Заявка оформлена на {formatMoney(request.amount)} — закрытие пересчитает сумму
                    по машинам
                  </Typography.Text>
                )}
                {missingPrice && (
                  <Typography.Text type="warning" style={{ fontSize: 12 }}>
                    Для выбранного типа цена в прайсе не задана — заявку с ним не закрыть
                  </Typography.Text>
                )}
                {priceIsMinimum && (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    Оператор не назначен — показана минимальная цена среди операторов
                  </Typography.Text>
                )}
              </div>
            </>
          )}

          {/* Талоны — общий пул заявки (ADR 0024): бумаги за всё закрытие, без деления по машинам.
              Приложенные прошлым закрытием остаются на заявке и показываются здесь же — чтобы
              не нести те же сканы второй раз. */}
          <div>
            <Typography.Text strong>Талоны</Typography.Text>
            {request.tickets.length > 0 && (
              <div style={{ marginTop: 4 }}>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  Уже приложены
                </Typography.Text>
                <FileLinkList files={request.tickets} maxNameWidth={300} />
              </div>
            )}
            <Space size={8} wrap style={{ marginTop: 8 }}>
              <Upload
                multiple
                showUploadList={false}
                beforeUpload={(file) => {
                  if (request.tickets.length + tickets.length >= MAX_TICKETS_PER_REQUEST) {
                    message.warning(`Не более ${MAX_TICKETS_PER_REQUEST} талонов`);
                    return Upload.LIST_IGNORE;
                  }
                  if (file.size > FILE_MAX_SIZE) {
                    message.warning('Файл больше 50 МБ');
                    return Upload.LIST_IGNORE;
                  }
                  void uploadTicket(file);
                  return false;
                }}
              >
                <Button icon={<UploadOutlined />} loading={uploading} danger={noTicketYet}>
                  Прикрепить талон
                </Button>
              </Upload>
              {noTicketYet && (
                <Typography.Text type="secondary" style={{ lineHeight: '32px' }}>
                  Талон обязателен: без него заявка не закрывается
                </Typography.Text>
              )}
            </Space>
            {tickets.length > 0 && (
              <div style={{ marginTop: 8 }}>
                <FileLinkList files={tickets} maxNameWidth={300} onRemove={removeTicket} />
              </div>
            )}
          </div>

          {/* Комментарий к выполнению — событие истории заявки, а не поле самой заявки: он
              описывает конкретное закрытие (что вывезли не полностью, кто принимал). */}
          <Form layout="vertical" component="div">
            <Form.Item label="Комментарий" style={{ marginBottom: 0 }}>
              <Input.TextArea
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                rows={2}
                maxLength={2000}
                showCount
                placeholder="Необязательно: что важно знать об этом выполнении"
              />
            </Form.Item>
          </Form>
        </div>
      )}
    </FormModal>
  );
}
