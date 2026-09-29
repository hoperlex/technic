import { Alert, Checkbox, Form, Space, Typography } from 'antd';
import type { WaybillWarning } from '@technic/contracts';

/**
 * Showing waybill warnings before a blank number is spent — the display half only.
 *
 * WHY HERE AND NOT IN A DOOR. Warnings reach the portal in three shapes: the route and weekly ESM-2
 * issue answer 409 with one fingerprint for one sheet; the assignment doors return a warning set
 * per planned sheet keyed by `issueKey`; the early-end doors return only the kinds of warnings
 * (`codes`), because their reader may not see whose documents they are (R26). The shapes differ,
 * the way a person reads them must not: two copies of the list drift apart on the first wording
 * change, and the dispatcher would read about a spent blank in one window and not in another. So
 * the list and the per-sheet confirmation live in the waybill slice, and each door keeps only its
 * adapter (how to read its answer and how to send the signature back).
 *
 * The portal decides nothing here: which sheets carry warnings and what they say comes from the
 * server; this module only renders what it was given.
 */

/** One line a person reads about a sheet: a warning's text, or only its kind (R26). */
export interface WarnedLine {
  /** Stable within the sheet: an index would move with the list when the server answers again. */
  key: string;
  text: string;
}

/** Full warnings as lines — the human text, never the machine facts; keyed by code and subject. */
export function waybillWarningLines(warnings: readonly WaybillWarning[]): WarnedLine[] {
  return warnings.map((warning) => ({
    key: `${warning.facts.code}:${warning.entities.join(',')}`,
    text: warning.message,
  }));
}

function WarnedLineList({ lines }: { lines: readonly WarnedLine[] }) {
  return (
    <ul style={{ margin: 0, paddingInlineStart: 20 }}>
      {lines.map((line) => (
        <li key={line.key}>{line.text}</li>
      ))}
    </ul>
  );
}

/** Warnings of one sheet as a list — the route and weekly ESM-2 issue confirmation shows it. */
export function WaybillWarningList({ warnings }: { warnings: readonly WaybillWarning[] }) {
  return <WarnedLineList lines={waybillWarningLines(warnings)} />;
}

/** A planned sheet whose warnings the person has to confirm before the command is sent. */
export interface WarnedSheet {
  /** Stable key of the sheet within the plan; the door sends the signature under it. */
  key: string;
  /** How the person recognises the blank: period, vehicle, driver — as much as they may see. */
  title: string;
  lines: WarnedLine[];
  /** Server fingerprint of this sheet's warning facts; returned untouched as the signature. */
  fingerprint: string;
}

/**
 * The set being confirmed, as one value.
 *
 * The checkbox stores this value instead of `true`: when the preview is recomputed (409, a new
 * midnight, someone fixed a driver's documents) the set changes, and a plain boolean would stay
 * ticked under a list the person never read. Comparing against the current signature makes a stale
 * tick read as unticked with no reset code in the windows.
 */
function signatureOf(sheets: readonly WarnedSheet[]): string {
  return sheets.map((sheet) => `${sheet.key}:${sheet.fingerprint}`).join('|');
}

function SignatureCheckbox({
  signature,
  value,
  onChange,
}: {
  signature: string;
  value?: string;
  onChange?: (value: string | undefined) => void;
}) {
  return (
    <Checkbox
      checked={value === signature}
      onChange={(e) => onChange?.(e.target.checked ? signature : undefined)}
    >
      Согласен: листы выпишутся с перечисленными предупреждениями
    </Checkbox>
  );
}

/**
 * Warnings of every planned sheet plus an explicit confirmation, as a block of the door's form.
 *
 * One tick for the whole list, not one per sheet: every sheet is named with its own warnings, and
 * the signature sent back is still per sheet — the server never counts one sheet's confirmation for
 * another. A dozen ticks for a dozen weeks with the same missing document would teach clicking
 * without reading, which is what the confirmation exists to prevent.
 *
 * Renders nothing when no sheet has warnings: a clean blank is issued without a signature, and
 * asking to confirm emptiness is exactly what the server rejects as a superfluous signature.
 */
export function WarnedSheetsConfirm({
  sheets,
  name,
}: {
  sheets: readonly WarnedSheet[];
  /** Form field holding the confirmation; the window validates it before sending. */
  name: string;
}) {
  if (sheets.length === 0) return null;
  const signature = signatureOf(sheets);
  return (
    <Space orientation="vertical" size={8} style={{ display: 'flex' }}>
      <Alert
        type="warning"
        showIcon
        title="Листы выпишутся с предупреждениями"
        description={
          <Space orientation="vertical" size={8} style={{ display: 'flex' }}>
            {sheets.map((sheet) => (
              <div key={sheet.key}>
                <Typography.Text strong>{sheet.title}</Typography.Text>
                <WarnedLineList lines={sheet.lines} />
              </div>
            ))}
            <Typography.Text type="secondary">
              Номера бланков израсходуются: чтобы переписать лист, его придётся аннулировать.
            </Typography.Text>
          </Space>
        }
      />
      <Form.Item
        name={name}
        style={{ marginBottom: 0 }}
        rules={[
          {
            validator: (_rule, value: string | undefined) =>
              value === signature
                ? Promise.resolve()
                : Promise.reject(new Error('Подтвердите предупреждения по листам')),
          },
        ]}
      >
        <SignatureCheckbox signature={signature} />
      </Form.Item>
    </Space>
  );
}
