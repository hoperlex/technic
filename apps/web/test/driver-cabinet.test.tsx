import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { useLocation } from 'react-router';
import dayjs from 'dayjs';
import {
  DRIVER_SUBMIT_PAST_DAYS,
  type DriverAssignmentDto,
  type DriverAssignmentEntry,
  type DriverReportDto,
} from '@technic/contracts';
import { MOSCOW_TZ } from '@shared/config';
import { json, mockHttp } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { MOBILE_VIEWPORT, type Viewport } from './viewport';
import { DriverLayout } from '../src/pages/driver/DriverLayout';
import { DriverPage } from '../src/pages/driver/DriverPage';
// Таблица стилей — текстом: раскладки jsdom не считает, и правило о прокрутке проверяется по
// самому правилу (см. тест про узкий экран). `?raw` разрешает путь так же, как импорт кода, —
// прогон из другого каталога его не сломает.
import { readFileSync } from 'node:fs';
import path from 'node:path';

/*
 * Таблица стилей читается с диска от корня пакета, а не импортом `?raw`: в jsdom стили не
 * подключаются вовсе, `?raw` здесь отдаёт пустую строку, и проверка правил молча проходила бы на
 * любом содержимом. `import.meta.url` в этом окружении не файловый, поэтому путь — от `cwd`,
 * который у прогона всегда `apps/web`.
 */
const stylesCss = readFileSync(path.resolve(process.cwd(), 'src/styles.css'), 'utf8');

/**
 * Кабинет водителя (ADR 0102): каркас и задание на дату — этап 3 плана, решения Р9–Р13.
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
  requests: [
    {
      displayNumber: 'ТС-101',
      customerName: 'Альфа-объект',
      loadingLocation: 'Карьер «Северный»',
      unloadingLocation: 'ЖК «Восход», корпус 3',
      time: '08:30',
      cargoLabel: 'Песок, 20 т',
      comment: 'Заезд через южные ворота',
      contacts: [{ label: 'Приёмка', name: 'Иванов Иван', phone: '+79990000001' }],
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
  requests: [],
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
      <DriverLayout>
        <DriverPage />
      </DriverLayout>
      <AddressProbe />
    </>,
    { user: driver, viewport: options.viewport, route: options.route ?? '/driver' },
  );
  return { ...rendered, http };
}

describe('кабинет водителя: задание на дату', () => {
  it('задание читается готовыми подписями: машина, источник, состав рейса и контакты', async () => {
    renderCabinet();

    // Источник и назначение — заголовком карточки: по ним водитель и узнаёт свой выезд.
    expect(await screen.findByText('Рейс Р-142')).toBeDefined();
    expect(screen.getByText('Грузоперевозка')).toBeDefined();
    // Машина названа одной готовой строкой вместе с гаражным номером: собирает её сервер.
    expect(screen.getByText('КамАЗ 65115 · А123ВС799 · гар. № 12')).toBeDefined();
    expect(screen.getByText('НЕФАЗ 8332 · АВ123477')).toBeDefined();

    // Состав рейса: заявка со временем, заказчиком, адресами, грузом и комментарием диспетчера.
    expect(screen.getByText('ТС-101')).toBeDefined();
    expect(screen.getByText('08:30')).toBeDefined();
    expect(screen.getByText('Альфа-объект')).toBeDefined();
    expect(screen.getByText('Карьер «Северный»')).toBeDefined();
    expect(screen.getByText('ЖК «Восход», корпус 3')).toBeDefined();
    expect(screen.getByText('Песок, 20 т')).toBeDefined();
    expect(screen.getByText('Заезд через южные ворота')).toBeDefined();

    // Контакт — ссылкой набора: кабинет открывают с того же телефона, с которого звонят.
    expect(screen.getByText('Приёмка')).toBeDefined();
    expect(screen.getByText('+79990000001').getAttribute('href')).toBe('tel:+79990000001');

    // Недельный лист даёт свою карточку рядом с рейсом: за день бывает и то, и другое.
    expect(screen.getByText('ЭСМ-2 № 000123')).toBeDefined();
    expect(screen.getByText('Экскаватор JCB · В010ОР799')).toBeDefined();
  });

  it('пустой день говорит словами и не показывает кнопок', async () => {
    // Выходной, отпуск, день без рейсов — законное состояние, а не ошибка и не «не найдено».
    renderCabinet({ entriesFor: () => [] });

    expect(await screen.findByText('На этот день заданий нет')).toBeDefined();
    // Кнопка, которая ничего не откроет, читается как поломка: передавать по такому дню нечего.
    expect(screen.queryByText('Передать показания')).toBeNull();
    expect(screen.queryByText('Черновик')).toBeNull();
  });

  it('стрелки переносят день в адрес и в запрос, а сегодня живёт без параметра', async () => {
    const { http } = renderCabinet();
    expect(await screen.findByText('Рейс Р-142')).toBeDefined();
    // Первый запрос — на сегодня по Москве, а не на дату часов устройства. Именно первый: следом
    // шапка спрашивает прошедшие дни окна записи, проверяя долг (П4), и последним будет один из них.
    expect(http.calls.find((call) => call.path === '/driver/assignment')?.query.get('date')).toBe(
      today,
    );

    fireEvent.click(screen.getByLabelText('Предыдущий день'));

    // Адрес — единственное место, где день хранится: его пересылают и по нему возвращаются.
    await waitFor(() =>
      expect(screen.getByTestId('address').textContent).toBe(`/driver?date=${yesterday}`),
    );
    await waitFor(() =>
      expect(http.lastCall('GET /driver/assignment')?.query.get('date')).toBe(yesterday),
    );

    fireEvent.click(screen.getByLabelText('Следующий день'));

    // Возврат на сегодня убирает параметр: ссылка на кабинет не должна устаревать к утру.
    await waitFor(() => expect(screen.getByTestId('address').textContent).toBe('/driver'));
    expect(http.lastCall('GET /driver/assignment')?.query.get('date')).toBe(today);
  });

  it('за окном записи задание читается, а передавать показания нельзя', async () => {
    // Окно чтения (−30) шире окна записи (8 дней, считая сегодняшний) — это и проверяется: день
    // девятидневной давности открывается, но закрыть его водителю уже нечем (Р11).
    renderCabinet({ route: `/driver?date=${beforeSubmitWindow}` });

    expect(await screen.findByText('Рейс Р-142')).toBeDefined();
    expect(screen.getByText('ТС-101')).toBeDefined();

    const submit = screen.getByText('Передать показания').closest('button');
    expect(submit?.disabled).toBe(true);
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
