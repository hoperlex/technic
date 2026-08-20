import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  can,
  type CredentialTypeCode,
  type CredentialVerificationStatus,
  displayDocumentOf,
  GARAGE_DRIVER_STATES,
  GARAGE_VEHICLE_STATES,
  garageDriverQuerySchema,
  garageDriverStateColors,
  garageDriverStateLabels,
  garageVehicleQuerySchema,
  garageVehicleStateColors,
  garageVehicleStateLabels,
  licenseDisplayState,
  profilesWith,
  waybillDocumentOf,
} from '@technic/contracts';

/**
 * Контракты гаража (ADR 0076): запросы среза и словарь состояний.
 *
 * Сами состояния считает сервер одним SQL-выражением — здесь проверяется то, что живёт в
 * контрактах: день приходит параметром (а не «сегодня» сервера), фильтры сужают список
 * перечисленными значениями, а каждому состоянию есть подпись и цвет. Пропущенная подпись не
 * ломает сборку — `Record` требует все ключи, — но пропущенный **вариант** в схеме превращает
 * фильтр в 400 на ровном месте.
 */

describe('запрос среза дня', () => {
  it('день необязателен: пустой означает сегодня, и считает его сервер', () => {
    const parsed = garageVehicleQuerySchema.parse({});
    expect(parsed.on).toBeUndefined();
    expect(parsed.page).toBe(1);
  });

  it('день принимается только календарным ключом', () => {
    expect(garageVehicleQuerySchema.parse({ on: '2026-08-06' }).on).toBe('2026-08-06');
    expect(garageVehicleQuerySchema.safeParse({ on: '06.08.2026' }).success).toBe(false);
    // Дата, которой не бывает: регулярное выражение её пропускает, а `dateOnlySchema` — нет.
    expect(garageVehicleQuerySchema.safeParse({ on: '2026-02-31' }).success).toBe(false);
  });

  it('фильтр состояния принимает только перечисленные значения', () => {
    for (const state of GARAGE_VEHICLE_STATES) {
      expect(garageVehicleQuerySchema.parse({ state }).state).toBe(state);
    }
    expect(garageVehicleQuerySchema.safeParse({ state: 'busy' }).success).toBe(false);

    for (const state of GARAGE_DRIVER_STATES) {
      expect(garageDriverQuerySchema.parse({ state }).state).toBe(state);
    }
    expect(garageDriverQuerySchema.safeParse({ state: 'on_route' }).success).toBe(false);
  });

  /**
   * Фильтр техники в гараже — тот же контрол, что в списке заявок: набор позиций одной строкой.
   * Старая пара остаётся принимаемой (по ней ходят вкладки со старым JS), но вместе с набором в
   * одном запросе — отказ: выбирать за клиента, какая из двух форм победила, сервер не берётся.
   */
  it('техника отбирается набором позиций; две формы фильтра сразу — отказ', () => {
    const TYPE = '33333333-3333-4333-8333-333333333333';
    const CATEGORY = '44444444-4444-4444-8444-444444444444';

    expect(
      garageVehicleQuerySchema.parse({ classifications: `t${TYPE},c${CATEGORY}` }).classifications,
    ).toEqual({ typeIds: [TYPE], categoryIds: [CATEGORY] });
    // Пустая строка означает «фильтра нет» — снятые галочки 400-й не отвечают.
    expect(garageVehicleQuerySchema.parse({ classifications: '' }).classifications).toEqual({
      typeIds: [],
      categoryIds: [],
    });
    expect(garageVehicleQuerySchema.safeParse({ classifications: `x${TYPE}` }).success).toBe(false);

    expect(garageVehicleQuerySchema.safeParse({ vehicleTypeId: TYPE }).success).toBe(true);
    expect(
      garageVehicleQuerySchema.safeParse({ classifications: `t${TYPE}`, vehicleTypeId: TYPE })
        .success,
    ).toBe(false);

    // Маршрут гаража расширяет эту схему своим фильтром показаний — запрет обязан доехать и туда,
    // иначе он держался бы на том, что расширения не появится.
    const extended = garageVehicleQuerySchema.extend({ readings: z.enum(['pending']).optional() });
    expect(
      extended.safeParse({ classifications: `t${TYPE}`, vehicleCategoryId: CATEGORY }).success,
    ).toBe(false);
    expect(extended.safeParse({ classifications: `t${TYPE}`, readings: 'pending' }).success).toBe(
      true,
    );
  });

  it('сортировка сужена полями, которые сервер умеет считать', () => {
    expect(garageVehicleQuerySchema.parse({ sortBy: 'state' }).sortBy).toBe('state');
    expect(garageVehicleQuerySchema.safeParse({ sortBy: 'busy' }).success).toBe(false);
    expect(garageDriverQuerySchema.parse({ sortBy: 'fullName' }).sortBy).toBe('fullName');
    // Удостоверением не сортируют: колонка собирается в памяти из документов человека.
    expect(garageDriverQuerySchema.safeParse({ sortBy: 'license' }).success).toBe(false);
  });

  it('комплект документов спрашивается теми же двумя словами, что в справочнике', () => {
    expect(garageDriverQuerySchema.parse({ documents: 'complete' }).documents).toBe('complete');
    expect(garageDriverQuerySchema.parse({ documents: 'incomplete' }).documents).toBe('incomplete');
    expect(garageDriverQuerySchema.safeParse({ documents: 'any' }).success).toBe(false);
  });
});

describe('словарь состояний', () => {
  it('у каждого состояния есть подпись и цвет', () => {
    for (const state of GARAGE_VEHICLE_STATES) {
      expect(garageVehicleStateLabels[state], state).toBeTruthy();
      expect(garageVehicleStateColors[state], state).toBeTruthy();
    }
    for (const state of GARAGE_DRIVER_STATES) {
      expect(garageDriverStateLabels[state], state).toBeTruthy();
      expect(garageDriverStateColors[state], state).toBeTruthy();
    }
  });

  it('состояния перечислены по старшинству — тем же порядком, что считает сервер', () => {
    // Порядок здесь не украшение: по нему читается правило «недоступность перекрывает работу, а
    // объект — рейс», и разойдись он с `vehicleStateSql`, список состояний перестал бы объяснять
    // колонку.
    expect([...GARAGE_VEHICLE_STATES]).toEqual(['unavailable', 'on_site', 'on_route', 'free']);
    expect([...GARAGE_DRIVER_STATES]).toEqual(['assigned', 'free']);
  });
});

/**
 * Удостоверение в строке среза (Р11–Р13): чем строка подсвечена и какой документ она называет.
 *
 * Обе функции живут в контрактах, а спрашивают их сервер и портал: сервер кладёт в строку дефект
 * показанного документа, портал считает по нему подсветку. Разъедься ответы — и одно и то же
 * удостоверение оказалось бы в списке красным, а в карточке жёлтым.
 */

const DAY = '2026-08-20';

/** Документ в объёме, который спрашивает показ: годность, графы бланка и идентификатор ничьей. */
function license(
  over: Partial<{
    id: string;
    credentialTypeCode: CredentialTypeCode;
    series: string;
    number: string;
    issuedOn: string | null;
    expiresOn: string | null;
    revokedAt: string | null;
    verificationStatus: CredentialVerificationStatus;
  }> = {},
) {
  return {
    id: 'a0000000-0000-4000-8000-000000000000',
    credentialTypeCode: 'driver_license' as CredentialTypeCode,
    series: '99 39',
    number: '482645',
    issuedOn: '2021-03-12',
    expiresOn: '2031-03-12',
    revokedAt: null,
    verificationStatus: 'verified' as CredentialVerificationStatus,
    ...over,
  };
}

describe('подсветка удостоверения', () => {
  it('порог считается календарными сутками: 31 день — ещё годен, 30 и 29 — истекает', () => {
    // Границы взяты от дня среза, а не от «сегодня»: заявку берут в работу заранее, и права,
    // истекающие через месяц, для рейса следующей недели уже жёлтые.
    expect(licenseDisplayState({ expiresOn: '2026-09-20', defect: null }, DAY)).toBe('valid');
    expect(licenseDisplayState({ expiresOn: '2026-09-19', defect: null }, DAY)).toBe('expiring');
    expect(licenseDisplayState({ expiresOn: '2026-09-18', defect: null }, DAY)).toBe('expiring');
    // День окончания входит в срок: сегодня документ ещё действует.
    expect(licenseDisplayState({ expiresOn: DAY, defect: null }, DAY)).toBe('expiring');
  });

  it('бессрочный документ подсветки не заслуживает', () => {
    expect(licenseDisplayState({ expiresOn: null, defect: null }, DAY)).toBe('none');
  });

  it('дефект старше срока: отклонённый с будущим сроком подписан отклонением, а не просрочкой', () => {
    // Ради этой строки состояние и считается поверх дефекта: срок у документа впереди, и счёт по
    // одному сроку назвал бы его годным — неправду о том, почему им нельзя выписывать лист.
    expect(licenseDisplayState({ expiresOn: '2031-03-12', defect: 'rejected' }, DAY)).toBe(
      'rejected',
    );
    // Аннулированный бессрочный: пустой срок дефект не отменяет.
    expect(licenseDisplayState({ expiresOn: null, defect: 'revoked' }, DAY)).toBe('revoked');
    expect(licenseDisplayState({ expiresOn: '2026-08-19', defect: 'expired' }, DAY)).toBe(
      'expired',
    );
  });
});

describe('какой документ показывает строка', () => {
  it('годный есть — показывается ровно тот, которым выпишется лист', () => {
    const valid = license({ id: 'b0000000-0000-4000-8000-000000000001' });
    const revoked = license({
      id: 'b0000000-0000-4000-8000-000000000002',
      expiresOn: null,
      revokedAt: '2026-01-10T00:00:00.000Z',
    });
    const licenses = [revoked, valid];
    expect(displayDocumentOf(licenses, 'Водитель', DAY)).toBe(valid);
    // Совпадение с правилом выписки — не совпадение случая: показ отличается от него только
    // хвостом «годного нет».
    expect(displayDocumentOf(licenses, 'Водитель', DAY)).toBe(
      waybillDocumentOf(licenses, 'Водитель', DAY),
    );
  });

  it('годного нет — впереди бессрочный аннулированный, и вид документа всё равно свой', () => {
    const revoked = license({
      id: 'c0000000-0000-4000-8000-000000000001',
      expiresOn: null,
      revokedAt: '2026-01-10T00:00:00.000Z',
    });
    const expired = license({
      id: 'c0000000-0000-4000-8000-000000000002',
      expiresOn: '2026-08-19',
    });
    // Тракторное лежит рядом и по ключам порядка обошло бы оба — но у водителя лист выписывается
    // по водительскому, и чужой номер в строке выглядел бы допуском, которого нет (ADR 0095).
    const tractor = license({
      id: 'c0000000-0000-4000-8000-000000000003',
      credentialTypeCode: 'tractor_license',
      expiresOn: null,
      revokedAt: '2026-02-10T00:00:00.000Z',
    });
    const licenses = [expired, tractor, revoked];
    expect(displayDocumentOf(licenses, 'Водитель', DAY)).toBe(revoked);
    expect(displayDocumentOf([...licenses].reverse(), 'Водитель', DAY)).toBe(revoked);
    expect(waybillDocumentOf(licenses, 'Водитель', DAY)).toBeNull();
  });

  it('ничья разводится датой выдачи, затем пробелами, затем идентификатором', () => {
    const older = license({
      id: 'd0000000-0000-4000-8000-000000000001',
      expiresOn: '2026-08-19',
      issuedOn: '2016-03-12',
    });
    const newer = license({
      id: 'd0000000-0000-4000-8000-000000000002',
      expiresOn: '2026-08-19',
      issuedOn: '2021-03-12',
    });
    expect(displayDocumentOf([older, newer], 'Водитель', DAY)).toBe(newer);
    expect(displayDocumentOf([newer, older], 'Водитель', DAY)).toBe(newer);

    // Те же сроки и та же выдача — впереди заполненный: пустые серия с номером в строке среза
    // ничего не сказали бы о том, чей это документ.
    const noRequisites = license({
      id: 'd0000000-0000-4000-8000-000000000000',
      expiresOn: '2026-08-19',
      issuedOn: '2021-03-12',
      series: '',
      number: '',
    });
    expect(displayDocumentOf([noRequisites, newer], 'Водитель', DAY)).toBe(newer);
    expect(displayDocumentOf([newer, noRequisites], 'Водитель', DAY)).toBe(newer);

    // Совпало всё — побеждает меньший `id`: иначе строку выбирал бы порядок запроса, и правка
    // сортировки в `loadDriverLicenses` молча меняла бы показанный документ.
    const twin = license({
      id: 'd0000000-0000-4000-8000-000000000003',
      expiresOn: '2026-08-19',
      issuedOn: '2021-03-12',
    });
    expect(displayDocumentOf([twin, newer], 'Водитель', DAY)).toBe(newer);
    expect(displayDocumentOf([newer, twin], 'Водитель', DAY)).toBe(newer);
  });

  it('своего вида нет вовсе — показывать нечего', () => {
    const tractor = license({ credentialTypeCode: 'tractor_license', expiresOn: '2026-08-19' });
    expect(displayDocumentOf([tractor], 'Водитель', DAY)).toBeNull();
  });
});

describe('право на раздел', () => {
  it('гараж открыт тем же, кто ведёт водителей и листы', () => {
    // Служба главного механика читает парк по должности (docs/access-model.md): техника компании
    // — её предмет, и без гаража ей нечем увидеть, где машина стоит сегодня.
    expect(profilesWith('garage.read').map((s) => s.role)).toEqual([
      'admin',
      'manager',
      'dispatcher',
      'mechanic',
      'chief_mechanic',
    ]);
  });

  it('наблюдателю раздел закрыт, хотя заявки он читает', () => {
    // В срезе видно, кто за рулём: это персональные данные, а у наблюдателя нет ни `drivers.read`,
    // ни `waybills.read` (ADR 0033) — и гараж не должен обойти оба запрета.
    expect(can({ role: 'observer' }, 'vehicleRequests.read')).toBe(true);
    expect(can({ role: 'observer' }, 'garage.read')).toBe(false);
  });

  it('арендодателю ТС раздел закрыт: парк и водители в нём наши', () => {
    expect(can({ role: 'operator', counterpartyType: 'vehicle_lessor' }, 'garage.read')).toBe(
      false,
    );
  });
});
