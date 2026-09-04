import { beforeEach, describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import dayjs from 'dayjs';
import type {
  DriverAssignmentDto,
  DriverReportDto,
  ReportItemDto,
  VehicleReadingDto,
} from '@technic/contracts';
import { MOSCOW_TZ } from '@shared/config';
import { json, mockHttp } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { DriverLayout } from '../src/pages/driver/DriverLayout';
import { DriverReadingsPage } from '../src/pages/driver/DriverReadingsPage';
import { readDraft } from '../src/pages/driver/draftStore';
import type { DraftItem } from '../src/pages/driver/api';

/**
 * Матрица состояний дня (план `docs/driver-readings-first-plan.md`, Р2, Р3, Р6, Р10; пункты 2, 9,
 * 10 и 11 раздела «Тесты»).
 *
 * Проверяется не разметка, а два решения на каждую клетку: **что нарисовано** и **ушёл ли
 * `POST …/open`**. Второе важнее первого: открытие — тяжёлая транзакция с блокировками машин и
 * источников, и уходить оно обязано только там, где открывать есть что.
 *
 * Три правила, которые набор и стережёт.
 *
 * 1. **Существующий отчёт старше живого задания.** Пустое задание никогда не прячет сохранённые
 *    числа: после отправки состав заморожен, и переназначенный источник остаётся строкой отчёта.
 * 2. **Читающих режима два, и с черновиком они обращаются по-разному** (Р10). Отчёт закрыт для
 *    водителя — показываются числа сервера, локальное не накладывается: экран обязан показывать то,
 *    что в учёте. Окно записи закрыто, а отчёт не закрыт — локальное показывается пометкой рядом:
 *    это его единственная копия, и стереть её за человека нельзя.
 * 3. **Черновик в читающем режиме не удаляется никогда.** Уборка бывает по успешной отправке, по
 *    TTL и по выходу из учётной записи — и ни по какому показу дня.
 */

const today = dayjs().tz(MOSCOW_TZ).format('YYYY-MM-DD');

/** jsdom не реализует `scrollIntoView`, а поле ввода доводится до видимой части по фокусу. */
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};

const driver = authUser({
  id: 'user-driver',
  email: 'driver@example.test',
  role: 'driver',
  lastName: 'Водителев',
  firstName: 'Виктор',
  middleName: 'Иванович',
  fullName: 'Водителев Виктор Иванович',
});

const V2_PREFIX = `technic:driver-draft-v2:${driver.id}:${today}:`;

const routeItem: ReportItemDto = {
  id: 'item-route',
  sourceKind: 'route',
  sourceId: 'route-1',
  sourceLabel: 'Рейс Р-142',
  vehicleId: 'v-1',
  vehicleLabel: 'КамАЗ 65115 · А123ВС799',
  shiftOrder: 1,
  reading: null,
};

/** Показание, уже записанное сервером: числа учёта, с которыми водитель сверяет своё введённое. */
const stored145320: VehicleReadingDto = {
  id: 'reading-1',
  itemId: routeItem.id,
  kind: 'values',
  odometerKm: 145320,
  engineHours: null,
  fuelStartLiters: null,
  fuelFilledLiters: null,
  fuelEndLiters: null,
  noDataReason: '',
  comment: '',
  source: 'driver',
  recordedAt: `${today}T10:00:00.000Z`,
  odometerAnomaly: null,
  engineHoursAnomaly: null,
  odometerDelta: null,
  engineHoursDelta: null,
  fileIds: [],
};

/** Строка отчёта с уже сохранённым показанием: её и читает закрытый для водителя день. */
const withReading: ReportItemDto = { ...routeItem, reading: stored145320 };

const item = (patch: Partial<DraftItem> = {}): DraftItem => ({
  odometerKm: '',
  engineHours: '',
  // Пять чисел, а не три (ADR 0163): остатки в баке обязательны в типе и стоят вокруг заправки
  // в порядке смены. Пропущенный здесь ключ — не мелочь фикстуры: `DraftItem` собирают все
  // перечисления черновика, и литерал без него перестал бы быть тем, что читает форма.
  fuelStartLiters: '',
  fuelFilledLiters: '',
  fuelEndLiters: '',
  comment: '',
  files: [],
  confirmAnomaly: false,
  ...patch,
});

/**
 * Ветка соседнего документа — ячейка чужой загрузки страницы. Пишется руками, а не через
 * `writeDraft`: своя ветка у модуля одна на весь прогон, и разводить их значением нечем (Р11в).
 */
function putBranch(branch: string, entries: Record<string, DraftItem>): void {
  const savedAt = Date.now();
  localStorage.setItem(
    `${V2_PREFIX}${branch}`,
    JSON.stringify({
      savedAt,
      entries: Object.fromEntries(
        Object.entries(entries).map(([key, value]) => [
          key,
          { clock: { counter: 1, branch }, savedAt, item: value },
        ]),
      ),
      legacy: [],
      attempts: [],
    }),
  );
}

function reportOf(items: ReportItemDto[], state: DriverReportDto['state']): DriverReportDto {
  return {
    id: 'report-1',
    personId: 'p-1',
    personName: driver.fullName,
    reportDate: today,
    state,
    contentVersion: 1,
    version: 3,
    acceptedContentVersion: null,
    acceptedAt: null,
    acceptedByName: '',
    items,
    discrepancies: [],
    canAccept: false,
    blockers: [],
  };
}

function assignmentOf(items: ReportItemDto[], canSubmit: boolean): DriverAssignmentDto {
  return {
    date: today,
    canSubmit,
    entries: items.map((entry) => ({
      sourceKind: entry.sourceKind,
      sourceId: entry.sourceId,
      sourceLabel: entry.sourceLabel,
      purposeLabel: 'Грузоперевозка',
      vehicleLabel: entry.vehicleLabel,
      garageNumber: '',
      trailerLabel: '',
      itemId: entry.id,
      shiftOrder: entry.shiftOrder,
      points: [],
      moveFrom: '',
      moveTo: '',
      comment: '',
      previous: null,
    })),
  };
}

interface CabinetOptions {
  /** Сохранённый отчёт дня (`GET`) — то, чем матрица и решает. `null` — отчёта нет вовсе. */
  stored?: DriverReportDto | null;
  /** Живое задание дня: состав, который может и опустеть под сохранённым отчётом. */
  entries?: ReportItemDto[];
  /** Окно записи держит сервер: сегодня и семь предыдущих дней. */
  canSubmit?: boolean;
  /** Что вернёт `open`, если он всё-таки уйдёт. */
  opened?: ReportItemDto[];
}

function renderCabinet(options: CabinetOptions = {}) {
  const entries = options.entries ?? [routeItem];
  const http = mockHttp({
    'GET /driver/assignment': () => json(assignmentOf(entries, options.canSubmit ?? true)),
    'GET /driver/reports/:date': () => json(options.stored ?? null),
    'POST /driver/reports/:date/open': () => json(reportOf(options.opened ?? entries, 'draft')),
    'POST /driver/reports/:date/submit': () => json(reportOf(entries, 'submitted')),
    'DELETE /files/:id': () => json({ ok: true }),
  });
  const rendered = renderWithUser(
    <DriverLayout>
      <DriverReadingsPage />
    </DriverLayout>,
    { user: driver, route: '/driver' },
  );
  return { ...rendered, http };
}

const opens = (http: ReturnType<typeof mockHttp>) =>
  http.countOf('POST /driver/reports/:date/open');

/**
 * Открытие уходит с задержкой (Э3, Р7): пауза отсекает промежуточные дни при листании стрелками.
 * Значит «`open` не ушёл», проверенное сразу после появления экрана, прошло бы при любом поведении
 * портала — эта пауза даёт ему успеть, и только потом счётчик что-то доказывает.
 */
const afterOpenDelay = () => new Promise((resolve) => setTimeout(resolve, 600));

async function expectNoOpen(http: ReturnType<typeof mockHttp>): Promise<void> {
  await afterOpenDelay();
  expect(opens(http)).toBe(0);
}

/** Блоки ждут дольше секунды по умолчанию: строки открытого дня приходят после паузы (Р7). */
async function waitForBlocks(): Promise<void> {
  await waitFor(
    () => expect(document.querySelectorAll('[id^="reading-"]').length).toBeGreaterThan(0),
    { timeout: 3000 },
  );
}

function blockOf(itemId: string): HTMLElement {
  const element = document.getElementById(`reading-${itemId}`);
  if (!element) throw new Error(`Блока строки «${itemId}» нет на экране`);
  return element;
}

function field(scope: HTMLElement, label: string): HTMLInputElement | HTMLTextAreaElement {
  const wrapper = [...scope.querySelectorAll('label')].find((l) =>
    l.textContent?.startsWith(label),
  );
  const input = wrapper?.querySelector('input, textarea');
  if (!input) throw new Error(`Поля «${label}» нет в блоке`);
  return input as HTMLInputElement | HTMLTextAreaElement;
}

/** Группа полей одного момента смены: «Начало смены», «За смену», «Конец смены» (Р7). */
function group(scope: HTMLElement, title: string): HTMLElement {
  const heading = [...scope.querySelectorAll('strong')].find((el) => el.textContent === title);
  const box = heading?.closest('div');
  if (!box) throw new Error(`Группы «${title}» нет в блоке`);
  return box as HTMLElement;
}

/** Подвал: причина, по которой день не передают, стоит там же, где стояла бы кнопка (Р10). */
function footer(): HTMLElement {
  const element = document.querySelector('.driver-footer');
  if (!element) throw new Error('Подвала на экране нет');
  return element as HTMLElement;
}

const submitButton = () => screen.queryByRole('button', { name: 'Передать' });

const draftRow = (key: string) => readDraft(driver.id, today).items[key]?.item;

describe('кабинет водителя: матрица состояний дня', () => {
  // Черновик лежит в localStorage по ключу «учётка + дата» и пережил бы соседний тест.
  beforeEach(() => localStorage.clear());

  it('отчёта нет, задание непустое, день в окне записи — `open` и форма ввода', async () => {
    const { http } = renderCabinet({ stored: null });
    await waitForBlocks();

    // Единственная клетка матрицы, где показ дня заводит отчёт: до `open` записывать некуда — у
    // строк нет `itemId` (Р2).
    expect(opens(http)).toBe(1);
    expect(field(blockOf(routeItem.id), 'Одометр').disabled).toBe(false);
    expect(submitButton()).not.toBeNull();
  });

  it('отчёта нет, задания нет — слова вместо формы, и `open` не зовётся', async () => {
    const { http } = renderCabinet({ stored: null, entries: [] });

    // Р6: пустой день формы не получает — но только когда отчёта нет вовсе. Открывать нечего, и
    // «Передать показания» над пустым экраном читалось бы как поломка.
    expect(await screen.findByText('На этот день заданий нет')).toBeDefined();
    await expectNoOpen(http);
    expect(document.querySelectorAll('[id^="reading-"]')).toHaveLength(0);
    // Подвала нет вовсе: называть причину дважды незачем, а кнопке нечего передавать.
    expect(document.querySelector('.driver-footer')).toBeNull();
  });

  it('черновик в окне записи открывается — тот же `open` синхронизирует состав', async () => {
    const { http } = renderCabinet({ stored: reportOf([routeItem], 'draft') });
    await waitForBlocks();

    // Строки здесь рисуются сохранённым отчётом, поэтому открытия ждём отдельно: оно уходит с
    // задержкой (Р7) и позже самих блоков. Состав черновика сервер синхронизирует именно им —
    // рейс, заведённый после показа дня, появляется строкой только оттуда.
    await waitFor(() => expect(opens(http)).toBe(1), { timeout: 3000 });
    expect(submitButton()).not.toBeNull();
  });

  it('черновик без строк при пустом задании не открывается', async () => {
    // Вторая половина Р2 — «есть что открывать»: непустое задание или уже заведённые строки. Рейсы
    // этого дня отменили уже после открытия, и без этого условия портал бил бы тяжёлой транзакцией
    // с блокировками машин и источников по каждой загрузке страницы — синхронизировать нечего.
    const { http } = renderCabinet({ stored: reportOf([], 'draft'), entries: [] });

    expect(
      await screen.findByText('За этот день передавать нечего: выездов не осталось'),
    ).toBeDefined();
    await expectNoOpen(http);
    // День при этом остаётся открытым для правки: строк просто нет, и это не «заданий нет».
    expect(screen.queryByText('На этот день заданий нет')).toBeNull();
  });

  it('переданный день в окне записи правится по сохранённому отчёту, без `open`', async () => {
    const { http } = renderCabinet({ stored: reportOf([withReading], 'submitted') });
    await waitForBlocks();

    // Состав отправленного дня заморожен: открывать нечего, а транзакция была бы тяжёлой и
    // бесследной. Правку при этом день принимает — пока его не приняли (Р12).
    await expectNoOpen(http);
    expect(await screen.findByText('Передано')).toBeDefined();
    const odometer = field(blockOf(routeItem.id), 'Одометр') as HTMLInputElement;
    expect(odometer.disabled).toBe(false);
    expect(odometer.value).toBe('145320');
    expect(submitButton()).not.toBeNull();
  });

  it('переданный день с опустевшим заданием показывает свои строки, а не «заданий нет»', async () => {
    // Правило над матрицей: существующий отчёт старше живого задания. Рейс переназначили уже
    // после отправки — состав отчёта заморожен, и числа никуда не делись.
    const { http } = renderCabinet({ stored: reportOf([withReading], 'submitted'), entries: [] });
    await waitForBlocks();

    await expectNoOpen(http);
    expect(screen.queryByText('На этот день заданий нет')).toBeNull();
    expect(within(blockOf(routeItem.id)).getByText('Рейс Р-142')).toBeDefined();
  });

  it('принятый день внутри окна записи читается, а не открывается', async () => {
    const { http } = renderCabinet({ stored: reportOf([withReading], 'accepted') });
    await waitForBlocks();

    await expectNoOpen(http);
    expect(await screen.findByText('Принято')).toBeDefined();
    // Причина — теми же словами, что и строка над формой, и стоит там, где была бы кнопка.
    expect(footer().textContent).toContain('правки вносит диспетчер');
    expect(submitButton()).toBeNull();
  });

  it('день на повторном приёме и аннулированный читаются той же клеткой', async () => {
    const again = renderCabinet({ stored: reportOf([withReading], 'needs_reacceptance') });
    await waitForBlocks();
    await expectNoOpen(again.http);
    expect(await screen.findByText('На повторном приёме')).toBeDefined();
    again.unmount();

    const voided = renderCabinet({ stored: reportOf([withReading], 'voided') });
    await waitForBlocks();
    await expectNoOpen(voided.http);
    expect(await screen.findByText('Аннулирован')).toBeDefined();
    expect(footer().textContent).toContain('Отчёт этого дня аннулирован');
    expect(submitButton()).toBeNull();
  });

  it('вне окна записи без отчёта — «не передавались» и ссылка на задание', async () => {
    const { http } = renderCabinet({ stored: null, canSubmit: false });

    // Задание в этот день было — значит день был рабочим, и человеку показывают, чем именно.
    expect(await screen.findByText('Показания за этот день не передавались')).toBeDefined();
    expect(screen.getByRole('link', { name: 'Открыть задание' }).getAttribute('href')).toBe(
      '/driver/assignment',
    );
    await expectNoOpen(http);
  });

  it('вне окна записи без задания — «заданий нет», и это не отказ', async () => {
    const { http } = renderCabinet({ stored: null, entries: [], canSubmit: false });

    expect(await screen.findByText('На этот день заданий нет')).toBeDefined();
    await expectNoOpen(http);
  });

  it('вне окна записи черновик читается по сохранённому отчёту', async () => {
    const { http } = renderCabinet({ stored: reportOf([withReading], 'draft'), canSubmit: false });
    await waitForBlocks();

    await expectNoOpen(http);
    const odometer = field(blockOf(routeItem.id), 'Одометр') as HTMLInputElement;
    expect(odometer.disabled).toBe(true);
    expect(odometer.value).toBe('145320');
    expect(submitButton()).toBeNull();
    expect(footer().textContent).toContain('Показания принимаются за сегодня');
  });
});

describe('кабинет водителя: читающий режим и черновик (Р10)', () => {
  beforeEach(() => localStorage.clear());

  it('принятый день не принимает ввода ни одним элементом и не зовёт `open`', async () => {
    const { http } = renderCabinet({ stored: reportOf([withReading], 'accepted') });
    await waitForBlocks();
    const block = blockOf(routeItem.id);

    // Выключено всё, чем можно ввести: ПЯТЬ чисел, комментарий, «Прикрепить фото». Иначе водитель
    // правит принятый день, а отказ приходит с сервера — после того, как он всё набрал. Читающий
    // режим гасит поля разом, одним признаком: выключай их поимённо — однажды забудешь шестое.
    for (const input of [
      field(block, 'Одометр'),
      field(block, 'Моточасы'),
      field(block, 'Заправлено'),
      // Два поля с подписью «Топливо» различает только заголовок группы (Р7): без него оба раза
      // проверялся бы остаток на начало, а конец смены остался бы без караула.
      field(group(block, 'Начало смены'), 'Топливо'),
      field(group(block, 'Конец смены'), 'Топливо'),
      field(block, 'Комментарий'),
    ]) {
      expect(input.disabled).toBe(true);
      fireEvent.change(input, { target: { value: '999' } });
    }
    const picker = block.querySelector('input[type="file"]') as HTMLInputElement;
    expect(picker.disabled).toBe(true);
    expect(
      within(block)
        .getByRole('button', { name: /Прикрепить фото/u })
        .hasAttribute('disabled'),
    ).toBe(true);
    // Удаление снято отсутствием кнопки: выключенная обещала бы действие, которого нет.
    expect(within(block).queryByRole('button', { name: 'Удалить' })).toBeNull();

    // Ни одна из попыток не дошла ни до черновика, ни до сервера.
    expect(readDraft(driver.id, today).items).toEqual({});
    await expectNoOpen(http);
    expect(submitButton()).toBeNull();
    expect(footer().textContent).toContain('Показания приняты — правки вносит диспетчер');
  });

  it('день старше семи суток показывает недоотправленное пометкой и не стирает его', async () => {
    putBranch('aaaa', { 'route:route-1': item({ odometerKm: '145400', comment: 'долил масла' }) });
    renderCabinet({ stored: reportOf([withReading], 'draft'), canSubmit: false });
    await waitForBlocks();

    // Числа сервера остаются в полях — это то, что в учёте.
    expect((field(blockOf(routeItem.id), 'Одометр') as HTMLInputElement).value).toBe('145320');
    // А введённое и не уехавшее стоит рядом пометкой: сдать такой день водитель уже не может, но
    // продиктовать свои цифры диспетчеру обязан мочь.
    expect(await screen.findByText('Введено, но не передано')).toBeDefined();
    expect(screen.getByText(/одометр 145400 км/u)).toBeDefined();
    expect(screen.getByText(/долил масла/u)).toBeDefined();

    // Показ дня черновик не убирает: уборка бывает по успешной отправке, по TTL и по выходу.
    expect(draftRow('route:route-1')).toMatchObject({ odometerKm: '145400' });
  });

  it('принятый день локальное не накладывает и тоже не стирает', async () => {
    putBranch('aaaa', { 'route:route-1': item({ odometerKm: '145400' }) });
    renderCabinet({ stored: reportOf([withReading], 'accepted') });
    await waitForBlocks();

    // Отчёт закрыт для водителя: экран показывает то, что в учёте, а не то, что человек набрал
    // после приёмки, — иначе он читал бы свои числа как принятые.
    expect((field(blockOf(routeItem.id), 'Одометр') as HTMLInputElement).value).toBe('145320');
    expect(screen.queryByText('Введено, но не передано')).toBeNull();
    // Не показано — не значит удалено: черновик на месте, и уборка его не касалась.
    expect(draftRow('route:route-1')).toMatchObject({ odometerKm: '145400' });
  });

  it('переданный день вне окна записи показывает и числа сервера, и незавершённое', async () => {
    // Случай достижим ровно потому, что страница после отправки живёт (Р12): день передали,
    // водитель начал правку, не отправил, и окно записи закрылось.
    putBranch('aaaa', { 'route:route-1': item({ odometerKm: '145400' }) });
    const { http } = renderCabinet({
      stored: reportOf([withReading], 'submitted'),
      canSubmit: false,
    });
    await waitForBlocks();

    await expectNoOpen(http);
    expect((field(blockOf(routeItem.id), 'Одометр') as HTMLInputElement).value).toBe('145320');
    expect(await screen.findByText('Введено, но не передано')).toBeDefined();
    expect(screen.getByText(/одометр 145400 км/u)).toBeDefined();
    // Передавать нечем, но и стирать нечего: правка не в учёте, но она есть.
    expect(submitButton()).toBeNull();
    expect(draftRow('route:route-1')).toMatchObject({ odometerKm: '145400' });
  });
});
