import { z } from 'zod';

/**
 * The client floor a release requires, and the one comparison that decides it (ADR 0226; the gate
 * itself is ADR 0146 decision 7, `src/lib/client-contract.ts`).
 *
 * Two readers ask the same question, and both must get the same answer:
 *
 * - the API at startup (`src/config.ts`): in production it refuses to start when
 *   `MIN_CLIENT_CONTRACT` is below the release's requirement;
 * - `deploy-auto` before any migration (`scripts/client-floor-check.ts`, run in the candidate
 *   image): without it that refusal surfaces only at the health check — after the dump, after the
 *   migrations, with the old containers already replaced.
 *
 * That is why this module has no side effects and imports nothing from the application: the
 * preflight cannot import `src/config.ts`, which validates the whole environment on import and would
 * die on the very mismatch it is supposed to report.
 */

/**
 * Lowest `MIN_CLIENT_CONTRACT` this release's API starts with in production.
 *
 * Raised only by a release that removes something older bundles still read or write, and only
 * after the operator has raised the floor on production (`deploy-auto --client-floor=N`, which
 * itself refuses a floor above the served bundle's contract). It never exceeds the
 * `CLIENT_CONTRACT` of the bundle built from the same commit — a test pins that, because such a
 * release would answer 426 to its own freshly opened tabs.
 *
 * 3 — release 2 "Заморозка" removed `parts` from the maintenance act DTO and the `/auto-parts`
 * routes (`docs/auto-part-receipts-plan.md`, R22, R23).
 */
export const REQUIRED_CLIENT_FLOOR = 3;

/**
 * What a tab below the floor would hit. Printed by both refusals and rewritten together with
 * `REQUIRED_CLIENT_FLOOR`: the person who reads it decides whether the floor operation is safe, and
 * a reason left over from the previous raise would describe the wrong release.
 */
export const REQUIRED_CLIENT_FLOOR_REASON =
  'старые вкладки получат ответ без `parts` и 404 на `/auto-parts` (выпуск «Заморозка») — то есть белый экран журнала ТО';

/**
 * `MIN_CLIENT_CONTRACT` exactly as the API parses it; `src/config.ts` uses this schema, so the
 * preflight cannot read the value differently. Unset is the default 1 (phase A: nobody is
 * blocked); an empty, fractional or non-numeric value fails validation, and the API would not start
 * at all.
 *
 * Nothing below one: a request without the header is read as contract 1, so floor 0 would differ
 * from 1 only in how the configuration looks.
 */
export const minClientContractSchema = z.coerce.number().int().min(1).default(1);

/** The single comparison. "Not below", not "equal": the floor rises release after release. */
export function clientFloorSatisfied(
  configured: number,
  required: number = REQUIRED_CLIENT_FLOOR,
): boolean {
  return configured >= required;
}

/**
 * The startup refusal. It names the command, not the condition: whoever reads it has an API that
 * did not come up and wants to know what to run.
 */
export function clientFloorStartupError(
  configured: number,
  required: number = REQUIRED_CLIENT_FLOOR,
): string {
  return (
    `Этот выпуск требует MIN_CLIENT_CONTRACT >= ${required}, сейчас ${configured}: ` +
    `сначала deploy-auto --client-floor=${required}, потом этот выкат. ` +
    `Иначе ${REQUIRED_CLIENT_FLOOR_REASON}.`
  );
}

export type ClientFloorVerdict =
  /** `defaulted`: the variable is unset and the API takes 1 — worth saying, it is rarely meant. */
  | { kind: 'pass'; required: number; configured: number; defaulted: boolean }
  | { kind: 'below'; required: number; configured: number; defaulted: boolean }
  /** The API would fail validation before it ever compared floors. */
  | { kind: 'unreadable'; required: number; raw: string };

/**
 * Verdict on the raw environment value, as the API of this release would reach it.
 *
 * Unset is judged as the default 1 and not as "unknown, let it pass": the preflight predicts the
 * API's own startup check, and the API reads unset as 1. A softer reading would pass a release that
 * then refuses to start; a stricter one would refuse a release that starts fine.
 */
export function judgeClientFloor(
  raw: string | undefined,
  required: number = REQUIRED_CLIENT_FLOOR,
): ClientFloorVerdict {
  const parsed = minClientContractSchema.safeParse(raw);
  if (!parsed.success) return { kind: 'unreadable', required, raw: raw ?? '' };
  const configured = parsed.data;
  const defaulted = raw === undefined;
  return clientFloorSatisfied(configured, required)
    ? { kind: 'pass', required, configured, defaulted }
    : { kind: 'below', required, configured, defaulted };
}

/**
 * Contract of the bundle being served now, as `deploy-auto` passes it (read from the running
 * revision's `clientContract.ts`). Empty or malformed means unknown: it only shapes the advice, never
 * the verdict.
 */
export function parseServedContract(raw: string | undefined): number | null {
  if (raw === undefined || !/^[1-9]\d*$/.test(raw.trim())) return null;
  return Number(raw.trim());
}

/** Exit code of a refusal; any other non-zero code means the check itself did not run. */
export const CLIENT_FLOOR_REFUSED = 3;

/**
 * Last stdout line of the CLI, the only thing `deploy-auto` treats as an answer. An exit code alone
 * is not enough: `pnpm --filter <pkg> <script>` exits 0 in silence when the package has no such
 * script, so an image without the check would read as a pass. The `journal ok` marker of
 * `migration-report.ts` exists for the same reason.
 */
export const CLIENT_FLOOR_PASS_MARKER = 'client-floor pass';
export const CLIENT_FLOOR_REFUSED_MARKER = 'client-floor refused';

export interface ClientFloorReport {
  exitCode: 0 | typeof CLIENT_FLOOR_REFUSED;
  lines: string[];
}

/** The configured side of a judged verdict, as the operator would look for it in `prod.env`. */
function configuredText(verdict: { configured: number; defaulted: boolean }): string {
  return verdict.defaulted
    ? 'MIN_CLIENT_CONTRACT не задан (сервер берёт 1)'
    : `MIN_CLIENT_CONTRACT=${verdict.configured}`;
}

/** A raw value goes into the deploy log, so it is cut: the variable is not a secret, junk is noise. */
function shown(raw: string): string {
  return raw.length > 40 ? `${raw.slice(0, 40)}…` : raw;
}

const NOTHING_CHANGED =
  '  Ничего не изменено: дамп не снят, миграции не накатаны, контейнеры прежние.';

/**
 * What to run when the floor is too low. The served contract decides it, because
 * `deploy-auto --client-floor=N` refuses a floor above it: advising that command to a site that
 * serves an older bundle would send the operator into a second refusal.
 */
function adviceForBelow(required: number, served: number | null): string[] {
  if (served === null) {
    return [
      '  Контракт раздаваемой сборки прочитать не удалось: deploy-auto --client-floor покажет его.',
      `  Если он не ниже ${required} — deploy-auto --client-floor=${required}, затем повторите deploy-auto;`,
      `  если ниже — сначала выпуск, чья сборка несёт CLIENT_CONTRACT не ниже ${required} (ADR 0226).`,
    ];
  }
  if (served >= required) {
    return [
      `  Раздаётся контракт ${served} — пол можно поднять, затем повторить выкат:`,
      `    deploy-auto --client-floor=${required}`,
      '    deploy-auto',
    ];
  }
  return [
    `  Раздаётся контракт ${served} — ниже ${required}, и deploy-auto --client-floor=${required} откажет:`,
    '  так портал закрылся бы для всех. Сначала выкатите выпуск, чья сборка несёт CLIENT_CONTRACT',
    `  не ниже ${required}, а REQUIRED_CLIENT_FLOOR ещё прежний; затем deploy-auto --client-floor=${required}`,
    '  и этот выкат (ADR 0226).',
  ];
}

/** The preflight's whole output: printed by `deploy-auto`, so every refusal says what to run. */
export function clientFloorPreflight(
  verdict: ClientFloorVerdict,
  served: number | null,
): ClientFloorReport {
  if (verdict.kind === 'pass') {
    return {
      exitCode: 0,
      lines: [
        `пол клиента: релиз требует не ниже ${verdict.required}, в prod.env ${configuredText(verdict)} — пройдено`,
      ],
    };
  }

  if (verdict.kind === 'unreadable') {
    const ceiling = served === null ? 'не прочитан' : `${served}`;
    return {
      exitCode: CLIENT_FLOOR_REFUSED,
      lines: [
        `ОТКАЗ: MIN_CLIENT_CONTRACT в prod.env не читается как целое не меньше 1 («${shown(verdict.raw)}»):`,
        '  technic-api с таким значением не стартует вовсе, и упал бы уже после наката миграций.',
        NOTHING_CHANGED,
        `  Перепишите строку командой deploy-auto --client-floor=N: релизу нужен N не ниже ${verdict.required},`,
        `  а команда примет N не выше контракта раздаваемой сборки (${ceiling}). Затем повторите deploy-auto.`,
      ],
    };
  }

  return {
    exitCode: CLIENT_FLOOR_REFUSED,
    lines: [
      `ОТКАЗ: релиз требует пол клиента не ниже ${verdict.required} (REQUIRED_CLIENT_FLOOR), а в prod.env ${configuredText(verdict)}.`,
      '  С таким полом technic-api этого релиза не стартует в production и упал бы уже после наката',
      '  миграций.',
      NOTHING_CHANGED,
      `  Зачем релизу этот пол: ${REQUIRED_CLIENT_FLOOR_REASON}.`,
      ...adviceForBelow(verdict.required, served),
    ],
  };
}
