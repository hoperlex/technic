import { useEffect, useState } from 'react';
import { App, Button, DatePicker, Form, Input, Typography } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useMutation } from '@tanstack/react-query';
import {
  earlyEndDateBounds,
  earlyEndDaysSaved,
  type EarlyEndApprovalPreviewDto,
  type RequestVehicleEarlyEndInput,
  requestCustomerName,
  type SpecialEquipmentRequestDto,
} from '@technic/contracts';
import { FormGrid } from '@shared/ui';
import { FormModal, useFormBlockers } from '@shared/ui';
import { vehicleRequestsApi } from '../../api/resources';
import { calendarDaysLabel } from '../../utils/date';
import { errorMessage } from '../../utils/format';
import { EarlyEndConsequences } from './EarlyEndConsequences';
import { reassignStaleReason } from './ReassignPreview';
import { formatDateOnly } from './shared';

/**
 * Досрочное завершение заказа спецтехники (ADR 0044): техника освободилась раньше срока.
 *
 * Заявку заказывали периодом — «автокран на две недели», — а фронт работ закрылся раньше, и
 * машина простаивает на площадке за деньги. Окно просит одно: до какого числа техника нужна
 * на самом деле и почему срок сокращается. Решает не тот, кто просит: запрос уходит на визу
 * руководителя строительства — того же, кто визировал сам заказ.
 *
 * Границы даты приходят из контрактов (`earlyEndDateBounds`) — теми же их проверяет сервер: не
 * раньше сегодня (задним числом период не переписывается) и строго раньше нынешнего конца.
 *
 * ДВЕ ВЕТВИ И ОДНО ОКНО (Р19, Р26 плана `docs/vehicle-request-actual-end-date-plan.md`). Запрос
 * того, кто эту заявку и визирует, сервер применяет немедленно — значит у него есть последствия
 * **сегодня**, и он получает второй шаг: предпросмотр, отпечаток и подтверждение. Запрос, уходящий
 * на визу, не двигает ни срока, ни бумаги; показывать ему нечего, а обещание «что будет, когда
 * завизируют» к моменту визы устареет — его покажет предпросмотр решения, в своём окне.
 *
 * ЧТО ОТСЮДА УБРАНО. Окно считало обещание про бумагу само: резало срок по календарным неделям и
 * писало «аннулируются листы за такие-то недели, выписываются заново». Неправдой это стало дважды —
 * у линейного заказа недель не существует вовсе (листы просят по одной), а с ADR 0178 сокращение
 * лист не перевыписывает, а правит. Считать это порталу нечем: границы листа задаёт не срок, а срок
 * вместе с историей назначения. Теперь всё приходит от сервера тем же расчётом, который потом и
 * отработает.
 */
interface Props {
  /** null — окно закрыто. Только заказ спецтехники: у грузоперевозки срока работ нет. */
  request: SpecialEquipmentRequestDto | null;
  /** День среза по Москве: его считает сервер, часы браузера тут не годятся (ADR 0036). */
  onDate: string;
  /** Запрос применится сразу: окно открыл тот, кто эту заявку и визирует. */
  approvesOwn: boolean;
  confirmLoading: boolean;
  onCancel: () => void;
  /**
   * Запрос уходит телом вызывающего: мутация и её сообщения живут в общем хуке действий. Ответ
   * ждём — 409 «последствия изменились» лечится повторным показом, и узнать об отказе обязано
   * именно окно.
   */
  onSubmit: (v: RequestVehicleEarlyEndInput) => Promise<unknown> | undefined;
}

interface FormValues {
  newDateTo?: Dayjs;
  reason?: string;
}

/** Семантическая половина команды: ею считают предпросмотр, ею же потом сокращают срок (Л1). */
interface EarlyEndBody {
  newDateTo: string;
  reason: string;
  version: number;
}

export function VehicleEarlyEndModal({
  request,
  onDate,
  approvesOwn,
  confirmLoading,
  onCancel,
  onSubmit,
}: Props) {
  const [form] = Form.useForm<FormValues>();
  const blockers = useFormBlockers(form);
  const { message } = App.useApp();
  /**
   * Ключ операции — один на открытое окно, а не на нажатие (Р25): связь оборвалась, ответа нет,
   * человек жмёт ещё раз — и сервер по тому же ключу возвращает прежний результат вместо второго
   * сокращения с новыми сгоревшими номерами.
   */
  const [operationId, setOperationId] = useState(() => crypto.randomUUID());
  /** Показанные последствия и тело, которому их посчитали: подтверждение отправляет именно его. */
  const [shown, setShown] = useState<{
    preview: EarlyEndApprovalPreviewDto;
    body: EarlyEndBody;
  } | null>(null);
  const [staleReason, setStaleReason] = useState<string | null>(null);

  const bounds = request ? earlyEndDateBounds(request, onDate) : null;

  // Окно переиспользуется под разные заявки, поэтому поля сбрасываются при смене цели. Дата
  // по умолчанию — сегодня: чаще всего именно им и заканчивают, «машина уезжает сегодня».
  const targetId = request?.id ?? null;
  useEffect(() => {
    if (!request) return;
    form.setFieldsValue({ newDateTo: bounds ? dayjs(bounds.min) : undefined, reason: '' });
    setShown(null);
    setStaleReason(null);
    setOperationId(crypto.randomUUID());
    // Зависимость — идентификатор заявки: перерисовка той же заявки приходит новым объектом и
    // стёрла бы уже набранное.
  }, [targetId]);

  const newDateTo = Form.useWatch('newDateTo', form);
  const newDateKey = newDateTo?.format('YYYY-MM-DD');
  // Сколько дней освобождается — то, ради чего сокращение и делают: по ним считают и площадку,
  // и аренду. Считает контракт, чтобы подпись не разошлась с тем, что запишет сервер.
  const daysSaved =
    request?.dateTo && newDateKey ? earlyEndDaysSaved(request.dateTo, newDateKey) : null;

  const previewMut = useMutation({
    mutationFn: async (body: EarlyEndBody) => ({
      body,
      preview: await vehicleRequestsApi.earlyEndPreview(request!.id, body),
    }),
    onSuccess: (data) => setShown(data),
    onError: (e) => message.error(errorMessage(e)),
  });

  const send = async (body: EarlyEndBody, preview: EarlyEndApprovalPreviewDto | null) => {
    try {
      await onSubmit({
        ...body,
        // Подтверждения уезжают только у применяющей ветви: у ждущей визы подтверждать нечего, и
        // присланное подтверждение она отвергает 422. Присутствие каждого задаёт **ответ сервера**,
        // а не желание клиента.
        ...(preview
          ? {
              operationId,
              previewFingerprint: preview.fingerprint,
              ...(preview.cancelGroupsFingerprint
                ? { cancelGroupsFingerprint: preview.cancelGroupsFingerprint }
                : {}),
            }
          : {}),
      });
    } catch (e) {
      /*
       * Последствия изменились между просмотром и нажатием — сервер отвечает 409, и правильный
       * ответ окна не «повторите», а «посмотрите заново»: перечень мог стать другим, и подтверждать
       * прежний человек больше не вправе. Прочие отказы показывает тостом общий хук.
       */
      const stale = reassignStaleReason(e);
      if (!stale) return;
      setStaleReason(stale);
      previewMut.mutate(body);
    }
  };

  const submit = (v: FormValues) => {
    const dateKey = v.newDateTo?.format('YYYY-MM-DD');
    if (!dateKey || !bounds || dateKey < bounds.min || dateKey > bounds.max) {
      blockers.raise({ newDateTo: 'Выберите дату внутри срока заявки' });
      return;
    }
    const body: EarlyEndBody = {
      newDateTo: dateKey,
      reason: (v.reason ?? '').trim(),
      version: request!.version,
    };
    // Запрос, уходящий на визу, ничего не применяет: последствий у него нет, и сервер отвечает на
    // такой предпросмотр отказом по существу.
    if (!approvesOwn) {
      void send(body, null);
      return;
    }
    if (shown) {
      void send(shown.body, shown.preview);
      return;
    }
    previewMut.mutate(body);
  };

  const secondStep = !!shown;

  return (
    <FormModal
      title={
        request
          ? `${secondStep ? 'Последствия досрочного завершения' : 'Досрочное завершение'} ${request.displayNumber}`
          : 'Досрочное завершение заявки'
      }
      open={!!request}
      onCancel={onCancel}
      onSubmit={() => form.submit()}
      confirmLoading={confirmLoading || previewMut.isPending}
      // Кнопка называет то, что произойдёт: у визирующего следующим шагом будет разговор о
      // последствиях, у остальных запрос уйдёт на визу. Обещать «завершено» тому, чей запрос ещё
      // будут смотреть, нельзя.
      okText={
        approvesOwn
          ? secondStep
            ? 'Завершить досрочно'
            : 'Показать последствия'
          : 'Отправить на визу'
      }
      // «Назад» уводит от отправки — потому и стоит по другую сторону от основного действия.
      footerExtra={secondStep ? <Button onClick={() => setShown(null)}>Назад</Button> : undefined}
      width={720}
    >
      {request && (
        <Form form={form} layout="vertical" onFinish={submit} {...blockers.formProps}>
          {shown && <EarlyEndConsequences preview={shown.preview} staleReason={staleReason} />}

          {/* Форма на втором шаге не размонтируется, а прячется: «Назад» обязан вернуть окно
            заполненным — набранная причина стоит человеку отдельной работы. */}
          <div style={{ display: secondStep ? 'none' : undefined }}>
            <FormGrid.Full>
              <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
                {requestCustomerName(request)}
              </Typography.Paragraph>

              {/* Заказанный срок — основание решения: сокращают именно его, и видеть его нужно
                там же, где выбирают новую дату. */}
              <div style={{ marginBottom: 16, lineHeight: 1.5 }}>
                <Typography.Text strong>
                  {/* Дата окончания у сокращаемой заявки есть всегда: без неё срок однодневный,
                    а однодневную сокращать нечем (`earlyEndBlocker`). */}
                  Заказано: {formatDateOnly(request.dateFrom)} –{' '}
                  {formatDateOnly(request.dateTo ?? request.dateFrom)}
                </Typography.Text>
                <div>
                  <Typography.Text type="secondary">
                    {calendarDaysLabel(request.dateFrom, request.dateTo)}
                  </Typography.Text>
                </div>
              </div>
            </FormGrid.Full>

            <FormGrid>
              <Form.Item
                name="newDateTo"
                label="Последний день работ"
                rules={[{ required: true, message: 'Выберите дату' }]}
                extra={
                  daysSaved != null
                    ? `Освободится ${daysSaved} дн. из заказанных`
                    : 'Не раньше сегодняшнего дня и раньше нынешнего окончания'
                }
              >
                <DatePicker
                  style={{ width: '100%' }}
                  format="DD.MM.YYYY"
                  allowClear={false}
                  // Те же границы проверяет сервер: портал не должен предлагать дату, которую он
                  // отклонит, — ни вчерашнюю, ни нынешний конец срока.
                  disabledDate={(d) => {
                    if (!bounds) return true;
                    const key = d.format('YYYY-MM-DD');
                    return key < bounds.min || key > bounds.max;
                  }}
                />
              </Form.Item>

              <FormGrid.Full>
                {/* Причина обязательна: руководителю строительства решать нечего, если ему не
                  сказали, что произошло на объекте, — площадку он в этот момент не видит. Она же
                  становится причиной записи в журнале коррекций: второго поля под причину у этой
                  двери нет и быть не должно (Р19). */}
                <Form.Item
                  name="reason"
                  label="Причина"
                  rules={[{ required: true, message: 'Укажите причину' }]}
                >
                  <Input.TextArea
                    rows={2}
                    maxLength={2000}
                    showCount
                    placeholder="Например: работы на фундаменте закончены, техника больше не нужна"
                  />
                </Form.Item>

                <Typography.Text type="secondary">
                  {approvesOwn
                    ? 'Срок заявки изменится сразу — вы её и визируете. Перед этим портал покажет, что случится с путевыми листами и записями о технике.'
                    : 'Запрос уйдёт на визу руководителя строительства; до визы срок заявки прежний, и путевые листы не меняются.'}
                </Typography.Text>
              </FormGrid.Full>
            </FormGrid>
          </div>
        </Form>
      )}
    </FormModal>
  );
}
