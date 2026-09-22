import dgram from 'node:dgram';
import { randomInt } from 'node:crypto';
import {
  BER,
  BerError,
  encodeInteger,
  encodeOid,
  readInteger,
  readOid,
  readString,
  readTlv,
  readUnsigned,
  tlv,
} from './ber';

/**
 * SNMP v2c GET поверх UDP. Ровно одна операция: спросить несколько OID и получить ответ.
 *
 * ПОЧЕМУ v2c, А НЕ v1. В v1 отсутствие ОДНОГО запрошенного OID — это отказ ВСЕГО запроса
 * (`noSuchName`), то есть аппарат, не знающий, скажем, серийника, не отдал бы и счётчик. В v2c
 * «нет такого объекта» приезжает значением в своём varbind, и остальные четыре ответа целы. Для
 * опроса смешанного парка это разница между «работает» и «работает у половины».
 *
 * SET ЗДЕСЬ НЕТ И НЕ БУДЕТ. Опрос обязан уметь только читать: запись в аппарат — это смена его
 * настроек по сети, и портал такого права не имеет ни в одном сценарии (§11.3 usage-плана).
 */

export type SnmpValue = string | bigint | null;

export interface SnmpVarbind {
  oid: string;
  tag: number;
  /** `null` — аппарат ответил «нет такого объекта/экземпляра»: см. `isAbsent`. */
  value: SnmpValue;
}

/** Ответа не было за отведённый срок: нет маршрута, аппарат выключен, пакет отфильтрован. */
export class SnmpTimeoutError extends Error {
  constructor(address: string, timeoutMs: number) {
    super(`нет ответа от ${address} за ${timeoutMs} мс`);
  }
}

/** Аппарат ответил отказом на уровне PDU. Чаще всего это не та community. */
export class SnmpResponseError extends Error {
  readonly errorStatus: number;
  constructor(errorStatus: number) {
    super(snmpErrorText(errorStatus));
    this.errorStatus = errorStatus;
  }
}

/**
 * Словарь отказов SNMP словами. Нужен именно здесь: код `5` в журнале попыток не скажет человеку
 * ничего, а «аппарат отказал в чтении» — скажет.
 */
function snmpErrorText(status: number): string {
  switch (status) {
    case 1:
      return 'ответ не помещается в пакет (tooBig)';
    case 2:
      return 'аппарат не знает запрошенного OID (noSuchName)';
    case 3:
      return 'аппарат не принял значение (badValue)';
    case 4:
      return 'объект доступен только для чтения (readOnly)';
    case 6:
      return 'доступ закрыт — проверьте community и список разрешённых адресов (noAccess)';
    case 16:
      return 'аппарат требует авторизации (authorizationError) — community не подходит';
    default:
      return `аппарат отказал (ошибка SNMP ${status})`;
  }
}

/** Отсутствующий объект: у v2c это значение varbind, а не ошибка запроса. */
export function isAbsent(vb: SnmpVarbind | undefined): boolean {
  return (
    !vb ||
    vb.value === null ||
    vb.tag === BER.NO_SUCH_OBJECT ||
    vb.tag === BER.NO_SUCH_INSTANCE ||
    vb.tag === BER.END_OF_MIB_VIEW
  );
}

export interface SnmpGetOptions {
  host: string;
  port: number;
  community: string;
  oids: readonly string[];
  timeoutMs: number;
}

export function buildGetRequest(requestId: number, community: string, oids: readonly string[]): Buffer {
  const varbinds = oids.map((oid) =>
    tlv(BER.SEQUENCE, Buffer.concat([encodeOid(oid), tlv(BER.NULL, Buffer.alloc(0))])),
  );
  const pdu = tlv(
    BER.GET_REQUEST,
    Buffer.concat([
      encodeInteger(requestId),
      encodeInteger(0), // error-status в запросе всегда 0
      encodeInteger(0), // error-index — тоже
      tlv(BER.SEQUENCE, Buffer.concat(varbinds)),
    ]),
  );
  return tlv(
    BER.SEQUENCE,
    Buffer.concat([
      encodeInteger(1), // version: 0 = v1, 1 = v2c
      tlv(BER.OCTET_STRING, Buffer.from(community, 'ascii')),
      pdu,
    ]),
  );
}

interface ParsedResponse {
  requestId: number;
  errorStatus: number;
  varbinds: SnmpVarbind[];
}

/**
 * Разбор ответа. Возвращает `null`, если это не SNMP-ответ вовсе, — такой пакет молча
 * пропускается: на открытый UDP-сокет может прилететь что угодно, и падать на чужой датаграмме,
 * не дождавшись своей, — значит отдать управление первому встречному.
 */
export function parseResponse(data: Buffer): ParsedResponse | null {
  try {
    const cursor = { offset: 0 };
    const message = readTlv(data, cursor);
    if (message.tag !== BER.SEQUENCE) return null;

    const inner = { offset: message.start };
    readTlv(data, inner); // version
    readTlv(data, inner); // community
    const pdu = readTlv(data, inner);
    if (pdu.tag !== BER.GET_RESPONSE) return null;

    const body = { offset: pdu.start };
    const requestId = readInteger(data, readTlv(data, body));
    const errorStatus = readInteger(data, readTlv(data, body));
    readTlv(data, body); // error-index

    const list = readTlv(data, body);
    const varbinds: SnmpVarbind[] = [];
    const listCursor = { offset: list.start };
    while (listCursor.offset < list.end) {
      const vb = readTlv(data, listCursor);
      if (vb.tag !== BER.SEQUENCE) return null;
      const vbCursor = { offset: vb.start };
      const oid = readOid(data, readTlv(data, vbCursor));
      const valueNode = readTlv(data, vbCursor);
      varbinds.push({ oid, tag: valueNode.tag, value: readValue(data, valueNode) });
    }
    return { requestId, errorStatus, varbinds };
  } catch (error) {
    if (error instanceof BerError) return null;
    throw error;
  }
}

function readValue(data: Buffer, node: { tag: number; start: number; end: number }): SnmpValue {
  switch (node.tag) {
    case BER.INTEGER:
      return BigInt(readInteger(data, node));
    case BER.COUNTER32:
    case BER.GAUGE32:
    case BER.TIMETICKS:
    case BER.COUNTER64:
      return readUnsigned(data, node);
    case BER.OCTET_STRING:
      return readString(data, node);
    case BER.OID:
      return readOid(data, node);
    case BER.IP_ADDRESS:
      return Array.from(data.subarray(node.start, node.end)).join('.');
    default:
      // NULL и три отказных тега v2c — «значения нет». Разница между ними для портала неважна:
      // ответ один и тот же — «аппарат этого не сообщает».
      return null;
  }
}

/**
 * Один GET и ожидание ответа.
 *
 * REQUEST-ID СВЕРЯЕТСЯ, И ЭТО НЕ ФОРМАЛЬНОСТЬ. UDP не связывает запрос с ответом ничем, кроме
 * этого числа: запоздавший ответ на ПРЕДЫДУЩИЙ опрос того же аппарата иначе стал бы ответом на
 * текущий — и счётчик, снятый минуту назад, записался бы как снятый сейчас.
 */
export async function snmpGet(opts: SnmpGetOptions): Promise<SnmpVarbind[]> {
  const { host, port, community, oids, timeoutMs } = opts;
  const requestId = randomInt(1, 2_147_483_646);
  const packet = buildGetRequest(requestId, community, oids);

  return new Promise<SnmpVarbind[]>((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    let settled = false;

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      try {
        socket.close();
      } catch {
        // Сокет мог закрыться сам на ошибке — закрывать дважды нечего, и падать тут не на чем.
      }
      fn();
    };

    const timer = setTimeout(
      () => finish(() => reject(new SnmpTimeoutError(`${host}:${port}`, timeoutMs))),
      timeoutMs,
    );

    socket.on('error', (error: Error) => finish(() => reject(error)));

    socket.on('message', (data: Buffer) => {
      const parsed = parseResponse(data);
      // Чужой или неразбираемый пакет — ждём дальше: свой ответ ещё может прийти, а срок ожидания
      // уже тикает.
      if (!parsed || parsed.requestId !== requestId) return;
      if (parsed.errorStatus !== 0) {
        finish(() => reject(new SnmpResponseError(parsed.errorStatus)));
        return;
      }
      finish(() => resolve(parsed.varbinds));
    });

    socket.send(packet, port, host, (error) => {
      // Ошибка отправки — это «адрес не резолвится» или «сеть недоступна»: ждать по ней нечего.
      if (error) finish(() => reject(error));
    });
  });
}
