import { useEffect, useState } from 'react';
import { Alert, Checkbox, Form, Input, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import {
  WAYBILL_CORRECTION_CONFIRM,
  type WeeklyCorrectionBody,
  type WeeklyVehicleRequestDto,
} from '@technic/contracts';
import { weeklyRequestKeys, weeklyRequestsApi } from '@entities/weekly-request';
import { FormModal } from '@shared/ui';
import { formatDateOnly } from '@shared/lib';

/**
 * Conducting an overdue week changes already-worked periods and may invalidate strict-reporting
 * numbers. The server computes the exact consequences with the same code that executes them; a
 * second client calculation would drift. Composition stays in the workspace so this dialog has
 * one responsibility: disclose and confirm the historical cost (ADR 0101).
 */

interface FormValues {
  reason: string;
  unlockWaybillIds: string[];
}

interface Props {
  /** Request being conducted; `null` closes the dialog. */
  request: WeeklyVehicleRequestDto | null;
  onClose: () => void;
  /** Send the complete correction block through the workspace's shared approval command. */
  onConduct: (correction: WeeklyCorrectionBody) => void;
  pending: boolean;
}

export function WeeklyRequestConductModal({ request, onClose, onConduct, pending }: Props) {
  const [form] = Form.useForm<FormValues>();

  /** Keep one idempotency key while this request stays open so a retry cannot apply twice. */
  const [operationId, setOperationId] = useState(() => crypto.randomUUID());
  useEffect(() => {
    if (!request) return;
    setOperationId(crypto.randomUUID());
    form.setFieldsValue({ reason: '', unlockWaybillIds: [] });
    // Depending on the whole request would reset the key and typed reason after a cache refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request?.id, form]);

  /** Ask the server for both consequences and blockers. */
  const { data: preview, isFetching } = useQuery({
    // The entity key keeps preview invalidation under the weekly-request root.
    queryKey: weeklyRequestKeys.correction(request?.id),
    queryFn: () => weeklyRequestsApi.correctionPreview(request!.id),
    enabled: !!request,
  });

  /** Permission, correction depth or document state may block conduct entirely. */
  const blocked = !!preview && !preview.allowed;

  const submit = (v: FormValues) => {
    // Do not submit a command whose preview already names the same refusal.
    if (blocked) return;
    onConduct({ operationId, reason: v.reason.trim(), unlockWaybillIds: v.unlockWaybillIds ?? [] });
  };

  return (
    <FormModal
      title={
        request
          ? `${request.displayNumber} · провести неделю задним числом`
          : 'Проведение недели задним числом'
      }
      open={!!request}
      onCancel={onClose}
      onSubmit={() => form.submit()}
      confirmLoading={pending}
      okText="Провести и завизировать"
      okDanger
      width={720}
    >
      <Form<FormValues> form={form} layout="vertical" onFinish={submit}>
        {/* Keep the disabled operation visible and explain which external condition blocks it. */}
        {blocked && (
          <Alert
            type="error"
            showIcon
            style={{ marginBottom: 16 }}
            title="Эту неделю сейчас не провести"
            description={preview!.blockedReason}
          />
        )}

        {preview && (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 16 }}
            title={`Что произойдёт с неделей ${preview.weekLabel}`}
            description={
              <ul style={{ margin: 0, paddingInlineStart: 20 }}>
                <li>
                  Сроки заказов продлятся за уже прошедшие дни — до{' '}
                  {formatDateOnly(preview.weekEnd)} включительно.
                </li>
                {/* A started week is overdue for planning but not necessarily backdated relative
                    to its Sunday effective date. */}
                <li>
                  {preview.backdated
                    ? `Операция идёт задним числом: её эффективная дата — воскресенье недели, ${formatDateOnly(preview.effectiveDate)}, и оно уже прошло.`
                    : `Неделя началась, но не кончилась: её воскресенье ${formatDateOnly(preview.effectiveDate)} ещё впереди, и правкой прошедшего дня операция не считается — но согласуются по ней уже отработанные дни.`}
                </li>
                <li>
                  Причина и ключ операции останутся в журнале коррекций вместе с вашим именем: через
                  месяцы по ним объяснят, почему неделю согласовали после неё, а не до.
                </li>
                {preview.pastWeeks.length > 0 && (
                  <li>
                    За прошедшие недели выпишется бумага, которой у заказов нет:{' '}
                    {preview.pastWeeks
                      .map(
                        (w) =>
                          `${w.displayNumber} · ${formatDateOnly(w.from)} – ${formatDateOnly(w.to)}`,
                      )
                      .join('; ')}
                    .
                  </li>
                )}
                {preview.unlockable.length > 0 && <li>{WAYBILL_CORRECTION_CONFIRM}</li>}
                {/* The cost comes last and plainly. Conducting can now be undone (annulment,
                    ADR 0218), yet a written-off form number never returns to the series, and a day
                    whose work is already signed stays beyond the annulment's reach. */}
                <li>
                  Развернуть проведение можно аннулированием недели, но списанный номер бланка не
                  возвращается, а дни с подписанной работой придётся разобрать поштучно.
                </li>
              </ul>
            }
          />
        )}

        {/* Select sheets by id: linear equipment may have two vehicles in one week, so a blanket
            “all past sheets” switch could invalidate the wrong number. */}
        <Form.Item
          name="unlockWaybillIds"
          label="Листы ЭСМ-2 к перевыписке"
          extra={
            (preview?.unlockable.length ?? 0) > 0
              ? 'Отмеченные номера будут аннулированы, взамен выпишутся новые — следующими по серии. Неотмеченная неделя останется с прежним листом и прежним сроком'
              : 'Действующих листов за отработанные недели у состава нет: переписывать нечего'
          }
        >
          <Checkbox.Group
            style={{ display: 'flex', flexDirection: 'column', gap: 4 }}
            options={(preview?.unlockable ?? []).map((w) => ({
              value: w.waybillId,
              label: `${w.displayNumber} · № ${w.number} · ${formatDateOnly(w.periodFrom)} – ${formatDateOnly(w.periodTo)}`,
            }))}
          />
        </Form.Item>

        {/* The durable reason is stored with the correction and every sheet it creates. */}
        <Form.Item
          name="reason"
          label="Причина проведения задним числом"
          rules={[{ required: true, message: 'Укажите причину' }]}
          extra="Останется в журнале коррекций и в листах, выписанных этой операцией"
        >
          <Input.TextArea
            rows={2}
            maxLength={2000}
            showCount
            placeholder="Например: техника отработала неделю по устной договорённости, заявку оформили в понедельник"
          />
        </Form.Item>

        {/* State the account's correction depth before it turns into a server refusal. */}
        {preview?.correctionFloor && (
          <Typography.Text type="secondary">
            Ваша глубина коррекции — недели, кончившиеся не раньше{' '}
            {formatDateOnly(preview.correctionFloor)}; давность больше этой проводит администратор.
          </Typography.Text>
        )}
        {isFetching && !preview && (
          <Typography.Text type="secondary">Считаем последствия…</Typography.Text>
        )}
      </Form>
    </FormModal>
  );
}
