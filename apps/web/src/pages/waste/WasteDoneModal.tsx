import { App, Button, Form, Input, InputNumber, Space, Typography, Upload } from 'antd';
import { CameraOutlined, UploadOutlined } from '@ant-design/icons';
import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  calcWasteFactCost,
  type CompleteWasteRequestInput,
  type FileDto,
  MAX_TICKETS_PER_REQUEST,
  requiresWasteFact,
  WASTE_REMOVAL_CONTAINER_KIND,
  type WasteRequestDto,
} from '@technic/contracts';
import { FILE_MAX_SIZE } from '@shared/config';
import { filesApi, wasteTariffsApi } from '../../api/resources';
import { FileLinkList } from '../../components/FileLinks';
import { FormGrid } from '../../components/FormGrid';
import { FormModal } from '../../components/FormModal';
import { useIsMobile } from '../../hooks/useIsMobile';
import { errorMessage, formatMoney } from '../../utils/format';

/**
 * Закрытие заявки: факт предъявляется вместе со сменой статуса, а не после неё.
 *  - вывоз мусора — сколько вывезли и во сколько это обошлось (ADR 0035). Объём вводят руками:
 *    он стоит в талоне и весовой квитанции. Состав техники не спрашивается — вывоз тарифицируется
 *    самосвалами (ADR 0022), и какими машинами увезли объём, к расчёту отношения не имеет;
 *  - контейнерные операции — только талон: ходка одна, и объёма у такой заявки нет (ADR 0013).
 *
 * Стоимость подставляется расчётом «объём × цена по прайсу» и правится свободно: счёт оператора
 * включает и подачу, и недогруз, и сходиться сумма должна со счётом, а не с формулой. Ручная
 * правка видна подсказкой — расхождение с расчётом должно быть замечено, а не проскочить молча.
 * Цены в прайсе нет — это не запрет: заявка выполнена, и сумму просто вводят руками.
 *
 * Талон обязателен в обоих случаях (ADR 0020) и с ADR 0024 крепится к самой заявке общим пулом:
 * оператор отдаёт бумаги пачкой за всё закрытие. Комментарий уходит в историю заявки.
 */
interface Props {
  /** null — окно закрыто; заявка берётся из строки списка. */
  request: WasteRequestDto | null;
  confirmLoading: boolean;
  onCancel: () => void;
  onSubmit: (v: {
    comment: string;
    /** Факт вывоза; null — заявка контейнерная, объёма у неё нет. */
    completion: CompleteWasteRequestInput | null;
    ticketFileIds: string[];
  }) => void;
}

interface FormValues {
  volumeM3?: number | null;
  totalCost?: number | null;
  comment?: string;
}

export function WasteDoneModal({ request, confirmLoading, onCancel, onSubmit }: Props) {
  const { message } = App.useApp();
  const isMobile = useIsMobile();
  const [form] = Form.useForm<FormValues>();
  const [tickets, setTickets] = useState<FileDto[]>([]);
  const [uploading, setUploading] = useState(false);
  /** Сумму правили руками — расчёт её больше не переписывает. */
  const [costTouched, setCostTouched] = useState(false);

  const byFact = request ? requiresWasteFact(request.requestType) : false;

  /**
   * Цена-основание: снимок самой заявки — по нему её оформляли, и правка прайса оформленную
   * заявку не переписывает (ADR 0009). Снимка нет (заявки старше тарификации) — спрашиваем прайс
   * по виду «Самосвал» той же ручкой, что считает цену сервер: правило подбора должно быть одно
   * на обе стороны (ADR 0022, ADR 0026). Тем же порядком цену выбирает и сервер при закрытии.
   */
  const wasteTypeId = request?.wasteTypeId ?? null;
  const operatorId = request?.operatorCounterpartyId ?? null;
  const needTariff = byFact && request?.pricePerM3 == null && !!wasteTypeId;
  const { data: tariffResult } = useQuery({
    queryKey: ['waste-tariffs', 'resolve', wasteTypeId, operatorId],
    queryFn: () =>
      wasteTariffsApi.resolve(
        wasteTypeId!,
        { containerKind: WASTE_REMOVAL_CONTAINER_KIND },
        operatorId,
      ),
    enabled: needTariff,
    staleTime: 60_000,
  });
  const pricePerM3 = request?.pricePerM3 ?? tariffResult?.tariff?.pricePerM3 ?? null;
  /** Цена «от»: оператор не назначен, и подбор взял минимальную среди операторов (ADR 0026). */
  const priceIsMinimum = request?.pricePerM3 == null && !!tariffResult?.tariff?.isMinimum;

  // Окно переиспользуется под разные заявки, поэтому поля сбрасываются при смене цели, а не при
  // размонтировании. Повторное закрытие (после отката администратором) открывается на прежнем
  // факте: обычно правят одну цифру, а не набирают всё заново. У первого закрытия объём
  // подставляется заявленным — его подтверждают или правят по талону.
  const targetId = request?.id ?? null;
  useEffect(() => {
    if (!request) return;
    const previous = request.completion;
    const volumeM3 = previous?.volumeM3 ?? request.volumeM3 ?? null;
    setTickets([]);
    setCostTouched(!!previous);
    form.setFieldsValue({
      volumeM3,
      totalCost:
        previous?.totalCost ??
        (volumeM3 != null ? calcWasteFactCost(volumeM3, request.pricePerM3) : null),
      comment: '',
    });
    // Зависимость — идентификатор заявки, а не сама заявка: перерисовка той же заявки (invalidate
    // списка после соседнего действия) приходит новым объектом и стёрла бы уже набранное.
  }, [targetId]);

  const volumeM3 = Form.useWatch('volumeM3', form);
  const totalCost = Form.useWatch('totalCost', form);

  // У заявок без снимка цены она приезжает отдельным запросом (прайс по виду «Самосвал»). Пока
  // сумму не правили руками, расчёт подставляется, как только цена известна: иначе поле осталось
  // бы пустым при заполненном прайсе.
  useEffect(() => {
    if (costTouched || pricePerM3 == null) return;
    const current = form.getFieldValue('volumeM3') as number | null | undefined;
    if (current == null || current <= 0) return;
    form.setFieldsValue({ totalCost: calcWasteFactCost(current, pricePerM3) });
  }, [pricePerM3, costTouched]);

  /** Расчёт по прайсу — им подставляется сумма и с ним же сравнивается введённая вручную. */
  const calculated =
    volumeM3 != null && volumeM3 > 0 ? calcWasteFactCost(volumeM3, pricePerM3) : null;
  const costDiffers = costTouched && calculated != null && (totalCost ?? null) !== calculated;

  /** Пока сумму не правили руками, она следует за объёмом: её показывают, а не набирают. */
  const changeVolume = (value: number | null) => {
    if (costTouched) return;
    form.setFieldsValue({ totalCost: value == null ? null : calcWasteFactCost(value, pricePerM3) });
  };

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

  /** Проверки талона общие для обоих способов приложить его — из файлов и снимком камеры. */
  const beforeUploadTicket = (file: File) => {
    if (!request) return Upload.LIST_IGNORE;
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
  };

  const cancel = () => {
    discardUploads();
    onCancel();
  };

  const submit = (v: FormValues) => {
    if (!request) return;
    if (byFact && (v.volumeM3 == null || v.volumeM3 <= 0)) {
      message.warning('Укажите фактически вывезенный объём');
      return;
    }
    // Талон обязателен у заявки любого типа; приложенные прошлым закрытием засчитываются.
    if (request.tickets.length + tickets.length === 0) {
      message.warning('Приложите талон — без него заявка не закрывается');
      return;
    }
    onSubmit({
      comment: (v.comment ?? '').trim(),
      completion: byFact ? { volumeM3: v.volumeM3!, totalCost: v.totalCost ?? null } : null,
      ticketFileIds: tickets.map((f) => f.id),
    });
  };

  const noTicketYet = !!request && request.tickets.length + tickets.length === 0;
  /** Расхождение с заявкой — подсказка, а не запрет: заявка это план, платят за вывезенное. */
  const volumeDiff =
    request?.volumeM3 != null && volumeM3 != null && volumeM3 > 0
      ? Math.round((volumeM3 - request.volumeM3) * 1000) / 1000
      : null;

  return (
    <FormModal
      title="Выполнение заявки"
      open={!!request}
      onCancel={cancel}
      onSubmit={() => form.submit()}
      confirmLoading={confirmLoading}
      okText="Выполнена"
      width={880}
    >
      {request && (
        // Факт слева, талоны справа: их прикладывают, глядя на введённый объём. На телефоне
        // колонка одна, порядок тот же.
        <Form form={form} layout="vertical" onFinish={submit}>
          <FormGrid>
          <FormGrid.Full>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
            Заявка № {request.displayNumber}, {request.objectName}
            {request.volumeM3 != null ? ` · заявлено ${request.volumeM3} м³` : ''}
            {request.amount != null ? ` на ${formatMoney(request.amount)}` : ''}
          </Typography.Paragraph>
          </FormGrid.Full>

          {byFact && (
            <>
              {/* Объём и стоимость — соседними ячейками: их сверяют друг с другом. */}
              <Form.Item
                  name="volumeM3"
                  label="Вывезено, м³"
                  rules={[
                    { required: true, message: 'Укажите объём' },
                    {
                      // Объём взвешивают, поэтому дробный он обычен, но не бесконечно: столько же
                      // знаков хранит БД, и лишние сервер отвергнет уже после отправки формы.
                      validator: (_rule, v: number | undefined) =>
                        v == null || Math.abs(v * 1000 - Math.round(v * 1000)) < 1e-6
                          ? Promise.resolve()
                          : Promise.reject(new Error('Не более 3 знаков после запятой')),
                    },
                  ]}
                  extra={
                    volumeDiff != null && volumeDiff !== 0
                      ? `Заявлено ${request.volumeM3} м³ (${volumeDiff > 0 ? '+' : ''}${volumeDiff} м³)`
                      : undefined
                  }
                >
                  <InputNumber
                    style={{ width: '100%' }}
                    min={0}
                    step={1}
                    placeholder="По талону"
                    onChange={changeVolume}
                  />
                </Form.Item>
                <Form.Item
                  name="totalCost"
                  label="Стоимость, ₽"
                  extra={
                    pricePerM3 != null
                      ? `${priceIsMinimum ? 'от ' : ''}${formatMoney(pricePerM3)}/м³ по прайсу`
                      : 'Цены на этот тип мусора в прайсе нет — укажите сумму'
                  }
                >
                  <InputNumber
                    style={{ width: '100%' }}
                    min={0}
                    step={1000}
                    precision={2}
                    onChange={() => setCostTouched(true)}
                  />
                </Form.Item>

              <FormGrid.Full>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginBottom: 16 }}>
                {costDiffers && (
                  <Typography.Text type="warning">
                    Сумма отличается от расчёта ({formatMoney(calculated)}) — в заявке сохранится
                    введённая
                  </Typography.Text>
                )}
                {/* Заявку оформляли планом, платят за вывезенное: расхождение сумм — не ошибка,
                    но человек должен увидеть его до нажатия «Выполнена». */}
                {totalCost != null && request.amount != null && totalCost !== request.amount && (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    Заявка оформлена на {formatMoney(request.amount)} — закрытие сохранит{' '}
                    {formatMoney(totalCost)}
                  </Typography.Text>
                )}
                {priceIsMinimum && (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    Оператор не назначен — расчёт по минимальной цене среди операторов
                  </Typography.Text>
                )}
              </div>
              </FormGrid.Full>
            </>
          )}

          {/* Талоны — общий пул заявки (ADR 0024): бумаги за всё закрытие, без деления по машинам.
              Приложенные прошлым закрытием остаются на заявке и показываются здесь же — чтобы
              не нести те же сканы второй раз. */}
          <FormGrid.Full>
          <Form.Item label="Талоны" style={{ marginBottom: 16 }}>
            {request.tickets.length > 0 && (
              <div style={{ marginBottom: 8 }}>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  Уже приложены
                </Typography.Text>
                <FileLinkList files={request.tickets} maxNameWidth={300} />
              </div>
            )}
            <Space size={8} wrap>
              {/* Снимок камерой — только на телефоне (ADR 0030): талон подписывают на площадке,
                  и фотографируют его там же. `capture` — подсказка браузеру, а не гарантия, что
                  откроется именно камера, поэтому обычная загрузка остаётся рядом. Ограничение
                  по типу стоит только на этой кнопке: у соседней его нет и не было. */}
              {isMobile && (
                <Upload
                  showUploadList={false}
                  accept="image/*"
                  capture="environment"
                  beforeUpload={beforeUploadTicket}
                >
                  <Button icon={<CameraOutlined />} loading={uploading} danger={noTicketYet}>
                    Снять камерой
                  </Button>
                </Upload>
              )}
              <Upload multiple showUploadList={false} beforeUpload={beforeUploadTicket}>
                <Button
                  icon={<UploadOutlined />}
                  loading={uploading}
                  danger={noTicketYet && !isMobile}
                >
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
          </Form.Item>

          {/* Комментарий к выполнению — событие истории заявки, а не поле самой заявки: он
              описывает конкретное закрытие (что вывезли не полностью, кто принимал). */}
          <Form.Item name="comment" label="Комментарий" style={{ marginBottom: 0 }}>
            <Input.TextArea
              rows={2}
              maxLength={2000}
              showCount
              placeholder="Необязательно: что важно знать об этом выполнении"
            />
          </Form.Item>
          </FormGrid.Full>
          </FormGrid>
        </Form>
      )}
    </FormModal>
  );
}
