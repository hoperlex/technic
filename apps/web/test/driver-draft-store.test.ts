import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReportSubmitBody } from '@technic/contracts';
import type { DraftItem } from '../src/pages/driver/api';
import type * as draftStore from '../src/pages/driver/draftStore';

/**
 * Хранилище черновика показаний `v2` (план кабинета водителя — Р11–Р11г, Р12а, Р14).
 *
 * Проверяется не «сохранилось и прочиталось», а совместная жизнь писателей: две вкладки новой
 * сборки, вкладка сборки прежней и вкладка, которую браузер заморозил на час. Каждый случай здесь
 * — тот, на котором прежнее устройство (общий ключ, объект дня целиком, порядок по физическому
 * времени) теряло введённое молча.
 */

type Tab = typeof draftStore;

/**
 * Вкладка — это модуль, загруженный заново: ветка рождается загрузкой и живёт только в памяти,
 * поэтому второй документ заводится сбросом реестра модулей, а не подменой значения. Заодно это и
 * есть проверка того, что ветку неоткуда скопировать.
 */
async function openTab(): Promise<Tab> {
  vi.resetModules();
  return import('../src/pages/driver/draftStore');
}

const USER = 'user-1';
const DAY = '2026-08-18';
const ROUTE = 'trip:route-142';
const WEEK = 'weekly:sheet-7';
const DAY_MS = 24 * 60 * 60 * 1000;

const item = (patch: Partial<DraftItem> = {}): DraftItem => ({
  odometerKm: '',
  engineHours: '',
  fuelFilledLiters: '',
  comment: '',
  files: [],
  confirmAnomaly: false,
  ...patch,
});

const v1Key = `technic:driver-draft:${USER}:${DAY}`;
const dayPrefix = `technic:driver-draft-v2:${USER}:${DAY}:`;
const branchKey = (tab: Tab): string => `${dayPrefix}${tab.draftBranch()}`;
const keys = (): string[] => Object.keys(localStorage);
const snapshot = (): Record<string, string> =>
  Object.fromEntries(keys().map((key) => [key, localStorage.getItem(key) ?? '']));

/** Черновик прежнего формата: ключи записей — `itemId`, объект дня целиком, свой `savedAt`. */
function putV1(items: Record<string, Partial<DraftItem>>): void {
  const value = Object.fromEntries(Object.entries(items).map(([id, raw]) => [id, item(raw)]));
  localStorage.setItem(
    v1Key,
    JSON.stringify({ idempotencyKey: 'legacy-key', savedAt: Date.now(), items: value }),
  );
}

/** Состарить ячейку: TTL считается от её `savedAt`, и системные часы для этого трогать незачем. */
function age(key: string, days: number): void {
  const raw = JSON.parse(localStorage.getItem(key) ?? '{}') as { savedAt: number };
  raw.savedAt = Date.now() - days * DAY_MS;
  localStorage.setItem(key, JSON.stringify(raw));
}

const bodyItems = (odometerKm: number): ReportSubmitBody['items'] => [
  { itemId: 'item-1', reading: { kind: 'values', odometerKm }, fileIds: [] },
];

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe('черновик показаний: ключи и совместная жизнь с прежним форматом', () => {
  it('строка адресуется источником и переживает пересоздание строки ожидания', async () => {
    const tab = await openTab();
    tab.writeDraft(USER, DAY, { items: [{ key: ROUTE, item: item({ odometerKm: '145320' }) }] });

    // `itemId` в ключе не участвует вовсе: перенос источника между черновиками пересоздаёт строку
    // с другим идентификатором, а рейс остаётся тем же рейсом (Р11).
    expect(tab.readDraft(USER, DAY).items[ROUTE]?.item.odometerKm).toBe('145320');
    // Ключ дня — тот, по которому соседняя вкладка узнаёт событие `storage` и перерисовывает
    // экран: префикс намеренно не подходит под `startsWith` старого (Р11б, Р11в).
    expect(keys()).toEqual([branchKey(tab)]);
    expect(branchKey(tab).startsWith(tab.draftPrefix(USER, DAY))).toBe(true);
    expect(branchKey(tab).startsWith(`technic:driver-draft:${USER}:`)).toBe(false);
  });

  it('в старый ключ не пишет и записей из него не удаляет', async () => {
    putV1({ 'item-1': { odometerKm: '145320' } });
    const before = localStorage.getItem(v1Key);
    const tab = await openTab();

    tab.writeDraft(USER, DAY, { items: [{ key: ROUTE, item: item({ engineHours: '9812' }) }] });
    tab.pruneDrafts();

    // Пока жива вкладка прежней сборки, у той ячейки два писателя: тронуть её значило бы затереть
    // то, что она держит в памяти (Р11б).
    expect(localStorage.getItem(v1Key)).toBe(before);
  });

  it('запись прежнего формата предъявляется блоком, а не подмешивается в строки', async () => {
    putV1({ 'item-1': { odometerKm: '145320', comment: 'набрано вчера' } });
    const tab = await openTab();
    tab.writeDraft(USER, DAY, { items: [{ key: ROUTE, item: item({ odometerKm: '999' }) }] });

    const view = tab.readDraft(USER, DAY);
    // Молчаливого слияния нет ни в каком виде: числа `v1` показываются человеку отдельно, и
    // решение принимает он, глядя на оба варианта (Р11, Р14).
    expect(view.items[ROUTE]?.item.odometerKm).toBe('999');
    expect(view.legacy).toHaveLength(1);
    expect(view.legacy[0]).toMatchObject({ itemId: 'item-1' });
    expect(view.legacy[0]?.item.comment).toBe('набрано вчера');
  });

  it('чужая правка не откатывает свою: старая вкладка переписала объект дня целиком', async () => {
    putV1({ 'item-1': { odometerKm: '145320' } });
    const tab = await openTab();
    tab.writeDraft(USER, DAY, { items: [{ key: ROUTE, item: item({ odometerKm: '145999' }) }] });

    // Старая вкладка кладёт свою копию строки A и новую строку B — целым объектом, как умеет.
    putV1({ 'item-1': { odometerKm: '145320' }, 'item-2': { engineHours: '9812' } });

    const view = tab.readDraft(USER, DAY);
    expect(view.items[ROUTE]?.item.odometerKm).toBe('145999');
    expect(view.legacy.map((record) => record.itemId).sort()).toEqual(['item-1', 'item-2']);
  });

  it('учтённая запись `v1` не воскресает, а изменённая — возвращается', async () => {
    putV1({ 'item-1': { odometerKm: '145320' } });
    const tab = await openTab();
    const record = tab.readDraft(USER, DAY).legacy[0];

    // Перенос гасит исходную запись отпечатком: чужой ключ новая сборка не пишет (Р14а п. 4).
    tab.writeDraft(USER, DAY, {
      items: [{ key: ROUTE, item: record?.item ?? item() }],
      legacy: [record?.fingerprint ?? ''],
    });
    expect(tab.readDraft(USER, DAY).legacy).toHaveLength(0);

    // Перезагрузка страницы — другая ветка: журнал сливается объединением множеств и переживает её.
    const reloaded = await openTab();
    expect(reloaded.readDraft(USER, DAY).legacy).toHaveLength(0);

    // А вот это уже новая правка человека: старая вкладка переписала ту же строку другим числом,
    // отпечаток разошёлся — и блок обязан появиться снова (Р11б).
    putV1({ 'item-1': { odometerKm: '146000' } });
    expect(reloaded.readDraft(USER, DAY).legacy).toHaveLength(1);
  });

  it('журнал переживает отправку, вычистившую последнюю строку', async () => {
    putV1({ 'item-1': { odometerKm: '145320' } });
    const tab = await openTab();
    const record = tab.readDraft(USER, DAY).legacy[0];
    tab.writeDraft(USER, DAY, {
      items: [{ key: ROUTE, item: item({ odometerKm: '145320' }) }],
      legacy: [record?.fingerprint ?? ''],
    });

    // Отправка гасит строку надгробием — значений в ветке не остаётся ни одного.
    tab.writeDraft(USER, DAY, { items: [{ key: ROUTE, item: null }] });

    const view = tab.readDraft(USER, DAY);
    expect(view.items).toEqual({});
    // Уйди журнал вместе с последней строкой — блок воскрес бы следующим же чтением (Р11б).
    expect(view.legacy).toHaveLength(0);
  });

  it('выход из учётной записи чистит оба префикса', async () => {
    putV1({ 'item-1': { odometerKm: '145320' } });
    const tab = await openTab();
    tab.writeDraft(USER, DAY, { items: [{ key: ROUTE, item: item({ odometerKm: '1' }) }] });
    localStorage.setItem('technic:driver-draft:user-2:2026-08-18', '{}');

    tab.clearUserDrafts(USER);

    // На общем телефоне чужие показания не должны пережить смену человека; соседняя учётка при
    // этом остаётся своей (Р11б).
    expect(keys()).toEqual(['technic:driver-draft:user-2:2026-08-18']);
  });
});

describe('черновик показаний: две вкладки новой сборки', () => {
  it('соседняя ветка, вписавшаяся между чтением и записью, обе правки сохраняет', async () => {
    const first = await openTab();
    const second = await openTab();
    first.writeDraft(USER, DAY, { items: [{ key: ROUTE, item: item({ odometerKm: '100' }) }] });
    const seen = first.readDraft(USER, DAY);
    expect(seen.items[WEEK]).toBeUndefined();

    // Между чтением первой вкладки и её записью влезла вторая — именно здесь общий ключ терял
    // правку целиком (Р11в).
    second.writeDraft(USER, DAY, { items: [{ key: WEEK, item: item({ engineHours: '900' }) }] });
    first.writeDraft(USER, DAY, { items: [{ key: ROUTE, item: item({ odometerKm: '145320' }) }] });

    const view = second.readDraft(USER, DAY);
    expect(view.items[ROUTE]?.item.odometerKm).toBe('145320');
    expect(view.items[WEEK]?.item.engineHours).toBe('900');
    expect(keys()).toHaveLength(2);
  });

  it('вкладки с одинаковым `sessionStorage` пишут в разные ветки', async () => {
    // Дочерняя вкладка и дубликат получают копию хранилища сессии — так написано в стандарте.
    // Идентификатор оттуда дал бы двум документам один ключ, то есть ровно ту гонку, ради которой
    // ключи и разводились (Р11в).
    sessionStorage.setItem('tab-id', 'копия из родительской вкладки');
    const first = await openTab();
    const second = await openTab();

    expect(first.draftBranch()).not.toBe(second.draftBranch());
    first.writeDraft(USER, DAY, { items: [{ key: ROUTE, item: item({ odometerKm: '1' }) }] });
    second.writeDraft(USER, DAY, { items: [{ key: WEEK, item: item({ odometerKm: '2' }) }] });
    expect(keys().sort()).toEqual([branchKey(first), branchKey(second)].sort());
    sessionStorage.clear();
  });

  it('замороженная вкладка не откатывает то, чего не видела', async () => {
    const frozen = await openTab();
    const live = await openTab();
    frozen.readDraft(USER, DAY);

    live.writeDraft(USER, DAY, { items: [{ key: ROUTE, item: item({ odometerKm: '100' }) }] });
    live.writeDraft(USER, DAY, { items: [{ key: ROUTE, item: item({ odometerKm: '200' }) }] });

    // Вкладка проснулась через час со своим снимком. Счётчик берётся перечитыванием веток в момент
    // записи, а не из снимка, — иначе её правка проиграла бы слияние собственной строке.
    frozen.writeDraft(USER, DAY, { items: [{ key: ROUTE, item: item({ odometerKm: '300' }) }] });

    const view = live.readDraft(USER, DAY);
    expect(view.items[ROUTE]?.item.odometerKm).toBe('300');
    expect(view.items[ROUTE]?.clock.counter).toBe(3);
  });

  it('равные физические отметки разводятся логическими часами', async () => {
    const fixed = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(fixed);
    const first = await openTab();
    const second = await openTab();
    first.writeDraft(USER, DAY, { items: [{ key: ROUTE, item: item({ odometerKm: '100' }) }] });
    // Значение и надгробие записаны в одну миллисекунду: по физическому времени победитель не
    // определён вовсе, и два чтения выбрали бы разных (Р11в).
    second.writeDraft(USER, DAY, { items: [{ key: ROUTE, item: null }] });

    expect(first.readDraft(USER, DAY).items[ROUTE]).toBeUndefined();
    expect(second.readDraft(USER, DAY).items[ROUTE]).toBeUndefined();
  });

  it('при равных счётчиках побеждает старшая ветка, в каком бы порядке ни читали', async () => {
    const stamp = Date.now();
    const cell = (branch: string, value: string) =>
      JSON.stringify({
        savedAt: stamp,
        entries: {
          [ROUTE]: {
            clock: { counter: 5, branch },
            savedAt: stamp,
            item: item({ odometerKm: value }),
          },
        },
        legacy: [],
        attempts: [],
      });

    localStorage.setItem(`${dayPrefix}aaaa`, cell('aaaa', '100'));
    localStorage.setItem(`${dayPrefix}zzzz`, cell('zzzz', '200'));
    const straight = (await openTab()).readDraft(USER, DAY).items[ROUTE]?.item.odometerKm;

    localStorage.clear();
    localStorage.setItem(`${dayPrefix}zzzz`, cell('zzzz', '200'));
    localStorage.setItem(`${dayPrefix}aaaa`, cell('aaaa', '100'));
    const reversed = (await openTab()).readDraft(USER, DAY).items[ROUTE]?.item.odometerKm;

    expect(straight).toBe('200');
    expect(reversed).toBe('200');
  });

  it('консолидация идемпотентна: повторное чтение ветку не пишет', async () => {
    const first = await openTab();
    first.writeDraft(USER, DAY, { items: [{ key: ROUTE, item: item({ odometerKm: '100' }) }] });
    const second = await openTab();
    second.readDraft(USER, DAY);
    const before = snapshot();
    expect(Object.keys(before)).toHaveLength(2);
    // Победившая версия копируется с исходными часами: выдай ей новые — и соседняя вкладка
    // ответила бы своей консолидацией, а та первой (Р11в).
    const copied = JSON.parse(before[branchKey(second)] ?? '{}') as {
      entries: Record<string, { clock: unknown } | undefined>;
    };
    expect(copied.entries[ROUTE]?.clock).toEqual({ counter: 1, branch: first.draftBranch() });

    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    second.readDraft(USER, DAY);
    first.readDraft(USER, DAY);

    // Иначе соседние вкладки ответили бы на `storage` взаимными консолидациями и обновляли бы друг
    // другу отметки до бесконечности (Р11в).
    expect(setItem).not.toHaveBeenCalled();
    expect(snapshot()).toEqual(before);
  });
});

describe('черновик показаний: надгробия и отправка', () => {
  it('отправленная строка не воскресает из ветки, где лежит её прежняя версия', async () => {
    const first = await openTab();
    first.writeDraft(USER, DAY, { items: [{ key: ROUTE, item: item({ odometerKm: '100' }) }] });
    const second = await openTab();
    second.writeDraft(USER, DAY, { items: [{ key: ROUTE, item: item({ odometerKm: '145320' }) }] });

    // Успешная отправка гасит строку версией-надгробием: удали её вторая вкладка из своей ветки —
    // слияние вернуло бы старое число, которое человек уже сдал (Р11г).
    second.writeDraft(USER, DAY, { items: [{ key: ROUTE, item: null }] });

    expect(first.readDraft(USER, DAY).items[ROUTE]).toBeUndefined();
    expect(second.readDraft(USER, DAY).items[ROUTE]).toBeUndefined();
  });

  it('отправка не уносит осиротевшую строку', async () => {
    const tab = await openTab();
    tab.writeDraft(USER, DAY, {
      items: [
        { key: ROUTE, item: item({ odometerKm: '145320' }) },
        { key: WEEK, item: item({ engineHours: '9812' }) },
      ],
    });

    // Гасятся ключи отправленных строк, а не черновик дня целиком: общая очистка унесла бы вместе
    // с ними введённое по источнику, которого в отчёте уже нет (Р12).
    tab.writeDraft(USER, DAY, { items: [{ key: ROUTE, item: null }] });

    const view = tab.readDraft(USER, DAY);
    expect(view.items[ROUTE]).toBeUndefined();
    expect(view.items[WEEK]?.item.engineHours).toBe('9812');
  });

  it('строку, переписанную пока запрос был в пути, отправка не гасит', async () => {
    const sender = await openTab();
    const other = await openTab();
    sender.writeDraft(USER, DAY, { items: [{ key: ROUTE, item: item({ odometerKm: '145320' }) }] });
    const sent = sender.readDraft(USER, DAY).items[ROUTE]?.clock;

    // Пока `POST` был в пути, строку переписали — в соседней вкладке или в этой же.
    other.writeDraft(USER, DAY, { items: [{ key: ROUTE, item: item({ odometerKm: '146000' }) }] });
    sender.writeDraft(USER, DAY, { items: [{ key: ROUTE, item: null, ifClock: sent }] });

    // Погасить её значило бы выбросить правку, сделанную позже отправленной: она остаётся
    // значением и уйдёт следующей попыткой (Р12).
    expect(other.readDraft(USER, DAY).items[ROUTE]?.item.odometerKm).toBe('146000');

    // А неизменившаяся строка гасится тем же вызовом.
    const fresh = sender.readDraft(USER, DAY).items[ROUTE]?.clock;
    sender.writeDraft(USER, DAY, { items: [{ key: ROUTE, item: null, ifClock: fresh }] });
    expect(sender.readDraft(USER, DAY).items[ROUTE]).toBeUndefined();
  });

  it('перенос пишет значение цели и надгробие источника одной записью', async () => {
    const first = await openTab();
    first.writeDraft(USER, DAY, { items: [{ key: ROUTE, item: item({ odometerKm: '145320' }) }] });
    const second = await openTab();

    // Порознь эти две версии дали бы либо задвоение, либо потерю (Р14а п. 4).
    second.writeDraft(USER, DAY, {
      items: [
        { key: WEEK, item: item({ odometerKm: '145320' }) },
        { key: ROUTE, item: null },
      ],
    });

    const view = first.readDraft(USER, DAY);
    expect(view.items[WEEK]?.item.odometerKm).toBe('145320');
    expect(view.items[ROUTE]).toBeUndefined();
  });
});

describe('черновик показаний: попытки отправки', () => {
  it('потерянный ответ после коммита повторяется исходной парой «ключ + версия»', async () => {
    const tab = await openTab();
    const mark = tab.bodyFingerprint(bodyItems(145320));
    // Попытка ложится в ветку до `POST`: команда, ушедшая без следа, при повторе стала бы второй
    // отправкой того же дня (Р12а п. 1).
    expect(
      tab.writeDraft(USER, DAY, {
        attempt: { key: 'idem-1', reportVersion: 5, fingerprint: mark },
      }).ok,
    ).toBe(true);

    // Сервер команду принял и поднял версию до 6, ответ не доехал, страница перезагрузилась.
    const reloaded = await openTab();
    const view = reloaded.readDraft(USER, DAY);
    expect(reloaded.pendingAttempt(view, mark)).toMatchObject({
      key: 'idem-1',
      reportVersion: 5,
      state: 'pending',
    });

    // Тело правили перед повтором — это уже другая команда, и она получит свой ключ и текущую
    // версию (Р12а п. 2).
    expect(reloaded.pendingAttempt(view, reloaded.bodyFingerprint(bodyItems(146000)))).toBeNull();
  });

  it('выбирается последняя совпавшая по отпечатку, а не последняя вообще', async () => {
    const tab = await openTab();
    const mine = tab.bodyFingerprint(bodyItems(145320));
    const other = tab.bodyFingerprint(bodyItems(146000));
    tab.writeDraft(USER, DAY, { attempt: { key: 'idem-1', reportVersion: 5, fingerprint: mine } });
    // Между обрывом и повтором человек поправил другую строку — попытка новее, но не та.
    tab.writeDraft(USER, DAY, { attempt: { key: 'idem-2', reportVersion: 5, fingerprint: other } });

    const view = tab.readDraft(USER, DAY);
    expect(tab.pendingAttempt(view, mine)?.key).toBe('idem-1');
    expect(tab.pendingAttempt(view, other)?.key).toBe('idem-2');
  });

  it('одиннадцатая попытка при десяти закрытых сохраняется и переживает перезагрузку', async () => {
    const tab = await openTab();
    // День с плохой связью: каждая правка тела — своя попытка (Р12а), и все они уже закрыты
    // известным ответом. Хранится их десять — больше дню и не нужно.
    for (let index = 0; index < 10; index += 1) {
      const key = `idem-${index}`;
      const fingerprint = tab.bodyFingerprint(bodyItems(index));
      tab.writeDraft(USER, DAY, { attempt: { key, reportVersion: 5, fingerprint } });
      tab.writeDraft(USER, DAY, { close: { key, state: 'rejected' } });
    }

    const mark = tab.bodyFingerprint(bodyItems(145320));
    const written = tab.writeDraft(USER, DAY, {
      attempt: { key: 'idem-new', reportVersion: 6, fingerprint: mark },
    });

    /*
     * Прежде счётчик новой попытки брался от предшественницы с тем же ключом, которой у нового
     * ключа не бывает: часы вырождались, срез до десяти отрезал как раз новую — и `writeDraft`
     * отвечал `{ok: true}`, ничего не сохранив. Это худший из исходов: страница считает, что
     * записала, шлёт `POST`, ответ теряется, а повторить нечем — повтор уходит новым ключом, то
     * есть второй отправкой того же дня (Р12а п. 1).
     */
    expect(written.ok).toBe(true);
    const reloaded = await openTab();
    expect(reloaded.pendingAttempt(reloaded.readDraft(USER, DAY), mark)).toMatchObject({
      key: 'idem-new',
      reportVersion: 6,
      state: 'pending',
    });
  });

  it('срез хранимых попыток не выбрасывает незавершённую раньше закрытой', async () => {
    const tab = await openTab();
    const mark = tab.bodyFingerprint(bodyItems(145320));
    // Незавершённая — самая старая из одиннадцати: связь оборвалась на ней, и повторить её
    // нечем, кроме как ею самой. Закрытая же теряет разве что копию в соседней ветке.
    tab.writeDraft(USER, DAY, {
      attempt: { key: 'idem-lost', reportVersion: 5, fingerprint: mark },
    });
    for (let index = 0; index < 10; index += 1) {
      const key = `idem-${index}`;
      const fingerprint = tab.bodyFingerprint(bodyItems(index));
      tab.writeDraft(USER, DAY, { attempt: { key, reportVersion: 5, fingerprint } });
      tab.writeDraft(USER, DAY, { close: { key, state: 'succeeded' } });
    }

    const view = tab.readDraft(USER, DAY);
    expect(view.attempts).toHaveLength(10);
    expect(tab.pendingAttempt(view, mark)?.key).toBe('idem-lost');
  });

  it('при двух незавершённых с одним отпечатком повторяется последняя', async () => {
    const first = await openTab();
    const mark = first.bodyFingerprint(bodyItems(145320));
    first.writeDraft(USER, DAY, {
      attempt: { key: 'idem-1', reportVersion: 5, fingerprint: mark },
    });
    // Соседняя вкладка отправила тот же день тем же телом: попыток две, и повторять нужно ту, что
    // ушла последней (Р12а п. 3). Порядок задают логические часы, а не то, чья ветка старше по
    // имени: у равных часов победителя выбирал бы случай, разный от загрузки к загрузке.
    const second = await openTab();
    second.writeDraft(USER, DAY, {
      attempt: { key: 'idem-2', reportVersion: 5, fingerprint: mark },
    });

    expect(first.pendingAttempt(first.readDraft(USER, DAY), mark)?.key).toBe('idem-2');
    expect(second.pendingAttempt(second.readDraft(USER, DAY), mark)?.key).toBe('idem-2');

    // И третья, из первой же вкладки: своих предшественниц она не знает, но часы у неё старше их
    // всех. Иначе повторялась бы попытка, записанная раньше, — то есть та пара «ключ + версия»,
    // которую сервер уже мог принять и закрыть.
    first.writeDraft(USER, DAY, {
      attempt: { key: 'idem-3', reportVersion: 5, fingerprint: mark },
    });
    expect(first.pendingAttempt(first.readDraft(USER, DAY), mark)?.key).toBe('idem-3');
  });

  it('известный отказ закрывает попытку, и копия из соседней ветки её не воскрешает', async () => {
    const first = await openTab();
    const mark = first.bodyFingerprint(bodyItems(145320));
    first.writeDraft(USER, DAY, {
      attempt: { key: 'idem-1', reportVersion: 5, fingerprint: mark },
    });

    // Отказ пришёл в другую вкладку: у первой копия попытки осталась незавершённой.
    const second = await openTab();
    second.writeDraft(USER, DAY, { close: { key: 'idem-1', state: 'rejected' } });

    // Итог кладётся старшими логическими часами — иначе копия выиграла бы слияние и портал
    // повторил бы команду, на которую уже получен ответ (Р12а п. 4).
    const view = first.readDraft(USER, DAY);
    expect(first.pendingAttempt(view, mark)).toBeNull();
    expect(view.attempts.map((attempt) => attempt.state)).toEqual(['rejected']);
  });

  it('отказ хранилища возвращается вызывающему, и ничего не меняет', async () => {
    const tab = await openTab();
    tab.writeDraft(USER, DAY, { items: [{ key: ROUTE, item: item({ odometerKm: '145320' }) }] });
    const mark = tab.bodyFingerprint(bodyItems(145320));
    const quota = new DOMException('переполнено', 'QuotaExceededError');
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw quota;
    });

    const result = tab.writeDraft(USER, DAY, {
      items: [{ key: ROUTE, item: item({ odometerKm: '146000' }) }],
      attempt: { key: 'idem-1', reportVersion: 5, fingerprint: mark },
    });

    // Проглоченный отказ дал бы худший исход: черновик остался прежним, а страница считает, что
    // записала, — и уже удаляет файлы или шлёт `POST` (Р14а п. 5, Р12а п. 1).
    expect(result).toEqual({ ok: false, error: quota });
    setItem.mockRestore();
    const view = tab.readDraft(USER, DAY);
    expect(view.items[ROUTE]?.item.odometerKm).toBe('145320');
    expect(view.attempts).toHaveLength(0);
  });
});

describe('черновик показаний: уборка', () => {
  it('ветка с журналом держится, пока для дня есть старый ключ, и уходит вместе с ним', async () => {
    putV1({ 'item-1': { odometerKm: '145320' } });
    const tab = await openTab();
    const record = tab.readDraft(USER, DAY).legacy[0];
    tab.writeDraft(USER, DAY, { legacy: [record?.fingerprint ?? ''] });
    // Строк в ветке нет ни одной — только пометки; сама ветка просрочена.
    age(branchKey(tab), 8);

    tab.pruneDrafts();
    expect(keys()).toContain(branchKey(tab));
    expect(tab.readDraft(USER, DAY).legacy).toHaveLength(0);

    // Исчез `v1` — уходит и журнал: гасить больше нечего (Р11б).
    age(v1Key, 8);
    tab.pruneDrafts();
    expect(localStorage.getItem(v1Key)).toBeNull();
    expect(keys()).not.toContain(branchKey(tab));
  });

  it('истечение ветки с надгробием не воскрешает строку и без всякого `v1`', async () => {
    const keeper = await openTab();
    keeper.writeDraft(USER, DAY, { items: [{ key: ROUTE, item: item({ odometerKm: '145320' }) }] });
    const closer = await openTab();
    closer.writeDraft(USER, DAY, { items: [{ key: ROUTE, item: null }] });
    // Ветка со старым значением переживает ветку с надгробием: её вкладка продолжает писать другие
    // строки, а надгробие тем временем истекает (Р11г).
    age(branchKey(closer), 8);

    keeper.pruneDrafts();
    expect(keys()).toContain(branchKey(closer));
    expect(keeper.readDraft(USER, DAY).items[ROUTE]).toBeUndefined();

    // Чтение перенесло надгробие консолидацией — теперь ветку можно снимать.
    keeper.pruneDrafts();
    expect(keys()).not.toContain(branchKey(closer));
    expect(keeper.readDraft(USER, DAY).items[ROUTE]).toBeUndefined();
  });

  it('испорченная ячейка читается как «ветки нет» и уходит уборкой', async () => {
    localStorage.setItem(`${dayPrefix}broken`, 'не json вовсе');
    const tab = await openTab();
    tab.writeDraft(USER, DAY, { items: [{ key: ROUTE, item: item({ odometerKm: '145320' }) }] });

    // Угадывать содержимое чужой или побитой записи нечем, а падать на ней посреди ввода нельзя.
    expect(tab.readDraft(USER, DAY).items[ROUTE]?.item.odometerKm).toBe('145320');
    tab.pruneDrafts();
    expect(keys()).toEqual([branchKey(tab)]);
  });

  it('просроченная ветка без надгробий и журнала уходит сразу', async () => {
    const stale = await openTab();
    stale.writeDraft(USER, DAY, { items: [{ key: ROUTE, item: item({ odometerKm: '145320' }) }] });
    age(branchKey(stale), 8);
    const fresh = await openTab();

    fresh.pruneDrafts();

    // Неделю назад введённые показания относятся уже не к тому счётчику, что человек видит перед
    // собой, — держать их незачем.
    expect(keys()).not.toContain(branchKey(stale));
    expect(fresh.readDraft(USER, DAY).items).toEqual({});
  });
});
