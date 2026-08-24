import { describe, expect, it } from 'vitest';
import {
  blindBaselineFingerprint,
  shouldSampleBlindCheck,
  type BlindCheckCandidate,
} from '../src/services/waste-ticket-blind';

/**
 * Отбор в слепую перепроверку (ADR 0114, Р31).
 *
 * Правило короткое, но держит смысл всей метрики: перепроверка меряет, насколько верно МАШИНА
 * прочитала рукопись. Попади в выборку ручной или уже исправленный талон — сравнивались бы два
 * человека, а результат назывался бы «ошибки OCR» и им бы объясняли, стоит ли платить за старшую
 * модель.
 */
function ticket(over: Partial<BlindCheckCandidate> = {}): BlindCheckCandidate {
  return {
    origin: 'ocr',
    editedAt: null,
    numberKey: '30476',
    issuedOn: '2026-08-17',
    volumeM3: '20.000',
    ...over,
  };
}

describe('кого берут в слепую перепроверку', () => {
  it('неправленый машинный талон — берут', () => {
    expect(shouldSampleBlindCheck(ticket(), 1)).toBe(true);
  });

  it('ручной талон не берут ни при какой доле', () => {
    // Его значения вписал человек: сравнение мерило бы внимательность двоих, а не чтение машины.
    expect(shouldSampleBlindCheck(ticket({ origin: 'manual' }), 1)).toBe(false);
  });

  it('правленый машинный талон не берут — хотя происхождение у него прежнее', () => {
    // `origin` при правке не меняется намеренно (Р14): иначе метрика «доля правок» перестала бы
    // видеть талон ровно тогда, когда он ей интереснее всего. Поэтому одного `origin` мало.
    expect(shouldSampleBlindCheck(ticket({ editedAt: new Date() }), 1)).toBe(false);
  });

  it('нулевая доля выключает выборку целиком', () => {
    // Выключенная перепроверка — это «не заводить заданий», а не «заводить и не показывать».
    let asked = false;
    const random = () => {
      asked = true;
      return 0;
    };
    expect(shouldSampleBlindCheck(ticket(), 0, random)).toBe(false);
    expect(asked).toBe(false);
  });

  it('доля решает жребием, а не порядком талонов', () => {
    expect(shouldSampleBlindCheck(ticket(), 0.05, () => 0.04)).toBe(true);
    expect(shouldSampleBlindCheck(ticket(), 0.05, () => 0.06)).toBe(false);
    // Граница включительно снизу: доля 0,05 означает «пять процентов», и значение ровно 0,05
    // относится уже к остальным 95 — иначе доля была бы чуть больше объявленной.
    expect(shouldSampleBlindCheck(ticket(), 0.05, () => 0.05)).toBe(false);
  });
});

describe('снимок сравнения', () => {
  it('отпечаток меняется вместе с любым из трёх сравниваемых полей', () => {
    const base = blindBaselineFingerprint(ticket());
    expect(blindBaselineFingerprint(ticket({ numberKey: '30477' }))).not.toBe(base);
    expect(blindBaselineFingerprint(ticket({ issuedOn: '2026-08-18' }))).not.toBe(base);
    expect(blindBaselineFingerprint(ticket({ volumeM3: '28.000' }))).not.toBe(base);
  });

  it('к происхождению и правке отпечаток равнодушен: он про чтение, а не про строку', () => {
    const base = blindBaselineFingerprint(ticket());
    expect(blindBaselineFingerprint(ticket({ origin: 'manual', editedAt: new Date() }))).toBe(base);
  });

  it('пустой объём и отсутствующая дата дают устойчивый отпечаток', () => {
    // Талон простоя: объёма на нём нет вовсе, и это законное состояние (Р18) — отпечаток обязан
    // считаться и для него, иначе такая строка не попала бы в перепроверку никогда.
    const idle = ticket({ volumeM3: null, issuedOn: null });
    expect(blindBaselineFingerprint(idle)).toMatch(/^[0-9a-f]{64}$/u);
    expect(blindBaselineFingerprint(idle)).toBe(blindBaselineFingerprint(idle));
  });
});
