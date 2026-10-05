import { Alert, Button, Space, Spin } from 'antd';
import {
  assignmentRateLabel,
  assignmentTitle,
  completionLabel,
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
 * human is the portal's business. That is why the vehicle and the presented fact are read off the
 * request itself: the preview says `assignment: true`, and the registration number with the rate
 * lives only in the request DTO. A line that told the human more than the plan does — «every
 * relocation goes» — is exactly the defect this window was built to end.
 *
 * A file of its own rather than lines inside the lifecycle hook: the hook is the conversation with
 * the server (ask on open, confirm with the fingerprint, ask again on a 409), and this is sixty
 * lines of solid text. Same split as `RollbackPreview` of the assign window (ADR 0178).
 */

interface Props {
  /** Названия стираемого: номер машины, ставка, предъявленный факт — их знает только заявка. */
  request: VehicleRequestDto;
  /** `null` — ответа ещё нет: обещать нечего, и окно показывает ожидание. */
  preview: VehicleRequestRollbackPreviewDto | null;
  /**
   * Почему последствия не прочитаны. Показывается вместо перечня: нажать «Вернуть» человек всё
   * равно сможет (отпечаток у двери необязателен, ADR 0211 решение 4, и возврат не должен
   * заклиниваться из-за недоступного предпросмотра) — но вслепую, и об этом сказано прямо.
   */
  failure: string | null;
  /** Почему перечень пересчитан сам: дверь отказала по устаревшему отпечатку. */
  staleReason: string | null;
  onRetry: () => void;
}

interface Line {
  key: string;
  text: string;
}

/** «1 строка» / «2 строки» / «5 строк»: число дней работ читают вслух, и «строк(и)» тут не годится. */
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

/** Что возврат снимет. Порядок — от договорённости к бумаге: так о потере и рассказывают. */
function eraseLines(request: VehicleRequestDto, p: VehicleRequestRollbackPreviewDto): Line[] {
  const lines: Line[] = [];
  if (p.assignment && request.assignment) {
    // Ставки называют ту самую коммерческую договорённость, которая снимается; у аренды без
    // согласованных ставок называется арендодатель — с ним договаривались, ему и звонить.
    const detail = assignmentRateLabel(request.assignment) || request.assignment.lessorName;
    lines.push({
      key: 'assignment',
      text: `Назначенная техника: ${assignmentTitle(request.assignment)}${detail ? ` — ${detail}` : ''}`,
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
      // Подписанный день бывает только за пределами срока: внутри срока он возврат запирает, а
      // дверь удаляет строки по заявке целиком — и молчать о принятых часах нельзя.
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
    // Номера бланков строгой отчётности открыты только журналу (ADR 0106): без него счётчик — и
    // есть полный ответ на вопрос «сгорит ли бумага».
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
  if (p.completion && request.completion) {
    lines.push({
      key: 'completion',
      text: `Предъявленный факт: ${completionLabel(request.completion)}`,
    });
  }
  return lines;
}

/** Что останется, хотя человек ждёт обратного, — и почему. Молчание здесь и обещало лишнее. */
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
      {/* Помеха — выше перечня: при ней не случится ничего из того, что ниже, и читать перечень
        раньше запрета значило бы читать его зря. Текст — тот же, которым откажет дверь. */}
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
            // Так ответил сервер — значит это и есть правда о заявке, а не недогрузившийся
            // список: пустой перечень «будет стёрто» человек читает как поломку.
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
