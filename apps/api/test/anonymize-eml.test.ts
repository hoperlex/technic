import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  AnonymizeRefusal,
  anonymizeEml,
  decodeQuotedPrintable,
  runCli,
} from '../scripts/anonymize-eml';
import { decodeEncodedWords, decodeText, parseDeviceMail } from '../src/services/device-mail/mime';

/**
 * Обезличиватель `.eml` (решение Р19 плана
 * [office-equipment-mail-telemetry-plan.md](../../../docs/office-equipment-mail-telemetry-plan.md),
 * §12; сам скрипт — [scripts/anonymize-eml.ts](../scripts/anonymize-eml.ts)).
 *
 * ЧТО ЗДЕСЬ ОХРАНЯЕТСЯ. Репозиторий публичный, а фикстуры разбора — настоящие письма с аппаратов.
 * Проверяется не «вызвалась ли замена», а пять свойств, каждое из которых стоит отдельной беды:
 *
 * 1. **в файле не осталось улик** — ни адреса живого домена, ни адреса сети (IPv4, IPv6, MAC), ни
 *    исходного серийника, ни фамилии, ни домена заказчика. Уехавшее в публичный репозиторий не
 *    отзывается;
 * 2. **улику видно там, где её видит разборщик** — в теме, закодированной `encoded-word`, и в
 *    части в `windows-1251`. Обезличиватель обязан видеть письмо не хуже собственного разборщика;
 * 3. **форма уцелела** — подставной серийник той же длины и того же чередования знаков, IPv6
 *    остался IPv6, кириллица осталась кириллицей и не превратилась в U+FFFD;
 * 4. **подмена устойчива** — один исходный номер даёт один подставной во всех частях и кодировках;
 * 5. **непонятое письмо получает отказ, а не «почти чистый» выход** — и код возврата ненулевой.
 *
 * ПОЧЕМУ ВСЯ БАТАРЕЯ СМОТРИТ В ЗАПИСАННЫЙ ФАЙЛ, А НЕ В РЕЗУЛЬТАТ ФУНКЦИИ. В репозиторий попадает
 * именно файл, записанный командой. Батарея, работающая по значению из памяти, пропустила бы
 * подмену записи копированием входа байт в байт — и такую проверку прошла бы версия скрипта, у
 * которой все счётчики нули. Поэтому файл читается с диска, раскрывается так же, как его
 * раскрывает разборщик, и напечатанные числа утверждаются наравне с содержимым.
 */

const FIXTURE = fileURLToPath(
  new URL('./fixtures/device-mail/anonymize/device-report.eml', import.meta.url),
);

/**
 * Значения, стоящие в письме голым словом: формой они не опознаются ничем и перечисляются руками —
 * как и в реальном прогоне. Номер с пробелом здесь не случаен: он проверяет, что список применяется
 * раньше правила по подписи поля и не получает уже обрезанный текст.
 */
const FLAGS = [
  '--serial=V5085400123',
  '--serial=C1460 400123',
  '--host=MFP-VYDUMKA-01',
  '--domain=vydumka-pechat.test',
];

/** Улики оригинала: ни одна не имеет права остаться в выходе ни в каком представлении. */
const LIVE = [
  'vydumka-pechat.test',
  'вымысел.рф',
  'o.kuznetsova',
  'i.petrov',
  'p.sidorov',
  'k.morozov',
  'it-sluzhba',
  'mfp-otchet',
  'иванов@',
  'admin:secret',
  'Кузнецова',
  'Иванов',
  'Petrov',
  'V5085400123',
  'C1460 400123',
  '0468-172/123',
  'V5О85400123',
  'MFP-VYDUMKA-01',
  'prn-vydumka-07',
  'office.lan',
  'corp.local',
  'reverse-07',
  '192.168.100.7',
  '10.20.30.40',
  '172.16.5.6',
  'fd00:1234:5678::9',
  'fe80::1',
  '2001:db8:1::a5',
  '00:1A:2B:3C:4D:5E',
];

const EMAIL = /[\p{L}\d._%+-]+@[\p{L}\d-]+(?:\.[\p{L}\d-]+)+/gu;
const IPV4 = /(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])/g;
/*
 * Строго: либо сжатие `::`, либо восемь групп. Нестрогая запись ловит время из заголовка `Date`
 * (`09:12:44`) и объявляет его адресом — на такой проверке тест падал, а не письмо.
 */
const IPV6 =
  /(?<![:.\w])(?:(?:[0-9A-Fa-f]{1,4}:){1,7}:(?::?[0-9A-Fa-f]{1,4})*|(?:[0-9A-Fa-f]{1,4}:){7}[0-9A-Fa-f]{1,4})(?![:.\w])/g;
const MAC = /(?<![\w:-])[0-9A-Fa-f]{2}(?::[0-9A-Fa-f]{2}){5}(?![\w:-])/g;
const BOUNDARY = '--=_part 1';

/** Форма значения: длина и чередование классов знаков — всё, ради чего номер вообще остаётся. */
function shapeOf(value: string): string {
  return value
    .replace(/\d/gu, '9')
    .replace(/[a-z]/gu, 'a')
    .replace(/[A-Z]/gu, 'A')
    .replace(/\p{Ll}/gu, 'я')
    .replace(/\p{Lu}/gu, 'Я');
}

/** Заголовок, написанный сырыми байтами UTF-8 в нарушение RFC 5322: так делают прошивки. */
function recoverRawBytes(latin: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(latin, 'latin1'));
  } catch {
    return latin;
  }
}

/**
 * Письмо в открытом виде: заголовки раскрыты из `encoded-word`, части раскодированы своей
 * кодировкой. Ровно так его видит разборщик — и ровно так обязана смотреть проверка улик: поиск
 * «собаки» в сыром `.eml` зеленел бы на письме, где чистой оказалась одна текстовая часть.
 */
function plainView(eml: Buffer): string {
  const latin = eml.toString('latin1').replace(/\r\n/gu, '\n');
  const split = latin.indexOf('\n\n');
  const block = (split < 0 ? latin : latin.slice(0, split)).replace(/\n[ \t]+/gu, ' ');
  const headers = block
    .split('\n')
    .map((line) => decodeEncodedWords(recoverRawBytes(line)))
    .join('\n');
  const body = split < 0 ? '' : latin.slice(split + 2);
  const parts = body
    .split(new RegExp(`^${BOUNDARY.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}(?:--)?$`, 'm'))
    .map((chunk) => {
      const at = chunk.indexOf('\n\n');
      if (at < 0) return '';
      const partHeaders = chunk.slice(0, at);
      const payload = chunk.slice(at + 2);
      if (/^content-type:\s*(image|application\/octet-stream)/imu.test(partHeaders)) {
        return partHeaders;
      }
      const charset = /charset="?([^";\s]+)/iu.exec(partHeaders)?.[1] ?? 'utf-8';
      const encoding = /^content-transfer-encoding:\s*(\S+)/imu
        .exec(partHeaders)?.[1]
        ?.toLowerCase();
      const bytes =
        encoding === 'base64'
          ? Buffer.from(payload, 'base64')
          : encoding === 'quoted-printable'
            ? decodeQuotedPrintable(payload)
            : Buffer.from(payload, 'latin1');
      return `${partHeaders}\n${decodeText(bytes, charset)}`;
    });
  return [headers, ...parts].join('\n');
}

/** Значение поля по подписи — так же, как его читает профиль вендора. */
function labelled(text: string, label: string): string[] {
  return [...text.matchAll(new RegExp(`${label}(?:</td><td>|:\\s*)([^\\n<]+)`, 'g'))].map((found) =>
    (found[1] ?? '').trim(),
  );
}

function cli(argv: readonly string[]): { code: number; out: string } {
  let out = '';
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out += String(chunk);
    return true;
  });
  try {
    return { code: runCli(argv), out };
  } finally {
    spy.mockRestore();
  }
}

/**
 * Единственный прогон команды на весь файл: батарея проверяет ЗАПИСАННЫЙ им файл.
 *
 * Отсутствие файла здесь не роняет сборку набора, а оставляется первому же случаю: сломанный
 * скрипт обязан дать названную неудачу («команда не записала файл»), а не ошибку чтения при сборе
 * тестов — по ней не видно, что именно сломалось.
 */
const dir = mkdtempSync(join(tmpdir(), 'anonymize-eml-'));
const OUT = join(dir, 'clean.eml');
const run = cli([FIXTURE, OUT, ...FLAGS]);
const source = readFileSync(FIXTURE);
const anonymized = existsSync(OUT) ? readFileSync(OUT) : Buffer.alloc(0);
const view = anonymized.length > 0 ? plainView(anonymized) : '';
const sourceView = plainView(source);

describe('обезличиватель .eml: улик не осталось в записанном файле', () => {
  it('команда отработала и записала файл', () => {
    expect(run.out).not.toContain('отказ:');
    expect(run.code).toBe(0);
    expect(anonymized.length).toBeGreaterThan(0);
    // Запись копированием входа такую проверку не прошла бы — файл обязан отличаться от оригинала.
    expect(anonymized.equals(source)).toBe(false);
  });

  it('ни одной улики оригинала: адреса, фамилии, номера, имена, сети', () => {
    for (const evidence of LIVE) {
      expect(sourceView.toLowerCase()).toContain(evidence.toLowerCase());
      expect(view.toLowerCase()).not.toContain(evidence.toLowerCase());
    }
  });

  it('все адреса электронной почты — на example.*', () => {
    const addresses = [...view.matchAll(EMAIL)].map((found) => found[0]);
    expect(addresses.length).toBeGreaterThan(8);
    for (const address of addresses) {
      expect(address.split('@')[1]).toMatch(/(^|\.)example(\.|$)/u);
    }
    // Адрес, уже стоящий на example.*, подменять нечем — он остаётся собой.
    expect(view).toContain('dezhurny@example.org');
  });

  it('все адреса сети — документационные: IPv4, IPv6 и MAC', () => {
    const ipv4 = [...view.matchAll(IPV4)].map((found) => found[0]);
    expect(ipv4.length).toBeGreaterThan(4);
    for (const ip of ipv4) expect(ip).toMatch(/^198\.51\.100\.\d{1,3}$/u);
    expect(view).not.toMatch(/(?<![\w.])(?:10|192\.168|172\.(?:1[6-9]|2\d|3[01]))\./u);

    const ipv6 = [...view.matchAll(IPV6)].map((found) => found[0]);
    expect(ipv6.length).toBeGreaterThan(2);
    for (const ip of ipv6) expect(ip.toLowerCase()).toMatch(/^2001:db8[:0-9a-f]*$/u);
    // `fd00::/8` — внутренняя сеть площадки, `fe80::/10` — канальный адрес самого аппарата.
    expect(view.toLowerCase()).not.toMatch(/(?<![\w:])f[cde][0-9a-f]{2}:/u);

    const macs = [...view.matchAll(MAC)].map((found) => found[0]);
    expect(macs.length).toBeGreaterThan(0);
    for (const mac of macs) expect(mac.toUpperCase()).toMatch(/^00:00:5E:00:53:[0-9A-F]{2}$/u);
  });

  it('ни одного внутреннего имени хоста и ни одного домена заказчика', () => {
    expect(view).not.toMatch(/\.(local|lan|intranet|corp)\b/iu);
    expect(view.toLowerCase()).not.toContain('vydumka');
  });
});

describe('обезличиватель .eml: улику видно там, где её видит разборщик', () => {
  it('тема в encoded-word раскрывается, чистится и складывается обратно (RFC 2047)', () => {
    // В оригинале тема — целиком base64, и улики в ней не видно поиском по файлу.
    expect(source.toString('latin1')).toMatch(/^Subject: =\?UTF-8\?B\?/mu);
    expect(sourceView).toContain('V5085400123');

    const subject = /^Subject:(.*)$/mu.exec(anonymized.toString('latin1').replace(/\r\n/gu, '\n'));
    expect(subject?.[1]?.trim()).toMatch(/^=\?UTF-8\?B\?/u);
    const decoded = decodeEncodedWords(subject?.[1] ?? '');
    expect(decoded).toContain('Отчёт');
    expect(decoded).not.toContain('V5085400123');
    expect(decoded).not.toContain('p.sidorov');
    expect(decoded).not.toContain('192.168.100.7');
    expect(decoded).not.toContain('MFP-VYDUMKA-01');
  });

  it('часть в windows-1251 чистится и уезжает обратно в windows-1251, а не в U+FFFD', () => {
    expect(anonymized.toString('latin1')).toContain('charset="windows-1251"');
    // Кириллица цела: чтение письма строкой в UTF-8 испортило бы байты ещё до всякой чистки.
    expect(view).toContain('Отчёт о состоянии аппарата');
    expect(view).toContain('Тонер (чёрный)');
    expect(view).not.toContain('�');
    // И base64-часть в той же кодировке: адрес внутри неё — это адрес, а не «непонятные буквы».
    expect(view).toContain('<td>Инженер</td>');
    expect(view).not.toContain('k.morozov');
  });

  it('имя файла в RFC 2231 тоже чистится', () => {
    const disposition = /filename\*=utf-8''(\S+)/u.exec(anonymized.toString('latin1'))?.[1] ?? '';
    expect(disposition).not.toBe('');
    const decoded = Buffer.from(
      disposition.replace(/%([0-9A-Fa-f]{2})/gu, (_m, hex: string) =>
        String.fromCharCode(Number.parseInt(hex, 16)),
      ),
      'latin1',
    ).toString('utf8');
    expect(decoded).toContain('Отчёт');
    expect(decoded).not.toContain('MFP-VYDUMKA-01');
  });

  it('граница с пробелом внутри кавычек разобрана: части раскодированы, а не проехали текстом', () => {
    expect(source.toString('latin1')).toContain('boundary="=_part 1"');
    expect(anonymized.toString('latin1')).toContain('boundary="=_part 1"');
    // Если бы граница не разобралась, base64-часть уехала бы нетронутой — и адрес в ней остался.
    expect(view).toContain('Serial Number</td><td>');
    expect(view.toLowerCase()).not.toContain('vydumka');
  });

  it('фамилия снимается в обоих обычных написаниях адресного заголовка', () => {
    const headers = anonymized.toString('latin1').replace(/\r\n/gu, '\n');
    // `Кузнецова Ольга<адрес>` — без пробела перед скобкой.
    expect(headers).toMatch(/^From: "user-[0-9a-f]{8}" </mu);
    // `Petrov, "Иванов" <адрес>` — запятая внутри значения, а не начало следующего адреса.
    expect(headers).toMatch(/^To: "user-[0-9a-f]{8}", "user-[0-9a-f]{8}" </mu);
  });

  it('домен заказчика снят и там, где он не часть ASCII-адреса', () => {
    // Обратная зона в скобках `Received`, логин с паролем в URL, адрес в зоне `.рф`.
    expect(sourceView).toContain('reverse-07.vydumka-pechat.test');
    expect(sourceView).toContain('admin:secret@mfp.vydumka-pechat.test');
    expect(sourceView).toContain('иванов@вымысел.рф');
    expect(view).not.toContain('admin');
    expect(view).not.toContain('secret');
    expect(view).toMatch(/\(\S+\.example\.net \[198\.51\.100\.\d+\]\)/u);
  });
});

describe('обезличиватель .eml: форма и устойчивость', () => {
  it('серийный номер сохранил форму: пробел, слэш и кириллический двойник цифры', () => {
    for (const label of ['Serial Number', 'S/N', 'Machine Serial']) {
      const before = labelled(sourceView, label);
      const after = labelled(view, label);
      expect(before.length).toBeGreaterThan(0);
      expect(after).toHaveLength(before.length);
      after.forEach((serial, index) => {
        expect(serial).not.toBe(before[index]);
        expect(shapeOf(serial)).toBe(shapeOf(before[index] ?? ''));
      });
    }
    // Номер с пробелом заменён целиком: цифры второй группы в файле не остались.
    expect(labelled(view, 'Serial Number')[0]).toMatch(/^[A-Z]\d{4} \d{6}$/u);
    expect(view).not.toContain('400123');
    expect(view).not.toContain('172/123');
  });

  it('один исходный номер — один подставной: тема, часть в cp1251 и base64-таблица', () => {
    const replacement = labelled(view, 'Serial Number').at(-1) ?? '';
    expect(replacement).toMatch(/^[A-Z]\d{10}$/u);
    // В оригинале `V5085400123` стоит дважды и в двух разных представлениях: тема — base64
    // `encoded-word` в UTF-8, таблица — base64-часть в windows-1251. Ни одно из них не видно
    // поиском по сырому файлу, и подмена в них обязана совпасть.
    expect(sourceView.split('V5085400123')).toHaveLength(3);
    expect(view.split(replacement)).toHaveLength(3);
  });

  it('имя аппарата подменяется одним значением: письма остаются письмами одного аппарата', () => {
    const name = labelled(view, 'Device Name')[0] ?? '';
    expect(shapeOf(name)).toBe(shapeOf('MFP-VYDUMKA-01'));
    // Тема, обе части и путь письма в `Received` несут одно имя — разойдись они, аппарат стал бы
    // несколькими, и дедупликация с резолвом проверялись бы на выдуманном парке.
    expect(view.toLowerCase().split(name.toLowerCase()).length).toBeGreaterThanOrEqual(5);
  });

  it('тот же вход даёт тот же выход байт в байт', () => {
    const second = join(dir, 'again.eml');
    expect(cli([FIXTURE, second, ...FLAGS]).code).toBe(0);
    expect(readFileSync(second).equals(anonymized)).toBe(true);
  });

  it('обезличенное письмо остаётся письмом: его читает разборщик', async () => {
    const context = await parseDeviceMail(anonymized);
    expect(context.subject).toContain(labelled(view, 'Serial Number').at(-1) ?? '—');
    expect(context.text).toContain('Отчёт о состоянии аппарата');
    expect(context.tables.length).toBeGreaterThan(0);
    expect(context.attachments.length).toBeGreaterThan(0);
    const everything = JSON.stringify(context).toLowerCase();
    for (const evidence of LIVE) expect(everything).not.toContain(evidence.toLowerCase());
  });
});

describe('обезличиватель .eml: напечатанные числа', () => {
  /*
   * Числа — часть договора с фикстурой: тест, который их не утверждает, прошла бы и версия
   * скрипта, где все счётчики нули, а файл записан копированием входа.
   */
  it('счётчики прогона совпадают с содержимым письма', () => {
    expect(run.out).toContain('адреса: 11');
    expect(run.out).toContain('серийные номера: 5 (различных 4)');
    expect(run.out).toContain('имена хостов: 26');
    expect(run.out).toContain('адреса IPv4: 7');
    expect(run.out).toContain('адреса IPv6: 3');
    expect(run.out).toContain('адреса MAC: 2');
    expect(run.out).toContain('отображаемые имена: 3');
    expect(run.out).toContain('раскрыто заголовков encoded-word: 3');
    expect(run.out).toContain('перекодировано частей не в UTF-8: 2');
  });
});

describe('обезличиватель .eml: отказы вместо тихих пропусков', () => {
  const letter = (headers: string, body: string): Buffer =>
    Buffer.from(`${headers}\r\n\r\n${body}`, 'utf8');

  it('повторный прогон по уже обезличенному файлу отказывается работать', () => {
    const again = join(dir, 'twice.eml');
    const repeat = cli([OUT, again, ...FLAGS]);
    expect(repeat.code).toBe(2);
    expect(repeat.out).toContain('уже обезличено');
    // Вторая подмена приняла бы свою же за улику: бесподписный хост и номер переименовались бы
    // заново, и два письма одного аппарата стали бы письмами разных.
    expect(existsSync(again)).toBe(false);
  });

  it('незнакомая кодировка части — отказ, а не пропуск части целиком', () => {
    const raw = letter(
      'Subject: test\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset="utf-7"',
      'ivanov@corp.test\r\n',
    );
    expect(() => anonymizeEml(raw)).toThrow(AnonymizeRefusal);
    expect(() => anonymizeEml(raw)).toThrow(/кодировка/u);
  });

  it('multipart без разобранной границы — отказ, а не откат к плоскому тексту', () => {
    const noParam = letter('MIME-Version: 1.0\r\nContent-Type: multipart/mixed', 'тело\r\n');
    expect(() => anonymizeEml(noParam)).toThrow(/граница не разобралась/u);

    const noMarker = letter(
      'MIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="=_part 9"',
      'ivanov@corp.test\r\n',
    );
    expect(() => anonymizeEml(noMarker)).toThrow(/в теле не встретилась/u);
  });

  it('перечисленное руками значение, которое не применилось, — отказ с ненулевым кодом', () => {
    const missed = join(dir, 'missed.eml');
    const result = cli([FIXTURE, missed, ...FLAGS, '--serial=НЕТ-ТАКОГО-123']);
    expect(result.code).toBe(2);
    expect(result.out).toContain('не применилось');
    expect(result.out).toContain('НЕТ-ТАКОГО-123');
    // Молчание здесь означало бы, что человек считает улику вычищенной, а она в файле.
    expect(existsSync(missed)).toBe(false);
  });

  it('оригинал на месте не переписывается, а без путей печатается подсказка', () => {
    const inPlace = cli([FIXTURE, FIXTURE, ...FLAGS]);
    expect(inPlace.code).toBe(1);
    expect(inPlace.out).toContain('выход обязан отличаться от входа');
    expect(readFileSync(FIXTURE).equals(source)).toBe(true);

    const noArgs = cli([FIXTURE]);
    expect(noArgs.code).toBe(1);
    expect(noArgs.out).toContain('--serial=');
  });
});
