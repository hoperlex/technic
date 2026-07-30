import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { unzipSync } from 'fflate';
import { WAYBILL_SNAPSHOT_KEYS } from '@technic/contracts';
import { inspectTemplate, renderOfficeTemplate } from '../src/services/office-template';

/**
 * Согласованность бланка и сборщика значений (ADR 0037 п. 10).
 *
 * Бланки пришли от бухгалтерии готовыми; портал только вписывает в них плейсхолдеры
 * (`scripts/mark-waybill-templates.ts`). Разъехавшись со сборщиком, разметка не ломает ни
 * типизацию, ни ревью: лист молча напечатается с пустой графой вместо СНИЛС, и заметит это
 * только тот, кто возьмёт бумагу в руки. Поэтому набор плейсхолдеров сверяется тестом.
 */

const templatesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'templates');

/** Код формы = имя файла: `vehicle_types.waybill_form_code` выбирает бланк по нему. */
const FORMS = ['4p', 'leg3'] as const;

function template(form: (typeof FORMS)[number]): Uint8Array {
  return new Uint8Array(readFileSync(join(templatesDir, `waybill-${form}.xlsx`)));
}

describe('разметка бланков', () => {
  it.each(FORMS)('в бланке %s нет графы, которой не собирает сервер', (form) => {
    const inTemplate = inspectTemplate(template(form));
    const known = new Set<string>(WAYBILL_SNAPSHOT_KEYS);

    expect(inTemplate.length).toBeGreaterThan(10);
    expect(inTemplate.filter((key) => !known.has(key))).toEqual([]);
  });

  it('в 4-П размечены реквизиты, без которых лист недействителен', () => {
    const inTemplate = new Set(inspectTemplate(template('4p')));
    // Приказ Минтранса № 390; СНИЛС водителя — с 01.03.2023.
    for (const key of [
      'org_name',
      'org_okpo',
      'waybill_series',
      'waybill_number',
      'waybill_date',
      'vehicle_brand',
      'vehicle_reg_number',
      'driver_fio',
      'driver_snils',
      'driver_license_number',
      'driver_license_issued_on',
    ]) {
      expect(inTemplate.has(key), key).toBe(true);
    }
  });

  it('в 4-П размечено задание водителю: по нему лист и выписывают', () => {
    const inTemplate = new Set(inspectTemplate(template('4p')));
    for (const key of ['customer_name', 'customer_address', 'task_from', 'task_to', 'task_cargo']) {
      expect(inTemplate.has(key), key).toBe(true);
    }
  });

  it.each(FORMS)('заполненный бланк %s не содержит незакрытых плейсхолдеров', (form) => {
    const values = Object.fromEntries(WAYBILL_SNAPSHOT_KEYS.map((k) => [k, `знач-${k}`]));
    const rendered = renderOfficeTemplate(template(form), values);

    expect(rendered.missing).toEqual([]);
    expect(inspectTemplate(rendered.bytes)).toEqual([]);
  });

  it.each(FORMS)('подстановка не трогает вёрстку бланка %s: стили и рисунки те же', (form) => {
    const original = template(form);
    const rendered = renderOfficeTemplate(original, { driver_fio: 'Иванов' });

    // Бланк прислан бухгалтерией: линии, шрифты и штампы обязаны пережить подстановку без правок.
    const before = unzipSync(original);
    const after = unzipSync(rendered.bytes);
    for (const part of ['xl/styles.xml', 'xl/drawings/drawing1.xml', 'xl/media/image1.png']) {
      expect(Array.from(after[part]!), part).toEqual(Array.from(before[part]!));
    }
  });
});
