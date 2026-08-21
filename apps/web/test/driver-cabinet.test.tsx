import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { useLocation } from 'react-router';
import dayjs from 'dayjs';
import {
  DRIVER_SUBMIT_PAST_DAYS,
  type DriverAssignmentDto,
  type DriverAssignmentEntry,
  type DriverReportDto,
} from '@technic/contracts';
import { MOSCOW_TZ } from '@shared/config';
import { QueryClient } from '@tanstack/react-query';
import { json, mockHttp, type HttpMock } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { MOBILE_VIEWPORT, type Viewport } from './viewport';
import { DriverLayout } from '../src/pages/driver/DriverLayout';
import { DriverPage } from '../src/pages/driver/DriverPage';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/*
 * Таблица стилей читается с диска, а не импортом `?raw`: стили в тестах не подключаются вовсе
 * (`css` у vitest выключен), `?raw` отдаёт пустую строку — и проверка правил молча проходила бы на
 * любом содержимом. Путь считается от файла теста, а не от рабочего каталога: прогон из корня
 * репозитория его не сломает.
 *
 * Адрес не собирается через `new URL('…', import.meta.url)`, хотя так было бы привычнее: Vite
 * распознаёт эту запись с литералом как ссылку на ассет и переписывает её на путь в сборке —
 * `readFileSync` получал `/src/styles.css` и падал ещё до первого теста файла.
 */
const stylesCss = readFileSync(join(import.meta.dirname, '../src/styles.css'), 'utf8');

/**
 * Кабинет водителя (ADR 0102): каркас и задание на дату — этап 3 плана, решения Р9–Р13.
 *
 * Задание живёт на `/driver/assignment` (план docs/driver-readings-first-plan.md, Р1): index
 * кабинета занят формой показаний. Экран от переезда не изменился — изменился адрес, по которому
 * его открывают, и потому здесь же проверяется переход между двумя половинами дня (Р5).
 *
 * Проверяется то, ради чего кабинет заведён отдельным контуром. Первое: задание читается целиком с
 * готовых подписей — у роли `driver` нет права `directories.read`, и спросить справочник ей нечем
 * (Р13), поэтому всё, чего нет в ответе ручки, на экране не появится ниоткуда. Второе: день живёт
 * в адресе (Р11) — состояние, которое нельзя переслать и нельзя обновить страницей, на телефоне
 * теряется первым. Третье: окно записи уже окна чтения (Р11) — за его границей задание читается,
 * а передавать по нему нечего. Четвёртое: разделов основного портала в каркасе нет вовсе (Р9).
 *
 * Даты считаются от сегодняшнего дня по Москве — по той же границе суток, по которой их считает
 * сам кабинет: прибитая к календарю дата разъехалась бы с окном записи на следующий же день.
 */

const today = dayjs().tz(MOSCOW_TZ).format('YYYY-MM-DD');
const yesterday = dayjs(today).subtract(1, 'day').format('YYYY-MM-DD');
/** Позавчера: второй из трёх прошедших дней, которые шапка проверяет на долг (П4). */
const dayBefore = dayjs(today).subtract(2, 'day').format('YYYY-MM-DD');
/** Первый день, за который водитель ещё может передать показания: сегодня и семь предыдущих. */
const firstSubmittable = dayjs(today).subtract(DRIVER_SUBMIT_PAST_DAYS, 'day').format('YYYY-MM-DD');
/** День старше окна записи, но внутри окна чтения (−30): задание есть, передавать нельзя. */
const beforeSubmitWindow = dayjs(today).subtract(9, 'day').format('YYYY-MM-DD');

/**
 * Рейс: подписи машины, прицепа и источника готовы, состав — заявки со временем, адресами и
 * контактами. Ни одного идентификатора справочника в строке нет намеренно (Р13).
 */
const routeEntry: DriverAssignmentEntry = {
  sourceKind: 'route',
  sourceId: 'route-1',
  sourceLabel: 'Рейс Р-142',
  purposeLabel: 'Грузоперевозка',
  vehicleLabel: 'КамАЗ 65115 · А123ВС799',
  garageNumber: '12',
  trailerLabel: 'НЕФАЗ 8332 · АВ123477',
  itemId: null,
  shiftOrder: null,
  /*
   * Задание водителю — **порядок объезда**, а не список заявок (§8 плана). Ездка занимает две
   * остановки: где грузим и где выгружаем; водитель читает их подряд, в том порядке, в котором
   * поедет. Комментарий строки стоит рядом с её ролью — в бланке он отбрасывается первым при
   * нехватке места (Р11а), и не покажи его кабинет, «заезд через южные ворота» не доехало бы
   * до водителя нигде.
   */
  points: [
    {
      position: 1,
      location: 'Карьер «Северный»',
      arrivalTime: '08:30',
      actions: [
        {
          role: 'load' as const,
          roleLabel: 'Грузим',
          displayNumber: 'ТС-101/1',
          customerName: 'Альфа-объект',
          cargoLabel: '20 т',
          comment: 'Заезд через южные ворота',
        },
      ],
      contacts: [{ name: 'Иванов Иван', phone: '+79990000001' }],
      comment: '',
    },
    {
      position: 2,
      location: 'ЖК «Восход», корпус 3',
      arrivalTime: '',
      actions: [
        {
          role: 'unload' as const,
          roleLabel: 'Выгружаем',
          displayNumber: 'ТС-101/1',
          customerName: 'Альфа-объект',
          cargoLabel: '20 т',
          comment: '',
        },
      ],
      contacts: [{ name: 'Петров Пётр', phone: '+79990000002' }],
      comment: '',
    },
  ],
  moveFrom: '',
  moveTo: '',
  comment: 'Заправиться на выезде',
  previous: null,
};

/** Недельный лист ЭСМ-2 накрывает день своей карточкой: состава у него нет, машина своя (Р16). */
const esm2Entry: DriverAssignmentEntry = {
  sourceKind: 'esm2',
  sourceId: 'wb-1',
  sourceLabel: 'ЭСМ-2 № 000123',
  purposeLabel: 'Работа на объекте',
  vehicleLabel: 'Экскаватор JCB · В010ОР799',
  garageNumber: '',
  trailerLabel: '',
  itemId: null,
  shiftOrder: null,
  // У недельного листа точек нет: он накрывает неделю работы на одной площадке, а не день объезда.
  points: [],
  moveFrom: '',
  moveTo: '',
  comment: '',
  previous: null,
};

/** Учётка водителя: два права кабинета и ни одного права основного портала (ADR 0102). */
const driver = authUser({
  id: 'user-driver',
  email: 'driver@example.test',
  role: 'driver',
  lastName: 'Водителев',
  firstName: 'Виктор',
  middleName: 'Иванович',
  fullName: 'Водителев Виктор Иванович',
});

/** Адрес виден тесту: день кабинета живёт именно в нём, а не в состоянии компонента (Р11). */
function AddressProbe() {
  const location = useLocation();
  return <div data-testid="address">{`${location.pathname}${location.search}`}</div>;
}

function renderCabinet(
  options: {
    route?: string;
    viewport?: Viewport;
    entriesFor?: (date: string) => DriverAssignmentEntry[];
    /** Отчёт дня: им проверяется строка долга — день без отчёта закрыт не был (П4). */
    reportFor?: (date: string) => DriverReportDto | null;
    /**
     * Что каркас показывает телом. По умолчанию — задание, ради которого сюда и ходят; `null`
     * оставляет одну шапку: её ссылки от содержимого страницы не зависят вовсе (Р5).
     */
    body?: ReactNode;
    /** Клиент запросов: сценариям про возврат в приложение нужен с настройками портала. */
    queryClient?: QueryClient;
  } = {},
) {
  const entriesFor = options.entriesFor ?? (() => [routeEntry, esm2Entry]);
  const reportFor = options.reportFor ?? (() => null);
  const http = mockHttp({
    'GET /driver/assignment': ({ query }) => {
      const date = query.get('date') ?? today;
      // Окно записи держит сервер: портал берёт `canSubmit` из ответа и сам его не вычисляет.
      const dto: DriverAssignmentDto = {
        date,
        canSubmit: date >= firstSubmittable && date <= today,
        entries: entriesFor(date),
      };
      return json(dto);
    },
    // Отчёта за день может не быть вовсе — это законное состояние, и кабинет обязан открыться.
    'GET /driver/reports/:date': ({ params }) => json(reportFor(params.date ?? today)),
  });
  const rendered = renderWithUser(
    <>
      <DriverLayout>{options.body === undefined ? <DriverPage /> : options.body}</DriverLayout>
      <AddressProbe />
    </>,
    {
      user: driver,
      viewport: options.viewport,
      route: options.route ?? '/driver/assignment',
      queryClient: options.queryClient,
    },
  );
  return { ...rendered, http };
}

/**
 * Клиент запросов с настройками портала: глобально `refetchOnWindowFocus: false` и свой срок
 * свежести ([main.tsx](../src/main.tsx)). Общий тестовый клиент их не повторяет — у него всё
 * стухает сразу и обновляется по фокусу само, — и проверка «кабинет читает по возврату» прошла бы
 * на любых настройках самого кабинета, ничего не проверив.
 */
const portalDefaults = (): QueryClient =>
  new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false, staleTime: 10_000 } },
  });

/** Сколько раз спросили задание за конкретный день: календарь и строка долга ходят одной ручкой. */
const assignmentCalls = (http: HttpMock, date: string): number =>
  http.calls.filter((call) => call.path === '/driver/assignment' && call.query.get('date') === date)
    .length;

/** То же по отчёту: у него ключ свой на каждую дату, и путь называет её прямо. */
const reportCalls = (http: HttpMock, date: string): number =>
  http.calls.filter((call) => call.path === `/driver/reports/${date}`).length;

describe('кабинет водителя: задание на дату', () => {
  it('задание читается готовыми подписями: машина, источник, состав рейса и контакты', async () => {
    renderCabinet();

    // Источник и назначение — заголовком карточки: по ним водитель и узнаёт свой выезд.
    expect(await screen.findByText('Рейс Р-142')).toBeDefined();
    expect(screen.getByText('Грузоперевозка')).toBeDefined();
    // Машина названа одной готовой строкой вместе с гаражным номером: собирает её сервер.
    expect(screen.getByText('КамАЗ 65115 · А123ВС799 · гар. № 12')).toBeDefined();
    expect(screen.getByText('НЕФАЗ 8332 · АВ123477')).toBeDefined();

    // Состав рейса: заявка со временем, заказчиком, адресами и комментарием заявителя.
    // Подпись строки несёт номер ездки (Р1): у заявки их может быть несколько, и водителю
    // важно, какую именно он грузит на этой остановке.
    expect(screen.getAllByText('ТС-101/1').length).toBeGreaterThan(0);
    expect(screen.getByText('08:30')).toBeDefined();
    // Заказчик назван у **каждой** роли: на погрузке и на разгрузке водитель видит, чью работу
    // он делает, не листая обратно к началу задания.
    expect(screen.getAllByText('Альфа-объект')).toHaveLength(2);
    expect(screen.getByText('Карьер «Северный»')).toBeDefined();
    expect(screen.getByText('ЖК «Восход», корпус 3')).toBeDefined();
    expect(screen.getByText('Заезд через южные ворота')).toBeDefined();

    // Количества груза в кабинете нет ни строкой, ни подписью: груз водителю описывает
    // комментарий заявки, а «20 т» он сверяет на весах. В письме-задании количество осталось.
    //
    // Ищется ровно то, что кладёт фикстура (`cargoLabel: '20 т'`). Прежняя проверка искала
    // «Песок, 20 т» — склейку из карточки заявки, которой в задании по точкам не бывает вовсе:
    // сторож проходил при любом содержимом строки роли и разворот решения пропустил молча.
    expect(screen.queryByText('Груз')).toBeNull();
    expect(screen.queryByText('20 т')).toBeNull();

    // Контакт — ссылкой набора: кабинет открывают с того же телефона, с которого звонят.
    // Подписи «Погрузка/Разгрузка» у контакта больше нет: он принадлежит **остановке**, а на ней
    // могут сойтись и погрузка, и разгрузка, и работа линейного дня (Р9, Р11а). Кто встречает —
    // назван именем, а что здесь делают, сказано ролями выше.
    // Имя и телефон стоят одним узлом через разделитель, поэтому ищем по вхождению.
    expect(screen.getAllByText(/Иванов Иван/).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Встречает').length).toBe(2);
    expect(screen.getByText('+79990000001').getAttribute('href')).toBe('tel:+79990000001');

    // Недельный лист даёт свою карточку рядом с рейсом: за день бывает и то, и другое.
    expect(screen.getByText('ЭСМ-2 № 000123')).toBeDefined();
    expect(screen.getByText('Экскаватор JCB · В010ОР799')).toBeDefined();
  });

  it('пустой день говорит словами и не показывает кнопок', async () => {
    // Выходной, отпуск, день без рейсов — законное состояние, а не ошибка и не «не найдено».
    renderCabinet({ entriesFor: () => [] });

    expect(await screen.findByText('На этот день заданий нет')).toBeDefined();
    // Экран задания читающий целиком: ни одного действия на нём нет и не появляется — ни у
    // пустого дня, ни у полного (Р12 ADR 0102).
    expect(screen.queryByRole('button', { name: /Передать/u })).toBeNull();
    expect(screen.queryByText('Черновик')).toBeNull();
  });

  it('стрелки переносят день в адрес и в показанное, а сегодня живёт без параметра', async () => {
    // Задание каждого дня подписано своей датой: по подписи и видно, за какой день читает страница.
    const { http } = renderCabinet({
      entriesFor: (date) => [{ ...routeEntry, sourceLabel: `Рейс ${date}` }],
    });
    expect(await screen.findByText(`Рейс ${today}`)).toBeDefined();
    // Первый запрос — на сегодня по Москве, а не на дату часов устройства. Именно первый: следом
    // шапка спрашивает прошедшие дни окна записи, проверяя долг (П4), и последним будет один из них.
    expect(http.calls.find((call) => call.path === '/driver/assignment')?.query.get('date')).toBe(
      today,
    );

    fireEvent.click(screen.getByLabelText('Предыдущий день'));

    // Адрес — единственное место, где день хранится: его пересылают и по нему возвращаются.
    await waitFor(() =>
      expect(screen.getByTestId('address').textContent).toBe(
        `/driver/assignment?date=${yesterday}`,
      ),
    );
    /*
     * Проверяется показанное, а не последний запрос. Нового запроса за вчера может не быть вовсе:
     * три прошедших дня минуту назад прочла строка долга в шапке, кэш у них с этой страницей общий
     * (Р8), и пока ответ свеж (`cabinetRead`), второго чтения того же самого портал не делает.
     * Прежняя проверка «последним ушёл запрос за вчера» держалась на том, что у тестового клиента
     * своего срока свежести нет, — то есть проверяла настройку теста, а не поведение кабинета.
     */
    expect(await screen.findByText(`Рейс ${yesterday}`)).toBeDefined();
    expect(
      http.calls.some(
        (call) => call.path === '/driver/assignment' && call.query.get('date') === yesterday,
      ),
    ).toBe(true);

    fireEvent.click(screen.getByLabelText('Следующий день'));

    // Возврат на сегодня убирает параметр: ссылка на кабинет не должна устаревать к утру.
    await waitFor(() =>
      expect(screen.getByTestId('address').textContent).toBe('/driver/assignment'),
    );
    expect(await screen.findByText(`Рейс ${today}`)).toBeDefined();
  });

  it('возврат в приложение перечитывает задание показанного дня', async () => {
    const { http } = renderCabinet({ queryClient: portalDefaults() });
    expect(await screen.findByText('Рейс Р-142')).toBeDefined();
    const before = assignmentCalls(http, today);

    /*
     * Возврат в приложение TanStack Query слышит как `visibilitychange` — им же он его и шлёт.
     * Телефон водителя лежит в кармане со свёрнутым браузером: рейс, заведённый диспетчером в
     * обед, обязан появиться сам, потому что сказать водителю «обнови страницу» здесь некому.
     * Портальное `refetchOnWindowFocus: false` в кабинете означало бы вчерашнее задание на
     * экране до перезагрузки, которой не будет (Р7).
     */
    fireEvent(window, new Event('visibilitychange'));

    await waitFor(() => expect(assignmentCalls(http, today)).toBeGreaterThan(before));
  });

  it('строка долга обновляется по возврату — но не по тому дню, который открыт', async () => {
    // Тело каркаса не нужно: проверяются запросы самой шапки (П4). Открыт вчерашний день —
    // именно тот, по которому со страницы показаний уходят `open` и `submit`.
    const { http } = renderCabinet({
      route: `/driver?date=${yesterday}`,
      body: null,
      queryClient: portalDefaults(),
    });
    await waitFor(() => expect(reportCalls(http, dayBefore)).toBe(1));
    const shownBefore = reportCalls(http, yesterday);

    fireEvent(window, new Event('visibilitychange'));

    /*
     * Прошедшие дни строка перечитывает: долг мог закрыть диспетчер, пока телефон лежал в кармане.
     * А показанный день — не трогает, и это не экономия запроса. Отчёт дня живёт одним кэшем (Р8),
     * страница на время полёта `open` и `submit` свои чтения выключает — этим и держится Р7:
     * единственный писатель кэша в полёте — сама мутация. Строка долга про гейт не знает ничего, и
     * её фоновое чтение легло бы снимком «до» поверх ответа отправки — то есть отдало бы форме
     * устаревшую версию отчёта и гарантированный 409 на следующей отправке.
     */
    await waitFor(() => expect(reportCalls(http, dayBefore)).toBe(2));
    expect(reportCalls(http, yesterday)).toBe(shownBefore);
  });

  it('за окном записи задание читается по-прежнему, а кнопок передачи в шапке нет вовсе', async () => {
    // Окно чтения (−30) шире окна записи (8 дней, считая сегодняшний) — это и проверяется: день
    // девятидневной давности открывается и читается целиком (Р11).
    renderCabinet({ route: `/driver/assignment?date=${beforeSubmitWindow}` });

    expect(await screen.findByText('Рейс Р-142')).toBeDefined();
    // Подпись строки несёт номер ездки (Р1): у заявки их может быть несколько, и водителю
    // важно, какую именно он грузит на этой остановке.
    expect(screen.getAllByText('ТС-101/1').length).toBeGreaterThan(0);

    /*
     * Кнопки передачи в шапке больше нет ни в каком дне (Р4): состояние дня называет строка над
     * формой показаний, а окно записи закрывает саму кнопку «Передать» в подвале той страницы —
     * это проверяет driver-readings.test.tsx. Здесь важно обратное: шапка задания её не рисует, и
     * прежняя проверка «кнопка выключена» молча проходила бы на любой странице.
     */
    expect(screen.queryByText('Передать показания')).toBeNull();
    expect(screen.queryByText('Передать')).toBeNull();
  });

  it('шапка ведёт с задания на показания того же дня, а логотип — на сегодня', async () => {
    // Р5: две половины дня связаны ссылкой в шапке, и дата едет с переходом. Логотип по-прежнему
    // ведёт на «сегодня» — то есть на сегодняшние показания, без параметра.
    renderCabinet({ route: `/driver/assignment?date=${beforeSubmitWindow}`, body: null });

    const back = await screen.findByText('Показания');
    expect(back.getAttribute('href')).toBe(`/driver?date=${beforeSubmitWindow}`);
    expect(screen.getByLabelText('Сегодня').getAttribute('href')).toBe('/driver');
  });

  it('со страницы показаний шапка ведёт на задание того же дня', async () => {
    renderCabinet({ route: `/driver?date=${yesterday}`, body: null });

    const forward = await screen.findByText('Задание');
    expect(forward.getAttribute('href')).toBe(`/driver/assignment?date=${yesterday}`);
    // Сегодняшний день параметра не получает и здесь: адрес «/driver/assignment» — адрес сегодня.
    expect(screen.queryByText('Показания')).toBeNull();
  });

  it('в каркасе кабинета нет ни бокового меню, ни нижней навигации', async () => {
    // Роль `driver` не имеет ни одного права основного портала, и каркас у кабинета свой (Р9):
    // разделы здесь нельзя скрыть — их нет. Смотрим с телефона: нижняя навигация живёт там.
    renderCabinet({ viewport: MOBILE_VIEWPORT });

    expect(await screen.findByText('Рейс Р-142')).toBeDefined();
    expect(document.querySelector('.mobile-nav')).toBeNull();
    expect(document.querySelector('.ant-layout-sider')).toBeNull();
    expect(document.querySelector('.ant-menu')).toBeNull();
    for (const section of ['Заказ ТС', 'Путевые листы', 'Справочники', 'Гараж', 'Вывоз мусора']) {
      expect(screen.queryByText(section), section).toBeNull();
    }
  });

  it('каркас несёт класс кабинета и переменную масштаба шрифта', async () => {
    // Масштаб живёт одной переменной на каркасе (Р1): подобрать его на живом телефоне — работа
    // одного значения, а не поиска по компонентам. Значение приходит из TS-константы кабинета,
    // поэтому проверяется не число, а то, что переменная вообще доехала до разметки.
    renderCabinet({ viewport: MOBILE_VIEWPORT });
    expect(await screen.findByText('Рейс Р-142')).toBeDefined();

    const shell = document.querySelector<HTMLElement>('.driver-shell');
    expect(shell).not.toBeNull();
    expect(Number(shell?.style.getPropertyValue('--driver-scale'))).toBeGreaterThan(0);
  });

  it('на узком экране страница не разъезжается вбок', async () => {
    renderCabinet({ viewport: MOBILE_VIEWPORT });
    expect(await screen.findByText('Рейс Р-142')).toBeDefined();

    expect(document.body.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
    /*
     * Ширины в jsdom нулевые — раскладку он не считает, и проверка выше сама по себе поймала бы
     * разъехавшуюся страницу только в настоящем браузере. Поэтому здесь же проверяются оба
     * правила, которыми прокрутка и запрещена (Р2): без `min-width: 0` потомок flex-строки не
     * сжимается меньше своего содержимого, а `clip` вместо `hidden` не заводит области прокрутки
     * и не ломает липкую шапку. Удалить их «за ненадобностью» тест не даст.
     */
    expect(stylesCss).toMatch(/\.driver-shell\s*\{[^}]*overflow-x:\s*clip/);
    expect(stylesCss).toMatch(/\.driver-shell \*\s*\{[^}]*min-width:\s*0/);
  });

  it('строка «не сдано» ведёт на ближайший незакрытый день, а выходной за долг не считает', async () => {
    /*
     * Вчера заданий не было (выходной), позавчера был рейс и отчёта по нему нет — долг именно
     * там. Отчёта нет у обоих дней: его заводит открытие оверлея, поэтому различает их только
     * задание. Ложная тревога по выходным научила бы не смотреть на строку вовсе.
     */
    renderCabinet({ entriesFor: (date) => (date === yesterday ? [] : [routeEntry]) });

    // Ссылка ведёт на показания того дня, а не на его задание: закрывают долг формой (Р1).
    const link = await screen.findByText(/Не переданы показания/);
    expect(link.getAttribute('href')).toBe(`/driver?date=${dayBefore}`);
    expect(link.textContent).toContain(dayjs(dayBefore).format('D MMM'));
  });

  it('карточки задания идут по позиции смены, а не по порядку ответа', async () => {
    // Порядок на экране — свойство экрана: день читают сверху вниз так же, как его работают.
    const second: DriverAssignmentEntry = { ...routeEntry, shiftOrder: 2 };
    const first: DriverAssignmentEntry = {
      ...routeEntry,
      sourceId: 'route-2',
      sourceLabel: 'Рейс Р-7',
      shiftOrder: 1,
    };
    renderCabinet({ entriesFor: () => [second, first, esm2Entry] });

    expect(await screen.findByText('Рейс Р-7')).toBeDefined();
    const titles = [...document.querySelectorAll('.ant-card-head-title')].map(
      (node) => node.textContent ?? '',
    );
    expect(titles[0]).toContain('Рейс Р-7');
    expect(titles[1]).toContain('Рейс Р-142');
    // Недельный лист смены не имеет вовсе и стоит после сменных карточек, а не перед ними.
    expect(titles[2]).toContain('ЭСМ-2 № 000123');
  });
});
