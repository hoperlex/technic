/**
 * ASN.1 / BER — ровно столько, сколько нужно SNMP v2c GET и разбору ответа на него.
 *
 * ПОЧЕМУ СВОИ СОРОК СТРОК, А НЕ БИБЛИОТЕКА. Зависимость ради GET-запроса стоит дороже, чем кажется:
 * `net-snmp` тянет в образ API свой транспорт, свой планировщик и свою модель ошибок, а нам нужен
 * один запрос с пятью OID и внятный ответ на вопрос «что сказал аппарат». Формат BER при этом не
 * меняется с 1990 года, и весь он здесь помещается на экран. План коллектора допускал `net-snmp`
 * (`Р104`) для узла на объекте — там опрашивается парк и нужны v3 и walk; здесь ни того, ни другого
 * нет.
 *
 * ФАЙЛ НИЧЕГО НЕ ЗНАЕТ НИ ПРО FASTIFY, НИ ПРО БАЗУ, и это условие переезда: когда опрос уедет с
 * сервера на узел в офисной сети, этот модуль и `client.ts` переезжают как есть.
 */

/** Теги, которые встречаются в нашем обмене. Остальные BER-теги сюда не попадают. */
export const BER = {
  INTEGER: 0x02,
  OCTET_STRING: 0x04,
  NULL: 0x05,
  OID: 0x06,
  SEQUENCE: 0x30,
  IP_ADDRESS: 0x40,
  COUNTER32: 0x41,
  GAUGE32: 0x42,
  TIMETICKS: 0x43,
  COUNTER64: 0x46,
  /** Три «значения-отказа» SNMPv2: их место — в varbind, а не в статусе ошибки PDU. */
  NO_SUCH_OBJECT: 0x80,
  NO_SUCH_INSTANCE: 0x81,
  END_OF_MIB_VIEW: 0x82,
  GET_REQUEST: 0xa0,
  GET_RESPONSE: 0xa2,
} as const;

// ── Сборка ──

/**
 * Длина в форме BER: короткая до 127 включительно, длинная — с числом байтов в старшем байте.
 * Граница ровно на 128, а не «примерно»: длинная форма для 100 байт собралась бы синтаксически
 * верно, и часть аппаратов ответила бы на неё отказом, а часть — молчанием.
 */
function encodeLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  const bytes: number[] = [];
  let rest = length;
  while (rest > 0) {
    bytes.unshift(rest & 0xff);
    rest = Math.floor(rest / 256);
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

export function tlv(tag: number, value: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), encodeLength(value.length), value]);
}

/**
 * ASN.1 INTEGER — ЗНАКОВЫЙ, и это главная ловушка сборки. Число, у которого старший бит первого
 * байта стоит (например 200 или request-id вроде 0x80000001), без ведущего нуля прочиталось бы
 * аппаратом как отрицательное: ответ на такой запрос либо не придёт, либо придёт с чужим
 * request-id.
 */
export function encodeInteger(value: number): Buffer {
  if (value === 0) return tlv(BER.INTEGER, Buffer.from([0]));
  const bytes: number[] = [];
  let rest = value;
  while (rest > 0) {
    bytes.unshift(rest & 0xff);
    rest = Math.floor(rest / 256);
  }
  if ((bytes[0] as number) & 0x80) bytes.unshift(0);
  return tlv(BER.INTEGER, Buffer.from(bytes));
}

/**
 * OID в BER: первые две дуги склеены в один байт (`x * 40 + y`), остальные — по семь бит на байт со
 * старшим битом продолжения. Дуги больше 127 (у вендорских OID это обычное дело) без этой упаковки
 * уехали бы обрезанными.
 */
export function encodeOid(oid: string): Buffer {
  const parts = oid
    .trim()
    .replace(/^\./, '')
    .split('.')
    .map((p) => Number(p));
  if (parts.length < 2 || parts.some((p) => !Number.isInteger(p) || p < 0)) {
    throw new Error(`Некорректный OID: ${oid}`);
  }
  const out: number[] = [];
  const push = (value: number): void => {
    const chunk: number[] = [];
    let rest = value;
    do {
      chunk.unshift(rest & 0x7f);
      rest = Math.floor(rest / 128);
    } while (rest > 0);
    for (let i = 0; i < chunk.length - 1; i += 1) chunk[i] = (chunk[i] as number) | 0x80;
    out.push(...chunk);
  };
  push((parts[0] as number) * 40 + (parts[1] as number));
  for (let i = 2; i < parts.length; i += 1) push(parts[i] as number);
  return tlv(BER.OID, Buffer.from(out));
}

// ── Разбор ──

export interface BerNode {
  tag: number;
  /** Смещение начала значения и его конца — разбор идёт по исходному буферу, без копий. */
  start: number;
  end: number;
}

export class BerError extends Error {}

/**
 * Читает один TLV с позиции `offset` и двигает курсор за его конец.
 *
 * ГРАНИЦЫ ПРОВЕРЯЮТСЯ КАЖДЫЙ РАЗ, потому что источник — UDP-датаграмма из сети: обрезанный или
 * нарочно испорченный пакет обязан дать внятный отказ, а не чтение за концом буфера.
 */
export function readTlv(data: Buffer, cursor: { offset: number }): BerNode {
  if (cursor.offset + 2 > data.length) throw new BerError('пакет оборван');
  const tag = data[cursor.offset] as number;
  cursor.offset += 1;
  const first = data[cursor.offset] as number;
  cursor.offset += 1;

  let length: number;
  if ((first & 0x80) === 0) {
    length = first;
  } else {
    const count = first & 0x7f;
    // Неопределённая длина в SNMP не встречается; молча принять её значило бы уехать разбором в
    // чужие байты и объяснить это потом как «ответ не разобран».
    if (count === 0 || count > 4) throw new BerError('неподдерживаемая форма длины');
    if (cursor.offset + count > data.length) throw new BerError('пакет оборван');
    length = 0;
    for (let i = 0; i < count; i += 1) {
      length = length * 256 + (data[cursor.offset] as number);
      cursor.offset += 1;
    }
  }

  const start = cursor.offset;
  const end = start + length;
  if (end > data.length) throw new BerError('длина блока больше пакета');
  cursor.offset = end;
  return { tag, start, end };
}

/** Целое без знака — `bigint`, потому что Counter64 не помещается в `number` целиком. */
export function readUnsigned(data: Buffer, node: BerNode): bigint {
  let value = 0n;
  for (let i = node.start; i < node.end; i += 1) value = value * 256n + BigInt(data[i] as number);
  return value;
}

/** Знаковое целое: отрицательные приходят от аппаратов в полях статусов и ошибок. */
export function readInteger(data: Buffer, node: BerNode): number {
  if (node.end === node.start) return 0;
  let value = 0;
  for (let i = node.start; i < node.end; i += 1) value = value * 256 + (data[i] as number);
  if ((data[node.start] as number) & 0x80) value -= Math.pow(2, (node.end - node.start) * 8);
  return value;
}

/**
 * Строка аппарата. `latin1` как запасной разбор не нужен: UTF-8 с заменой битых байтов даёт
 * читаемое «почти то же самое», а падать на кодировке `sysDescr` ради счётчика — плохой размен.
 * Хвостовые нули срезаются: их дописывают прошивки, и без среза они уезжают в базу и на экран.
 */
export function readString(data: Buffer, node: BerNode): string {
  return data
    .subarray(node.start, node.end)
    .toString('utf8')
    .replace(/\0+$/, '')
    .trim();
}

/** OID обратно в точечную запись — им подписан ответ, и по нему мы узнаём свой varbind. */
export function readOid(data: Buffer, node: BerNode): string {
  if (node.end === node.start) return '';
  const first = data[node.start] as number;
  const parts: number[] = [Math.floor(first / 40), first % 40];
  let value = 0;
  for (let i = node.start + 1; i < node.end; i += 1) {
    const byte = data[i] as number;
    value = value * 128 + (byte & 0x7f);
    if ((byte & 0x80) === 0) {
      parts.push(value);
      value = 0;
    }
  }
  return parts.join('.');
}
