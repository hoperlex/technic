import { describe, expect, it } from 'vitest';
import {
  parseRecognizedWasteTicket,
  parseWasteTicketDate,
  parseWasteTicketVolume,
  parseWasteTicketWorkKind,
  similarWasteAddress,
  wasteAddressParts,
  wasteTicketNumberFuzzy,
  wasteTicketNumberKey,
} from '../src/services/waste-ticket-normalize';

// Нормализации и разбор полей талона (ADR 0114, план `docs/waste-ticket-ocr-plan.md`, Р16, Р19).
// Фикстуры синтетические: репозиторий публичный, настоящих сканов и номеров здесь нет.

/** Момент, от которого считается «текущий век» у двузначного года: фиксируем, а не берём часы. */
const NOW = new Date('2026-08-21T09:00:00.000Z');

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

describe('дата талона (Р19)', () => {
  it('разбирает форматы с настоящих бланков', () => {
    expect(parseWasteTicketDate('17.08.2026', NOW)).toBe('2026-08-17');
    expect(parseWasteTicketDate('17 08 2026', NOW)).toBe('2026-08-17');
    expect(parseWasteTicketDate('17/08/2026', NOW)).toBe('2026-08-17');
    expect(parseWasteTicketDate('7.8.2026', NOW)).toBe('2026-08-07');
    expect(parseWasteTicketDate('18082026', NOW)).toBe('2026-08-18');
    // Собственный ответ модели: промпт просит именно этот формат.
    expect(parseWasteTicketDate('2026-08-17', NOW)).toBe('2026-08-17');
  });

  it('двузначный год относит к текущему веку', () => {
    expect(parseWasteTicketDate('17.08.26', NOW)).toBe('2026-08-17');
    expect(parseWasteTicketDate('01.01.99', NOW)).toBe('2099-01-01');
    // Век берётся из календаря, а не зашит числом 2000.
    expect(parseWasteTicketDate('17.08.26', new Date('2101-01-01T00:00:00.000Z'))).toBe(
      '2126-08-17',
    );
  });

  it('восемь цифр разводит правдоподобием года', () => {
    // `20260818` — машинный порядок; `18082026` годом 1808 быть не может.
    expect(parseWasteTicketDate('20260818', NOW)).toBe('2026-08-18');
    expect(parseWasteTicketDate(18082026, NOW)).toBe('2026-08-18');
  });

  it('несуществующий день и мусор оставляют поле пустым (Р4)', () => {
    expect(parseWasteTicketDate('31.02.2026', NOW)).toBeNull();
    expect(parseWasteTicketDate('17.13.2026', NOW)).toBeNull();
    expect(parseWasteTicketDate('', NOW)).toBeNull();
    expect(parseWasteTicketDate('  ', NOW)).toBeNull();
    expect(parseWasteTicketDate('август', NOW)).toBeNull();
    expect(parseWasteTicketDate(null, NOW)).toBeNull();
    expect(parseWasteTicketDate(undefined, NOW)).toBeNull();
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
      parseRecognizedWasteTicket(
        {
          number: ' № 30 476 ',
          issuedOn: '17.08.2026',
          volumeM3: '20 м3 бой',
          workKind: 'removal',
          addressRaw: '  Волоколамское ш. 71/14 ',
        },
        NOW,
      ),
    ).toEqual({
      // Номер хранится ДОСЛОВНО: нормализации считаются отдельно, человеку показывают бумагу.
      number: '№ 30 476',
      issuedOn: '2026-08-17',
      volumeM3: 20,
      workKind: 'removal',
      addressRaw: 'Волоколамское ш. 71/14',
    });
  });

  it('битый ответ не выдумывает значений', () => {
    expect(
      parseRecognizedWasteTicket({ number: 42, issuedOn: {}, volumeM3: 'нет', workKind: 7 }, NOW),
    ).toEqual({
      number: null,
      issuedOn: null,
      volumeM3: null,
      workKind: 'other',
      addressRaw: null,
    });
    expect(parseRecognizedWasteTicket({}, NOW).number).toBeNull();
  });

  // Обрезанный номер — это ДРУГОЙ номер, который займёт чужую бумагу в уникальности.
  it('слишком длинный номер обнуляется, а адрес обрезается', () => {
    const parsed = parseRecognizedWasteTicket(
      { number: '1'.repeat(65), addressRaw: 'а'.repeat(600) },
      NOW,
    );
    expect(parsed.number).toBeNull();
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
