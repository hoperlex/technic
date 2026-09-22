import {
  DEVICE_POLL_OIDS,
  devicePollUnit,
  metricForCounterUnit,
  normalizeIdentityValue,
  type DevicePollOutcome,
  type MetricCode,
  type MetricUnit,
} from '@technic/contracts';
import { isAbsent, snmpGet, SnmpResponseError, SnmpTimeoutError, type SnmpVarbind } from './client';
import { targetAddress, type PollTarget } from './targets';

/**
 * ОДИН ОПРОС ЦЕЛИ: спросить пять OID и решить, что с этим делать.
 *
 * ФАЙЛ НИЧЕГО НЕ ПИШЕТ. Он возвращает исход, а записью попытки и показания занимается маршрут: так
 * весь разбор ответов аппарата проверяется тестом без базы, а правила записи — тестом с базой, и
 * ни один из них не проверяет заодно чужую половину.
 */

export interface PollReading {
  metricCode: MetricCode;
  value: number;
  unit: MetricUnit;
}

export interface PollResult {
  outcome: DevicePollOutcome;
  /** Объяснение словами — то, что увидит человек на карточке цели. */
  message: string;
  sysDescr: string;
  sysName: string;
  deviceSerial: string;
  /** Показание, годное к записи; `null` при любом исходе, кроме `ok` и `ok_unverified`. */
  reading: PollReading | null;
  /**
   * Момент НАЧАЛА опроса, а не возврата. Он же уезжает в `observed_at` показания: ряд наработки
   * обязан быть монотонным, а конец запроса сдвигается на срок ожидания — то есть медленный ответ
   * оказался бы «позже» быстрого, снятого после него.
   */
  startedAt: Date;
  durationMs: number;
}

const stringOf = (vb: SnmpVarbind | undefined): string =>
  isAbsent(vb) || typeof vb?.value !== 'string' ? '' : vb.value;

export async function pollTarget(target: PollTarget, timeoutMs: number): Promise<PollResult> {
  const address = targetAddress(target);
  const startedAt = new Date();
  const started = startedAt.getTime();

  let varbinds: SnmpVarbind[];
  try {
    varbinds = await snmpGet({
      host: target.host,
      port: target.port,
      community: target.community,
      oids: Object.values(DEVICE_POLL_OIDS),
      timeoutMs,
    });
  } catch (error) {
    return failure(error, address, startedAt, Date.now() - started);
  }

  const durationMs = Date.now() - started;
  const byOid = new Map(varbinds.map((vb) => [vb.oid, vb]));
  const sysDescr = stringOf(byOid.get(DEVICE_POLL_OIDS.sysDescr));
  const sysName = stringOf(byOid.get(DEVICE_POLL_OIDS.sysName));
  const deviceSerial = stringOf(byOid.get(DEVICE_POLL_OIDS.serial));
  const base = { sysDescr, sysName, deviceSerial, reading: null, startedAt, durationMs };

  const counterVb = byOid.get(DEVICE_POLL_OIDS.counter);
  // Ответ есть, но нашего varbind в нём нет вовсе — это не «счётчика нет» (так отвечают значением),
  // а разговор не о том: чужой агент, обрезанный ответ, подменённый пакет.
  if (!counterVb) {
    return {
      ...base,
      outcome: 'bad_response',
      message: `Аппарат ответил, но счётчика в ответе нет вовсе — ${address} отвечает не по Printer-MIB`,
    };
  }

  /**
   * СВЕРКА СЕРИЙНИКА ИДЁТ ДО СЧЁТЧИКА, И ПОРЯДОК ВАЖЕН. Адрес аппарат не опознаёт: после смены
   * аренды DHCP по нему стоит соседний принтер (то же правило у почтового приёма —
   * `DEVICE_IDENTITY_KINDS`). Запиши мы счётчик раньше проверки — чужая наработка легла бы в ряд
   * карточки и осталась бы там навсегда: показания не удаляются.
   */
  if (target.expectedSerial && deviceSerial) {
    const expected = normalizeIdentityValue(target.expectedSerial);
    const actual = normalizeIdentityValue(deviceSerial);
    if (expected !== actual) {
      return {
        ...base,
        outcome: 'serial_mismatch',
        message: `По адресу ${address} отвечает аппарат с серийным номером «${deviceSerial}», а ожидался «${target.expectedSerial}». Показание не записано`,
      };
    }
  }

  if (isAbsent(counterVb)) {
    return {
      ...base,
      outcome: 'no_counter',
      message: `Аппарат отвечает, но счётчика prtMarkerLifeCount (${DEVICE_POLL_OIDS.counter}) у него нет — нужен фирменный OID вендора`,
    };
  }

  const unitVb = byOid.get(DEVICE_POLL_OIDS.counterUnit);
  if (isAbsent(unitVb) || typeof unitVb?.value !== 'bigint') {
    return {
      ...base,
      outcome: 'unit_unknown',
      message:
        'Аппарат не сообщил единицу счётчика (prtMarkerCounterUnit) — в чём снято число, неизвестно, и записать его некуда',
    };
  }

  const unitCode = Number(unitVb.value);
  const metricCode = metricForCounterUnit(unitCode);
  if (!metricCode) {
    return {
      ...base,
      outcome: 'unit_unknown',
      message: `Счётчик считает в единице ${unitCode} по Printer-MIB — ни оттиски, ни листы, и подходящей метрики для неё нет`,
    };
  }

  if (typeof counterVb.value !== 'bigint') {
    return {
      ...base,
      outcome: 'bad_response',
      message: 'Счётчик пришёл не числом — ответ аппарата не разобран',
    };
  }

  // Счётчик печати не достигает 2^53 ни при какой наработке, но проверка стоит здесь потому, что
  // пришло это число из сети: битый или подменённый ответ не должен превратиться в тихую потерю
  // точности внутри ряда наработки.
  if (counterVb.value > BigInt(Number.MAX_SAFE_INTEGER)) {
    return {
      ...base,
      outcome: 'bad_response',
      message: `Счётчик вернул неправдоподобное число (${counterVb.value}) — записывать его нельзя`,
    };
  }

  const reading: PollReading = {
    metricCode,
    value: Number(counterVb.value),
    unit: devicePollUnit(metricCode),
  };

  /**
   * Неподтверждённый исход — отдельный, а не «ok с оговоркой». Показание при нём пишется: отказать
   * значило бы остаться без данных с аппаратов, которые серийник не сообщают вовсе. Но человек
   * обязан видеть, что сверки НЕ БЫЛО, — иначе «снято» читается как «проверено».
   */
  const verified = Boolean(target.expectedSerial && deviceSerial);
  return {
    ...base,
    reading,
    outcome: verified ? 'ok' : 'ok_unverified',
    message: verified
      ? `Снято: ${reading.value}`
      : target.expectedSerial
        ? `Снято: ${reading.value}. Аппарат не сообщил свой серийный номер — сверить было нечем`
        : `Снято: ${reading.value}. У цели не задан серийный номер — сверять не с чем`,
  };
}

function failure(
  error: unknown,
  address: string,
  startedAt: Date,
  durationMs: number,
): PollResult {
  const base = { sysDescr: '', sysName: '', deviceSerial: '', reading: null, startedAt, durationMs };

  if (error instanceof SnmpTimeoutError) {
    return {
      ...base,
      outcome: 'no_answer',
      message: `${address} не ответил. Проверьте маршрут до сети аппарата, включён ли он и разрешён ли SNMP`,
    };
  }
  if (error instanceof SnmpResponseError) {
    return { ...base, outcome: 'snmp_error', message: `Аппарат ответил отказом: ${error.message}` };
  }
  // Сюда приходят отказы сокета: имя не разрешилось, сети нет, адрес запрещён правилами хоста.
  // Для человека это то же самое «не дошли», и разводить их по разным исходам не за чем — текст
  // ошибки уезжает в сообщение целиком.
  return {
    ...base,
    outcome: 'no_answer',
    message: `Не удалось отправить запрос на ${address}: ${error instanceof Error ? error.message : String(error)}`,
  };
}
