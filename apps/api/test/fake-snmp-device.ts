import dgram from 'node:dgram';
import { DEVICE_POLL_OIDS } from '@technic/contracts';
import { BER, encodeInteger, encodeOid, readInteger, readTlv, tlv } from '../src/services/device-snmp/ber';

/**
 * ФАЛЬШИВЫЙ АППАРАТ: UDP-агент на localhost, отвечающий заготовленным SNMP-пакетом.
 *
 * ЗАЧЕМ. Живого принтера у прогона нет и быть не может: аппарат стоит в офисной сети за NAT
 * (`Р92` в `docs/office-equipment-usage-plan.md`), а тесты гоняются на сервере. Без такого агента
 * проверялся бы только разбор байтов, и весь путь «кнопка → опрос → запись показания» остался бы
 * непокрытым до первого ручного прогона.
 *
 * Общий для теста разбора (`device-snmp.test.ts`) и теста ручек (`device-poll.db.test.ts`): два
 * аппарата, собранные по-разному, разошлись бы в ответах — и один из тестов проверял бы поведение,
 * которого нет.
 */

export interface FakeDevice {
  port: number;
  close: () => Promise<void>;
}

/** Достаёт request-id запроса: ответ обязан нести тот же, иначе клиент его не примет. */
export function requestIdOf(packet: Buffer): number {
  const cursor = { offset: 0 };
  const message = readTlv(packet, cursor);
  const inner = { offset: message.start };
  readTlv(packet, inner); // version
  readTlv(packet, inner); // community
  const pdu = readTlv(packet, inner);
  const body = { offset: pdu.start };
  return readInteger(packet, readTlv(packet, body));
}

export function response(
  requestId: number,
  varbinds: [string, Buffer][],
  errorStatus = 0,
): Buffer {
  const list = varbinds.map(([oid, value]) =>
    tlv(BER.SEQUENCE, Buffer.concat([encodeOid(oid), value])),
  );
  const pdu = tlv(
    BER.GET_RESPONSE,
    Buffer.concat([
      encodeInteger(requestId),
      encodeInteger(errorStatus),
      encodeInteger(0),
      tlv(BER.SEQUENCE, Buffer.concat(list)),
    ]),
  );
  return tlv(
    BER.SEQUENCE,
    Buffer.concat([encodeInteger(1), tlv(BER.OCTET_STRING, Buffer.from('public')), pdu]),
  );
}

export const octet = (value: string): Buffer => tlv(BER.OCTET_STRING, Buffer.from(value, 'utf8'));

export const integer = (value: number): Buffer => tlv(BER.INTEGER, Buffer.from([value]));

export const counter32 = (value: number): Buffer => {
  const bytes: number[] = [];
  let rest = value;
  while (rest > 0) {
    bytes.unshift(rest & 0xff);
    rest = Math.floor(rest / 256);
  }
  return tlv(BER.COUNTER32, Buffer.from(bytes.length ? bytes : [0]));
};

/** «Нет такого экземпляра» — так v2c отвечает про объект, которого у аппарата нет. */
export const absent = (): Buffer => tlv(BER.NO_SUCH_INSTANCE, Buffer.alloc(0));

/** Полный набор ответов исправного цветного МФУ: единица «оттиски», счётчик 97 011. */
export function healthyReply(
  over: Partial<Record<keyof typeof DEVICE_POLL_OIDS, Buffer>> = {},
): (requestId: number) => Buffer {
  return (requestId) =>
    response(requestId, [
      [DEVICE_POLL_OIDS.sysDescr, over.sysDescr ?? octet('RICOH MP C2011SP')],
      [DEVICE_POLL_OIDS.sysName, over.sysName ?? octet('ricoh-priemnaya')],
      [DEVICE_POLL_OIDS.serial, over.serial ?? octet('Y505P400123')],
      [DEVICE_POLL_OIDS.counterUnit, over.counterUnit ?? integer(7)],
      [DEVICE_POLL_OIDS.counter, over.counter ?? counter32(97_011)],
    ]);
}

export async function startFakeDevice(
  reply: (requestId: number) => Buffer | null,
): Promise<FakeDevice> {
  const socket = dgram.createSocket('udp4');
  await new Promise<void>((resolve) => socket.bind(0, '127.0.0.1', resolve));
  socket.on('message', (data, rinfo) => {
    const answer = reply(requestIdOf(data));
    if (answer) socket.send(answer, rinfo.port, rinfo.address);
  });
  const address = socket.address();
  return {
    port: typeof address === 'string' ? 0 : address.port,
    close: () => new Promise<void>((resolve) => socket.close(resolve)),
  };
}

/**
 * Порт, на котором заведомо никто не слушает: сокет открывается и тут же закрывается, а номер
 * остаётся занятым нами в пределах прогона. Так проверяется молчание сети — исход, который на
 * живом контуре встречается чаще снятого показания.
 */
export async function silentPort(): Promise<number> {
  const device = await startFakeDevice(() => null);
  await device.close();
  return device.port;
}
