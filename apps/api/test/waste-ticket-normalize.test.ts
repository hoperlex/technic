import { describe, expect, it } from 'vitest';
import {
  parseRecognizedWasteTicket,
  parseWasteTicketVolume,
  parseWasteTicketWorkKind,
  similarWasteAddress,
  wasteAddressParts,
  wasteTicketNumberFuzzy,
  wasteTicketNumberKey,
} from '../src/services/waste-ticket-normalize';

// Нормализации и разбор полей талона (ADR 0114, план `docs/waste-ticket-ocr-plan.md`, Р16, Р19).
// Фикстуры синтетические: репозиторий публичный, настоящих сканов и номеров здесь нет.
//
// «Сейчас» в этом файле больше нет ни у одной проверки (ADR 0166, п. 2): разбор написаний уехал в
// контракты, а год двузначной записи выбирает ЯКОРЬ ЗАЯВКИ — это проверяет
// `waste-ticket-date-anchor.test.ts`.

describe('номер: консервативная нормализация (Р16)', () => {
  it('снимает регистр, пробелы и знак номера', () => {
    expect(wasteTicketNumberKey(' № 30 476 ')).toBe('30476');
    expect(wasteTicketNumberKey('ab-12')).toBe('AB-12');
    expect(wasteTicketNumberKey('№30476')).toBe('30476');
  });

  // Главное свойство ключа: по нему стоит ограничение БД, и склеивать им разные бумаги нельзя.
  it('дефисы и ведущие нули сохраняет: «12-34» и «123-4» — разные талоны', () => {
    expect(wasteTicketNumberKey('12-34')).toBe('12-34');
    expect(wasteTicketNumberKey('123-4')).toBe('123-4');
    expect(wasteTicketNumberKey('12-34')).not.toBe(wasteTicketNumberKey('123-4'));
    expect(wasteTicketNumberKey('007')).toBe('007');
    expect(wasteTicketNumberKey('007')).not.toBe(wasteTicketNumberKey('7'));
  });

  it('пробел внутри номера снимается, потому что его печатают разрядкой', () => {
    expect(wasteTicketNumberKey('30 476')).toBe(wasteTicketNumberKey('30476'));
  });
});

describe('номер: поисковая нормализация (Р16)', () => {
  it('сводит визуально похожие знаки', () => {
    // Кириллическая «З» и цифра «3», «О» и ноль — на бланке это один и тот же знак.
    expect(wasteTicketNumberFuzzy('ЗО476')).toBe(wasteTicketNumberFuzzy('30476'));
    expect(wasteTicketNumberFuzzy('АВС')).toBe(wasteTicketNumberFuzzy('ABC'));
    expect(wasteTicketNumberFuzzy('РЕТМ')).toBe(wasteTicketNumberFuzzy('PETM'));
    expect(wasteTicketNumberFuzzy('КХУН')).toBe(wasteTicketNumberFuzzy('KXYH'));
    // Латинская «O» рядом с кириллической: правку вписывают из другой раскладки.
    expect(wasteTicketNumberFuzzy('O476')).toBe(wasteTicketNumberFuzzy('О476'));
  });

  it('наследует консервативность ключа: «12-34» и «123-4» не становятся похожими', () => {
    expect(wasteTicketNumberFuzzy('12-34')).not.toBe(wasteTicketNumberFuzzy('123-4'));
    expect(wasteTicketNumberFuzzy(' № 12-34 ')).toBe('12-34');
  });
});

describe('дата в ответе модели (Р19, ADR 0166 п. 2)', () => {
  const issuedOn = (raw: unknown): string | null =>
    parseRecognizedWasteTicket({ issuedOn: raw }).issuedOn;

  it('разбирает написания с настоящих бланков, когда год записан полностью', () => {
    expect(issuedOn('17.08.2026')).toBe('2026-08-17');
    expect(issuedOn('17 08 2026')).toBe('2026-08-17');
    expect(issuedOn('17/08/2026')).toBe('2026-08-17');
    expect(issuedOn('7.8.2026')).toBe('2026-08-07');
    // `20260818` — машинный порядок; `18082026` годом 1808 быть не может.
    expect(issuedOn('20260818')).toBe('2026-08-18');
    expect(issuedOn('18082026')).toBe('2026-08-18');
    // Собственный ответ модели: промпт просит именно этот формат.
    expect(issuedOn('2026-08-17')).toBe('2026-08-17');
    // Восемь цифр модель отдаёт то строкой, то числом: терять дату из-за формата JSON нельзя.
    expect(issuedOn(18082026)).toBe('2026-08-18');
  });

  it('век здесь не выбирается вовсе: двузначный год и запись без года остаются пустыми', () => {
    // Здесь стоял выбор века ПО ТЕКУЩЕЙ ДАТЕ — ровно та ошибка, против которой заведён ADR 0166.
    // Год двузначной записи выбирает якорь заявки (`resolveWasteTicketIssuedOn`), и приходит такая
    // запись транскрипцией `issuedOnRaw`, а не полем `issuedOn`: в нём формат требует четырёх цифр.
    expect(issuedOn('17.08.26')).toBeNull();
    expect(issuedOn('17.08')).toBeNull();
  });

  it('несуществующий день и мусор оставляют поле пустым (Р4)', () => {
    expect(issuedOn('31.02.2026')).toBeNull();
    expect(issuedOn('17.13.2026')).toBeNull();
    expect(issuedOn('')).toBeNull();
    expect(issuedOn('  ')).toBeNull();
    expect(issuedOn('август')).toBeNull();
    expect(issuedOn(null)).toBeNull();
    expect(issuedOn(undefined)).toBeNull();
    expect(issuedOn({})).toBeNull();
  });
});

describe('объём талона (Р18)', () => {
  it('читает число с единицей, без неё и с запятой', () => {
    expect(parseWasteTicketVolume('20 м3')).toBe(20);
    expect(parseWasteTicketVolume('20 м³')).toBe(20);
    expect(parseWasteTicketVolume('20')).toBe(20);
    expect(parseWasteTicketVolume(20)).toBe(20);
    expect(parseWasteTicketVolume('8,5')).toBe(8.5);
    expect(parseWasteTicketVolume('8,5 куб.м')).toBe(8.5);
    // Рядом с числом пишут вид отходов — это буквы, и объёму они не мешают.
    expect(parseWasteTicketVolume('20 м3 строй мусор')).toBe(20);
  });

  it('«м3» не читается как тройка', () => {
    // Единицы снимаются до поиска числа: иначе талон на двадцать кубов стал бы талоном на три.
    expect(parseWasteTicketVolume('м3 20')).toBe(20);
    expect(parseWasteTicketVolume('м3')).toBeNull();
  });

  it('вторая группа цифр означает, что в графе не объём', () => {
    expect(parseWasteTicketVolume('Простой с 9:10 по 10:10')).toBeNull();
  });

  it('пустое, ноль и отрицательное — пустое поле', () => {
    expect(parseWasteTicketVolume('')).toBeNull();
    expect(parseWasteTicketVolume('—')).toBeNull();
    expect(parseWasteTicketVolume('0')).toBeNull();
    expect(parseWasteTicketVolume('-5')).toBeNull();
    expect(parseWasteTicketVolume(null)).toBeNull();
  });

  it('округляет до точности колонки numeric(12,3)', () => {
    expect(parseWasteTicketVolume('8,5555')).toBe(8.556);
    expect(parseWasteTicketVolume('1000000')).toBeNull();
  });
});

describe('вид работ (Р2)', () => {
  it('принимает код перечисления и слово с бланка', () => {
    expect(parseWasteTicketWorkKind('idle')).toBe('idle');
    expect(parseWasteTicketWorkKind('removal')).toBe('removal');
    expect(parseWasteTicketWorkKind('Простой')).toBe('idle');
    expect(parseWasteTicketWorkKind('вывоз')).toBe('removal');
  });

  // Умолчание «вывоз» тихо втянуло бы непонятую бумагу в сумму объёма.
  it('нераспознанное становится «иное», а не «вывозом»', () => {
    expect(parseWasteTicketWorkKind('перевозка')).toBe('other');
    expect(parseWasteTicketWorkKind(null)).toBe('other');
  });
});

describe('талон из ответа модели целиком (Р4)', () => {
  it('разбирает поля и оставляет пустым то, что не прочиталось', () => {
    expect(
      parseRecognizedWasteTicket({
        number: ' № 30 476 ',
        issuedOn: '17.08.2026',
        issuedOnRaw: ' 17.08.26 ',
        volumeM3: '20 м3 бой',
        workKind: 'removal',
        addressRaw: '  Волоколамское ш. 71/14 ',
      }),
    ).toEqual({
      // Номер хранится ДОСЛОВНО: нормализации считаются отдельно, человеку показывают бумагу.
      number: '№ 30 476',
      issuedOn: '2026-08-17',
      // Транскрипция тоже дословная — только пробелы по краям: по ней год выберет якорь заявки.
      issuedOnRaw: '17.08.26',
      volumeM3: 20,
      workKind: 'removal',
      addressRaw: 'Волоколамское ш. 71/14',
    });
  });

  it('битый ответ не выдумывает значений', () => {
    expect(
      parseRecognizedWasteTicket({
        number: 42,
        issuedOn: {},
        issuedOnRaw: 17,
        volumeM3: 'нет',
        workKind: 7,
      }),
    ).toEqual({
      number: null,
      issuedOn: null,
      issuedOnRaw: null,
      volumeM3: null,
      workKind: 'other',
      addressRaw: null,
    });
    expect(parseRecognizedWasteTicket({}).number).toBeNull();
    expect(parseRecognizedWasteTicket({}).issuedOnRaw).toBeNull();
  });

  // Обрезанный номер — это ДРУГОЙ номер, который займёт чужую бумагу в уникальности.
  it('слишком длинный номер и написание обнуляются, а адрес обрезается', () => {
    const parsed = parseRecognizedWasteTicket({
      number: '1'.repeat(65),
      issuedOnRaw: '1'.repeat(65),
      addressRaw: 'а'.repeat(600),
    });
    expect(parsed.number).toBeNull();
    // Обрезанное написание — это другое написание: год по нему выбирал бы якорь, и догадка
    // получила бы вид прочитанного. Строка длиннее 64 знаков означает, что в графу «Дата» уехала
    // половина талона (ADR 0166, п. 1).
    expect(parsed.issuedOnRaw).toBeNull();
    expect(parsed.addressRaw).toHaveLength(500);
  });
});

describe('адрес: нестрогое сравнение (Р18)', () => {
  it('разбирает адрес на значимые слова и числа', () => {
    expect(wasteAddressParts('Волоколамское шоссе, 71к14')).toEqual({
      words: ['волоколамское'],
      numbers: ['71', '14'],
    });
    // Дробь, буква корпуса и ведущий ноль записывают одно и то же.
    expect(wasteAddressParts('Волоколамское ш. 071/14')).toEqual({
      words: ['волоколамское'],
      numbers: ['71', '14'],
    });
  });

  it('сокращение и полное написание — один адрес', () => {
    expect(similarWasteAddress('Волоколамское ш. 71/14', 'Волоколамское шоссе, 71к14')).toBe(true);
    expect(similarWasteAddress('садовническая наб., д. 76', 'Садовническая набережная, 76')).toBe(
      true,
    );
    // Падеж отличается хвостом, а не началом.
    expect(similarWasteAddress('Волоколамский проезд, 5', 'Волоколамское шоссе, 5')).toBe(true);
    // «ё» пишут и не пишут.
    expect(similarWasteAddress('пос. Сычёво, 12', 'посёлок Сычево, 12')).toBe(true);
  });

  it('чужая площадка не похожа', () => {
    expect(similarWasteAddress('Волоколамское ш. 71/14', 'Садовническая, 76')).toBe(false);
    // Улица та же, дом другой — тоже чужая бумага.
    expect(similarWasteAddress('Автозаводская, лот 33', 'Автозаводская, лот 44')).toBe(false);
  });

  it('город и уровни адреса сравнению не мешают', () => {
    expect(
      similarWasteAddress('Автозаводская, лот 33', 'г. Москва, ул. Автозаводская, лот 33'),
    ).toBe(true);
  });

  it('пустая сторона считается похожей: сравнивать не с чем', () => {
    expect(similarWasteAddress('', 'Садовническая, 76')).toBe(true);
    expect(similarWasteAddress('Садовническая, 76', '  ')).toBe(true);
  });
});
