import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { inspectTemplate, renderOfficeTemplate } from '../src/services/office-template';
import { WAYBILL_SNAPSHOT_KEYS } from '@technic/contracts';

/**
 * Согласованность бланка и сборщика значений (ADR 0037 п. 10).
 *
 * Разъехавшись, они не ломают ни типизацию, ни ревью: шаблон молча напечатает пустую графу вместо
 * СНИЛС, и заметит это только тот, кто возьмёт лист в руки. Поэтому набор плейсхолдеров сверяется
 * тестом — и у xlsx, и у ods, потому что печатают из обоих.
 */

const templatesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'templates');
const FORMATS = ['xlsx', 'ods'] as const;

function template(format: (typeof FORMATS)[number]): Uint8Array {
  return new Uint8Array(readFileSync(join(templatesDir, `waybill-4p.${format}`)));
}

describe('бланк 4-П и снимок значений', () => {
  it.each(FORMATS)('в %s нет графы, которой не собирает сервер', (format) => {
    const inTemplate = inspectTemplate(template(format));
    const known = new Set<string>(WAYBILL_SNAPSHOT_KEYS);

    expect(inTemplate.length).toBeGreaterThan(20);
    expect(inTemplate.filter((key) => !known.has(key))).toEqual([]);
  });

  it('оба формата печатают одно и то же: расхождение — разные документы', () => {
    expect(inspectTemplate(template('xlsx'))).toEqual(inspectTemplate(template('ods')));
  });

  it('обязательные реквизиты листа в бланке есть', () => {
    const inTemplate = new Set(inspectTemplate(template('xlsx')));
    // Без них документ недействителен: приказ Минтранса № 390 (СНИЛС — с 01.03.2023).
    for (const key of [
      'org_name',
      'waybill_number',
      'waybill_date',
      'vehicle_brand',
      'vehicle_reg_number',
      'driver_fio',
      'driver_snils',
      'driver_license_number',
    ]) {
      expect(inTemplate.has(key), key).toBe(true);
    }
  });

  it.each(FORMATS)('заполненный %s не содержит незакрытых плейсхолдеров', (format) => {
    const values = Object.fromEntries(WAYBILL_SNAPSHOT_KEYS.map((k) => [k, `знач-${k}`]));
    const rendered = renderOfficeTemplate(template(format), values);

    expect(rendered.missing).toEqual([]);
    expect(inspectTemplate(rendered.bytes)).toEqual([]);
  });
});
