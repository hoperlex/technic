import { describe, expect, it, vi } from 'vitest';
import type { BackdateVerdict } from '@technic/contracts';
import { AppError } from '../src/lib/errors';

/**
 * Операция коррекции задним числом (ADR 0101) — та её часть, что в базу не ходит.
 *
 * Проверяются две вещи, и обе ломаются молча.
 *
 * **Отпечаток команды** (Р31). Он единственное, чем «повтор той же кнопки» отличается от «другой
 * команды под тем же ключом». Разъедься отпечаток на порядке ключей JSON — и обычный ретрай начнёт
 * получать 409 вместо прежнего результата; склей он разные тела — и второй запрос молча получит
 * чужой результат, ничего не выполнив. Ни то ни другое не видно ни типами, ни линтом.
 *
 * **Перевод вердикта в отказ** (Р29). Коды разведены ради разных поручений человеку: «нет права» —
 * идти к другому, «не хватает причины» — дописать её самому. Один статус на оба сделал бы отказ
 * нечитаемым, а портал — гадающим, что показать.
 *
 * База подменена: обе функции чистые, а `db/client` строит пул при импорте и требует окружения.
 */

vi.mock('../src/db/client', () => ({ db: {} }));

const { backdateOrThrow, correctionFingerprint, waybillEffectiveDate } =
  await import('../src/services/waybill-correction');

/** Отказ вердикта: сам текст предикату безразличен, а маршрут выбирает статус по коду. */
function denial(code: 'permission' | 'reason' | 'limit'): BackdateVerdict {
  return { ok: false, code, reason: `отказ: ${code}` };
}

describe('отпечаток команды коррекции', () => {
  it('не зависит от порядка ключей: ретрай той же кнопки обязан быть повтором', () => {
    const first = correctionFingerprint({
      kind: 'cancel',
      target: 'w-1',
      body: { reason: 'не та машина' },
    });
    const second = correctionFingerprint({
      body: { reason: 'не та машина' },
      target: 'w-1',
      kind: 'cancel',
    });
    expect(second).toBe(first);
  });

  it('сортирует ключи и во вложенных объектах', () => {
    const a = correctionFingerprint({
      body: { trip: { withTrailer: true, communicationKind: 'г' } },
    });
    const b = correctionFingerprint({
      body: { trip: { communicationKind: 'г', withTrailer: true } },
    });
    expect(b).toBe(a);
  });

  it('не переданное поле и переданное `undefined` — одна и та же команда', () => {
    const absent = correctionFingerprint({ reason: 'исправление', vehicleId: undefined });
    expect(correctionFingerprint({ reason: 'исправление' })).toBe(absent);
  });

  it('`null` от `undefined` отличается: «снять значение» это не «не трогать»', () => {
    expect(correctionFingerprint({ driverPersonId: null })).not.toBe(
      correctionFingerprint({ driverPersonId: undefined }),
    );
  });

  it('порядок элементов массива значим: им задаётся порядок талонов', () => {
    expect(correctionFingerprint({ requestOrder: ['a', 'b'] })).not.toBe(
      correctionFingerprint({ requestOrder: ['b', 'a'] }),
    );
  });

  it('другая причина — другая команда: причина уходит в бланк и в журнал', () => {
    expect(correctionFingerprint({ target: 'w-1', reason: 'ошибка в реквизитах' })).not.toBe(
      correctionFingerprint({ target: 'w-1', reason: 'рейс не состоялся' }),
    );
  });

  it('цель входит в отпечаток: id из пути ручки телом не передаётся', () => {
    expect(correctionFingerprint({ target: 'w-1', body: {} })).not.toBe(
      correctionFingerprint({ target: 'w-2', body: {} }),
    );
  });
});

describe('вердикт заднего числа в отказе маршрута', () => {
  it('сегодняшняя операция проходит и коррекцией не считается', () => {
    expect(backdateOrThrow({ ok: true, backdated: false })).toBe(false);
  });

  it('разрешённая операция прошлого возвращает признак: по нему заводится запись операции', () => {
    expect(backdateOrThrow({ ok: true, backdated: true })).toBe(true);
  });

  it('нет права — 403: помочь может только другой человек', () => {
    expect(() => backdateOrThrow(denial('permission'))).toThrow(AppError);
    try {
      backdateOrThrow(denial('permission'));
    } catch (e) {
      expect((e as AppError).statusCode).toBe(403);
    }
  });

  it('нет причины и слишком давно — 422: запрос понят, но выполнить его нельзя', () => {
    for (const code of ['reason', 'limit'] as const) {
      try {
        backdateOrThrow(denial(code));
        expect.unreachable(`вердикт ${code} обязан отказывать`);
      } catch (e) {
        expect((e as AppError).statusCode, code).toBe(422);
        expect((e as AppError).message, code).toContain(code);
      }
    }
  });
});

describe('эффективная дата листа', () => {
  it('у недельного листа — конец недели, тем же концом её считает `canCancelWaybill`', () => {
    expect(waybillEffectiveDate({ issuedForDate: '2026-08-31', periodTo: '2026-09-06' })).toBe(
      '2026-09-06',
    );
  });

  it('у листа на рейс периода нет — границей остаётся день выезда', () => {
    expect(waybillEffectiveDate({ issuedForDate: '2026-08-10', periodTo: null })).toBe(
      '2026-08-10',
    );
    expect(waybillEffectiveDate({ issuedForDate: '2026-08-10' })).toBe('2026-08-10');
  });
});
