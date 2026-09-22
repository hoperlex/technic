import { afterEach, describe, expect, it } from 'vitest';
import { DEVICE_POLL_OIDS } from '@technic/contracts';
import { BER, tlv } from '../src/services/device-snmp/ber';
import { buildGetRequest, parseResponse } from '../src/services/device-snmp/client';
import { pollTarget } from '../src/services/device-snmp/poll';
import { parsePollTargets, type PollTarget } from '../src/services/device-snmp/targets';
import {
  absent,
  counter32,
  healthyReply,
  octet,
  response,
  startFakeDevice,
  type FakeDevice,
} from './fake-snmp-device';

/**
 * ОПРОС АППАРАТОВ ПО СЕТИ (решение `docs/adr/0205-device-network-poll.md`).
 *
 * БЕЗ БАЗЫ И БЕЗ ПРИНТЕРА: предмет проверки — что уходит в сеть, что мы понимаем в ответе и какой
 * исход из этого следует. Ни одно из этих утверждений не про SQL, и ни одно не требует живого
 * аппарата: на месте принтера стоит фальшивый агент на localhost, отвечающий заготовленным пакетом.
 *
 * Что доказывается:
 *
 * - **запрос собирается побайтово верно** — против эталона, посчитанного по RFC вручную, а не
 *   против собственного разбора: иначе обе стороны могли бы ошибаться одинаково и молча;
 * - **ответ разбирается** из тех же «золотых» байтов — строка, Counter32 и OID на своих местах;
 * - **счётчик снимается** и получает метрику ПО ЕДИНИЦЕ аппарата: оттиски и листы — разные ряды;
 * - **чужой серийник останавливает запись**: по знакомому адресу после DHCP отвечает соседний
 *   аппарат, и его наработка не должна попасть в чужую карточку;
 * - **отсутствие счётчика, незнакомая единица и отказ SNMP** дают разные исходы и разные слова:
 *   «нет ответа» и «аппарат ответил отказом» чинятся в разных местах;
 * - **молчание — это исход, а не зависание**: срок ожидания кончается сам;
 * - **чужой request-id не считается ответом** — иначе запоздавший ответ прошлого опроса стал бы
 *   ответом текущего;
 * - **реестр целей** разбирается, а битая строка не роняет остальные.
 */

// ── Фальшивый аппарат ──

const devices: FakeDevice[] = [];
afterEach(async () => {
  while (devices.length) await devices.pop()?.close();
});

async function fakeDevice(reply: (requestId: number) => Buffer | null): Promise<FakeDevice> {
  const device = await startFakeDevice(reply);
  devices.push(device);
  return device;
}

function targetOn(port: number, over: Partial<PollTarget> = {}): PollTarget {
  return {
    key: 'ricoh-1',
    label: 'RICOH, приёмная',
    host: '127.0.0.1',
    port,
    community: 'public',
    expectedSerial: 'Y505P400123',
    ...over,
  };
}

// ── Байты ──

describe('SNMP: пакет', () => {
  /**
   * Эталон посчитан по RFC 3416 вручную и записан здесь целиком: GET v2c, community `public`,
   * request-id 12345, один OID `sysDescr.0`.
   *
   * ЗАЧЕМ СРАВНИВАТЬ С КОНСТАНТОЙ, А НЕ С СОБСТВЕННЫМ РАЗБОРОМ. Разбор и сборка написаны одной
   * рукой в один день: ошибись они одинаково — например, забудь обе про ведущий ноль у знакового
   * INTEGER, — и тест «собрали и разобрали» прошёл бы, а принтер молчал бы в ответ.
   */
  const GOLDEN_REQUEST =
    '3027' + // SEQUENCE, 39 байт
    '020101' + // version = 1 (v2c)
    '04067075626c6963' + // community "public"
    'a01a' + // GetRequest PDU, 26 байт
    '02023039' + // request-id 12345
    '020100' + // error-status 0
    '020100' + // error-index 0
    '300e' + // varbind list
    '300c' + // varbind
    '06082b06010201010100' + // OID 1.3.6.1.2.1.1.1.0
    '0500'; // NULL

  it('собирается побайтово как в RFC', () => {
    const packet = buildGetRequest(12_345, 'public', ['1.3.6.1.2.1.1.1.0']);
    expect(packet.toString('hex')).toBe(GOLDEN_REQUEST);
  });

  /** Ответ того же вида: строка `RICOH` и Counter32 97 011 — то самое число из живого опроса. */
  const GOLDEN_RESPONSE =
    '3041' +
    '020101' +
    '04067075626c6963' +
    'a234' +
    '02023039' +
    '020100' +
    '020100' +
    '3028' +
    '3011' +
    '06082b06010201010100' +
    '04055249434f48' + // "RICOH"
    '3013' +
    '060c2b060102012b0a020104010' +
    '1' + // OID 1.3.6.1.2.1.43.10.2.1.4.1.1
    '4103017af3'; // Counter32 97011

  it('разбирается из ответа аппарата', () => {
    const parsed = parseResponse(Buffer.from(GOLDEN_RESPONSE, 'hex'));
    expect(parsed?.requestId).toBe(12_345);
    expect(parsed?.errorStatus).toBe(0);
    expect(parsed?.varbinds).toEqual([
      { oid: '1.3.6.1.2.1.1.1.0', tag: BER.OCTET_STRING, value: 'RICOH' },
      { oid: '1.3.6.1.2.1.43.10.2.1.4.1.1', tag: BER.COUNTER32, value: 97_011n },
    ]);
  });

  it('не принимает за ответ чужую датаграмму', () => {
    expect(parseResponse(Buffer.from('не snmp вовсе', 'utf8'))).toBeNull();
  });
});

// ── Опрос ──

describe('SNMP: опрос цели', () => {
  it('снимает счётчик и сверяет серийный номер', async () => {
    const device = await fakeDevice(healthyReply());
    const result = await pollTarget(targetOn(device.port), 1_000);

    expect(result.outcome).toBe('ok');
    expect(result.reading).toEqual({
      metricCode: 'marker_life_total',
      value: 97_011,
      unit: 'impressions',
    });
    expect(result.sysDescr).toBe('RICOH MP C2011SP');
    expect(result.deviceSerial).toBe('Y505P400123');
  });

  /**
   * Единица аппарата решает КОД метрики. Тот же счётчик, настроенный на листы, обязан лечь в ряд
   * листов: сложенный с оттисками, он испортил бы обе величины разом и молча.
   */
  it('кладёт листы в метрику листов, а не оттисков', async () => {
    const device = await fakeDevice(
      healthyReply({ counterUnit: tlv(BER.INTEGER, Buffer.from([8])) }),
    );
    const result = await pollTarget(targetOn(device.port), 1_000);

    expect(result.outcome).toBe('ok');
    expect(result.reading).toEqual({
      metricCode: 'printed_sheets_total',
      value: 97_011,
      unit: 'sheets',
    });
  });

  it('не снимает показание, если по адресу отвечает другой аппарат', async () => {
    const device = await fakeDevice(healthyReply({ serial: octet('OTHER-77') }));
    const result = await pollTarget(targetOn(device.port), 1_000);

    expect(result.outcome).toBe('serial_mismatch');
    expect(result.reading).toBeNull();
    expect(result.message).toContain('OTHER-77');
  });

  /** Серийник аппарат не сообщил: показание годится, но человек обязан видеть, что сверки не было. */
  it('помечает снятое как неподтверждённое, если аппарат не назвал серийник', async () => {
    const device = await fakeDevice(healthyReply({ serial: absent() }));
    const result = await pollTarget(targetOn(device.port), 1_000);

    expect(result.outcome).toBe('ok_unverified');
    expect(result.reading?.value).toBe(97_011);
  });

  it('отличает отсутствие счётчика от молчания', async () => {
    const device = await fakeDevice(healthyReply({ counter: absent() }));
    const result = await pollTarget(targetOn(device.port), 1_000);

    expect(result.outcome).toBe('no_counter');
    expect(result.reading).toBeNull();
  });

  it('отказывается писать число в незнакомой единице', async () => {
    const device = await fakeDevice(
      // 11 — «часы» по PrtMarkerCounterUnitTC: величина есть, метрики под неё нет.
      healthyReply({ counterUnit: tlv(BER.INTEGER, Buffer.from([11])) }),
    );
    const result = await pollTarget(targetOn(device.port), 1_000);

    expect(result.outcome).toBe('unit_unknown');
    expect(result.reading).toBeNull();
  });

  it('передаёт отказ аппарата словами', async () => {
    const device = await fakeDevice((requestId) => response(requestId, [], 16));
    const result = await pollTarget(targetOn(device.port), 1_000);

    expect(result.outcome).toBe('snmp_error');
    expect(result.message).toContain('community');
  });

  it('кончает молчание сроком ожидания, а не зависанием', async () => {
    const device = await fakeDevice(() => null);
    const result = await pollTarget(targetOn(device.port), 150);

    expect(result.outcome).toBe('no_answer');
    expect(result.message).toContain('не ответил');
  });

  /**
   * Запоздавший ответ ПРОШЛОГО опроса приходит на тот же порт и выглядит как ответ. Отличает их
   * только request-id — и если его не сверять, счётчик, снятый минуту назад, запишется как снятый
   * сейчас.
   */
  it('не принимает ответ с чужим request-id', async () => {
    const device = await fakeDevice((requestId) =>
      response(requestId + 1, [[DEVICE_POLL_OIDS.counter, counter32(1)]]),
    );
    const result = await pollTarget(targetOn(device.port), 150);

    expect(result.outcome).toBe('no_answer');
  });

  it('называет исходом ответ не по Printer-MIB', async () => {
    const device = await fakeDevice((requestId) =>
      response(requestId, [['1.3.6.1.2.1.1.1.0', octet('нечто иное')]]),
    );
    const result = await pollTarget(targetOn(device.port), 1_000);

    expect(result.outcome).toBe('bad_response');
  });
});

// ── Реестр целей ──

describe('реестр целей опроса', () => {
  it('разбирает строку настройки и подставляет порт по умолчанию', () => {
    const { targets, problems } = parsePollTargets(
      'ricoh-1|RICOH, приёмная|192.168.5.71|public|Y505P400123; kyocera-2|Kyocera, склад|10.0.0.9:1161|secret|',
    );

    expect(problems).toEqual([]);
    expect(targets).toEqual([
      {
        key: 'ricoh-1',
        label: 'RICOH, приёмная',
        host: '192.168.5.71',
        port: 161,
        community: 'public',
        expectedSerial: 'Y505P400123',
      },
      {
        key: 'kyocera-2',
        label: 'Kyocera, склад',
        host: '10.0.0.9',
        port: 1161,
        community: 'secret',
        expectedSerial: '',
      },
    ]);
  });

  /**
   * Битая строка не роняет ни портал, ни соседние цели. Правка адреса принтера в проде не должна
   * стоить портала всем, включая тех, кто про опрос не знает.
   */
  it('пропускает битые строки, называя причину, и оставляет годные', () => {
    const { targets, problems } = parsePollTargets(
      'ПЛОХОЙ КЛЮЧ|нечто|1.2.3.4|public|; ok-1|Годная|1.2.3.4|public|SN1; ok-1|Дубль|5.6.7.8|public|SN2; no-community|Без пароля|1.2.3.4||SN3',
    );

    expect(targets.map((t) => t.key)).toEqual(['ok-1']);
    expect(problems).toHaveLength(3);
    expect(problems.join(' ')).toContain('уже встречался');
    expect(problems.join(' ')).toContain('community');
  });

  it('пустая настройка — это ноль целей, а не ошибка', () => {
    expect(parsePollTargets('')).toEqual({ targets: [], problems: [] });
  });
});
