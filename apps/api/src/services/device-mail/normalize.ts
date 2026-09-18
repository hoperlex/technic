import { deviceErrorClasses, metricUnits, parsedDeviceMessageSchema } from '@technic/contracts';
import type {
  DeviceErrorClass,
  DeviceErrorCode,
  DeviceEventInput,
  DeviceMailContext,
  DeviceObservationInput,
  DeviceProfile,
  MetricUnit,
  ParsedDeviceMessage,
} from '@technic/contracts';
import { limitIdentityHints, type ProfileParseResult } from './profiles/types';

/**
 * Поля профиля → снимок разбора письма (план `docs/office-equipment-mail-telemetry-plan.md` §8,
 * `normalize.ts`; Р20, Р22, Р33).
 *
 * Слой отвечает ровно за то, чего профиль знать не обязан и о чём договариваются все источники
 * сразу — почта сегодня, коллектор Этапа 2 завтра:
 *
 * - **единица берётся из реестра метрик и сверяется** (Р22). Разошлась — письмо уходит в `failed` с
 *   кодом `unit_mismatch`, а не пишется: две копии единицы, которые «как-нибудь разойдутся», — это
 *   ровно то, от чего предостерегает правило одного места;
 * - **событию назначается `ordinal`** — порядковый номер вхождения кода внутри одного письма
 *   (Р33). Он часть уникального ключа `(source, source_ref, event_code, ordinal)`, и без него
 *   второе замятие того же письма гасило бы первое;
 * - **разрез проверяется на неповторимость**. Ключ наблюдения — `(source, source_ref, metric_code,
 *   component)`, и два одинаковых разреза в одном письме уткнулись бы в него уже при записи —
 *   пятисоткой из глубины транзакции вместо внятной причины в очереди.
 *
 * Снимок применяется КАК ЕСТЬ, когда человек привяжет аппарат, — и потому сверка с реестром идёт
 * здесь, на горячем разборе, и только здесь (Р20).
 */

/** Отказ разбора с обеими осями сразу — образец `apps/worker/src/ticket-ocr/errors.ts`. */
export class DeviceParseError extends Error {
  readonly code: DeviceErrorCode;
  readonly errorClass: DeviceErrorClass;
  /** Человеческая причина: она уезжает в `error_text` строки письма и дальше в очередь. */
  readonly reason: string;

  constructor(code: DeviceErrorCode, reason: string, cause?: unknown) {
    super(`${code}: ${reason}`, { cause });
    this.name = 'DeviceParseError';
    this.code = code;
    this.errorClass = deviceErrorClasses[code];
    this.reason = reason;
  }
}

/**
 * Назначение `ordinal` — порядкового номера вхождения кода внутри одного письма (Р33).
 *
 * Поле объявлено в контракте (`deviceEventInputSchema`), и второго типа поверх него здесь нет
 * намеренно: свой `…WithOrdinal` был бы вторым носителем одного правила и разошёлся бы с первым
 * молча. Считает номера **и** разбор, **и** применение снимка (A4) — функция одна, тоже намеренно.
 *
 * Операция идемпотентна: номер выводится из порядка массива, а прежнее значение перезаписывается,
 * — поэтому повторный прогон снимка через неё ничего не меняет, а повторный разбор того же письма
 * тем же профилем даёт те же номера.
 */
export function assignEventOrdinals(events: readonly DeviceEventInput[]): DeviceEventInput[] {
  const seen = new Map<string, number>();
  return events.map((event) => {
    const used = seen.get(event.eventCode) ?? 0;
    seen.set(event.eventCode, used + 1);
    return { ...event, ordinal: used };
  });
}

function checkUnits(observations: readonly DeviceObservationInput[]): void {
  for (const item of observations) {
    const expected = metricUnits[item.metricCode] as MetricUnit | undefined;
    // Кода нет в реестре — это не расхождение единицы, и причина у него своя. Сообщение
    // «измеряется в «undefined»» отправляло бы разбираться с реестром метрик вместо профиля,
    // а реестр append-only (Р20) и сам собой пополниться не мог.
    if (expected === undefined) {
      throw new DeviceParseError(
        'extract_failed',
        `кода метрики «${item.metricCode}» нет в реестре метрик контракта`,
      );
    }
    if (item.unit !== expected) {
      throw new DeviceParseError(
        'unit_mismatch',
        `метрика ${item.metricCode} измеряется в «${expected}», а разбор дал «${item.unit}»`,
      );
    }
  }
}

function checkComponents(observations: readonly DeviceObservationInput[]): void {
  const seen = new Set<string>();
  for (const item of observations) {
    const key = `${item.metricCode}|${item.component}`;
    if (seen.has(key)) {
      throw new DeviceParseError(
        'extract_failed',
        `в одном письме дважды разобран показатель ${item.metricCode} с разрезом «${item.component}»`,
      );
    }
    seen.add(key);
  }
}

/**
 * Результат профиля → снимок письма. Профиль здесь уже отработал: этот вход нужен там, где разбор и
 * проверка разнесены (перечитывание, прогон на фикстурах).
 */
export function normalizeProfileResult(
  profile: Pick<DeviceProfile, 'code' | 'version'>,
  result: ProfileParseResult,
): ParsedDeviceMessage {
  checkUnits(result.observations);
  checkComponents(result.observations);
  const parsed = parsedDeviceMessageSchema.safeParse({
    profileCode: profile.code,
    parserVersion: profile.version,
    observations: result.observations,
    events: result.events,
    // Границы подсказок — свойство снимка, а не аккуратности отдельного профиля: вендорский
    // профиль, забывший про них, потерял бы всё письмо (см. `limitIdentityHints`).
    identity: limitIdentityHints(result.identity),
  });
  if (!parsed.success) {
    // Профиль отдал поле, которого контракт не принимает (чаще всего — значение не того вида).
    // Это `extract_failed`, а не пятисотка: письмо принято, сырьё лежит, кнопка «перечитать» жива.
    const first = parsed.error.issues[0];
    const where = first ? first.path.join('.') : 'снимок';
    const why = first ? first.message : 'форма снимка не принята контрактом';
    throw new DeviceParseError(
      'extract_failed',
      `профиль ${profile.code} отдал поле не по контракту: ${where} — ${why}`,
      parsed.error,
    );
  }
  // Номера считаются ПОСЛЕ проверки схемы, и порядок здесь несущий: `safeParse` возвращает свои
  // объекты и применяет умолчания (у `ordinal` умолчание — ноль). Занумеруй до проверки — и в
  // снимок уедет то, что отдала схема, а не то, что посчитал разбор; занумеруй после — номер
  // стоит ровно в тех данных, которые лягут в `parsed_payload`.
  return { ...parsed.data, events: assignEventOrdinals(parsed.data.events) };
}

/**
 * Полный разбор одним вызовом: профиль читает письмо, нормализатор сверяет и собирает снимок.
 *
 * Исключение профиля не выпускается наружу как есть: любая неожиданность внутри чтения полей —
 * это `extract_failed` (terminal), и письмо закрывается строкой с причиной. Незавёрнутое
 * исключение ушло бы в общий обработчик ошибок приложения, а тот, по §9.1 п. 7, читается снаружи
 * как пауза — и ящик встал бы навсегда из-за одного кривого письма.
 */
export function normalizeParsedMessage(
  profile: DeviceProfile,
  ctx: DeviceMailContext,
): ParsedDeviceMessage {
  try {
    // Сборка снимка стоит ВНУТРИ того же `try`: профиль, отдавший малоформатный объект (нет
    // массива наблюдений, `identity` не объект), ронял бы голый `TypeError` уже в проверках
    // нормализатора — а он снаружи читается как пауза и останавливает ящик.
    return normalizeProfileResult(profile, profile.parse(ctx));
  } catch (error) {
    if (error instanceof DeviceParseError) throw error;
    const reason = error instanceof Error ? error.message : String(error);
    throw new DeviceParseError(
      'extract_failed',
      `профиль ${profile.code} не смог прочитать письмо: ${reason}`,
      error,
    );
  }
}
