import { Alert, Space, Typography } from 'antd';
import { type AssignmentPreviewDto, workedAmountLabel } from '@technic/contracts';
import { formatDateOnly } from '@shared/lib';
import {
  consequencesListStyle as listStyle,
  consequencesTotalOf as totalOf,
} from '@entities/vehicle-request';

/**
 * The cost of a vehicle change, read by the person **before** the click (wave 4a of
 * `docs/assignment-periods-plan.md`, §7): which ESM-2 numbers burn and which are issued, which site
 * signatures drop, which days the machinist lacks.
 *
 * Separate from the dialog form on the same border as `RollbackPreview`: the form is fields, rules
 * and sending; this is the list of consequences, which has nothing to do with input and grows with
 * every new backdate door.
 *
 * Nothing is computed here: everything comes ready from the server
 * (`POST /vehicle-requests/:id/assignment/preview`), computed by the same planner that will then
 * run (`planReassignCommand`). A second computation in the portal would drift from the first, and
 * the dialog would promise something other than what happens. Pure decisions about silent, blocked
 * or stale previews live in `@features/vehicle-assignment`.
 *
 * What is absent and why. `requiredVehicleResolution` is always empty at this door: a tail mismatch
 * locks a term extension, and a vehicle change opens no new days. Warned sheets (`issues`) are not
 * drawn here either, though the server computes them: they need a confirmation, and the tick with
 * its form lives in `useReassignConsequences.tsx`, next to the command that carries the signatures.
 */

interface Props {
  preview: AssignmentPreviewDto;
  /**
   * Why the dialog returned to the consequences by itself: the server said what was shown is stale.
   * `null` — the person came here the ordinary way, by pressing "Change vehicle".
   */
  staleReason?: string | null;
}

export function ReassignPreview({ preview, staleReason }: Props) {
  const { cancel, issue } = preview.plan;
  const blocked = preview.blockedShiftDays;
  const cleared = preview.clearedShiftDays;

  return (
    <Space orientation="vertical" size={12} style={{ display: 'flex' }}>
      {staleReason && (
        <Alert type="warning" showIcon title="Последствия пересчитаны" description={staleReason} />
      )}

      {/* The signed-days lock comes first: nothing below happens while it holds, and reading the
        paper list before the ban would be reading in vain. The way out is named directly: the
        signature is removed not by a vehicle change but by a backdated correction. */}
      {blocked.length > 0 && (
        <Alert
          type="error"
          showIcon
          title="Сменить технику нельзя: дни уже подписаны объектом"
          description={
            <>
              <div>
                Часы этих дней приняты, и смена машины переписала бы задним числом то, под чем стоит
                подпись. Снять её можно только коррекцией — вернитесь и отметьте «Исправить задним
                числом: работала другая машина».
              </div>
              <ul style={listStyle}>
                {blocked.map((day) => (
                  <li key={day.date}>
                    {formatDateOnly(day.date)} — {workedAmountLabel('hours', day.hours)}
                  </li>
                ))}
              </ul>
              <Typography.Text type="secondary">{totalOf(blocked)}</Typography.Text>
            </>
          }
        />
      )}

      <div>
        <Typography.Text strong>Путевые листы ЭСМ-2</Typography.Text>
        {cancel.length === 0 && issue.length === 0 ? (
          <div>
            <Typography.Text type="secondary">
              Останутся как есть: аннулировать и выписывать нечего.
            </Typography.Text>
          </div>
        ) : (
          <ul style={listStyle}>
            {cancel.map((sheet) => (
              <li key={sheet.waybillId}>
                Сгорит № {sheet.displayNumber} за {formatDateOnly(sheet.from)} —{' '}
                {formatDateOnly(sheet.to)}
              </li>
            ))}
            {/* Composition, not just boundaries: different vehicles and people work a site within a
              week, and "a form for 10–16 August will be issued" does not say under whose name. */}
            {issue.map((sheet) => (
              <li key={sheet.issueKey}>
                Выпишется лист за {formatDateOnly(sheet.from)} — {formatDateOnly(sheet.to)}:{' '}
                {sheet.vehicleName}, машинист {sheet.driverName}
              </li>
            ))}
          </ul>
        )}
      </div>

      {/* Unlocking worked weeks (R11): reconciliation would not touch these numbers by itself —
        their week is over. The list is the server's and stands next to the plan on purpose: it
        explains why past weeks appear among the burning ones. */}
      {preview.requiredUnlocks.length > 0 && (
        <div>
          <Typography.Text strong>Отработанные недели</Typography.Text>
          <div>
            <Typography.Text type="secondary">
              Их неделя уже закрыта — эти листы переоформляются только разблокировкой:
            </Typography.Text>
          </div>
          <ul style={listStyle}>
            {preview.requiredUnlocks.map((sheet) => (
              <li key={sheet.waybillId}>
                № {sheet.displayNumber} за {formatDateOnly(sheet.from)} — {formatDateOnly(sheet.to)}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Site signatures. Today this door **removes** them and keeps the hours
        (`clearShiftApprovals`): deleting hours filled without a signature comes with the term
        split, and must not be promised now. Hours are shown per day and as a sum — the cost of the
        confirmation must be visible, not implied. */}
      {cleared.length > 0 && (
        <div>
          <Typography.Text strong>Подписи объекта</Typography.Text>
          <div>
            <Typography.Text type="secondary">
              Слетят с этих дней: часы останутся, но принять их объекту придётся заново — уже по той
              машине, которая работала на самом деле.
            </Typography.Text>
          </div>
          <ul style={listStyle}>
            {cleared.map((day) => (
              <li key={day.date}>
                {formatDateOnly(day.date)} — {workedAmountLabel('hours', day.hours)}
              </li>
            ))}
          </ul>
          <Typography.Text type="secondary">{totalOf(cleared)}</Typography.Text>
        </div>
      )}

      {/* Machinist gaps (R16). Today they do not stop a vehicle change — assignment history is not
        kept yet, and forbidding here would take away a working action. But silence is wrong: until
        a person is named for these days, no ESM-2 form can be issued for them. */}
      {preview.requiredAnchors.length > 0 && (
        <div>
          <Typography.Text strong>Машинист неизвестен</Typography.Text>
          <div>
            <Typography.Text type="secondary">
              История этих дней восстановлена не полностью. Смене техники это не мешает, но пока
              человек не назван, лист ЭСМ-2 за такие дни выписать нечем:
            </Typography.Text>
          </div>
          <ul style={listStyle}>
            {preview.requiredAnchors.map((gap) => (
              <li key={`${gap.requestId}@${gap.effectiveDate}`}>
                {formatDateOnly(gap.from)} — {formatDateOnly(gap.to)} · заявка {gap.requestNumber}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* The operation outcome is decided by the server (R32), not by a client calendar: a planned
        future change needs no reason, while editing past days always does. The portal only voices
        what the server decided — a second matrix would drift on the first refinement. */}
      {preview.operationRequirement && (
        <div>
          <Typography.Text strong>Журнал коррекций</Typography.Text>
          <div>
            <Typography.Text type="secondary">
              {preview.operationRequirement.kind === 'crew'
                ? 'Операция правит уже прошедшие дни — она попадёт в журнал вместе с причиной, и причина напечатается в обоих листах.'
                : 'Операция правит уже принятое решение — она попадёт в журнал вместе с причиной.'}
            </Typography.Text>
          </div>
        </div>
      )}

      {/* The computation day is part of the fingerprint: yesterday's preview will not match today's
        command even if nothing else changed. Saying it here is cheaper than explaining an
        unexpected refusal after midnight. */}
      <Typography.Text type="secondary">
        Последствия посчитаны на {formatDateOnly(preview.asOf)}.
      </Typography.Text>
    </Space>
  );
}
