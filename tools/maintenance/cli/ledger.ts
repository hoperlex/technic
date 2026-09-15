/**
 * Журнал находок глазами человека: посмотреть и решить.
 *
 * ПОЧЕМУ ЭТА КОМАНДА ВООБЩЕ НУЖНА. Журнал придуман ради того, чтобы решение человека («это
 * осознанный долг», «это ложное срабатывание») не спрашивалось каждый прогон заново. Но записывать
 * такое решение было нечем: цикл сам помечает невзятое как «отложено», а сказать «не спрашивайте
 * про это больше» человек не мог никак — только править JSON руками. Журнал, в который нельзя
 * ответить, помнит лишь то, что система придумала о себе сама.
 */
import path from 'node:path';
import type { MaintenanceConfig } from '../core/config.ts';
import type { Reporter } from '../core/contracts.ts';
import type { LedgerStatus } from '../state/ledger.ts';
import { JsonFindingStore, decide } from '../state/ledger.ts';
import { ensureWorkspace } from '../state/workspace.ts';
import type { CommandResult } from './commands.ts';

const STATUSES: readonly LedgerStatus[] = [
  'new',
  'accepted-debt',
  'deferred',
  'false-positive',
  'fixed',
  'reopened',
];

/** Что значит статус для следующего прогона — человеку важно именно это, а не само слово. */
const MEANING: Record<LedgerStatus, string> = {
  new: 'встретилась впервые, пойдёт агенту',
  'accepted-debt': 'осознанный долг: спрашивать не будут, пока не изменится код или правило',
  deferred: 'отложено: вернётся по сроку пересмотра',
  'false-positive': 'ложное срабатывание: молчит дольше, но тоже не вечно',
  fixed: 'починено: встретится снова — будет регрессией',
  reopened: 'переоткрыто: обстоятельства изменились, пойдёт агенту',
};

export interface LedgerArgs {
  /** Отпечаток находки, по которой принимается решение. Хватает первых символов. */
  readonly fingerprint: string | null;
  readonly status: LedgerStatus | null;
  readonly note: string | null;
  readonly filter: LedgerStatus | null;
}

export async function ledger(
  config: MaintenanceConfig,
  out: Reporter,
  args: LedgerArgs,
): Promise<CommandResult> {
  const workspace = ensureWorkspace(config.runtimeDir);
  const file = path.join(workspace.state, 'ledger.json');
  const store = new JsonFindingStore(file);
  const entries = await store.load();

  if (args.fingerprint !== null) {
    if (args.status === null) {
      out.error('вместе с отпечатком нужен --status: одно только имя записи ничего не решает');
      out.item(`допустимые: ${STATUSES.join(', ')}`);
      return { ok: false };
    }
    /*
     * Отпечаток разрешено сокращать: в отчётах он длинный, а руками его набирают. Но неоднозначное
     * сокращение — отказ, а не «возьмём первое совпавшее»: решение по чужой находке человек не
     * заметит, и она замолчит на полгода.
     */
    const matched = entries.filter((entry) => entry.fingerprint.startsWith(args.fingerprint ?? ''));
    if (matched.length === 0) {
      out.error(`записи с отпечатком ${args.fingerprint} в журнале нет`);
      return { ok: false };
    }
    if (matched.length > 1) {
      out.error(`отпечаток ${args.fingerprint} подходит ${matched.length} записям — уточните`);
      for (const entry of matched) out.item(`${entry.fingerprint} — ${entry.title}`);
      return { ok: false };
    }

    const target = matched[0];
    if (target === undefined) return { ok: false };
    const updated = decide(entries, target.fingerprint, args.status, {
      note: args.note ?? undefined,
      now: new Date(),
    });
    await store.save(updated);
    out.heading('решение записано');
    out.item(`${target.title}`);
    out.item(`${target.fingerprint} → ${args.status}: ${MEANING[args.status]}`);
    if (args.note !== null) out.item(`причина: ${args.note}`);
    return { ok: true };
  }

  const shown = args.filter === null ? entries : entries.filter((e) => e.status === args.filter);
  out.heading(`журнал находок — ${shown.length} из ${entries.length}`);
  if (entries.length === 0) {
    out.item('журнал пуст: ни один прогон ещё не разобрал ни одной находки');
    return { ok: true };
  }
  for (const entry of shown) {
    out.item(`${entry.fingerprint.slice(0, 8)} [${entry.status}] ${entry.title}`);
    out.line(`      ${entry.files.join(', ')}`);
    if (entry.note !== undefined) out.line(`      причина: ${entry.note}`);
  }
  out.line();
  out.item('решение: maintain ledger --finding <отпечаток> --status <статус> [--note "почему"]');
  return { ok: true };
}

/** Разбор статуса из аргумента: слово вне словаря — отказ, а не молчаливое умолчание. */
export function parseStatus(value: string | null): LedgerStatus | null {
  if (value === null) return null;
  const found = STATUSES.find((status) => status === value);
  if (found === undefined) {
    throw new Error(`статус ${value} не из словаря: ${STATUSES.join(', ')}`);
  }
  return found;
}
