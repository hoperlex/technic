import { describe, expect, it } from 'vitest';
import { unzipSync, zipSync } from 'fflate';
import { inspectTemplate, renderOfficeTemplate } from '../src/services/office-template';

/**
 * Подстановка в бланк (ADR 0037). Бланк 4-П верстается один раз в редакторе таблиц, и от движка
 * требуется ровно одно: заменить плейсхолдеры, не тронув ничего больше. Поэтому здесь проверяется
 * не только результат подстановки, но и сохранность частей, которых она не касается: сетка,
 * стили и штампы бланка живут именно там.
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Минимальный xlsx: строки лежат в sharedStrings, стили — отдельной частью. */
function xlsxTemplate(): Uint8Array {
  return zipSync(
    {
      '[Content_Types].xml': enc.encode('<?xml version="1.0"?><Types/>'),
      'xl/workbook.xml': enc.encode('<?xml version="1.0"?><workbook/>'),
      'xl/sharedStrings.xml': enc.encode(
        '<?xml version="1.0"?><sst><si><t>Водитель</t></si><si><t>{{driver_fio}}</t></si>' +
          '<si><t>СНИЛС {{driver_snils}}</t></si><si><t>{{org_name}}</t></si></sst>',
      ),
      'xl/worksheets/sheet1.xml': enc.encode(
        '<?xml version="1.0"?><worksheet><c t="inlineStr"><is><t>{{waybill_number}}</t></is></c></worksheet>',
      ),
      'xl/styles.xml': enc.encode(
        '<?xml version="1.0"?><styleSheet><!-- рамки бланка --></styleSheet>',
      ),
      'xl/drawings/drawing1.xml': enc.encode('<?xml version="1.0"?><wsDr>штамп</wsDr>'),
    },
    { mtime: Date.UTC(1980, 0, 1) },
  );
}

/** Минимальный ods: тот же бланк, текст в content.xml. */
function odsTemplate(): Uint8Array {
  return zipSync(
    {
      mimetype: enc.encode('application/vnd.oasis.opendocument.spreadsheet'),
      'content.xml': enc.encode(
        '<?xml version="1.0"?><office:document-content><text:p>{{driver_fio}}</text:p>' +
          '<text:p>{{waybill_number}}</text:p></office:document-content>',
      ),
      'META-INF/manifest.xml': enc.encode('<?xml version="1.0"?><manifest/>'),
    },
    { mtime: Date.UTC(1980, 0, 1) },
  );
}

function partOf(bytes: Uint8Array, name: string): string {
  return dec.decode(unzipSync(bytes)[name]!);
}

describe('подстановка в xlsx', () => {
  it('заменяет плейсхолдеры и в общих строках, и в теле листа', () => {
    const r = renderOfficeTemplate(xlsxTemplate(), {
      driver_fio: 'Смуток Василий Николаевич',
      driver_snils: '171-270-127 32',
      org_name: 'АО «Служба механизации»',
      waybill_number: '00000004897',
    });

    expect(partOf(r.bytes, 'xl/sharedStrings.xml')).toContain('Смуток Василий Николаевич');
    expect(partOf(r.bytes, 'xl/sharedStrings.xml')).toContain('СНИЛС 171-270-127 32');
    expect(partOf(r.bytes, 'xl/worksheets/sheet1.xml')).toContain('00000004897');
    expect(r.missing).toEqual([]);
    expect(r.unused).toEqual([]);
  });

  it('не трогает части, где плейсхолдеров нет: там живёт вёрстка бланка', () => {
    const template = xlsxTemplate();
    const r = renderOfficeTemplate(template, { driver_fio: 'Иванов' });

    const before = unzipSync(template);
    const after = unzipSync(r.bytes);
    for (const part of ['xl/styles.xml', 'xl/drawings/drawing1.xml', '[Content_Types].xml']) {
      expect(Array.from(after[part]!), part).toEqual(Array.from(before[part]!));
    }
  });

  it('незаполненная графа печатается пустой, а не фигурными скобками', () => {
    const r = renderOfficeTemplate(xlsxTemplate(), { driver_fio: 'Иванов' });
    const strings = partOf(r.bytes, 'xl/sharedStrings.xml');

    expect(strings).not.toContain('{{');
    expect(strings).toContain('<si><t></t></si>');
    expect(r.missing).toEqual(['driver_snils', 'org_name', 'waybill_number']);
  });

  it('значение, которому нет места в бланке, возвращается отдельно — это опечатка в ключе', () => {
    const r = renderOfficeTemplate(xlsxTemplate(), { driver_fio: 'Иванов', drivre_snils: '1' });
    expect(r.unused).toEqual(['drivre_snils']);
  });

  it('регистр ключа значения не важен: бланк верстает человек', () => {
    const r = renderOfficeTemplate(xlsxTemplate(), { DRIVER_FIO: 'Иванов' });
    expect(partOf(r.bytes, 'xl/sharedStrings.xml')).toContain('Иванов');
    expect(r.missing).not.toContain('driver_fio');
  });
});

describe('экранирование', () => {
  it('амперсанд и кавычки в значении не ломают документ', () => {
    const r = renderOfficeTemplate(xlsxTemplate(), {
      org_name: 'ООО «Иванов & Ко» "Спец"',
      driver_fio: "О'Коннор Джон",
    });
    const strings = partOf(r.bytes, 'xl/sharedStrings.xml');

    expect(strings).toContain('&amp;');
    expect(strings).toContain('&apos;');
    expect(strings).not.toMatch(/[^&]&[^a-z]/u);
  });

  it('угловые скобки не превращаются в разметку', () => {
    const r = renderOfficeTemplate(xlsxTemplate(), { driver_fio: '<t>подделка</t>' });
    const strings = partOf(r.bytes, 'xl/sharedStrings.xml');
    expect(strings).toContain('&lt;t&gt;подделка&lt;/t&gt;');
  });
});

describe('подстановка в ods', () => {
  it('тот же движок обслуживает content.xml', () => {
    const r = renderOfficeTemplate(odsTemplate(), {
      driver_fio: 'Шевченко Андрей Евгеньевич',
      waybill_number: '00000004892',
    });
    const content = partOf(r.bytes, 'content.xml');

    expect(content).toContain('Шевченко Андрей Евгеньевич');
    expect(content).toContain('00000004892');
    expect(r.missing).toEqual([]);
  });

  it('mimetype и манифест остаются как были', () => {
    const template = odsTemplate();
    const r = renderOfficeTemplate(template, { driver_fio: 'Иванов' });
    const before = unzipSync(template);
    const after = unzipSync(r.bytes);

    expect(dec.decode(after['mimetype']!)).toBe(dec.decode(before['mimetype']!));
    expect(Array.from(after['META-INF/manifest.xml']!)).toEqual(
      Array.from(before['META-INF/manifest.xml']!),
    );
  });
});

describe('состав бланка', () => {
  it('перечисляет плейсхолдеры — этим сверяют шаблон со сборщиком значений', () => {
    expect(inspectTemplate(xlsxTemplate())).toEqual([
      'driver_fio',
      'driver_snils',
      'org_name',
      'waybill_number',
    ]);
  });

  it('одинаковый снимок даёт одинаковый файл: на этом будет держаться подпись', () => {
    const values = { driver_fio: 'Иванов', waybill_number: '1' };
    const a = renderOfficeTemplate(xlsxTemplate(), values).bytes;
    const b = renderOfficeTemplate(xlsxTemplate(), values).bytes;
    expect(Array.from(a)).toEqual(Array.from(b));
  });
});
