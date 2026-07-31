import { describe, expect, it } from 'vitest';
import {
  createDriverSchema,
  driverLicenseInputSchema,
  formatSnils,
  hasCategoryOn,
  isValidSnils,
  licenseDefect,
  licenseNumberLabel,
  licenseRequisitesMissing,
  normalizeSnils,
  snilsSchema,
  trailerCategoryCode,
  type DriverLicenseDto,
} from '@technic/contracts';

/**
 * Справочник водителей и его реквизиты (ADR 0037). Проверяется вход и правила годности документа:
 * по ним же отбирается водитель под машину, поэтому расхождение правил формы и сервера дало бы
 * список, в котором человек есть, а сохранить его нельзя — или наоборот.
 */

const CATEGORY_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_CATEGORY_ID = '22222222-2222-4222-8222-222222222222';

const VALID_DRIVER = {
  lastName: 'Тестовый',
  firstName: 'Водитель',
  middleName: 'Первый',
  snils: '112-233-445 95',
};

function license(over: Partial<DriverLicenseDto> = {}): DriverLicenseDto {
  return {
    id: 'l1',
    series: '00 00',
    number: '000001',
    issuedOn: '2021-03-12',
    expiresOn: '2031-03-12',
    issuedBy: '',
    verificationStatus: 'verified',
    verifiedByName: null,
    verifiedAt: '2021-03-13T00:00:00.000Z',
    revokedAt: null,
    revokeReason: '',
    categories: [
      {
        categoryId: CATEGORY_ID,
        code: 'c',
        name: 'C',
        validFrom: null,
        validTo: null,
        restrictions: '',
      },
    ],
    ...over,
  };
}

describe('СНИЛС: нормализация и формат', () => {
  it('разделители — оформление, а не часть номера', () => {
    expect(normalizeSnils('112-233-445 95')).toBe('11223344595');
    expect(normalizeSnils('112 233 445 95')).toBe('11223344595');
    expect(normalizeSnils('11223344595')).toBe('11223344595');
  });

  it('на выводе номер печатается так, как он в документе', () => {
    expect(formatSnils('11223344595')).toBe('112-233-445 95');
  });

  it('схема принимает набранное с разделителями и отдаёт цифры', () => {
    expect(snilsSchema.parse('112-233-445 95')).toBe('11223344595');
  });

  it('десять цифр — не СНИЛС', () => {
    expect(snilsSchema.safeParse('1122334459').success).toBe(false);
  });

  it('мегабайт пробелов не доходит до регулярного выражения', () => {
    expect(snilsSchema.safeParse(' '.repeat(5000)).success).toBe(false);
  });
});

describe('СНИЛС: контрольная сумма', () => {
  it('принимает верный номер и отклоняет опечатку в одной цифре', () => {
    expect(isValidSnils('112-233-445 95')).toBe(true);
    expect(isValidSnils('112-233-445 96')).toBe(false);
  });

  it('номера до 001-001-998 выданы без контрольного числа и не проверяются', () => {
    expect(isValidSnils('00100199899')).toBe(true);
  });

  it('нецифровое значение не проходит', () => {
    expect(isValidSnils('11223344КОД')).toBe(false);
  });

  /**
   * Утверждённые тестовые водители (ADR 0037): номера из одинаковых цифр очевидно синтетические,
   * но контрольную сумму обязаны проходить — иначе карточку такого водителя нельзя будет открыть
   * и сохранить через ту же форму, которой пользуются с настоящими.
   */
  it('тестовые номера сида проходят проверку', () => {
    const seeded = [
      '111-111-111 45',
      '222-222-222 90',
      '333-333-333 34',
      '444-444-444 79',
      '555-555-555 23',
      '666-666-666 68',
      '777-777-777 12',
      '888-888-888 57',
      '999-999-999 01',
    ];
    expect(seeded.filter((s) => !isValidSnils(s))).toEqual([]);
  });
});

describe('годность удостоверения на дату', () => {
  it('действующий проверенный документ годен', () => {
    expect(licenseDefect(license(), '2026-07-30')).toBeNull();
  });

  it('срок сверяется с датой рейса, а не с сегодняшним днём', () => {
    const l = license({ expiresOn: '2026-07-29' });
    expect(licenseDefect(l, '2026-07-28')).toBeNull();
    expect(licenseDefect(l, '2026-07-29')).toBeNull();
    expect(licenseDefect(l, '2026-07-30')).toBe('expired');
  });

  it('аннулирование сильнее срока: документ был действующим и перестал им быть', () => {
    expect(licenseDefect(license({ revokedAt: '2026-06-15T00:00:00.000Z' }), '2026-07-30')).toBe(
      'revoked',
    );
  });

  it('отклонённый при проверке документ не годится', () => {
    expect(licenseDefect(license({ verificationStatus: 'rejected' }), '2026-07-30')).toBe(
      'rejected',
    );
  });

  it('непроверенный документ дефектом не считается — его помечают, а не прячут', () => {
    expect(
      licenseDefect(license({ verificationStatus: 'unverified', verifiedAt: null }), '2026-07-30'),
    ).toBeNull();
  });

  it('бессрочный документ не то же самое, что просроченный', () => {
    expect(licenseDefect(license({ expiresOn: null }), '2099-01-01')).toBeNull();
  });
});

describe('рейс с прицепом', () => {
  it('поднимает требование до E-версии той же категории', () => {
    expect(trailerCategoryCode('c')).toBe('ce');
    expect(trailerCategoryCode('b')).toBe('be');
    expect(trailerCategoryCode('c1')).toBe('c1e');
  });

  it('категорию, которая уже с прицепом, не меняет — подменять нечем', () => {
    expect(trailerCategoryCode('ce')).toBe('ce');
    expect(trailerCategoryCode('be')).toBe('be');
  });

  it('к трамваю и мопеду прицеп неприменим: требование остаётся прежним', () => {
    expect(trailerCategoryCode('tm')).toBe('tm');
    expect(trailerCategoryCode('m')).toBe('m');
  });
});

describe('категории документа', () => {
  it('открытая категория находится по коду', () => {
    expect(hasCategoryOn(license(), 'c', '2026-07-30')).toBe(true);
    expect(hasCategoryOn(license(), 'ce', '2026-07-30')).toBe(false);
  });

  it('собственный срок категории сужает срок документа, но не продлевает его', () => {
    const l = license({
      categories: [
        {
          categoryId: CATEGORY_ID,
          code: 'ce',
          name: 'CE',
          validFrom: null,
          validTo: '2026-06-01',
          restrictions: '',
        },
      ],
    });
    // Сам документ действует до 2031 года, а категория закрылась в июне.
    expect(licenseDefect(l, '2026-07-30')).toBeNull();
    expect(hasCategoryOn(l, 'ce', '2026-05-31')).toBe(true);
    expect(hasCategoryOn(l, 'ce', '2026-07-30')).toBe(false);
  });
});

describe('ввод удостоверения', () => {
  const CATEGORY = { categoryId: CATEGORY_ID };

  it('документ без категорий не открывает ничего', () => {
    const r = driverLicenseInputSchema.safeParse({ number: '000001', categories: [] });
    expect(r.success).toBe(false);
  });

  it('одна и та же категория дважды — ошибка ввода, а не два допуска', () => {
    const r = driverLicenseInputSchema.safeParse({
      number: '000001',
      categories: [CATEGORY, { categoryId: CATEGORY_ID }],
    });
    expect(r.success).toBe(false);
  });

  it('две разные категории принимаются', () => {
    const r = driverLicenseInputSchema.safeParse({
      number: '000001',
      categories: [CATEGORY, { categoryId: OTHER_CATEGORY_ID }],
    });
    expect(r.success).toBe(true);
  });

  it('срок не может истечь раньше выдачи', () => {
    const r = driverLicenseInputSchema.safeParse({
      number: '000001',
      issuedOn: '2026-07-30',
      expiresOn: '2026-07-29',
      categories: [CATEGORY],
    });
    expect(r.success).toBe(false);
  });

  it('несуществующая дата не проходит, хотя формат совпадает', () => {
    const r = driverLicenseInputSchema.safeParse({
      number: '000001',
      issuedOn: '2026-02-31',
      categories: [CATEGORY],
    });
    expect(r.success).toBe(false);
  });
});

describe('заведение водителя', () => {
  it('без СНИЛС водителя не завести: ради него карточка и существует', () => {
    const { snils: _snils, ...withoutSnils } = VALID_DRIVER;
    expect(createDriverSchema.safeParse(withoutSnils).success).toBe(false);
  });

  it('СНИЛС нормализуется на входе, должность подставляется', () => {
    const r = createDriverSchema.parse(VALID_DRIVER);
    expect(r.snils).toBe('11223344595');
    expect(r.jobTitle).toBe('Водитель');
  });

  it('удостоверение необязательно: человека заводят и до того, как принесли документы', () => {
    expect(createDriverSchema.safeParse(VALID_DRIVER).success).toBe(true);
  });

  it('лишнее поле отклоняется, а не молча теряется', () => {
    expect(createDriverSchema.safeParse({ ...VALID_DRIVER, role: 'admin' }).success).toBe(false);
  });
});

describe('реквизиты удостоверения не внесены', () => {
  it('документ из кадровой выгрузки: категории есть, серии и номера нет', () => {
    expect(licenseRequisitesMissing(licenseNumberLabel({ series: '', number: '' }))).toBe(true);
  });

  it('одного номера достаточно: серия есть не во всяком бланке', () => {
    expect(licenseRequisitesMissing(licenseNumberLabel({ series: '', number: '482645' }))).toBe(
      false,
    );
  });

  it('заполненный документ предупреждения не вызывает', () => {
    expect(licenseRequisitesMissing(licenseNumberLabel({ series: '99 39', number: '482645' }))).toBe(
      false,
    );
  });

  it('пробелы вместо номера — это не номер', () => {
    expect(licenseRequisitesMissing('   ')).toBe(true);
  });

  it('строку выбора сервер склеивает сам — правило то же', () => {
    expect(licenseRequisitesMissing('')).toBe(true);
    expect(licenseRequisitesMissing('00 00 000001')).toBe(false);
  });
});
