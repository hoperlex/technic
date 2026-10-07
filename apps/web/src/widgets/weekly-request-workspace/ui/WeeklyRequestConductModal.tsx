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
 * Conducting an overdue week retroactively (docs/adr/0085-weekly-vehicle-request.md + ADR 0101).
 *
 * Approving a regular week asks nothing: terms move forward and paper is issued for days that have
 * not happened yet. An overdue week is a different action behind the same button: it extends orders
 * for days ALREADY WORKED, issues strict-accounting forms for them and, if the week already has
 * ESM-2 waybills, burns their numbers. That price is named by a person, not deduced by the server
 * from the date in the header, hence a separate window rather than a field quietly added to the old
 * button.
 *
 * Built like the route correction window (VehicleRouteCorrectionModal) and for the same reason: the
 * server computes the consequences with the same code that will execute them (GET /:id/correction).
 * A second computation in the portal would drift, and the window would promise something other than
 * what happens.
 *
 * What is not here: the composition. It is edited on the page itself, and repeating it as a list in
 * the window would give two answers to "what is being approved". The window answers another
 * question: what this costs in the past.
 */

interface FormValues {
  reason: string;
  unlockWaybillIds: string[];
}

interface Props {
  /** Request being conducted; `null` closes the dialog. */
  request: WeeklyVehicleRequestDto | null;
  onClose: () => void;
  /**
   * Conduct: the whole correction block. Approval goes by the same call as a regular one, and the
   * mutation lives in the workspace hook, next to the 409/422 handling and to saving the
   * composition in the same move.
   */
  onConduct: (correction: WeeklyCorrectionBody) => void;
  pending: boolean;
}

export function WeeklyRequestConductModal({ request, onClose, onConduct, pending }: Props) {
  const [form] = Form.useForm<FormValues>();

  /**
   * Idempotency key (ADR 0101 R31): generated BEFORE sending and kept while the window is open on
   * this request. A retry after a dropped connection must return the previous operation's result
   * (200 with apply: null) instead of extending terms a second time and burning a second form
   * number.
   */
  const [operationId, setOperationId] = useState(() => crypto.randomUUID());
  useEffect(() => {
    if (!request) return;
    setOperationId(crypto.randomUUID());
    form.setFieldsValue({ reason: '', unlockWaybillIds: [] });
    // The dependency is only the request id: tracking the whole object would make the operation key
    // and the typed reason jump on every card refresh, while the key must stay fixed for as long as
    // the window is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request?.id, form]);

  /** Operation price and its prohibitions come from the server, by the rules it will execute. */
  const { data: preview, isFetching } = useQuery({
    // The slice key factory yields the same array: the page invalidates by the
    // ['weekly-vehicle-requests', ...] prefix, and a diverging key would silently leave the window
    // with a stale preview after an approval that already moved the terms.
    queryKey: weeklyRequestKeys.correction(request?.id),
    queryFn: () => weeklyRequestsApi.correctionPreview(request!.id),
    enabled: !!request,
  });

  /**
   * Conduct is impossible altogether: right, depth or document state; the server names one reason.
   */
  const blocked = !!preview && !preview.allowed;

  const submit = (v: FormValues) => {
    // A refusal already named by the preview is not asked again: the endpoint would answer with the
    // same text, but after the reason was typed and the button pressed, while the person had to
    // read it before writing.
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
        {/* The refusal is read first: right, depth and document state are three different reasons,
            and they are fixed by someone other than whoever opened the window. The button stays in
            place and simply does not send: a vanished button does not explain why it is gone. */}
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
                {/* "Overdue" and "backdated" are not the same: a started week still has its Sunday
                    ahead, and backdateGuard's verdict for it is negative. It must be said here,
                    otherwise the person reads about the past where there is no past. */}
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

        {/* Waybills of worked weeks are listed by name (ADR 0101 R11), not "all past ones": after
            linear equipment two vehicles' waybills legitimately live in one week (ADR 0100 item 7),
            and a blanket checkbox would burn the wrong number. An unnamed waybill stays untouched:
            unlocking is targeted and does not spread by itself. In `history` the list holds exactly
            the waybills the visa must reissue, and leaving one unnamed refuses the visa with its
            number (ADR 0220) — so the hint promises only what is true in both modes. */}
        <Form.Item
          name="unlockWaybillIds"
          label="Листы ЭСМ-2 к перевыписке"
          extra={
            (preview?.unlockable.length ?? 0) > 0
              ? 'Отмеченные номера будут аннулированы, взамен выпишутся новые — следующими по серии. Неотмеченный лист не переписывается'
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

        {/* The reason is mandatory here and on the server (422 without it): it goes into the
            operation record and the waybills it issues (ADR 0101 R35), and remains the only
            explanation of why the week was approved after it was worked. */}
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

        {/* The right's depth is a note, not a prohibition: beyond it the server answers with the
            refusal above, while this line answers "how far back can I go at all" before it becomes
            a refusal. */}
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
