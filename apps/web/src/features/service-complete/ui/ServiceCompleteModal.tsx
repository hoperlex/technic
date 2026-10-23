import { useEffect, useMemo, useState } from 'react';
import { Alert, App, DatePicker, Form, Input, Typography } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  canCoordinateServiceRequests,
  type CompleteServiceRequestInput,
  type ServiceRequestDto,
} from '@technic/contracts';
import {
  consumableFailureText,
  ServiceHint,
  ServiceRequestContext,
  serviceRequestKeys,
  serviceRequestsApi,
} from '@entities/service-request';
import {
  officeEquipmentConsumableKeys,
  officeEquipmentKeys,
  officeEquipmentPurchaseKeys,
} from '@entities/office-equipment';
import { useAuth } from '@entities/session';
import { FormModal, useFormBlockers } from '@shared/ui';
import { errorMessage, formatMoney } from '@shared/lib';
import {
  completeBody,
  completeFormValues,
  completeIssue,
  completeMode,
  type CompleteFormValues,
} from '../model/completeForm';
import { ConsumableLines } from './ConsumableLines';
import { DocumentFact, EstimateFact, UNKNOWN_AMOUNT } from './EstimateFact';

/** The work date cannot be cleared (`allowClear={false}`); a stray empty value keeps the last one. */
const keepDate = (date: Dayjs | null, previous: Dayjs) => date ?? previous;

/**
 * Closing the works by the executor (§9.3). Three windows in one, because the arc is one: a
 * contractor repair presents the estimate and the fact by its rows, consumables say how much of
 * what was issued (§6.2), an in-house repair gives a date and words. Which one is open is
 * `completeMode` (see there for why the money question is asked by the contracts predicate and
 * not by "does the request have rows").
 *
 * A contractor repair has its total as **a computed line, not an input** (R12); consumables have
 * no estimate, hence no total, no discount and no closing-document bar (the contracts predicate
 * requires `kind = 'repair'`). Their default fact "as much as was asked" is set by the form (R3),
 * and the write-off goes in the same transaction as the move to «Решена» (R5): a shortage cancels
 * the closing whole and arrives as a text naming the item, the stock and both lawful ways out (R7).
 *
 * The in-house repair (R6 of `office-equipment-card-and-list-cleanup-plan.md`) closes with the
 * work date and an optional «Что сделали»: the own administrator records no cost, and rows, a
 * discount, a computed total and the «Согласована ревизия N на X ₽» bar would show them zeros —
 * figures where the request never has any. The DOCUMENT SUBMISSION is not a fourth window but a
 * branch of the first (R8 of `docs/office-equipment-on-site-and-invoice-estimate-plan.md`): the
 * request counts money as before, but there are no rows to mark, no discount, and the sum is named
 * in words; `completeMode` names the branch only because those three leave the screen.
 *
 * THE STATE IS AN ANTD FORM (Q7, ADR 0094). Rows and consumable lines are `Form.List`s, and every
 * check is a rule of the field at fault: a refused click marks the fields, scrolls to the first
 * and flashes, instead of a toast in the corner. The body is pinned byte for byte by
 * `test/service-complete-body.test.tsx` against the window that held its rows in `useState`.
 *
 * The form is rendered WITHOUT a `<form>` element (`component={false}`). The window never closed
 * the works on Enter, and a `<form>` would start doing it where only one single-line input is
 * left — the work date of an in-house or document closing: the browser's implicit submission
 * fires there, and Enter is exactly the key that confirms a date typed into the picker. Without
 * the element `form.submit()` still runs validation and `onFinish`, so the button is the only way
 * to close, as before; the flash class of `useFormBlockers` goes on the wrapper instead.
 */
export function ServiceCompleteModal({
  request,
  forceWithoutDocument = false,
  onClose,
}: {
  /** `null` — the window is closed. It opens in status «В работе». */
  request: ServiceRequestDto | null;
  forceWithoutDocument?: boolean;
  onClose: () => void;
}) {
  const { message } = App.useApp();
  const { user, can } = useAuth();
  const qc = useQueryClient();
  const [form] = Form.useForm<CompleteFormValues>();
  const { className: blockersClass, ...blockersHandlers } = useFormBlockers(form).formProps;
  /**
   * The server's refusal stays as a line in the window, not only as a toast: a stock shortage
   * names the item and the figure by which the person corrects the fact right here, and by then
   * the toast has faded.
   */
  const [failure, setFailure] = useState<string | null>(null);
  const mode = request ? completeMode(request) : null;
  /**
   * Who is owed explanations (R11): the holder of `serviceRequests.assign` — «Ведение» and the IT
   * service. Asked through ONE contracts function rather than a `can(...)` in place: eleven places
   * ask this question, and spread over calls it would have moved only halfway.
   */
  const coordinator = canCoordinateServiceRequests(user, can);

  /** The state the window opens with; the form resets to it whenever another request arrives. */
  const initial = useMemo(() => (request ? completeFormValues(request, dayjs()) : null), [request]);
  /*
   * What is on screen right now, for the total, the disabled reason field and the line under the
   * window. `preserve` reads the whole store — the rows' agreed quantities and prices included,
   * which no field edits. Merged over `initial`, because the watch catches up a render after the
   * store: on the first render it has nothing yet.
   */
  const watched = Form.useWatch([], { form, preserve: true });
  const values: CompleteFormValues | null = initial && { ...initial, ...watched };

  useEffect(() => {
    if (!request) return;
    form.resetFields();
    setFailure(null);
  }, [request, form]);

  /*
   * The first fault, in words under the window, before any click — the line the window has always
   * shown. The rules ask the same checks and mark the fields themselves.
   */
  const issue =
    request && values && mode
      ? completeIssue(values, mode, request.estimatedTotalAmount ?? null)
      : null;

  const mutation = useMutation({
    mutationFn: (body: CompleteServiceRequestInput) =>
      serviceRequestsApi.complete(request!.id, body),
    onSuccess: () => {
      message.success('Работы закрыты — заявка ждёт приёмки');
      void qc.invalidateQueries({ queryKey: serviceRequestKeys.root });
      void qc.invalidateQueries({ queryKey: officeEquipmentKeys.root });
      // Closing consumables moves the warehouse in the same transaction (R5): the stock in the
      // directory and the journal feed are stale right now, and so is a purchase card, which
      // shows the position's stock of today next to its snapshot (`currentStock`).
      if (mode === 'consumable') {
        void qc.invalidateQueries({ queryKey: officeEquipmentConsumableKeys.root });
        void qc.invalidateQueries({ queryKey: officeEquipmentPurchaseKeys.root });
      }
      onClose();
    },
    onError: (e) => {
      const text = mode === 'consumable' ? consumableFailureText(e) : errorMessage(e);
      setFailure(text);
      message.error(text);
    },
  });

  /*
   * Reached only when every rule passed. The body is built from the whole store, not from the
   * validated values: the rows' ids and the lines' requested quantities belong to no field.
   */
  const finish = () => {
    if (!request || !mode) return;
    const state = form.getFieldsValue(true) as CompleteFormValues;
    mutation.mutate({
      ...completeBody(state, mode, request.version),
      ...(forceWithoutDocument ? { forceWithoutDocument: true } : {}),
    });
  };

  return (
    <FormModal
      title={
        mode === 'supplied'
          ? `Перевод в «Решена» ${request?.displayNumber ?? ''}`.trim()
          : request
            ? `${forceWithoutDocument ? 'Принудительное закрытие' : 'Закрытие работ'} ${request.displayNumber}`
            : 'Закрытие работ'
      }
      open={!!request}
      onCancel={onClose}
      onSubmit={() => form.submit()}
      confirmLoading={mutation.isPending}
      okText={
        forceWithoutDocument
          ? 'Закрыть без документа'
          : mode === 'supplied'
            ? 'Перевести в «Решена»'
            : 'Закрыть работы'
      }
      width={720}
    >
      {request && values && (
        <Form
          form={form}
          component={false}
          initialValues={initial ?? undefined}
          onFinish={finish}
          {...blockersHandlers}
        >
          <div
            className={blockersClass}
            style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
          >
            <ServiceRequestContext request={request} />
            {forceWithoutDocument && (
              <Alert
                type="warning"
                showIcon
                title="Заявка перейдёт в «Решена» без закрывающего документа"
                description="Укажите причину. Действие и его автор сохранятся в истории. После этого примите работу отдельным действием."
              />
            )}
            {/*
             * Explanations go only to whoever coordinates requests (R11, E4). The executor and the
             * contractor's operator know the form, and the blue bars were asked away exactly for
             * them; they are read through `ServiceHint` of `entities`, not an own `Alert`: a shared
             * component placed in `features` would be out of reach of the neighbouring slices (N14).
             *
             * An in-house repair has no bar for anyone: there is nothing to explain — no rows, no
             * revision, no sum — and «Согласована ревизия 0 на 0,00 ₽» would name figures that are
             * not there.
             */}
            {mode === 'supplied' ? (
              <ServiceHint
                coordinator={coordinator}
                level="info"
                title="Расходники привозит подрядчик"
                description="Склад по этой заявке не двигается, отметок выдачи не нужно. Укажите дату — заявка уйдёт на приёмку."
              />
            ) : mode === 'consumable' ? (
              <ServiceHint
                coordinator={coordinator}
                level="info"
                title="Отметьте, сколько выдали"
                description="Умолчание — сколько просили. Расхождение объясняется причиной: выдали больше, меньше или не выдали вовсе. Закрывающий документ у расходников не требуется."
              />
            ) : (
              (mode === 'items' || mode === 'document') && (
                <ServiceHint
                  coordinator={coordinator}
                  level="info"
                  /*
                   * The sum goes into the title ONLY when there is one. The former `?? 0` wrote
                   * «Согласована ревизия 3 на 0,00 ₽» for a request whose sum is unknown — a figure
                   * in place of the answer "no figure yet" (§8).
                   */
                  title={
                    request.estimatedTotalAmount == null
                      ? `Согласована ревизия ${request.approval?.revision ?? request.estimateRevision}: сумма ${UNKNOWN_AMOUNT}`
                      : `Согласована ревизия ${request.approval?.revision ?? request.estimateRevision} на ${formatMoney(request.estimatedTotalAmount)}`
                  }
                  description={
                    mode === 'document'
                      ? 'Объём работ подан счётом: строк, по которым ставят отметки, у такой заявки нет, и сумму системе назовёт разбор документа. Нужна построчная картина — «Ведение» разложит счёт по графам, и заявка вернётся в обычный порядок.'
                      : 'Снимите отметку с того, что не понадобилось: гарантия проставляется только выполненным строкам.'
                  }
                />
              )
            )}

            {/* The work date: the server counts the warranties of rows without their own date from
                it, and it is the only required field of an in-house closing (R6). It is labelled
                for that reason: an in-house closing has neither a table nor a total next to it by
                which one would read what this date is. */}
            <Form.Item name="completedOn" noStyle normalize={keepDate}>
              <DatePicker
                style={{ width: 220 }}
                format="DD.MM.YYYY"
                allowClear={false}
                aria-label="Дата выполнения"
              />
            </Form.Item>

            {mode === 'consumable' && <ConsumableLines />}
            {/* Rows, discount and total only where the request counts money (R6), by the R4 sign
                and not by "has rows": a request handed to the own employee keeps the contractor's
                rows, and a fact table would offer to close someone else's estimate as own work. */}
            {mode === 'items' && (
              <EstimateFact values={values} estimatedTotal={request.estimatedTotalAmount ?? null} />
            )}
            {mode === 'document' && <DocumentFact />}

            {/*
             * Words about the work. For an in-house repair they are the whole content of the
             * closing, hence its own label: «Что сделали» answers the question such a request is
             * asked, while «чего не понадобилось» is about estimate rows it does not have. It does
             * not become required: the customer asked for a date and an OPTIONAL comment, and an
             * invented requirement would make people type «сделал» for the sake of the button.
             */}
            <Form.Item
              name="comment"
              noStyle
              rules={
                forceWithoutDocument
                  ? [
                      {
                        required: true,
                        whitespace: true,
                        message: 'Укажите причину закрытия без документа',
                      },
                    ]
                  : undefined
              }
            >
              <Input.TextArea
                rows={2}
                maxLength={1000}
                aria-label={
                  forceWithoutDocument
                    ? 'Причина закрытия без документа'
                    : mode === 'inHouse'
                      ? 'Что сделали'
                      : 'Комментарий'
                }
                placeholder={
                  forceWithoutDocument
                    ? 'Почему закрываем без документа'
                    : mode === 'inHouse'
                      ? 'Что сделали — необязательно: например, заменили ролик подачи'
                      : mode === 'supplied'
                        ? 'Комментарий — необязательно'
                        : 'Комментарий: что сделали и чего не понадобилось'
                }
              />
            </Form.Item>
            {/* The server's refusal is shown as is (R7): it names the item, the stock and the way out. */}
            {failure && <Alert type="error" showIcon title={failure} />}
            {issue && <Typography.Text type="warning">{issue}</Typography.Text>}
          </div>
        </Form>
      )}
    </FormModal>
  );
}
