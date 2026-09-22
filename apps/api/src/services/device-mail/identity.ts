import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import {
  normalizeIdentityValue,
  type DeviceIdentityHints,
  type DeviceIdentityKind,
  type DeviceMessageStatus,
} from '@technic/contracts';
import type { db } from '../../db/client';
import { deviceMailIdentities, officeEquipment } from '../../db/schema';

/**
 * Резолв «письмо → карточка аппарата» (план `docs/office-equipment-mail-telemetry-plan.md`, §6,
 * Р9).
 *
 * САМОЕ ДОРОГОЕ МЕСТО ВОЛНЫ. Ошибка здесь приписывает чужую наработку живой карточке, и заметить
 * это некому: счётчик МФУ никто не помнит наизусть, а месячная дельта следующего этапа посчитается
 * по испорченному ряду молча. Поэтому здесь нет ни одной ветки «похоже, подходит»: исход либо
 * однозначный, либо его нет.
 *
 * ПОРЯДОК СТРОГИЙ, И ПЕРВЫЙ ОДНОЗНАЧНЫЙ ВЫИГРЫВАЕТ (Р9):
 *
 * 1. подтверждённая человеком ЖИВАЯ привязка `device_mail_identities` — по ЛЮБОМУ ключу письма;
 *    снятая (`revoked_at`) не опознаёт ничего и остаётся только объяснением прошлого;
 * 2. серийный номер письма → `office_equipment.serial_number`;
 * 3. инвентарный номер → `office_equipment.inventory_number`;
 * 4. имя устройства и сетевое имя — ТОЛЬКО через п. 1, сами по себе не матчат никогда;
 * 5. IP не матчит ни при каких условиях.
 *
 * Пункты 4 и 5 — не забытые ветки, а обязательства. Имя устройства ИТ-служба меняет при переезде
 * аппарата в другой кабинет, а после DHCP по вчерашнему адресу стоит другой принтер: обе подсказки
 * показываются человеку в очереди и обе не имеют права решать за него. Ровно поэтому шага
 * «поискать имя устройства среди названий карточек» в этом файле нет и быть не должно; единственный
 * путь для имени — привязка, заведённая руками.
 *
 * СТУПЕНЬ, ДАВШАЯ ДВУХ КАНДИДАТОВ, ОСТАНАВЛИВАЕТ РЕЗОЛВ. Провалиться с двух подтверждённых
 * привязок на серийник значило бы: человек однажды сказал «это аппарат A», потом сказал «это
 * аппарат B», а портал молча выбрал третьего — по номеру из письма. Противоречие разбирает человек,
 * и до разбора письмо лежит в очереди, а карточки не тронуты.
 */

/** Транзакция drizzle либо сам пул: резолв ничего не пишет и живёт в любом из двух. */
export type TelemetryReader = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Ключ письма в том виде, в каком его сравнивают: род плюс нормализованное значение. */
export interface DeviceIdentityKey {
  kind: DeviceIdentityKind;
  /** Нормализовано `normalizeIdentityValue` — той же формой, что уникальные индексы карточки. */
  value: string;
}

export interface DeviceIdentityCandidate extends DeviceIdentityKey {
  equipmentId: string;
}

export type DeviceIdentityResolution =
  | {
      status: 'matched';
      equipmentId: string;
      /** Чем опознали: очередь и журнал обязаны уметь ответить «почему это он». */
      by: DeviceIdentityKey;
    }
  | { status: 'unmatched'; candidates: [] }
  | {
      /** Двое и более — карточки не трогаются вовсе, письмо ждёт человека. */
      status: 'ambiguous';
      candidates: DeviceIdentityCandidate[];
    };

/**
 * Что резолв берёт из письма. Подсказки разбора плюс два адреса конверта: они живут не в
 * `DeviceIdentityHints`, а в `DeviceMailContext` (конверт — свойство письма, а не разбора), и без
 * них п. 1 не увидел бы привязки, заведённой по адресу отправителя.
 */
export interface DeviceIdentityLookup {
  hints: DeviceIdentityHints;
  fromAddress?: string | null;
  envelopeTo?: string | null;
}

/** Как род и значение складываются в один ключ множества. Разделитель — вертикальная черта. */
function token(kind: DeviceIdentityKind, value: string): string {
  return `${kind}|${value}`;
}

/**
 * Ключи письма — нормализованные, без пустых и без повторов.
 *
 * `ip` и `model` сюда не попадают ни при каком значении, и это утверждение файла: IP не опознаёт
 * (п. 5), а модель — не ключ вовсе, аппаратов одной модели в парке сотни.
 */
export function identityKeysOf(lookup: DeviceIdentityLookup): DeviceIdentityKey[] {
  const raw: [DeviceIdentityKind, string | null | undefined][] = [
    ['serial', lookup.hints.serial],
    ['inventory', lookup.hints.inventory],
    ['deviceName', lookup.hints.deviceName],
    ['host', lookup.hints.host],
    ['envelopeTo', lookup.envelopeTo],
    ['fromAddress', lookup.fromAddress],
  ];
  const seen = new Set<string>();
  const keys: DeviceIdentityKey[] = [];
  for (const [kind, value] of raw) {
    if (typeof value !== 'string') continue;
    const normalized = normalizeIdentityValue(value);
    if (normalized === '') continue;
    if (seen.has(token(kind, normalized))) continue;
    seen.add(token(kind, normalized));
    keys.push({ kind, value: normalized });
  }
  return keys;
}

/**
 * Карточка в той же форме, в какой её держат уникальные индексы номеров: `upper(btrim(...))` среди
 * ЖИВЫХ записей.
 *
 * Живых — не из осторожности. Оба индекса частичные (`deleted_at IS NULL`), то есть снятая карточка
 * номер не держит и тот же серийник законно принадлежит новой. Считай архивные кандидатами — и
 * замена аппарата с переносом номера давала бы либо вечный `ambiguous`, либо наработку, уехавшую в
 * карточку, которой никто не видит.
 */
async function equipmentByNumber(
  reader: TelemetryReader,
  column: typeof officeEquipment.serialNumber | typeof officeEquipment.inventoryNumber,
  normalized: string,
): Promise<string[]> {
  const rows = await reader
    .select({ id: officeEquipment.id })
    .from(officeEquipment)
    .where(and(isNull(officeEquipment.deletedAt), sql`upper(btrim(${column})) = ${normalized}`));
  return rows.map((row) => row.id);
}

/** Исход одной ступени: ноль кандидатов — идём дальше, один — победа, двое — стоп. */
function step(candidates: DeviceIdentityCandidate[]): DeviceIdentityResolution | null {
  const ids = new Set(candidates.map((candidate) => candidate.equipmentId));
  if (ids.size === 0) return null;
  if (ids.size === 1) {
    const first = candidates[0]!;
    return {
      status: 'matched',
      equipmentId: first.equipmentId,
      by: { kind: first.kind, value: first.value },
    };
  }
  return { status: 'ambiguous', candidates };
}

/**
 * Резолв аппарата по подсказкам разбора. Ничего не пишет и никого не трогает: единственное, что он
 * умеет, — назвать карточку либо честно признаться, что не может.
 */
export async function resolveDeviceIdentity(
  reader: TelemetryReader,
  lookup: DeviceIdentityLookup,
): Promise<DeviceIdentityResolution> {
  const keys = identityKeysOf(lookup);

  // ── 1. Подтверждённые привязки, по любому ключу письма ──
  //
  // Одним запросом по всем ключам, а не ступенькой на каждый род: привязка — это уже решение
  // человека, и спор двух его решений обязан быть виден целиком, а не гаситься порядком родов.
  if (keys.length > 0) {
    const bound = await reader
      .select({
        equipmentId: deviceMailIdentities.equipmentId,
        kind: deviceMailIdentities.keyKind,
        value: deviceMailIdentities.keyValue,
      })
      .from(deviceMailIdentities)
      // Привязка на снятую карточку не опознаёт — по той же причине, по какой не опознают её
      // номера: номер снятой карточки свободен, и новая карточка обязана матчиться сама.
      .innerJoin(
        officeEquipment,
        and(
          eq(officeEquipment.id, deviceMailIdentities.equipmentId),
          isNull(officeEquipment.deletedAt),
        ),
      )
      .where(
        and(
          // Снятая привязка не опознаёт: человек сказал «это больше не он», и резолв обязан
          // услышать это раньше, чем сравнит хоть одно значение (план
          // `docs/office-equipment-mail-identity-ui-plan.md`, §5.1).
          isNull(deviceMailIdentities.revokedAt),
          inArray(
            deviceMailIdentities.keyKind,
            keys.map((key) => key.kind),
          ),
          inArray(
            deviceMailIdentities.keyValue,
            keys.map((key) => key.value),
          ),
        ),
      );
    // Пара «род плюс значение» сходится здесь, а не в условии запроса: «род из списка И значение из
    // списка» шире пары и поймало бы привязку по серийнику ABC, когда в письме серийник XYZ, а ABC
    // стоит инвентарным. Раскладывать это в перечисление пар — тот же ответ, только длиннее и без
    // индекса на длинном списке.
    const wanted = new Set(keys.map((key) => token(key.kind, key.value)));
    const candidates = bound
      .filter((row) => wanted.has(token(row.kind as DeviceIdentityKind, row.value)))
      .map((row) => ({
        equipmentId: row.equipmentId,
        kind: row.kind as DeviceIdentityKind,
        value: row.value,
      }));
    const outcome = step(candidates);
    if (outcome) return outcome;
  }

  // ── 2. Серийный номер ──
  const serial = keys.find((key) => key.kind === 'serial');
  if (serial) {
    const ids = await equipmentByNumber(reader, officeEquipment.serialNumber, serial.value);
    const outcome = step(ids.map((id) => ({ equipmentId: id, ...serial })));
    if (outcome) return outcome;
  }

  // ── 3. Инвентарный номер ──
  //
  // Именно третьей ступенью, а не вместе с серийником: инвентарный номер ИТ-служба прописывает в
  // «имя устройства», и там он живёт рядом с описками. Серийник, нашедший карточку, старше.
  const inventory = keys.find((key) => key.kind === 'inventory');
  if (inventory) {
    const ids = await equipmentByNumber(reader, officeEquipment.inventoryNumber, inventory.value);
    const outcome = step(ids.map((id) => ({ equipmentId: id, ...inventory })));
    if (outcome) return outcome;
  }

  // ── 4 и 5. Имя устройства, сетевое имя, IP ──
  //
  // Ступеней у них нет. Имя и хост уже отработали в п. 1 — и только там; IP не участвует вовсе, он
  // даже не доезжает до `identityKeysOf`. Строка ниже — и есть п. 5.
  return { status: 'unmatched', candidates: [] };
}

/**
 * Статус письма по исходу резолва.
 *
 * Живёт здесь, а не в приёмнике, чтобы соответствие было записано один раз: `unmatched` и
 * `ambiguous` — штатные исходы, а не ошибки, и письмо с ними принято, разобрано и сохранено
 * снимком. Ошибкой их однажды прочитает тот, кто будет писать второе место этого соответствия.
 */
export function deviceMessageStatusForIdentity(
  resolution: DeviceIdentityResolution,
): DeviceMessageStatus {
  switch (resolution.status) {
    case 'matched':
      return 'parsed';
    case 'ambiguous':
      return 'ambiguous';
    default:
      return 'unmatched';
  }
}

/**
 * Модель аппарата, которого письмо уже опознало, — для условия применимости правил разбора
 * (ADR 0204).
 *
 * БЕРЁТСЯ ИМЯ КАРТОЧКИ, И ЭТО НЕ СРЕЗАННЫЙ УГОЛ. `office_equipment.name` — не отдельное поле, а
 * зеркало имени модели: его переписывает триггер `office_equipment_model_mirror` (`BEFORE INSERT
 * OR UPDATE`, и `ENABLE ALWAYS`, так что даже на реплике-приёмнике оно не отстаёт). Второй запрос
 * — join к `office_equipment_models` — вернул бы ту же строку, то есть завёл бы вторую дорогу к
 * одному ответу в горячем пути приёма. У карточки без ссылки на справочник (ссылка пока
 * необязательна) зеркало — просто её имя, и это законный ответ: сравнивать всё равно не с чем
 * другим.
 *
 * `null` — карточка не найдена: снята, или её не было вовсе. Пустая строка и `null` здесь значат
 * одно и то же — «сравнивать не с чем», — и различать их выше по течению незачем.
 */
export async function equipmentModelName(
  reader: TelemetryReader,
  equipmentId: string,
): Promise<string | null> {
  const [row] = await reader
    .select({ name: officeEquipment.name })
    .from(officeEquipment)
    .where(and(eq(officeEquipment.id, equipmentId), isNull(officeEquipment.deletedAt)));
  return row?.name ?? null;
}

/**
 * Модель аппарата, которого назвало письмо, — или `null`, если письмо аппарата не назвало.
 *
 * ПРЕДВАРИТЕЛЬНЫЙ РЕЗОЛВ, И ЕГО ИСХОД НИКУДА НЕ ЗАПИСЫВАЕТСЯ. Он отвечает ровно на один вопрос:
 * «с какой моделью сверять условия правил». Настоящий резолв идёт позже, уже по подсказкам ПОСЛЕ
 * правил, и решает судьбу письма он — здесь же ни статус, ни привязка не назначаются.
 *
 * ОТСЮДА ДВЕ ГРАНИЦЫ, И ОБЕ НАЗВАНЫ ВСЛУХ.
 *
 * Первая: подсказки здесь — ПРОФИЛЬНЫЕ, до правил. Не нашёл профиль ни одного ключа — аппарат на
 * этот момент не опознан, и сверка пойдёт с моделью из письма или из темы (`ruleModel`). Значит
 * правило, которое само достаёт серийник, на модель карточки рассчитывать не может.
 *
 * Вторая неочевиднее: профиль мог найти СВОЙ ключ, а правило потом достанет другой. Тогда условие
 * посчитано по карточке A, а письмо уедет на карточку B. Мириться с этим можно ровно потому, что
 * условие применимости — не запись: неверно посчитанное условие правило не применит (или применит
 * там, где не надо), но число ляжет в карточку, названную НАСТОЯЩИМ резолвом, а не этой сверкой.
 *
 * `ambiguous` здесь читается как «модели нет»: при двух кандидатах резолв обязан остановиться
 * (ADR 0197), и выбирать одну из спорных карточек ради условия правила значило бы решать спор
 * втихую — а решает его человек в очереди.
 */
export async function resolveEquipmentModel(
  reader: TelemetryReader,
  lookup: DeviceIdentityLookup,
): Promise<string | null> {
  const resolution = await resolveDeviceIdentity(reader, lookup);
  if (resolution.status !== 'matched') return null;
  return equipmentModelName(reader, resolution.equipmentId);
}
