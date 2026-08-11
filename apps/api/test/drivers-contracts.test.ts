import { describe, expect, it } from 'vitest';
import {
  compareDriverOptions,
  driverCategoryMismatchWarning,
  createDriverSchema,
  driverDocumentGaps,
  driverDocumentGapsHint,
  driverDocumentGapsWarning,
  driverDocumentsComplete,
  driverRelevanceRank,
  driverLicenseInputSchema,
  driverListQuerySchema,
  driverWorkedOnVehicle,
  formatSnils,
  hasCategoryOn,
  isValidSnils,
  licenseDefect,
  licenseNumberLabel,
  licenseRequisitesMissing,
  normalizeJobTitle,
  normalizeSnils,
  requiredCredentialType,
  jobTitleCredentialType,
  snilsSchema,
  trailerCategoryCode,
  updateDriverSchema,
  waybillDocumentOf,
  waybillLicenseOf,
  type DriverDocumentGap,
  type DriverDto,
  type DriverLicenseDto,
} from '@technic/contracts';

/**
 * Справочник водителей и его реквизиты (ADR 0037). Проверяется вход и правила годности документа:
 * по ним же отбирается водитель под машину, поэтому расхождение правил формы и сервера дало бы
 * список, в котором человек есть, а сохранить его нельзя — или наоборот.
 *
 * Документов у справочника два вида (ADR 0095), и какой из них смотреть — решает должность.
 * Поэтому там, где раньше спрашивали «есть ли годное удостоверение», теперь спрашивают «есть ли
 * годный документ **того** вида»: у машиниста экскаватора комплект закрывает тракторное, а
 * водительское, лежащее рядом, не закрывает ничего.
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
    credentialTypeCode: 'driver_license',
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

/**
 * Тракторное удостоверение: те же графы, другой вид и другой смысл у той же буквы. «C» здесь —
 * колёсная машина до 110 кВт, а не грузовик, и подменять им водительское нельзя ни в листе, ни в
 * подсчёте пробелов.
 */
function tractorLicense(over: Partial<DriverLicenseDto> = {}): DriverLicenseDto {
  return license({
    id: 't1',
    credentialTypeCode: 'tractor_license',
    series: 'AB',
    number: '900001',
    ...over,
  });
}

const MACHINIST = 'Машинист экскаватора';

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

  it('вид документа необязателен: не прислали — заводится водительское', () => {
    expect(
      driverLicenseInputSchema.parse({ number: '000001', categories: [CATEGORY] }).credentialType,
    ).toBe('driver_license');
    expect(
      driverLicenseInputSchema.safeParse({
        number: '000001',
        credentialType: 'medical',
        categories: [CATEGORY],
      }).success,
    ).toBe(false);
  });

  it('у тракторного категории необязательны: в кадровой выгрузке их не бывает вовсе', () => {
    // Требовать букву, которой нет в присланных данных, значило бы не дать завести документ, по
    // которому машинист ездит, — а листу нужны номер и дата выдачи, а не категория.
    const r = driverLicenseInputSchema.safeParse({
      number: '900001',
      credentialType: 'tractor_license',
      categories: [],
    });
    expect(r.success).toBe(true);
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

describe('email водителя', () => {
  it('не указан — пустая строка: письма такому водителю не отправляются', () => {
    expect(createDriverSchema.parse(VALID_DRIVER).email).toBe('');
  });

  it('адрес принимается и очищается от пробелов по краям', () => {
    const r = createDriverSchema.parse({ ...VALID_DRIVER, email: ' ivanov@example.ru ' });
    expect(r.email).toBe('ivanov@example.ru');
  });

  it('регистр сохраняется: в базе citext, и показывать адрес не так, как его написали, незачем', () => {
    const r = createDriverSchema.parse({ ...VALID_DRIVER, email: 'Ivanov@Example.RU' });
    expect(r.email).toBe('Ivanov@Example.RU');
  });

  it('«-» и «нет» вместо адреса не проходят: такое поле выглядит заполненным, а письмо не уйдёт', () => {
    for (const value of ['-', 'нет', 'ivanov(at)example.ru', 'ivanov@']) {
      expect(createDriverSchema.safeParse({ ...VALID_DRIVER, email: value }).success).toBe(false);
    }
  });

  it('в правке карточки поле необязательно: не прислали — адрес остаётся прежним', () => {
    const r = updateDriverSchema.parse({ version: 0 });
    expect(r.email).toBeUndefined();
  });

  it('пустая строка в правке — это «убрать адрес», и она проходит', () => {
    const r = updateDriverSchema.parse({ version: 0, email: '' });
    expect(r.email).toBe('');
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
    expect(
      licenseRequisitesMissing(licenseNumberLabel({ series: '99 39', number: '482645' })),
    ).toBe(false);
  });

  it('пробелы вместо номера — это не номер', () => {
    expect(licenseRequisitesMissing('   ')).toBe(true);
  });

  it('строку выбора сервер склеивает сам — правило то же', () => {
    expect(licenseRequisitesMissing('')).toBe(true);
    expect(licenseRequisitesMissing('00 00 000001')).toBe(false);
  });
});

/**
 * Порядок списка выбора (ADR 0056). Правило живёт в контрактах, потому что применяют его двое:
 * сервер сортирует ответ, форма его показывает — и разойтись им негде.
 */
describe('водители, работавшие на этой машине, идут первыми', () => {
  const worked = (fullName: string, lastWorkedOn: string | null) => ({
    fullName,
    lastWorkedOn,
    // Категория подходит и комплект полон у всех: их влияние на порядок проверяется отдельно, а
    // здесь они сравняли бы всех по первым ключам и спрятали бы разницу в опыте.
    matchesRequiredCategory: true,
    gaps: [],
  });

  it('опыт поднимает над алфавитом', () => {
    const list = [
      worked('Абрамов А. А.', null),
      worked('Яковлев Я. Я.', '2026-07-14'),
      worked('Борисов Б. Б.', null),
    ].sort(compareDriverOptions);
    expect(list.map((d) => d.fullName)).toEqual([
      'Яковлев Я. Я.',
      'Абрамов А. А.',
      'Борисов Б. Б.',
    ]);
  });

  it('среди работавших выше тот, кто ездил на ней последним', () => {
    const list = [
      worked('Абрамов А. А.', '2026-02-03'),
      worked('Яковлев Я. Я.', '2026-07-14'),
    ].sort(compareDriverOptions);
    expect(list.map((d) => d.fullName)).toEqual(['Яковлев Я. Я.', 'Абрамов А. А.']);
  });

  it('при равном опыте порядок остаётся алфавитным — и у работавших, и у остальных', () => {
    const sameDay = [worked('Яковлев Я. Я.', '2026-07-14'), worked('Абрамов А. А.', '2026-07-14')];
    expect(sameDay.sort(compareDriverOptions).map((d) => d.fullName)).toEqual([
      'Абрамов А. А.',
      'Яковлев Я. Я.',
    ]);

    const noExperience = [worked('Яковлев Я. Я.', null), worked('Абрамов А. А.', null)];
    expect(noExperience.sort(compareDriverOptions).map((d) => d.fullName)).toEqual([
      'Абрамов А. А.',
      'Яковлев Я. Я.',
    ]);
  });

  it('пометку ставит факт работы, а не число рейсов', () => {
    expect(driverWorkedOnVehicle({ lastWorkedOn: '2026-07-14' })).toBe(true);
    expect(driverWorkedOnVehicle({ lastWorkedOn: null })).toBe(false);
  });
});

describe('комплект документов для путевого листа', () => {
  const ON = '2026-08-03';
  const driver = (over: Partial<Pick<DriverDto, 'snils' | 'jobTitle' | 'licenses'>> = {}) => ({
    snils: '11223344595',
    jobTitle: 'Водитель',
    licenses: [license()],
    ...over,
  });

  it('СНИЛС, номер и дата выдачи — полный комплект', () => {
    expect(driverDocumentGaps(driver(), ON)).toEqual([]);
    expect(driverDocumentsComplete(driver(), ON)).toBe(true);
  });

  it('срок в комплект не входит: бессрочный документ — не пустая графа', () => {
    expect(driverDocumentsComplete(driver({ licenses: [license({ expiresOn: null })] }), ON)).toBe(
      true,
    );
  });

  it('документ из кадровой выгрузки: категории есть, реквизитов нет', () => {
    expect(
      driverDocumentGaps(
        driver({ licenses: [license({ series: '', number: '', issuedOn: null })] }),
        ON,
      ),
    ).toEqual(['requisites', 'issuedOn']);
  });

  it('одной серии достаточно: она и номер печатаются в листе одной графой', () => {
    expect(driverDocumentGaps(driver({ licenses: [license({ number: '' })] }), ON)).toEqual([]);
  });

  it('без СНИЛС лист недействителен, сколько бы граф в документе ни было', () => {
    expect(driverDocumentGaps(driver({ snils: '' }), ON)).toEqual(['snils']);
  });

  it('негодный документ комплекта не даёт: по нему в рейс не выйти', () => {
    const cases: DriverLicenseDto[] = [
      license({ expiresOn: '2026-08-02' }),
      license({ revokedAt: '2026-07-01T00:00:00.000Z' }),
      license({ verificationStatus: 'rejected' }),
    ];
    for (const l of cases) {
      expect(driverDocumentGaps(driver({ licenses: [l] }), ON)).toEqual(['license']);
    }
  });

  it('непроверенный документ комплект не рушит: проверка бумаги — учётная процедура', () => {
    expect(
      driverDocumentsComplete(
        driver({ licenses: [license({ verificationStatus: 'unverified' })] }),
        ON,
      ),
    ).toBe(true);
  });

  it('из нескольких годных берётся самый заполненный: лист выпишется по любому', () => {
    const partial = license({ id: 'l2', series: '', number: '', issuedOn: null });
    expect(driverDocumentGaps(driver({ licenses: [partial, license()] }), ON)).toEqual([]);
  });

  it('водитель без документов: пробел один — самого удостоверения нет', () => {
    expect(driverDocumentGaps(driver({ licenses: [] }), ON)).toEqual(['license']);
  });

  /**
   * Комплект машиниста считается по тракторному удостоверению (ADR 0095). Это и есть смена смысла
   * фильтра «Полный комплект»: у машиниста, заведённого с одним ВУ, комплект неполон — по ВУ его за
   * экскаватор не сажают, и лист по нему выписывать нечем.
   */
  it('машинисту комплект закрывает тракторное удостоверение, а водительское — нет', () => {
    const machinist = { jobTitle: MACHINIST, licenses: [tractorLicense()] };
    expect(driverDocumentGaps(driver(machinist), ON)).toEqual([]);
    expect(driverDocumentsComplete(driver(machinist), ON)).toBe(true);

    expect(driverDocumentGaps(driver({ jobTitle: MACHINIST, licenses: [license()] }), ON)).toEqual([
      'license',
    ]);
  });

  it('водителю комплект не закрывает тракторное — даже когда другого документа нет', () => {
    // Симметрия обязательна: иначе номер тракторного уехал бы в графу «водительское
    // удостоверение» листа 4-П, и заполненная графа выглядела бы верной.
    expect(driverDocumentGaps(driver({ licenses: [tractorLicense()] }), ON)).toEqual(['license']);
  });

  it('оба документа сразу: каждому спрашивают свой', () => {
    const both = [license(), tractorLicense()];
    expect(driverDocumentGaps(driver({ licenses: both }), ON)).toEqual([]);
    expect(driverDocumentGaps(driver({ jobTitle: MACHINIST, licenses: both }), ON)).toEqual([]);
    // Пробелы считаются по своему документу, а не по худшему из двух.
    const partialTractor = tractorLicense({ series: '', number: '', issuedOn: null });
    expect(driverDocumentGaps(driver({ licenses: [license(), partialTractor] }), ON)).toEqual([]);
    expect(
      driverDocumentGaps(
        driver({ jobTitle: MACHINIST, licenses: [license(), partialTractor] }),
        ON,
      ),
    ).toEqual(['requisites', 'issuedOn']);
  });

  it('незнакомая должность считается водительской: молча менять поведение нельзя', () => {
    expect(driverDocumentsComplete(driver({ jobTitle: 'Экскаваторщик' }), ON)).toBe(true);
    expect(driverDocumentsComplete(driver({ jobTitle: '' }), ON)).toBe(true);
  });

  it('фильтр справочника принимает оба значения и отклоняет прочие', () => {
    expect(driverListQuerySchema.safeParse({ documents: 'complete' }).success).toBe(true);
    expect(driverListQuerySchema.safeParse({ documents: 'incomplete' }).success).toBe(true);
    expect(driverListQuerySchema.safeParse({ documents: 'partial' }).success).toBe(false);
    // Не задан — справочник показывает всех: фильтр не сужает список молча.
    expect(driverListQuerySchema.parse({}).documents).toBeUndefined();
  });
});

/**
 * Должность называет документ (ADR 0095). Правило живёт в контрактах, потому что спрашивают его
 * трое: карточка справочника, подстановка в путевой лист и SQL-фильтр комплекта — и разойтись им
 * негде.
 */
describe('должность решает, каким документом человек допущен', () => {
  it('список закрытый: автокран ездит по дорогам, экскаватор — нет', () => {
    expect(requiredCredentialType('Водитель')).toBe('driver_license');
    expect(requiredCredentialType('Машинист автокрана')).toBe('driver_license');
    expect(requiredCredentialType('Машинист погрузчика')).toBe('tractor_license');
    expect(requiredCredentialType(MACHINIST)).toBe('tractor_license');
  });

  it('регистр и лишние пробелы — оформление кадровой строки, а не другая должность', () => {
    expect(normalizeJobTitle('  Машинист   Экскаватора ')).toBe('машинист экскаватора');
    expect(requiredCredentialType('  МАШИНИСТ  ЭКСКАВАТОРА ')).toBe('tractor_license');
  });

  it('незнакомая должность отвечает умолчанием, но остаётся неизвестной для загрузки', () => {
    // Разница существенна: приписать тракторные категории к ВУ значит выдать допуск к автобусу.
    expect(requiredCredentialType('Экскаваторщик')).toBe('driver_license');
    expect(jobTitleCredentialType('Экскаваторщик')).toBeNull();
    expect(jobTitleCredentialType('Водитель-экспедитор')).toBe('driver_license');
  });

  it('документ листа берётся своего вида — чужой не подставляется даже вместо пустого', () => {
    const ON = '2026-08-03';
    const both = [license(), tractorLicense()];
    expect(waybillDocumentOf(both, 'Водитель', ON)?.id).toBe('l1');
    expect(waybillDocumentOf(both, MACHINIST, ON)?.id).toBe('t1');
    expect(waybillDocumentOf([license()], MACHINIST, ON)).toBeNull();
  });

  it('фильтр списка по должности необязателен и приходит текстом', () => {
    expect(driverListQuerySchema.parse({}).jobTitle).toBeUndefined();
    expect(driverListQuerySchema.parse({ jobTitle: ' Машинист экскаватора ' }).jobTitle).toBe(
      'Машинист экскаватора',
    );
    expect(driverListQuerySchema.safeParse({ jobTitle: 'а'.repeat(256) }).success).toBe(false);
  });
});

/**
 * Категория прав — справочная информация (ADR 0055). Правило проверяется здесь же, где и комплект
 * документов: одно решает, кого показать, второе — как назвать расхождение, и путать их нельзя.
 */
describe('категория прав ничего не запрещает, но порядок и текст задаёт', () => {
  const option = (
    fullName: string,
    matchesRequiredCategory: boolean,
    lastWorkedOn: string | null = null,
  ) => ({ fullName, matchesRequiredCategory, lastWorkedOn, gaps: [] });

  it('подходящие по категории идут выше — даже без опыта на этой машине', () => {
    const list = [option('Яковлев Я. Я.', false, '2026-07-14'), option('Абрамов А. А.', true)].sort(
      compareDriverOptions,
    );
    expect(list.map((d) => d.fullName)).toEqual(['Абрамов А. А.', 'Яковлев Я. Я.']);
  });

  it('внутри группы порядок прежний: опыт, потом алфавит', () => {
    const list = [
      option('Борисов Б. Б.', true),
      option('Абрамов А. А.', true, '2026-02-03'),
      option('Яковлев Я. Я.', false, '2026-07-14'),
      option('Васильев В. В.', false),
    ].sort(compareDriverOptions);
    expect(list.map((d) => d.fullName)).toEqual([
      'Абрамов А. А.',
      'Борисов Б. Б.',
      'Яковлев Я. Я.',
      'Васильев В. В.',
    ]);
  });

  it('предупреждение называет обе стороны: что требует машина и что открыто у водителя', () => {
    const text = driverCategoryMismatchWarning(
      'CE',
      'driver_license',
      ['B', 'C'],
      'driver_license',
    );
    expect(text).toContain('CE');
    expect(text).toContain('B, C');
    // Запрета в тексте нет: расхождение — повод проверить документ, а не отказ.
    expect(text).toContain('Рейс заведётся как есть');
  });

  it('вид документа назван у каждой стороны: «C» тракториста — не «C» водительского', () => {
    // Иначе предупреждение читалось бы как ошибка портала: «нужна C, а открыта C».
    const text = driverCategoryMismatchWarning('C', 'driver_license', ['C'], 'tractor_license');
    expect(text).toContain('ВУ «C»');
    expect(text).toContain('по УТМ открыты «C»');
  });

  it('водитель без единой категории описан словами, а не пустыми кавычками', () => {
    expect(driverCategoryMismatchWarning('C', 'driver_license', [], 'driver_license')).toContain(
      'ни одной категории',
    );
  });

  it('фильтр справочника по категории необязателен и принимает только идентификатор', () => {
    expect(driverListQuerySchema.parse({}).categoryId).toBeUndefined();
    expect(driverListQuerySchema.safeParse({ categoryId: CATEGORY_ID }).success).toBe(true);
    expect(driverListQuerySchema.safeParse({ categoryId: 'ce' }).success).toBe(false);
  });
});

/**
 * Полнота документов — справочная информация (ADR 0064). Раньше она решала, кого показать; теперь
 * решает, кого показать **первым** и о чём предупредить. Проверяется здесь же, где и сам комплект:
 * пробелы считаются одним правилом, а называются в трёх местах, и разъехаться им негде.
 */
describe('полнота документов задаёт порядок и текст, но никого не убирает', () => {
  const option = (
    fullName: string,
    gaps: DriverDocumentGap[],
    matchesRequiredCategory = true,
    lastWorkedOn: string | null = null,
  ) => ({ fullName, gaps, matchesRequiredCategory, lastWorkedOn });

  it('пригодность считается документами прежде категории', () => {
    // Пустая графа бланка обнаружится в тот же день, а расхождение с категорией заведено оптом
    // миграцией 0059 и часто существует только в справочнике (ADR 0055).
    expect(driverRelevanceRank({ gaps: [], matchesRequiredCategory: true })).toBe(0);
    expect(driverRelevanceRank({ gaps: [], matchesRequiredCategory: false })).toBe(1);
    expect(driverRelevanceRank({ gaps: ['requisites'], matchesRequiredCategory: true })).toBe(2);
    expect(driverRelevanceRank({ gaps: ['snils'], matchesRequiredCategory: false })).toBe(3);
  });

  it('водитель без реквизитов ВУ уходит вниз, но из списка не исчезает', () => {
    const list = [option('Абрамов А. А.', ['requisites']), option('Яковлев Я. Я.', [])].sort(
      compareDriverOptions,
    );
    // Алфавит уступил пригодности — и оба на месте: отбора больше нет (ADR 0064).
    expect(list.map((d) => d.fullName)).toEqual(['Яковлев Я. Я.', 'Абрамов А. А.']);
    expect(list).toHaveLength(2);
  });

  it('опыт на машине неполный комплект не перебивает', () => {
    // Иначе первым предлагался бы тот, на кого лист выпишется с пустыми графами.
    const list = [
      option('Абрамов А. А.', ['snils'], true, '2026-07-14'),
      option('Яковлев Я. Я.', [], true, null),
    ].sort(compareDriverOptions);
    expect(list.map((d) => d.fullName)).toEqual(['Яковлев Я. Я.', 'Абрамов А. А.']);
  });

  it('пометка строки перечисляет пробелы, а полный комплект молчит', () => {
    expect(driverDocumentGapsHint(['requisites', 'issuedOn'], 'driver_license')).toBe(
      'без номера ВУ, без даты выдачи ВУ',
    );
    expect(driverDocumentGapsHint([], 'driver_license')).toBeNull();
  });

  it('пробелы машиниста подписаны его документом: в кабину поедет другая бумага', () => {
    expect(driverDocumentGapsHint(['license'], 'tractor_license')).toBe('без действующего УТМ');
    expect(driverDocumentGapsHint(['requisites'], 'tractor_license')).toBe('без номера УТМ');
  });

  it('предупреждение называет последствие и бланк, а не состояние справочника', () => {
    const text = driverDocumentGapsWarning(['requisites'], 'driver_license', '4-П')!;
    expect(text).toContain('без номера ВУ');
    expect(text).toContain('4-П');
    expect(text).toContain('останутся пустыми');
    // Запрета в тексте нет: это предупреждение, а не отказ.
    expect(text).toContain('администратор');
  });

  it('без известного бланка предупреждение говорит о путевом листе вообще', () => {
    expect(driverDocumentGapsWarning(['snils'], 'driver_license', null)).toContain(
      'в путевом листе эти графы',
    );
  });

  it('полный комплект предупреждения не поднимает', () => {
    expect(driverDocumentGapsWarning([], 'driver_license', '4-П')).toBeNull();
  });
});

/**
 * Документ, по которому выпишется лист, — тот же, о пробелах которого предупредили. Правило одно
 * на портал и на сервер (`waybillLicenseOf`): две копии этого выбора означали бы лист, выписанный
 * по одному удостоверению, и предупреждение — по другому.
 */
describe('удостоверение для листа', () => {
  const ON = '2026-08-03';

  it('годное на дату; негодные не берутся', () => {
    expect(waybillLicenseOf([license({ expiresOn: '2026-08-02' })], ON)).toBeNull();
    expect(waybillLicenseOf([license()], ON)?.id).toBe(license().id);
  });

  it('из нескольких годных — самое заполненное', () => {
    const partial = license({ id: 'l2', series: '', number: '', issuedOn: null });
    expect(waybillLicenseOf([partial, license()], ON)?.id).toBe(license().id);
  });

  it('документов нет вовсе — брать нечего', () => {
    expect(waybillLicenseOf([], ON)).toBeNull();
  });
});
