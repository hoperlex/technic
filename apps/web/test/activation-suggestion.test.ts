import { describe, expect, it } from 'vitest';
import {
  matchReasonLabels,
  suggestCounterparty,
  suggestSubdivision,
  type MatchRecord,
} from '../src/pages/admin/activationSuggestion';

/**
 * Подбор области по свободному тексту заявки на регистрацию (план «пожелание при регистрации», §3.7).
 *
 * Проверяется значениями: подбор — чистая функция над загруженными справочниками, и через экран
 * видно было бы только то, что поле заполнилось, а не чем именно оно совпало и почему не совпало
 * второе. Случаи здесь — ровно те написания, которыми заявитель и справочник расходятся: приставка
 * «ООО», дефис вместо пробела, ИНН вместо названия.
 */

const SEVERNY: MatchRecord = { id: 'obj-1', code: 'С-12', name: 'ЖК Северный' };
const SEVERNY_2: MatchRecord = { id: 'obj-2', code: 'С-14', name: 'ЖК Северный-2' };
const OBJECTS = [SEVERNY, SEVERNY_2];

const ROMASHKA_LESSOR: MatchRecord = {
  id: 'cp-1',
  name: 'Ромашка',
  inn: '7701234567',
  type: 'vehicle_lessor',
};
const ROMASHKA_SERVICE: MatchRecord = {
  id: 'cp-2',
  name: 'ООО «Ромашка»',
  inn: '7809876543',
  type: 'service',
};
/** Середина названия — та самая «ао», которую снятие формы подстрокой съело бы. */
const KAOLENIT: MatchRecord = { id: 'cp-3', name: 'Каоленит', inn: '5012345678', type: 'service' };
const KLENIT: MatchRecord = { id: 'cp-4', name: 'Кленит', inn: '5087654321', type: 'service' };
const COUNTERPARTIES = [ROMASHKA_LESSOR, ROMASHKA_SERVICE, KAOLENIT, KLENIT];

describe('подбор подразделения', () => {
  it('подставляет по точному названию и говорит, чем совпало', () => {
    const suggestion = suggestSubdivision('ЖК Северный', OBJECTS);
    expect(suggestion).toEqual({ kind: 'match', record: SEVERNY, reason: 'name' });
    // Подпись причины уходит в баннер: «объект „С-12 — ЖК Северный“ (совпал по названию)».
    expect(matchReasonLabels.name).toBe('по названию');
  });

  it('подставляет по точному коду', () => {
    expect(suggestSubdivision('С-12', OBJECTS)).toEqual({
      kind: 'match',
      record: SEVERNY,
      reason: 'code',
    });
  });

  it('не различает дефис и пробел', () => {
    // «ЖК Северный 2» в заявке и «ЖК Северный-2» в справочнике — одно и то же название.
    expect(suggestSubdivision('ЖК Северный 2', OBJECTS)).toEqual({
      kind: 'match',
      record: SEVERNY_2,
      reason: 'name',
    });
    expect(suggestSubdivision('с 12', OBJECTS)).toEqual({
      kind: 'match',
      record: SEVERNY,
      reason: 'code',
    });
  });

  it('на двух одинаковых названиях не подставляет ничего, а предлагает оба', () => {
    // Выбрать за администратора между двумя «Северными» портал не может: молчаливый выбор отдал бы
    // человеку чужой объект, а исправлять было бы нечего — поле выглядит заполненным правильно.
    const twins: MatchRecord[] = [
      { id: 'obj-3', code: 'С-20', name: 'Северный' },
      { id: 'obj-4', code: 'С-21', name: 'Северный' },
    ];
    expect(suggestSubdivision('Северный', twins)).toEqual({ kind: 'candidates', records: twins });
  });

  it('предлагает не больше трёх кандидатов', () => {
    const many: MatchRecord[] = [1, 2, 3, 4, 5].map((n) => ({
      id: `obj-${n}`,
      code: `С-${n}`,
      name: `ЖК Северный-${n}`,
    }));
    const suggestion = suggestSubdivision('Северный', many);
    expect(suggestion.kind).toBe('candidates');
    // Порядок кандидатов — порядок справочника: он отсортирован по наименованию.
    expect(suggestion).toEqual({ kind: 'candidates', records: many.slice(0, 3) });
  });

  it('на пустом тексте молчит', () => {
    // Пустая подсказка хуже её отсутствия: строки кандидатов нет вовсе.
    expect(suggestSubdivision('', OBJECTS)).toEqual({ kind: 'none' });
    expect(suggestSubdivision('   ', OBJECTS)).toEqual({ kind: 'none' });
    expect(suggestSubdivision(null, OBJECTS)).toEqual({ kind: 'none' });
    expect(suggestSubdivision(undefined, OBJECTS)).toEqual({ kind: 'none' });
  });

  it('ничего не находит — и не предлагает', () => {
    expect(suggestSubdivision('Промзона', OBJECTS)).toEqual({ kind: 'none' });
  });
});

describe('подбор контрагента', () => {
  it('снимает организационно-правовую форму с обеих сторон', () => {
    // «ООО „Ромашка“» в заявке и «Ромашка» в справочнике — одна организация.
    expect(suggestCounterparty('ООО «Ромашка»', COUNTERPARTIES, 'vehicle_lessor')).toEqual({
      kind: 'match',
      record: ROMASHKA_LESSOR,
      reason: 'name',
    });
    // И наоборот: форма записана в справочнике, а заявитель её не написал.
    expect(suggestCounterparty('Ромашка', COUNTERPARTIES, 'service')).toEqual({
      kind: 'match',
      record: ROMASHKA_SERVICE,
      reason: 'name',
    });
  });

  it('снимает форму отдельным словом, а не подстрокой', () => {
    // Съешь мы «ао» подстрокой — «Каоленит» стал бы «кленитом» и уверенно совпал бы с «Кленитом».
    expect(suggestCounterparty('ООО «Каоленит»', COUNTERPARTIES, 'service')).toEqual({
      kind: 'match',
      record: KAOLENIT,
      reason: 'name',
    });
  });

  it('подставляет по ИНН', () => {
    expect(suggestCounterparty('7701234567', COUNTERPARTIES, 'vehicle_lessor')).toEqual({
      kind: 'match',
      record: ROMASHKA_LESSOR,
      reason: 'inn',
    });
    // Двенадцать цифр — ИНН предпринимателя; девять — уже не ИНН, и названия такого нет.
    const ip: MatchRecord = { id: 'cp-9', name: 'Петров', inn: '500100732259', type: 'service' };
    expect(suggestCounterparty('500100732259', [ip], 'service')).toEqual({
      kind: 'match',
      record: ip,
      reason: 'inn',
    });
    expect(suggestCounterparty('770123456', COUNTERPARTIES, 'vehicle_lessor')).toEqual({
      kind: 'none',
    });
  });

  it('ищет только внутри ожидаемого типа', () => {
    /*
     * Две «Ромашки» разных типов — две разные организации (ADR 0038). Роль у трёх внешних пожеланий
     * одна, и ошибка типа отдала бы учётке не тот модуль, не показав этого ничем.
     */
    expect(suggestCounterparty('Ромашка', COUNTERPARTIES, 'service')).toEqual({
      kind: 'match',
      record: ROMASHKA_SERVICE,
      reason: 'name',
    });
    expect(suggestCounterparty('Ромашка', COUNTERPARTIES, 'vehicle_lessor')).toEqual({
      kind: 'match',
      record: ROMASHKA_LESSOR,
      reason: 'name',
    });
    // Оператора вывоза с таким названием нет — и одноимённые организации чужих типов его не
    // заменяют: ни подстановкой, ни кандидатом.
    expect(suggestCounterparty('Ромашка', COUNTERPARTIES, 'operator')).toEqual({ kind: 'none' });
    // ИНН чужого типа — тоже не совпадение: тип отбирает записи до всякого сравнения.
    expect(suggestCounterparty('7701234567', COUNTERPARTIES, 'service')).toEqual({ kind: 'none' });
  });

  it('без ожидаемого типа не подбирает вовсе', () => {
    // Пожелание, которое про компанию не спрашивает, и подставить её не может: выбор за
    // администратором.
    expect(suggestCounterparty('Ромашка', COUNTERPARTIES, null)).toEqual({ kind: 'none' });
  });
});
