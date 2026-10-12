import type { ReactNode } from 'react';
import { Divider, Form, Input, InputNumber, Space, Typography } from 'antd';
import { formatMoney } from '@shared/lib';
import type { CompleteFormValues } from '../model/completeForm';
import { factTotal } from '../model/fact';
import { adjustmentReasonRule, adjustmentRule, estimateCapRule } from '../model/completeRules';
import { CompleteRows } from './CompleteRows';

/**
 * AN UNKNOWN SUM IN WORDS, NOT AS ZERO (§8 of
 * `docs/office-equipment-on-site-and-invoice-estimate-plan.md`).
 *
 * A document submission has the invoice attached, while its content is not yet known to the
 * system: parsing the document is the next wave (R2, the customer's answer V5 of 11.09.2026). A
 * zero here is not the formatting of an empty field but the statement "the works are free", and a
 * person takes a money decision by it. The server reasons the same way: it writes `NULL` into the
 * act total, not the counted `sumAmounts([])`.
 */
export const UNKNOWN_AMOUNT = 'не разобрана';

/**
 * The money line at the bottom of the window. `id` is there for the total's holder field (see
 * `EstimateFact`): the field passes its id, and `scrollToField` finds the line by it.
 */
function TotalLine({ id, label, amount }: { id?: string; label: string; amount: ReactNode }) {
  return (
    <Space id={id} size={8} style={{ justifyContent: 'flex-end', width: '100%' }}>
      <Typography.Text type="secondary">{label}</Typography.Text>
      <Typography.Text strong style={{ fontSize: 16 }}>
        {amount}
      </Typography.Text>
    </Space>
  );
}

/** The fields whose change can move the total: every row's mark and fact, and the discount. */
function totalDependencies(rowCount: number) {
  return [
    ...Array.from({ length: rowCount }, (_, i) => [
      ['rows', i, 'performed'],
      ['rows', i, 'actualQuantity'],
    ]).flat(),
    ['adjustment'],
  ];
}

/**
 * A contractor repair closed row by row: the rows, the act discount with its reason, and the
 * total. The total is **a computed line, not an input** (R12): it is recounted on screen at every
 * unchecked mark and cannot drift from the row sum. Needing more than was agreed, the window does
 * not let through and says where to go: a price rise passes through reopening the estimate.
 */
export function EstimateFact({
  values,
  estimatedTotal,
}: {
  values: CompleteFormValues;
  estimatedTotal: number | null;
}) {
  return (
    <>
      <CompleteRows rows={values.rows} />

      <Divider style={{ margin: '8px 0' }} />

      <Space wrap align="start">
        <Form.Item name="adjustment" rules={[adjustmentRule]} style={{ marginBottom: 0 }}>
          <InputNumber
            style={{ width: 200 }}
            max={-0.01}
            placeholder="Скидка по акту, ₽"
            aria-label="Скидка по акту"
          />
        </Form.Item>
        <Form.Item
          name="adjustmentReason"
          rules={[adjustmentReasonRule]}
          dependencies={['adjustment']}
          style={{ marginBottom: 0 }}
        >
          <Input
            style={{ width: 320 }}
            maxLength={500}
            disabled={values.adjustment == null}
            placeholder="Причина скидки"
            aria-label="Причина скидки"
          />
        </Form.Item>
      </Space>

      {/*
       * The total is computed, not typed (R12), and the "above the agreed estimate" net has no
       * input to mark: the line itself is a holder field (ADR 0094, decision 9), so the reason
       * stands under the total it is about and the scroll lands there.
       */}
      <Form.Item
        name="estimateCap"
        rules={[estimateCapRule(estimatedTotal)]}
        dependencies={totalDependencies(values.rows.length)}
        style={{ marginBottom: 0 }}
      >
        <TotalLine
          label="Итого по акту:"
          amount={formatMoney(factTotal(values.rows, values.adjustment))}
        />
      </Form.Item>
    </>
  );
}

/**
 * THE EMPTY TABLE IS EXPLAINED, NOT SHOWN (R8). A document revision has no rows at all, and the
 * row list would draw an empty space where a person looks for what to mark; the server does not
 * expect marks either — there is nothing to mark against.
 *
 * The act discount and its reason are REMOVED BY STATE, not greyed out (R10): the server answers
 * them with 422 — there is nothing to discount from while the total is unknown — and a greyed
 * field would mean "do something else first", that is, send the person after a path that does
 * not exist. The way out is named: «Ведение» lays the invoice out.
 *
 * The hint above does not contradict this text and does not replace it: only a coordinator sees
 * it (`ServiceHint`), while the executor closes the works — and the explanation of the empty space
 * is for the executor.
 */
export function DocumentFact() {
  return (
    <>
      <Typography.Text type="secondary">
        Отмечать нечего: объём работ подан счётом — строк у него нет, скидка по акту такой заявке
        недоступна, а сумму системе назовёт разбор документа. Работы закрывает акт о выполненных
        работах: подшейте его на вкладке документов.
      </Typography.Text>

      {/* The total line keeps its place and answers IN WORDS: removed, it would make a person
          used to reading the sum at the bottom think the window is half-drawn; a zero here would
          say the works are free (§8). The server writes `NULL` into the total for the same
          reason. */}
      <TotalLine label="Сумма по акту:" amount={UNKNOWN_AMOUNT} />
    </>
  );
}
