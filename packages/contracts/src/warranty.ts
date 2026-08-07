/**
 * Состояние гарантии (ADR 0085).
 *
 * Гарантию в портале несут три носителя: сама единица оргтехники (гарантия поставщика), запчасть и
 * услуга в смете ремонта. Показывается она в пяти местах — справочник, карточка единицы, форма
 * заявки, карточка заявки, реестр гарантий, — и во всех пяти должна выглядеть одинаково.
 *
 * Поэтому состояние считает **одна** функция, а не пять сравнений дат по месту: у «истекает скоро»
 * есть порог, и стоит ему разъехаться между экранами, как одна и та же гарантия окажется жёлтой в
 * списке и зелёной в карточке. Функция чистая и принимает «сегодня» аргументом — тесты проверяют
 * границы, не подменяя часы.
 */

/** За сколько дней до конца гарантия считается истекающей. */
export const WARRANTY_EXPIRING_DAYS = 30;

export const WARRANTY_STATES = ['active', 'expiring', 'expired', 'none'] as const;
export type WarrantyState = (typeof WARRANTY_STATES)[number];

/**
 * Дата окончания гарантии — календарные сутки (`YYYY-MM-DD`), а не момент времени: гарантия
 * действует «по такое-то число», и часовой пояс сдвигал бы её на день (тот же приём, что у
 * `dateOnlySchema` в common.ts). Поэтому сравниваются строки дат, а не `Date`.
 */
function daysBetween(fromIso: string, toIso: string): number | null {
  const from = Date.parse(`${fromIso}T00:00:00Z`);
  const to = Date.parse(`${toIso}T00:00:00Z`);
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  return Math.round((to - from) / 86_400_000);
}

/** Сегодняшняя дата в календарных сутках Москвы — «сегодня» для гарантии одно на весь портал. */
export function warrantyToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/**
 * Состояние гарантии на указанный день. `null`/пустая дата — `none`: срок не заведён, и это не то
 * же самое, что истёкшая гарантия — «неизвестно» нельзя показывать как «нет».
 *
 * День окончания входит в гарантию: `until === today` — ещё `expiring`, а не `expired`.
 */
export function warrantyState(
  until: string | null | undefined,
  today: string = warrantyToday(),
): WarrantyState {
  if (!until) return 'none';
  const left = daysBetween(today, until);
  if (left === null) return 'none';
  if (left < 0) return 'expired';
  return left <= WARRANTY_EXPIRING_DAYS ? 'expiring' : 'active';
}

/** Сколько дней осталось; отрицательное — сколько прошло с окончания. `null` — срок не задан. */
export function warrantyDaysLeft(
  until: string | null | undefined,
  today: string = warrantyToday(),
): number | null {
  if (!until) return null;
  return daysBetween(today, until);
}

/** Действует ли гарантия на указанный день — предикат для проверок сервера и подсказок формы. */
export function isWarrantyActive(
  until: string | null | undefined,
  today: string = warrantyToday(),
): boolean {
  const state = warrantyState(until, today);
  return state === 'active' || state === 'expiring';
}

/** Цвета тега — рядом с состоянием: подсветка обязана совпадать во всех списках. */
export const warrantyStateColors: Record<WarrantyState, string> = {
  active: 'green',
  expiring: 'gold',
  expired: 'default',
  none: 'default',
};

function formatDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}

/**
 * Подпись тега. Пустая строка у `none` — списку нечего показывать, и прочерк он ставит сам:
 * выдуманное «гарантии нет» утверждало бы то, чего портал не знает.
 */
export function warrantyLabel(
  until: string | null | undefined,
  today: string = warrantyToday(),
): string {
  const state = warrantyState(until, today);
  if (state === 'none' || !until) return '';
  const date = formatDate(until);
  if (state === 'expired') return `истекла ${date}`;
  return state === 'expiring' ? `истекает ${date}` : `до ${date}`;
}
