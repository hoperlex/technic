import { useEffect } from 'react';
import { Alert, App, Checkbox, Form, Input, Skeleton, Space, Typography } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  assignmentDimensionLabels,
  type CancelledAssignmentGroupDto,
  type PeriodPreviewDto,
  type SpecialEquipmentRequestDto,
} from '@technic/contracts';
import { FormModal } from '@shared/ui';
import { isApiError } from '@shared/api';
import { garageKeys } from '@entities/garage';
import { vehicleRequestsApi, type VehicleRequestPeriodResultDto } from '../../api/resources';
import { calendarDaysLabel } from '../../utils/date';
import { errorMessage } from '../../utils/format';
import { formatDateOnly } from './shared';

/**
 * Правка срока заказа спецтехники через свою дверь (`docs/assignment-periods-plan.md`, волна 4a;
 * Ж4, З5, Д2, Л1): предпросмотр → показ последствий → подтверждение.
 *
 * ЗАЧЕМ ОКНО. Срок правился широким `PATCH /vehicle-requests/:id` вместе со всем остальным телом,
 * и человек нажимал «Сохранить», не зная цены: продление выписывает бланки строгой отчётности, а
 * сокращение **гасит решения о технике** за новым концом срока. Второе особенно неочевидно:
 * оставленная там запись ожила бы при следующем продлении — сама, без разговора о ставках и
 * занятости, — поэтому сервер её гасит и требует подтверждения перечня (Д2). Без окна это
 * подтверждение неоткуда взять, и правка упиралась бы в 422.
 *
 * ЧТО ОКНО СЧИТАЕТ САМО. Ничего. Все последствия приходят предпросмотром — тем же расчётом,
 * которым потом отработает боевая ручка: вторая, портальная редакция правил разошлась бы с
 * серверной на первом же уточнении, и окно начало бы обещать не то. Отсюда же и правило «нужна ли
 * причина»: его задаёт `operationRequirement`, а не календарь (Р32) — сокращение с гашением
 * требует объяснения и на завтрашних датах.
 *
 * ЧТО УЕЗЖАЕТ ПОДТВЕРЖДЕНИЯМИ. Отпечаток последствий (их видел человек), перечень гасимых решений
 * (их он подтвердил галочкой) и отпечаток отработанных листов, которые операция переоформит.
 * Отпечатки портал не разбирает — он их только носит обратно.
 */

/** Семантическая половина команды: пропущенное поле — «не трогали», `null` у `dateTo` — «сняли». */
export interface VehiclePeriodCommand {
  dateFrom?: string;
  dateTo?: string | null;
}

interface Props {
  /** `null` — окно закрыто. Только заказ спецтехники: у грузоперевозки срока работ нет. */
  request: SpecialEquipmentRequestDto | null;
  /** Каким срок станет. `null` — окно закрыто. */
  command: VehiclePeriodCommand | null;
  /**
   * Причина, уже набранная в форме правки (задним числом, ADR 0101): переспрашивать её незачем —
   * человек объясняет одну правку, а не каждую ручку, через которую она проходит.
   */
  reason?: string;
  /**
   * Ключ операции — один на открытое окно правки, а не на нажатие (Р9): связь оборвалась, ответа
   * нет, человек жмёт ещё раз — и сервер по тому же ключу возвращает прежний результат вместо
   * второго сгоревшего номера.
   */
  operationId: string;
  onCancel: () => void;
  /** Срок изменён. Дальше вызывающий досохраняет остальное — у той правки своя дверь. */
  onApplied: (result: VehicleRequestPeriodResultDto) => void;
}

interface FormValues {
  /** Подтверждение перечня гасимых решений о технике (Д2). */
  cancelAck?: boolean;
  reason?: string;
}

export function VehiclePeriodModal({
  request,
  command,
  reason: initialReason,
  operationId,
  onCancel,
  onApplied,
}: Props) {
  const [form] = Form.useForm<FormValues>();
  const { message } = App.useApp();
  const qc = useQueryClient();
  const open = !!request && !!command;

  /**
   * Последствия — запросом на каждое открытие, без кэша: между вчерашним просмотром и сегодняшним
   * нажатием план меняется, не тронув заявку (чужая команда заняла дату, лист аннулировали своей
   * ручкой, наступила полночь), а отпечаток такой предпросмотр уже не подтвердит.
   */
  const preview = useQuery({
    queryKey: ['vehicle-requests', request?.id, 'period-preview', command],
    queryFn: () =>
      vehicleRequestsApi.periodPreview(request!.id, { version: request!.version, ...command! }),
    enabled: open,
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });

  // Окно переиспользуется под разные заявки и под разные сроки: поля сбрасываются при смене цели,
  // иначе галочка, поставленная под прошлый перечень, подтверждала бы новый.
  const targetKey = `${request?.id ?? ''}|${command?.dateFrom ?? ''}|${String(command?.dateTo)}`;
  useEffect(() => {
    if (!open) return;
    form.setFieldsValue({ cancelAck: false, reason: initialReason ?? '' });
  }, [targetKey, open]);

  const applyMut = useMutation({
    mutationFn: (v: FormValues) => {
      const dto = preview.data!;
      return vehicleRequestsApi.changePeriod(request!.id, {
        version: request!.version,
        ...command!,
        previewFingerprint: dto.fingerprint,
        // Присутствие каждого подтверждения задаёт **ответ сервера**, а не желание клиента: лишний
        // отпечаток отвергается так же строго, как недостающий, — он означает, что тело посчитано
        // по другому состоянию.
        ...(dto.cancelGroupsFingerprint
          ? { cancelGroupsFingerprint: dto.cancelGroupsFingerprint }
          : {}),
        ...(dto.unlockFingerprint !== null ? { unlockFingerprint: dto.unlockFingerprint } : {}),
        ...(dto.operationRequirement
          ? { operation: { operationId, reason: (v.reason ?? '').trim() } }
          : {}),
      });
    },
    onSuccess: (res) => {
      message.success(res.repeated ? 'Срок уже был изменён этой же командой' : 'Срок изменён');
      void qc.invalidateQueries({ queryKey: ['vehicle-requests'] });
      // Срок переписывает бумагу: недели за прежним концом гаснут, новые выписываются.
      void qc.invalidateQueries({ queryKey: ['waybills'] });
      void qc.invalidateQueries({ queryKey: garageKeys.root });
      onApplied(res);
    },
    onError: (e) => {
      message.error(errorMessage(e));
      /*
       * Последствия изменились между просмотром и нажатием — сервер отвечает 409, и правильный
       * ответ портала не «повторите», а «посмотрите заново»: перечень гасимых решений мог стать
       * другим, и подтверждать прежний человек больше не вправе.
       */
      if (isApiError(e) && e.code === 'assignment_preview_stale') void preview.refetch();
    },
  });

  const dto = preview.data ?? null;
  const submit = (v: FormValues) => {
    if (!dto) return;
    applyMut.mutate(v);
  };

  const before = request ? { from: request.dateFrom, to: request.dateTo } : null;
  const after =
    request && command
      ? {
          from: command.dateFrom ?? request.dateFrom,
          to: command.dateTo !== undefined ? command.dateTo : request.dateTo,
        }
      : null;

  return (
    <FormModal
      title={request ? `Срок работ: заявка ${request.displayNumber}` : 'Срок работ'}
      open={open}
      onCancel={onCancel}
      onSubmit={() => form.submit()}
      confirmLoading={applyMut.isPending}
      // Кнопка называет действие, а не «Сохранить»: за ней сгорают и выписываются бланки строгой
      // отчётности, а у сокращения ещё и гаснут решения о технике.
      okText="Изменить срок"
      // Последствий нет — подтверждать нечего: пока предпросмотр не ответил, нажимать не на что.
      okDisabled={!dto}
      width={720}
    >
      <Form form={form} layout="vertical" onFinish={submit}>
        <Space direction="vertical" size={12} style={{ display: 'flex' }}>
          {before && after && <PeriodChange before={before} after={after} />}

          {preview.isPending && <Skeleton active paragraph={{ rows: 4 }} />}
          {preview.isError && (
            <Alert
              type="error"
              showIcon
              message="Последствия посчитать не удалось"
              description={errorMessage(preview.error)}
            />
          )}

          {dto && <PeriodConsequences preview={dto} />}

          {dto && dto.cancelGroups.length > 0 && (
            <Form.Item
              name="cancelAck"
              valuePropName="checked"
              style={{ marginBottom: 0 }}
              rules={[
                {
                  validator: (_r, value: boolean | undefined) =>
                    value
                      ? Promise.resolve()
                      : Promise.reject(
                          new Error('Подтвердите, что перечисленные записи о технике погаснут'),
                        ),
                },
              ]}
            >
              <Checkbox>Согласен: перечисленные записи о технике погаснут</Checkbox>
            </Form.Item>
          )}

          {dto?.operationRequirement && (
            <Form.Item
              name="reason"
              label="Причина правки"
              style={{ marginBottom: 0 }}
              extra={
                dto.operationRequirement.kind === 'crew'
                  ? 'Правка задевает уже отработанные дни: она пойдёт записью в журнал коррекций, и без объяснения её там быть не может.'
                  : 'Правка гасит решения о технике: она пойдёт записью в журнал коррекций, и без объяснения её там быть не может.'
              }
              rules={[{ required: true, message: 'Укажите причину' }]}
            >
              <Input.TextArea
                rows={2}
                maxLength={2000}
                showCount
                placeholder="Например: объект попросил продлить работы до конца месяца"
              />
            </Form.Item>
          )}
        </Space>
      </Form>
    </FormModal>
  );
}

/** Срок «было → станет»: правят именно его, и видеть обе половины нужно рядом. */
function PeriodChange({
  before,
  after,
}: {
  before: { from: string; to: string | null };
  after: { from: string; to: string | null };
}) {
  const line = (term: { from: string; to: string | null }) =>
    `${formatDateOnly(term.from)} – ${term.to ? formatDateOnly(term.to) : 'без даты окончания'}`;
  return (
    <div style={{ lineHeight: 1.6 }}>
      <div>
        <Typography.Text type="secondary">Было: {line(before)}</Typography.Text>
      </div>
      <div>
        <Typography.Text strong>Станет: {line(after)}</Typography.Text>{' '}
        <Typography.Text type="secondary">
          {calendarDaysLabel(after.from, after.to)}
        </Typography.Text>
      </div>
    </div>
  );
}

/** Всё, что посчитал сервер: бумага, гасимые решения о технике и отработанные листы под правку. */
function PeriodConsequences({ preview }: { preview: PeriodPreviewDto }) {
  const { cancel, issue } = preview.plan;
  return (
    <Space direction="vertical" size={12} style={{ display: 'flex' }}>
      <div>
        <Typography.Text strong>Путевые листы</Typography.Text>
        {cancel.length === 0 && issue.length === 0 ? (
          <div>
            <Typography.Text type="secondary">
              Останутся как есть: выписывать и аннулировать нечего.
            </Typography.Text>
          </div>
        ) : (
          <ul style={{ margin: '4px 0 0', paddingInlineStart: 20 }}>
            {cancel.map((w) => (
              <li key={w.waybillId}>
                Сгорит {w.displayNumber} ({formatDateOnly(w.from)} — {formatDateOnly(w.to)})
              </li>
            ))}
            {issue.map((sheet) => (
              <li key={sheet.issueKey}>
                Выпишется лист за {formatDateOnly(sheet.from)} — {formatDateOnly(sheet.to)}:{' '}
                {sheet.vehicleName}, {sheet.driverName}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Гашение — то, ради чего у правки срока вообще появилось рукопожатие (Д2). Текст говорит
        человеческим языком: что погаснет и почему это нельзя оставить как есть. */}
      {preview.cancelGroups.length > 0 && (
        <Alert
          type="warning"
          showIcon
          message="При сокращении срока погаснут записи о технике"
          description={
            <>
              <div>
                За новым концом срока остаются решения о том, какая техника и какой машинист
                работают по заявке. Оставить их нельзя: при следующем продлении они ожили бы сами —
                без разговора о ставках и занятости.
              </div>
              <ul style={{ margin: '8px 0 0', paddingInlineStart: 20 }}>
                {preview.cancelGroups.map((group) => (
                  <li key={group.changeGroupId}>{cancelGroupLine(group)}</li>
                ))}
              </ul>
            </>
          }
        />
      )}

      {/* Отработанные листы: правка их переоформит, то есть сожжёт номера строгой отчётности. */}
      {preview.requiredUnlocks.length > 0 && (
        <div>
          <Typography.Text strong>
            Отработанные листы, которые придётся переоформить
          </Typography.Text>
          <ul style={{ margin: '4px 0 0', paddingInlineStart: 20 }}>
            {preview.requiredUnlocks.map((w) => (
              <li key={w.waybillId}>
                {w.displayNumber} ({formatDateOnly(w.from)} — {formatDateOnly(w.to)})
              </li>
            ))}
          </ul>
        </div>
      )}
    </Space>
  );
}

/**
 * Одна гасимая группа человеческой строкой: с какого числа и что именно уходит.
 *
 * Гашение групповое (В2) — вместе с машиной уходит и назначенный на неё машинист, — поэтому
 * состав перечисляется целиком. Имени машиниста в перечне нет и взяться ему неоткуда: строка
 * шкалы `driver` носит состояние, а не человека, — поэтому окно называет состояние, а не выдумывает
 * фамилию.
 */
function cancelGroupLine(group: CancelledAssignmentGroupDto): string {
  const parts = group.rows.map((row) => {
    if (row.dimension === 'vehicle') {
      return `${assignmentDimensionLabels.vehicle}: ${row.vehicle?.name ?? 'не названа'}`;
    }
    const state = row.driver?.state;
    const text =
      state === 'set'
        ? 'назначенный этим же решением'
        : state === 'cleared'
          ? 'снят — участок вёл арендодатель'
          : 'не восстановлен по бумаге';
    return `${assignmentDimensionLabels.driver}: ${text}`;
  });
  const since = group.rows[0]?.effectiveDate;
  return `с ${since ? formatDateOnly(since) : '—'} — ${parts.join('; ')}`;
}
