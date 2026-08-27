import { describe, expect, it } from 'vitest';
import type { HitchedTrailerDto } from '@technic/contracts';
import {
  foreignHitchWarning,
  MANUAL_TRAILER_MODES,
  substitutedTrailerModes,
} from '@entities/vehicle-route';

/**
 * Выбор прицепа из реестра в форме рейса (план `docs/vehicle-trailers-plan.md`, §13).
 *
 * Проверяются чистые функции, а не окно: правило одно на пять окон заведения рейса, и сломать его
 * можно ровно в двух местах — в режиме, который включает подстановка, и в словах, которыми портал
 * называет чужое закрепление. Оба видны без DOM, а прогнанные через рендер они прятались бы за
 * его поломками.
 */

const hitched = (position: 1 | 2, registrationNumber: string): HitchedTrailerDto => ({
  id: `t-${position}`,
  position,
  model: 'ШМИТЦ SPR-24',
  registrationNumber,
  status: 'active',
});

describe('substitutedTrailerModes — режим при подстановке (Р17)', () => {
  it('без закрепления оставляет обе пары граф ручными: подставлять нечего', () => {
    expect(substitutedTrailerModes([])).toEqual(MANUAL_TRAILER_MODES);
    expect(substitutedTrailerModes(undefined)).toEqual(MANUAL_TRAILER_MODES);
    expect(substitutedTrailerModes(null)).toEqual(MANUAL_TRAILER_MODES);
  });

  it('один закреплённый включает справочник в первой паре и не трогает вторую', () => {
    expect(substitutedTrailerModes([hitched(1, 'ВХ933277')])).toEqual({
      slot1: 'directory',
      slot2: 'manual',
    });
  });

  it('два закреплённых включают справочник в обеих парах', () => {
    expect(substitutedTrailerModes([hitched(1, 'ВХ933277'), hitched(2, 'АВ123477')])).toEqual({
      slot1: 'directory',
      slot2: 'directory',
    });
  });

  it('единственный прицеп из второго слота реестра включает режим первой пары — там он и встал', () => {
    // Графы бланка заполняются по порядку, а не по номеру слота реестра (§4.6), и режим обязан
    // описывать ту графу, которую заполнила подстановка, — иначе список встанет над пустым.
    expect(substitutedTrailerModes([hitched(2, 'ВХ933277')])).toEqual({
      slot1: 'directory',
      slot2: 'manual',
    });
  });
});

describe('foreignHitchWarning — предупреждение о чужом закреплении (Р19)', () => {
  const at = (id: string, registrationNumber: string | null = 'О403ВХ777') => ({
    hitchedVehicle: { id, registrationNumber, modelName: 'КАМАЗ-5490' },
  });

  it('чужое закрепление названо госномером машины и не запрещено', () => {
    expect(foreignHitchWarning(at('v-2'), 'v-1')).toBe(
      'Прицеп закреплён за другой машиной — О403ВХ777. Рейс это не запрещает: закрепление не меняется.',
    );
  });

  it('своё закрепление молчит: ровно его портал в графы и подставляет', () => {
    expect(foreignHitchWarning(at('v-1'), 'v-1')).toBeNull();
  });

  it('свободный прицеп молчит: закрепления нет — говорить не о чем', () => {
    expect(foreignHitchWarning({ hitchedVehicle: null }, 'v-1')).toBeNull();
    expect(foreignHitchWarning(undefined, 'v-1')).toBeNull();
    expect(foreignHitchWarning(null, 'v-1')).toBeNull();
  });

  it('машина без госномера названа маркой, а безымянная — никак', () => {
    // Оба реквизита приезжают допускающими `null`: такими они лежат в `vehicles`. Тире с пустотой
    // после него человек прочтёт как сбой, поэтому у безымянной машины его нет вовсе.
    expect(foreignHitchWarning(at('v-2', null), 'v-1')).toBe(
      'Прицеп закреплён за другой машиной — КАМАЗ-5490. Рейс это не запрещает: закрепление не меняется.',
    );
    expect(
      foreignHitchWarning(
        { hitchedVehicle: { id: 'v-2', registrationNumber: '', modelName: '' } },
        'v-1',
      ),
    ).toBe('Прицеп закреплён за другой машиной. Рейс это не запрещает: закрепление не меняется.');
  });

  it('машины в форме ещё нет — чужое закрепление от этого чужим быть не перестаёт', () => {
    expect(foreignHitchWarning(at('v-2'), undefined)).toBe(
      'Прицеп закреплён за другой машиной — О403ВХ777. Рейс это не запрещает: закрепление не меняется.',
    );
  });
});
