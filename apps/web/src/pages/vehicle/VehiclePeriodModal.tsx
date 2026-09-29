import { useEffect, useEffectEvent, useState } from 'react';
import { Alert, App, Checkbox, Form, Input, Skeleton, Space, Typography } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PeriodPreviewDto, SpecialEquipmentRequestDto } from '@technic/contracts';
import { FormModal } from '@shared/ui';
import { calendarDaysLabel, formatDateOnly } from '@shared/lib';
import { garageKeys } from '@entities/garage';
import { vehicleRequestKeys } from '@entities/vehicle-request';
import { waybillKeys, WarnedSheetsConfirm } from '@entities/waybill';
import { vehicleRequestsApi, type VehicleRequestPeriodResultDto } from '@entities/vehicle-request';
import { vehicleRequestErrorMessage as errorMessage } from '@entities/vehicle-request';
import { acknowledgementsOf, recheckReasonOf, warnedSheetsOf } from './assignmentWarnings';
import { cancelGroupLine } from './cancelGroups';

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
 *
 * Plus a signature per issued sheet with warnings (B4): in `history` read mode this door issues the
 * blanks itself and refuses an unsigned warned sheet with 409, so the window shows every warned
 * sheet and sends the signatures only after an explicit tick (`assignmentWarnings.ts`).
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
  /** Signature of the confirmed warning set (`WarnedSheetsConfirm`), not a plain boolean. */
  warningsAck?: string;
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
   * Why the window recomputed the consequences on its own. Set on a refusal that means "what you
   * read is no longer true" and shown above the new list instead of a toast: the toast disappears,
   * while the person has to know why the list in front of them changed.
   */
  const [recheck, setRecheck] = useState<string | null>(null);

  /**
   * Последствия — запросом на каждое открытие, без кэша: между вчерашним просмотром и сегодняшним
   * нажатием план меняется, не тронув заявку (чужая команда заняла дату, лист аннулировали своей
   * ручкой, наступила полночь), а отпечаток такой предпросмотр уже не подтвердит.
   */
  const preview = useQuery({
    queryKey: vehicleRequestKeys.periodPreview(request?.id ?? '', command),
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
  const resetForTarget = useEffectEvent((_key: string, _open: boolean) => {
    if (!open) return;
    setRecheck(null);
    form.setFieldsValue({ cancelAck: false, warningsAck: undefined, reason: initialReason ?? '' });
  });
  useEffect(() => resetForTarget(targetKey, open), [targetKey, open]);

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
        // Built from the same preview the person just confirmed; the form rule has already
        // checked that the tick belongs to exactly this set.
        ...acknowledgementsOf(warnedSheetsOf(dto)),
        ...(dto.operationRequirement
          ? { operation: { operationId, reason: (v.reason ?? '').trim() } }
          : {}),
      });
    },
    onSuccess: (res) => {
      message.success(res.repeated ? 'Срок уже был изменён этой же командой' : 'Срок изменён');
      void qc.invalidateQueries({ queryKey: vehicleRequestKeys.root });
      // Срок переписывает бумагу: недели за прежним концом гаснут, новые выписываются.
      void qc.invalidateQueries({ queryKey: waybillKeys.root });
      void qc.invalidateQueries({ queryKey: garageKeys.root });
      onApplied(res);
    },
    onError: (e) => {
      /*
       * The consequences or the warnings changed between reading and pressing. The right answer is
       * not "try again" but "read again": the list of cancelled decisions or of warned sheets may
       * be different now, and the person may not confirm the old one. The new preview replaces the
       * old in place, with the reason above it, and the tick under the cancelled decisions is taken
       * back (the warning tick needs no reset: it is bound to the set it was given for).
       */
      const reason = recheckReasonOf(e);
      if (!reason) {
        message.error(errorMessage(e));
        return;
      }
      setRecheck(reason);
      form.setFieldsValue({ cancelAck: false });
      void preview.refetch();
    },
  });

  const dto = preview.data ?? null;
  const warned = dto ? warnedSheetsOf(dto) : [];
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
      // Nothing to confirm until the preview answers — and nothing while it is being recomputed:
      // the list on screen is then the one the server has just called outdated.
      okDisabled={!dto || preview.isFetching}
      width={720}
    >
      <Form form={form} layout="vertical" onFinish={submit}>
        <Space orientation="vertical" size={12} style={{ display: 'flex' }}>
          {before && after && <PeriodChange before={before} after={after} />}

          {preview.isPending && <Skeleton active paragraph={{ rows: 4 }} />}
          {preview.isError && (
            <Alert
              type="error"
              showIcon
              title="Последствия посчитать не удалось"
              description={errorMessage(preview.error)}
            />
          )}

          {recheck && (
            <Alert type="warning" showIcon title="Последствия пересчитаны" description={recheck} />
          )}

          {dto && <PeriodConsequences preview={dto} />}

          <WarnedSheetsConfirm name="warningsAck" sheets={warned} />

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
    <Space orientation="vertical" size={12} style={{ display: 'flex' }}>
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
          title="При сокращении срока погаснут записи о технике"
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
