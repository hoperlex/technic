import { describe, expect, it } from 'vitest';
import {
  createVehicleTrailerSchema,
  hitchTrailerSchema,
  TRAILER_HITCH_POSITIONS,
  TRAILER_KINDS,
  trailerKindLabels,
  trailerTitle,
  updateVehicleTrailerSchema,
  vehicleTrailerListQuerySchema,
} from '@technic/contracts';

/**
 * Контракты реестра прицепов (план `docs/vehicle-trailers-plan.md`, §12 «Шаг 2»).
 *
 * Файл проверяет ровно то, что решается формой и до базы не доезжает: какие графы СТС обязательны,
 * что делает форма с введённым текстом и чего она в тело не пускает. Всё остальное — уникальность
 * номера, слоты, порядок блокировок — предмет `vehicle-trailers.db.test.ts`: там живая схема, и
 * повторять её правила здесь значило бы завести второй источник тех же ограничений.
 *
 * Два предмета стоят отдельно от «проверок полей» и оправдывают файл сами по себе.
 *
 * 1. **`.strict()` как запрет привязки в теле.** Привязку меняет команда `POST /:id/hitch`, а не
 *    поле карточки (Р14), и держится это решение исключительно на `.strict()`: пропусти схема
 *    `hitchedVehicleId`, и портал получил бы второй путь к тому же значению — без единого порядка
 *    блокировок и без вытеснения прежнего жильца слота. Проверка стоит именно за это, а не за
 *    аккуратность к опечаткам в ключах.
 * 2. **`update` не наследует `.default()`.** Схема правки объявлена полями заново, а не
 *    `.partial()` от схемы заведения, потому что `.partial()` снимает обязательность, но
 *    **не** умолчание, — и PATCH одного статуса затирал бы VIN, цвет и примечание пустой строкой.
 *    Ошибка эта невидима на ревью и видна человеку сразу: он менял состояние, а потерял реквизиты.
 */

const ORG = '11111111-1111-4111-8111-111111111111';
const VEHICLE = '22222222-2222-4222-8222-222222222222';

/** Минимально валидное тело заведения: тип, марка и госномер — остальное схема доставит сама. */
const create = (patch: Record<string, unknown> = {}) => ({
  kind: 'semi_trailer' as const,
  model: 'ШМИТЦ SPR-24',
  registrationNumber: 'ВХ933277',
  ...patch,
});

describe('прицепы: заведение карточки', () => {
  it('минимально валидно — тип, марка и госномер; прочее приезжает умолчаниями', () => {
    const v = createVehicleTrailerSchema.parse(create());
    expect(v.kind).toBe('semi_trailer');
    expect(v.model).toBe('ШМИТЦ SPR-24');
    expect(v.registrationNumber).toBe('ВХ933277');
    // Умолчания в теле заведения нужны: строка заводится целиком, и пустая графа СТС — это пустая
    // строка, а не «неизвестно». `null` в них означал бы третье состояние, которого у текста нет.
    expect(v.vin).toBe('');
    expect(v.passportNumber).toBe('');
    expect(v.color).toBe('');
    expect(v.note).toBe('');
    expect(v.status).toBe('active');
  });

  it('марка обязательна: без неё прицеп не опознать в графе бланка', () => {
    // Три разных «пусто», и все три обязаны отказать одинаково: графа «(марка)» печатается, и
    // пробел в ней выглядит на бумаге ровно как отсутствие прицепа.
    expect(() => createVehicleTrailerSchema.parse({ ...create(), model: undefined })).toThrow();
    expect(() => createVehicleTrailerSchema.parse(create({ model: '' }))).toThrow();
    expect(() => createVehicleTrailerSchema.parse(create({ model: '   ' }))).toThrow();
  });

  it('госномер обязателен по той же причине и той же строгостью', () => {
    expect(() =>
      createVehicleTrailerSchema.parse({ ...create(), registrationNumber: undefined }),
    ).toThrow();
    expect(() => createVehicleTrailerSchema.parse(create({ registrationNumber: '' }))).toThrow();
    expect(() =>
      createVehicleTrailerSchema.parse(create({ registrationNumber: ' \t ' })),
    ).toThrow();
  });

  it('обрезает края у всего, что вводят руками', () => {
    // Реквизиты переносят с бумаги копированием, и хвостовой пробел приезжает вместе с текстом.
    // Не обрежь его форма — «ВХ933277 » и «ВХ933277» были бы в реестре двумя разными прицепами:
    // уникальность считается по нормализованному значению, но само значение хранится как введено.
    const v = createVehicleTrailerSchema.parse(
      create({
        model: '  ШМИТЦ SPR-24  ',
        registrationNumber: '  ВХ933277 ',
        vin: ' WSM00000005142287 ',
        passportNumber: ' 50НТ926651 ',
        color: ' белый ',
        note: '  полуприцеп с бортовой платформой  ',
      }),
    );
    expect(v.model).toBe('ШМИТЦ SPR-24');
    expect(v.registrationNumber).toBe('ВХ933277');
    expect(v.vin).toBe('WSM00000005142287');
    expect(v.passportNumber).toBe('50НТ926651');
    expect(v.color).toBe('белый');
    expect(v.note).toBe('полуприцеп с бортовой платформой');
  });

  it('приводить госномер к латинице и верхнему регистру форме не поручено', () => {
    // Это не пропуск: единственная нормализация госномера в портале — `vehicle_reg_normalize` в
    // БД, и она же считает уникальность и ищет. Приведи форма номер к «BX933277» ещё и на входе —
    // человек увидел бы в карточке не то, что переписал с бумаги, а реестр хранил бы два вида
    // одного реквизита. Случай стоит здесь именно затем, чтобы правку «а давайте нормализуем
    // заодно и тут» кто-нибудь заметил до выката.
    const v = createVehicleTrailerSchema.parse(create({ registrationNumber: 'вх 933277' }));
    expect(v.registrationNumber).toBe('вх 933277');
  });

  it('масса в снаряжённом состоянии не больше технически допустимой', () => {
    expect(() =>
      createVehicleTrailerSchema.parse(create({ maxMassKg: 39_000, curbMassKg: 40_000 })),
    ).toThrow();
    // Равенство законно: у бортовых полуприцепов графы СТС совпадают чаще, чем кажется.
    expect(
      createVehicleTrailerSchema.parse(create({ maxMassKg: 39_000, curbMassKg: 39_000 }))
        .curbMassKg,
    ).toBe(39_000);
    expect(
      createVehicleTrailerSchema.parse(create({ maxMassKg: 39_000, curbMassKg: 6_500 })).curbMassKg,
    ).toBe(6_500);
  });

  it('порядок масс не требует обеих граф: бумага бывает неполной', () => {
    // Скан СТС приходит односторонним, и требовать пару значило бы запретить завести прицеп до
    // того, как найдётся вторая половина документа. Одностороннюю правку («максимальную опустили
    // ниже прежней снаряжённой») ловит CHECK в БД — телу PATCH второй половины пары не видно.
    expect(createVehicleTrailerSchema.parse(create({ curbMassKg: 6_500 })).maxMassKg ?? null).toBe(
      null,
    );
    expect(createVehicleTrailerSchema.parse(create({ maxMassKg: 39_000 })).curbMassKg ?? null).toBe(
      null,
    );
    expect(
      createVehicleTrailerSchema.parse(create({ maxMassKg: null, curbMassKg: null })).kind,
    ).toBe('semi_trailer');
  });

  it('отказ по порядку масс указывает на снаряжённую графу', () => {
    // Пометка поля — не украшение: портал подсвечивает по `path` ту графу, которую человеку
    // править. Укажи отказ на карточку целиком — форма показала бы ошибку без места.
    const parsed = createVehicleTrailerSchema.safeParse(
      create({ maxMassKg: 6_000, curbMassKg: 6_500 }),
    );
    expect(parsed.success).toBe(false);
    expect(parsed.success === false && parsed.error.issues[0]!.path).toEqual(['curbMassKg']);
  });

  it('масса — целое, положительное и в пределах `integer` базы', () => {
    // Верхняя граница продуктового смысла не имеет: она стоит затем, чтобы лишний ноль из
    // опечатки отбивался формой, а не возвращался пятисоткой «integer out of range» из Postgres.
    expect(() => createVehicleTrailerSchema.parse(create({ maxMassKg: 0 }))).toThrow();
    expect(() => createVehicleTrailerSchema.parse(create({ maxMassKg: -1 }))).toThrow();
    expect(() => createVehicleTrailerSchema.parse(create({ maxMassKg: 6_500.5 }))).toThrow();
    expect(() => createVehicleTrailerSchema.parse(create({ maxMassKg: 2_147_483_648 }))).toThrow();
  });

  it('год выпуска ограничен теми же границами, что и CHECK таблицы', () => {
    // Расходиться проверке формы и базе не за что: разойдись они — форма приняла бы год, на
    // котором транзакция упадёт нарушением ограничения.
    expect(() => createVehicleTrailerSchema.parse(create({ manufacturedYear: 1899 }))).toThrow();
    expect(() => createVehicleTrailerSchema.parse(create({ manufacturedYear: 2101 }))).toThrow();
    expect(() => createVehicleTrailerSchema.parse(create({ manufacturedYear: 2013.5 }))).toThrow();
    expect(
      createVehicleTrailerSchema.parse(create({ manufacturedYear: 2013 })).manufacturedYear,
    ).toBe(2013);
    // Год со скана читается не всегда — пустая графа законна.
    expect(
      createVehicleTrailerSchema.parse(create({ manufacturedYear: null })).manufacturedYear ?? null,
    ).toBe(null);
  });

  it('вид прицепа — только два значения, и у каждого есть подпись', () => {
    // Своего классификатора у прицепа нет и не заводится (Р7): видов ровно два. Пара «значение —
    // подпись» проверяется здесь, потому что разъехаться им негде больше: выпадающий список
    // собирается из `TRAILER_KINDS`, а рисуется по `trailerKindLabels`.
    expect(() => createVehicleTrailerSchema.parse(create({ kind: 'dolly' }))).toThrow();
    for (const kind of TRAILER_KINDS) {
      expect(createVehicleTrailerSchema.parse(create({ kind })).kind).toBe(kind);
      expect(trailerKindLabels[kind]).toBeTruthy();
    }
  });

  it('состояние — те же четыре, что у техники', () => {
    expect(createVehicleTrailerSchema.parse(create({ status: 'maintenance' })).status).toBe(
      'maintenance',
    );
    // Отдельного «прицеплен/отцеплен» здесь нет намеренно (Р2): на этот вопрос отвечает сама
    // привязка, а флаг рядом с ней был бы вторым источником того же факта.
    expect(() => createVehicleTrailerSchema.parse(create({ status: 'hitched' }))).toThrow();
  });

  it('собственник — ссылка на организацию, а не свободный текст', () => {
    expect(
      createVehicleTrailerSchema.parse(create({ ownerOrganizationId: ORG })).ownerOrganizationId,
    ).toBe(ORG);
    expect(() =>
      createVehicleTrailerSchema.parse(create({ ownerOrganizationId: 'ООО «Перевозчик»' })),
    ).toThrow();
  });

  it('strict: лишние ключи отбиваются', () => {
    expect(() => createVehicleTrailerSchema.parse(create({ foo: 1 }))).toThrow();
  });

  it('strict закрывает единственную дверь, через которую привязка попала бы в тело', () => {
    // Главная работа `.strict()` в этом файле. Привязку меняет команда с единым порядком захвата
    // блокировок; пройди она полем карточки — то же самое менялось бы двумя путями, и второй путь
    // не вытеснял бы жильца занятого слота, а упирался бы в `UNIQUE` нарушением индекса.
    for (const field of ['hitchedVehicleId', 'hitchPosition', 'hitchedVehicle', 'sourceName']) {
      expect(() => createVehicleTrailerSchema.parse(create({ [field]: VEHICLE }))).toThrow();
      expect(() => updateVehicleTrailerSchema.parse({ [field]: VEHICLE })).toThrow();
    }
  });
});

describe('прицепы: правка карточки', () => {
  it('пустое тело допустимо: PATCH правит названное, а не всё', () => {
    expect(updateVehicleTrailerSchema.parse({})).toEqual({});
  });

  it('умолчаний не приносит — иначе PATCH статуса стирал бы реквизиты СТС', () => {
    // Тот самый подвох `.partial()`, из-за которого схема объявлена полями заново. Проверяется не
    // значение, а **отсутствие ключа**: пустая строка в `set` дошла бы до `UPDATE` и затёрла бы
    // VIN, цвет и примечание у человека, который менял одно состояние.
    const v = updateVehicleTrailerSchema.parse({ status: 'maintenance' });
    expect(Object.keys(v)).toEqual(['status']);
    for (const field of ['vin', 'passportNumber', 'color', 'note', 'kind']) {
      expect(v).not.toHaveProperty(field);
    }
  });

  it('обязательность граф сохраняется, когда их всё-таки называют', () => {
    // Необязательность здесь про «можно не присылать», а не про «можно прислать пустым»: марку и
    // госномер печатают в бланке, и очистить их правкой нельзя так же, как нельзя не заполнить.
    expect(() => updateVehicleTrailerSchema.parse({ model: '  ' })).toThrow();
    expect(() => updateVehicleTrailerSchema.parse({ registrationNumber: '' })).toThrow();
    expect(updateVehicleTrailerSchema.parse({ model: ' МАЗ 938660-044 ' }).model).toBe(
      'МАЗ 938660-044',
    );
  });

  it('порядок масс проверяется и в правке — но только когда названы обе', () => {
    expect(() =>
      updateVehicleTrailerSchema.parse({ maxMassKg: 6_000, curbMassKg: 6_500 }),
    ).toThrow();
    // Односторонняя правка форме неподсудна: второй половины пары в теле нет, и сверять не с чем.
    // Её ловит CHECK `vehicle_trailers_mass_order` — см. db-тест.
    expect(updateVehicleTrailerSchema.parse({ curbMassKg: 6_500 }).curbMassKg).toBe(6_500);
  });

  it('обнуление необязательных граф отличается от их неупоминания', () => {
    // `null` означает «стереть», отсутствие ключа — «не трогать». Схема обязана различать оба:
    // год и массы со скана иногда приходится убирать, когда выясняется, что прочитали не то.
    expect(updateVehicleTrailerSchema.parse({ manufacturedYear: null }).manufacturedYear).toBe(
      null,
    );
    expect(
      updateVehicleTrailerSchema.parse({ ownerOrganizationId: null }).ownerOrganizationId,
    ).toBe(null);
  });

  it('strict: лишние ключи отбиваются и здесь', () => {
    expect(() => updateVehicleTrailerSchema.parse({ foo: 1 })).toThrow();
  });
});

describe('прицепы: команда «прицепить»', () => {
  it('принимает машину и слот бланка', () => {
    const v = hitchTrailerSchema.parse({ vehicleId: VEHICLE, position: 1 });
    expect(v.vehicleId).toBe(VEHICLE);
    expect(v.position).toBe(1);
    expect(hitchTrailerSchema.parse({ vehicleId: VEHICLE, position: 2 }).position).toBe(2);
  });

  it('третьего слота нет: у бланка 4-П граф прицепа ровно две', () => {
    // Номер слота — не «порядок в списке», а место в шапке листа: третий прицеп печатать некуда.
    // Прими схема `3`, и запись упёрлась бы в CHECK базы пятисоткой вместо внятного отказа формы.
    expect(() => hitchTrailerSchema.parse({ vehicleId: VEHICLE, position: 3 })).toThrow();
    expect(() => hitchTrailerSchema.parse({ vehicleId: VEHICLE, position: 0 })).toThrow();
    expect(() => hitchTrailerSchema.parse({ vehicleId: VEHICLE, position: -1 })).toThrow();
    // Строкой номер слота тоже не приходит: приведения здесь нет, и «1» из формы — это ошибка
    // формы, а не значение.
    expect(() => hitchTrailerSchema.parse({ vehicleId: VEHICLE, position: '1' })).toThrow();
    expect(TRAILER_HITCH_POSITIONS).toEqual([1, 2]);
  });

  it('машина обязательна и названа ключом', () => {
    expect(() => hitchTrailerSchema.parse({ position: 1 })).toThrow();
    expect(() => hitchTrailerSchema.parse({ vehicleId: 'ВХ933277', position: 1 })).toThrow();
  });

  it('strict: прежнюю привязку и вытесняемого клиент не называет', () => {
    // Их находит сервер под блокировкой (Р14, шаги 1–4). Приди они от клиента — команда исполняла
    // бы картину мира, устаревшую к моменту нажатия кнопки.
    expect(() =>
      hitchTrailerSchema.parse({ vehicleId: VEHICLE, position: 1, evictTrailerId: VEHICLE }),
    ).toThrow();
    expect(() =>
      hitchTrailerSchema.parse({ vehicleId: VEHICLE, position: 1, fromVehicleId: VEHICLE }),
    ).toThrow();
  });
});

describe('прицепы: запрос списка', () => {
  it('архив спрашивают строкой запроса, а получают признаком', () => {
    expect(vehicleTrailerListQuerySchema.parse({}).includeDeleted).toBe(false);
    expect(vehicleTrailerListQuerySchema.parse({ includeDeleted: 'true' }).includeDeleted).toBe(
      true,
    );
    expect(vehicleTrailerListQuerySchema.parse({ includeDeleted: 'false' }).includeDeleted).toBe(
      false,
    );
    expect(() => vehicleTrailerListQuerySchema.parse({ includeDeleted: '1' })).toThrow();
  });

  it('сортировка — только по столбцам вкладки', () => {
    // Ключ поля совпадает с ключом колонки, и чужое имя отбивается до запроса: иначе оно доехало
    // бы до `ORDER BY` строкой, которую собирают из параметра.
    expect(vehicleTrailerListQuerySchema.parse({ sortBy: 'hitchedVehicle' }).sortBy).toBe(
      'hitchedVehicle',
    );
    expect(() => vehicleTrailerListQuerySchema.parse({ sortBy: 'note' })).toThrow();
    expect(() => vehicleTrailerListQuerySchema.parse({ sortBy: 'id; DROP TABLE' })).toThrow();
  });

  it('отбор состава одной машины требует ключа машины, а не её номера', () => {
    expect(
      vehicleTrailerListQuerySchema.parse({ hitchedVehicleId: VEHICLE }).hitchedVehicleId,
    ).toBe(VEHICLE);
    expect(() => vehicleTrailerListQuerySchema.parse({ hitchedVehicleId: 'О403ВХ777' })).toThrow();
  });

  it('отбор по состоянию и виду принимает только известные значения', () => {
    expect(vehicleTrailerListQuerySchema.parse({ status: 'retired' }).status).toBe('retired');
    expect(vehicleTrailerListQuerySchema.parse({ kind: 'trailer' }).kind).toBe('trailer');
    expect(() => vehicleTrailerListQuerySchema.parse({ status: 'hitched' })).toThrow();
    expect(() => vehicleTrailerListQuerySchema.parse({ kind: 'dolly' })).toThrow();
  });
});

describe('прицепы: подпись', () => {
  it('марка и госномер через пробел — так же, как их печатает бланк', () => {
    // Подпись обязана читаться так же, как напечатанная строка листа: `trailerLabelOf` в рейсе
    // склеивает те же две графы тем же пробелом. Разойдись эти два выражения — человек сверял бы
    // «то же самое», написанное по-разному.
    expect(trailerTitle({ model: 'ШМИТЦ SPR-24', registrationNumber: 'ВХ933277' })).toBe(
      'ШМИТЦ SPR-24 ВХ933277',
    );
  });

  it('неполные данные подписываются тем, что есть', () => {
    // У живой записи пустых половин не бывает — обе графы обязательны. Но подпись зовут и из
    // формы, где реквизит ещё вводят, и лишний пробел там читался бы как потерянное слово.
    expect(trailerTitle({ model: 'ШМИТЦ SPR-24', registrationNumber: '' })).toBe('ШМИТЦ SPR-24');
    expect(trailerTitle({ model: '', registrationNumber: 'ВХ933277' })).toBe('ВХ933277');
    expect(trailerTitle({ model: '  ', registrationNumber: '  ' })).toBe('');
  });
});
