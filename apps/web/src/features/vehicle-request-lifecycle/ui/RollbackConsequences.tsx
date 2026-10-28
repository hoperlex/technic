import { Alert, Button, Space, Spin } from 'antd';
import {
  assignmentRateLabel,
  assignmentTitle,
  completionFactLabel,
  routePurposeLabels,
  type Esm2CancelPreviewDto,
  type VehicleRequestDto,
  type VehicleRequestRollbackPreviewDto,
} from '@technic/contracts';
import { formatDateOnly } from '@shared/lib';
import { consequencesListStyle as listStyle } from '@entities/vehicle-request';

/**
 * The whole notice of the rollback window: what the return to «Новая» takes away, what it leaves,
 * and what stops it — in the words of the plan the server answered with (ADR 0211).
 *
 * NOT A SECOND CARRIER OF THE RULE, and the line between the two sides is worth keeping: *whether*
 * a thing goes is the server's answer and is never recomputed here, while *how it is named* to the
 * human is the portal's business. That is why the vehicle and the presented fact are named from the
 * request itself: the preview says `assignment: true`, and the registration number with the rate
 * lives only in the request DTO — but the line exists because the plan says so, named or not. A
 * line that told the human more than the plan does — «every relocation goes» — is exactly the
 * defect this window was built to end.
 *
 * A file of its own rather than lines inside the lifecycle hook: the hook is the conversation with
 * the server (ask on open, confirm with the fingerprint, ask again on a 409), and this is sixty
 * lines of solid text. Same split as `RollbackPreview` of the assign window (ADR 0178).
 */

interface Props {
  /**
   * Names of what is erased: the vehicle number, the rate, the presented fact — only the request
   * knows them.
   */
  request: VehicleRequestDto;
  /** `null` — no answer yet: nothing to promise, and the dialog shows a wait. */
  preview: VehicleRequestRollbackPreviewDto | null;
  /**
   * Why the consequences were not read. Shown instead of the list: the person can still press
   * "Return" (the door's fingerprint is optional, ADR 0211 decision 4, and the return must not jam
   * over an unavailable preview) — but blind, and that is said plainly.
   */
  failure: string | null;
  /** Why the list was recomputed by itself: the door refused over a stale fingerprint. */
  staleReason: string | null;
  onRetry: () => void;
}

interface Line {
  key: string;
  text: string;
}

/**
 * "1 строка" / "2 строки" / "5 строк": the number of work days is read aloud, and a "строк(и)"
 * placeholder does not do here.
 */
function rowsText(count: number): string {
  const tail = count % 100;
  const last = count % 10;
  const form =
    tail >= 11 && tail <= 14
      ? 'строк'
      : last === 1
        ? 'строка'
        : last >= 2 && last <= 4
          ? 'строки'
          : 'строк';
  return `${count} ${form}`;
}

function sheetText(sheet: Esm2CancelPreviewDto): string {
  return `${sheet.number} (${formatDateOnly(sheet.from)} — ${formatDateOnly(sheet.to)})`;
}

/**
 * What the return removes. The order runs from the agreement to the paper — the way a loss is told.
 */
function eraseLines(request: VehicleRequestDto, p: VehicleRequestRollbackPreviewDto): Line[] {
  const lines: Line[] = [];
  /*
   * The plan decides whether the line is there; the request only names it. A request row that went
   * stale before the dialog opened may lack the vehicle the server is about to remove — then the
   * line stays, without the name, rather than the window keeping silent about it.
   */
  if (p.assignment) {
    const assignment = request.assignment;
    // Rates name the very commercial agreement being removed; a rental without agreed rates names
    // the lessor — the agreement was with them, and they are the one to call.
    const detail = assignment ? assignmentRateLabel(assignment) || assignment.lessorName : null;
    lines.push({
      key: 'assignment',
      text: assignment
        ? `Назначенная техника: ${assignmentTitle(assignment)}${detail ? ` — ${detail}` : ''}`
        : 'Назначенная техника со ставками',
    });
  }
  for (const r of p.routes.detach) {
    lines.push({
      key: `detach-${r.routeNumber}-${r.date}`,
      text: `Место в рейсе ${r.routeNumber} за ${formatDateOnly(r.date)}`,
    });
  }
  for (const r of p.relocations.drop) {
    lines.push({
      key: `drop-${r.routeNumber}`,
      text: `${routePurposeLabels[r.purpose]} — рейс ${r.routeNumber} от ${formatDateOnly(r.routeDate)}`,
    });
  }
  if (p.shifts.length > 0) {
    const approved = p.shifts.filter((s) => s.approved);
    lines.push({
      key: 'shifts',
      // An approved day exists only outside the term: inside it the day locks the return, while the
      // door deletes the request's rows wholesale — and keeping silent about accepted hours is not
      // allowed.
      text:
        `Дни работ — ${rowsText(p.shifts.length)}` +
        (approved.length > 0
          ? `, из них согласованных объектом: ${approved.map((s) => formatDateOnly(s.date)).join(', ')}`
          : ''),
    });
  }
  if (p.earlyEnd) {
    lines.push({
      key: 'early-end',
      text: `Запрос на досрочное завершение по ${formatDateOnly(p.earlyEnd.newDateTo)} — он ждёт визы и будет снят`,
    });
  }
  if (p.esm2.cancelCount > 0) {
    // Strict-accounting form numbers are open only to the journal (ADR 0106): without it the
    // counter is the full answer to "will the paper burn".
    lines.push({
      key: 'esm2-cancel',
      text: p.esm2.sheets
        ? `Аннулируются листы ЭСМ-2: ${p.esm2.sheets.cancel.map(sheetText).join('; ')}`
        : `Аннулируются недельные листы ЭСМ-2 — ${p.esm2.cancelCount}`,
    });
  }
  if (p.dropsLinearFreeze) {
    lines.push({
      key: 'linear-freeze',
      text: 'Снимется заморозка линейности: взятая в работу заново, заявка пойдёт по справочнику видов техники, каким он будет тогда',
    });
  }
  if (p.completion) {
    lines.push({
      key: 'completion',
      text: request.completion
        ? `Предъявленный факт: ${completionFactLabel(request.completion)}`
        : 'Предъявленный факт',
    });
  }
  return lines;
}

/**
 * What stays although the person expects otherwise — and why. Silence here is what promised too
 * much.
 */
function keepLines(p: VehicleRequestRollbackPreviewDto): Line[] {
  const lines: Line[] = [];
  for (const r of p.routes.frozen) {
    lines.push({
      key: `frozen-${r.routeNumber}-${r.date}`,
      text: `Место в рейсе ${r.routeNumber} за ${formatDateOnly(r.date)} — его держит действующий путевой лист`,
    });
  }
  for (const r of p.relocations.keep) {
    lines.push({
      key: `keep-${r.routeNumber}`,
      text: `${routePurposeLabels[r.purpose]} — рейс ${r.routeNumber} от ${formatDateOnly(r.routeDate)}: по нему выписывали лист, и журнал бланков на этот рейс ссылается`,
    });
  }
  if (p.esm2.keepCount > 0) {
    lines.push({
      key: 'esm2-keep',
      text: p.esm2.sheets
        ? `Останутся действующими листы ЭСМ-2 за отработанные недели: ${p.esm2.sheets.keep.map(sheetText).join('; ')}`
        : `Останутся действующими листы ЭСМ-2 за отработанные недели — ${p.esm2.keepCount}`,
    });
  }
  return lines;
}

export function RollbackConsequences({ request, preview, failure, staleReason, onRetry }: Props) {
  return (
    <Space orientation="vertical" size={12} style={{ display: 'flex', marginBottom: 16 }}>
      {staleReason && (
        <Alert type="warning" showIcon title="Последствия пересчитаны" description={staleReason} />
      )}
      {/* A blocker stands above the list: with it nothing below will happen, and reading the list
        before the prohibition would be reading it in vain. The text is the door's own refusal. */}
      {preview?.blockers.map((b) => (
        <Alert key={b.code} type="error" showIcon title={b.message} />
      ))}
      {failure ? (
        <Alert
          type="error"
          showIcon
          title="Не удалось узнать, что снимет возврат"
          description={
            <>
              <div>{failure}</div>
              <div>
                Пока перечня нет, возврат стёр бы работу вслепую. Повторите — или закройте окно и
                откройте заявку заново.
              </div>
              <Button size="small" style={{ marginTop: 8 }} onClick={onRetry}>
                Повторить
              </Button>
            </>
          }
        />
      ) : !preview ? (
        <Alert
          type="info"
          icon={<Spin size="small" />}
          showIcon
          title="Выясняем, что снимет возврат"
          description="Перечень считает сервер — тем же планом, которым потом исполнит возврат."
        />
      ) : (
        <ConsequencesAlert request={request} preview={preview} />
      )}
    </Space>
  );
}

function ConsequencesAlert({
  request,
  preview,
}: {
  request: VehicleRequestDto;
  preview: VehicleRequestRollbackPreviewDto;
}) {
  const erase = eraseLines(request, preview);
  const keep = keepLines(preview);
  return (
    <Alert
      type="warning"
      showIcon
      title="Заявка вернётся в состояние только что заведённой"
      description={
        <>
          {erase.length > 0 ? (
            <>
              Будет стёрто:
              <ul style={listStyle}>
                {erase.map((line) => (
                  <li key={line.key}>{line.text}</li>
                ))}
              </ul>
            </>
          ) : (
            // The server answered so — this is the truth about the request, not a list that failed
            // to load: an empty "will be erased" list reads as a breakage.
            'Стирать у заявки нечего — сменится только статус.'
          )}
          {keep.length > 0 && (
            <>
              <div style={{ marginTop: 8 }}>Останется как есть:</div>
              <ul style={listStyle}>
                {keep.map((line) => (
                  <li key={line.key}>{line.text}</li>
                ))}
              </ul>
            </>
          )}
        </>
      }
    />
  );
}
