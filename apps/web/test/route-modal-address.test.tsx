import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { Route, Routes, useLocation, useNavigate } from 'react-router';
import { moscowDateKeyOf, type AuthUser, type VehicleRouteDto } from '@technic/contracts';
import { apiError, json, mockHttp } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { emptyList, list } from './factories/common';
import { vehicleRequest } from './factories/vehicle';
import { RouteModalProvider, useRouteModal } from '../src/pages/vehicle/routeModal';

/**
 * Адресация окон рейса, списка рейсов и заявки (ADR 0120, план `docs/vehicle-routes-modal-plan.md`).
 *
 * Вкладки «Маршруты» больше нет: рейс открывается окном поверх той страницы, где о нём спросили, и
 * единственное место, где записано «какое окно открыто», — сам адрес (`?route=`, `?routes=1`,
 * `?request=`). Отсюда и предмет проверки: не «рисуется ли карточка», а как держатель окон
 * (`RouteModalProvider`) читает адрес и что оставляет в нём после себя.
 *
 * Провайдер здесь поднимается настоящий, элементом маршрутизации, — заглушка `RouteModalContext` из
 * общего рендера отвечает на другой вопрос («попросили ли открыть окно»), и держателя адреса ею не
 * проверить вовсе: он и есть то, что подменяют. Под провайдером стоит проба вместо страницы: ему
 * всё равно, что под окном, а сценарию нужны видимый адрес, два входа в окна и «назад».
 *
 * Почему это вообще проверяется тестами, а не глазами: карточка рейса своей ошибки не обрабатывает
 * (`VehicleRouteModal` ошибку запроса не читает), поэтому ссылка на удалённый рейс без держателя
 * оставила бы поверх страницы пустое окно навсегда. Прежде эту работу делала вкладка, а с её сносом
 * защита осталась в одном месте — здесь.
 */

/**
 * День рейса — сегодняшний, и константой его не задать: зафиксированное число рано или поздно
 * окажется в прошлом, и правка рейса начнёт спрашивать причину коррекции (ADR 0101), которой
 * сценарий про адрес не ждёт вовсе.
 */
const TODAY = moscowDateKeyOf(new Date());

const ROUTE: VehicleRouteDto = {
  id: 'route-1',
  displayNumber: 'Р-12',
  purpose: 'freight',
  formCode: '4p',
  sourceRequest: null,
  moveFrom: '',
  moveTo: '',
  routeDate: TODAY,
  vehicleId: 'v-own',
  vehicleLabel: 'КамАЗ 65201 · Е646СК799',
  vehicleKindId: 'kind-freight',
  vehicleTypeId: 'type-dump',
  vehicleTypeName: 'Самосвалы',
  vehicleCategoryId: null,
  vehicleCategorySpecs: null,
  driverPersonId: 'p-1',
  driverName: 'Иванов Иван Иванович',
  driverGaps: [],
  withTrailer: false,
  trailerLabel: '',
  trailer1Model: '',
  trailer1RegNumber: '',
  trailer2Model: '',
  trailer2RegNumber: '',
  garageNumber: '',
  communicationKind: '',
  transportationKind: '',
  comment: '',
  requests: [],
  points: [],
  waybill: null,
  createdByName: 'Диспетчеров Д. П.',
  createdAt: '2026-08-06T09:00:00.000Z',
  version: 1,
};

/** Заявка, стоящая в этом рейсе: ею проверяется переход «заявка → рейс» (§3.1, инвариант 3). */
const REQUEST = vehicleRequest({
  status: 'confirmed',
  route: {
    id: ROUTE.id,
    displayNumber: ROUTE.displayNumber,
    routeDate: ROUTE.routeDate,
    position: 1,
    hasWaybill: false,
    version: 1,
  },
});

/**
 * Проба вместо страницы под окнами. Стоит она **внутри** провайдера (`<Outlet/>`), и это
 * существенно: контекст окон она берёт настоящий, а не заглушку общего рендера, которая лежит
 * снаружи.
 *
 * Три кнопки — три способа задать сцену так, как её задаёт портал: клик по номеру рейса
 * (`openRoute`), «Все маршруты» (`openRoutesList`) и браузерное «назад». Последнее нельзя заменить
 * ручной правкой адреса: проверяется как раз то, что окно живёт записью в истории, а не состоянием
 * React.
 */
function Probe() {
  const { openRoute, openRoutesList } = useRouteModal();
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <div data-testid="address">{`${location.pathname}${location.search}`}</div>
      <button onClick={() => openRoute(ROUTE.id)}>проба: открыть рейс</button>
      <button onClick={() => openRoutesList()}>проба: все маршруты</button>
      <button onClick={() => navigate(-1)}>проба: назад</button>
    </>
  );
}

function renderScene(route: string, user: AuthUser = authUser()) {
  return renderWithUser(
    <Routes>
      <Route element={<RouteModalProvider />}>
        <Route path="/vehicle-requests" element={<Probe />} />
      </Route>
    </Routes>,
    { user, route },
  );
}

const address = () => screen.getByTestId('address').textContent ?? '';

/** Заголовки открытых окон: ими и проверяется «окно не висит» — пустое оно или с чужим рейсом. */
const modalTitles = () =>
  [...document.querySelectorAll('.ant-modal-title')].map((el) => el.textContent ?? '');

/**
 * Сообщение портала. Ждётся, а не проверяется сразу: и ошибка запроса, и отказ по праву приходят
 * эффектом — то есть кадром позже отрисовки.
 */
async function expectMessage(text: string): Promise<void> {
  await waitFor(() => {
    const shown = [...document.querySelectorAll('.ant-message-notice')]
      .map((el) => el.textContent ?? '')
      .join('\n');
    expect(shown, 'сообщения портала').toContain(text);
  });
}

/** Кнопка по видимой подписи: `*ByRole` на открытом окне считает доступные имена всему дереву. */
function clickButton(label: string) {
  const button = [...document.querySelectorAll('button')].find((el) => el.textContent === label);
  expect(button, `кнопка «${label}»`).toBeTruthy();
  fireEvent.click(button!);
}

describe('адрес окон: запись, которой нет', () => {
  it('неверный или удалённый ?route= кончается сообщением и очисткой адреса', async () => {
    const http = mockHttp({
      // Тот же 404, каким сервер отвечает на удалённый рейс и на выдуманный идентификатор из
      // старой закладки: портал не различает их и не должен.
      'GET /vehicle-routes/:id': () => apiError(404, { code: 'not_found', message: 'Не найдено' }),
    });
    renderScene('/vehicle-requests?route=route-404');

    /*
     * Окно открывается **раньше** ответа сервера, со скелетом: идентификатор известен из адреса, и
     * ожидание внутри окна честнее задержки его появления. Отсюда и вся эта проверка — закрыть
     * такое окно некому, кроме держателя адреса.
     */
    expect(modalTitles()).toEqual(['Маршрут']);

    await expectMessage('Маршрут не найден');
    /*
     * Параметр снимается — иначе он открывал бы пустоту при каждом возвращении на страницу и при
     * каждом «назад». Вместе с ним уходит и окно: карточка рейса ошибки не читает вовсе, и
     * оставленная открытой висела бы пустой рамкой поверх страницы без всякого способа понять, что
     * произошло.
     */
    await waitFor(() => expect(address()).toBe('/vehicle-requests'));
    expect(modalTitles()).toEqual([]);
    // Ключ запроса у держателя и у карточки общий (§3.2), поэтому запрос один на двоих: второй
    // означал бы, что окно грузит рейс само по себе, и ошибку пришлось бы обрабатывать дважды.
    expect(http.countOf('GET /vehicle-routes/:id')).toBe(1);
  });

  it('на недоступную заявку ?request= отвечает «не найдена или недоступна»', async () => {
    const http = mockHttp({
      /*
       * Одним 404 сервер отвечает и на чужую область видимости, и на удалённую заявку без права
       * архива (§3.2). Портал до ответа не знает, какой это случай, — поэтому и сообщение здесь
       * другое, чем у рейса: «не найдена» на существующей заявке читалось бы как потеря данных.
       */
      'GET /vehicle-requests/:id': () =>
        apiError(404, { code: 'not_found', message: 'Не найдено' }),
    });
    renderScene('/vehicle-requests?request=vr-404');

    // Как и у рейса: окно уже открыто со скелетом, и без держателя оно осталось бы таким навсегда.
    expect(modalTitles()).toEqual(['Заявка']);

    await expectMessage('Заявка не найдена или недоступна');
    await waitFor(() => expect(address()).toBe('/vehicle-requests'));
    expect(modalTitles()).toEqual([]);
    expect(http.countOf('GET /vehicle-requests/:id')).toBe(1);
  });
});

describe('адрес окон: право на окно', () => {
  /**
   * Механик — не «роль поменьше», а точная граница правила: журнал листов и гараж у него есть
   * (`waybills.read`, `garage.read`), а `vehicleRequests.status` и `vehicleRequests.read` нет
   * вовсе. Ровно он и приходит по чужой ссылке на рейс — из письма или пересланной строки адреса.
   */
  const mechanic = () => authUser({ role: 'mechanic' });

  it('без права на рейс ?route= снимается с сообщением и без запроса на сервер', async () => {
    const http = mockHttp({
      // Ответ рейсом, а не отказом: проверяется, что портал сюда не пошёл вовсе, а не то, что он
      // пережил отказ сервера.
      'GET /vehicle-routes/:id': () => json(ROUTE),
    });
    renderScene('/vehicle-requests?route=route-1', mechanic());

    /*
     * Сообщение обязательно: молча исчезнувший из адреса ключ читается как поломка портала — «я
     * же открыл ссылку, а ничего не произошло». Отказ по праву называет причину.
     */
    await expectMessage('Маршруты вам недоступны');
    await waitFor(() => expect(address()).toBe('/vehicle-requests'));
    expect(modalTitles()).toEqual([]);
    /*
     * Запрос не уходит, и это не про экономию сети. Ушедший вернул бы отказ, а на отказ у окна
     * своя реакция — поверх «Маршруты вам недоступны» легло бы второе сообщение, «Маршрут не
     * найден», объясняющее не то.
     */
    expect(http.countOf('GET /vehicle-routes/:id')).toBe(0);
  });

  it('без права на заявки ?request= снимается с сообщением и без запроса на сервер', async () => {
    const http = mockHttp({
      'GET /vehicle-requests/:id': () => json(REQUEST),
    });
    renderScene('/vehicle-requests?request=vr-1', mechanic());

    await expectMessage('Заявки на технику вам недоступны');
    await waitFor(() => expect(address()).toBe('/vehicle-requests'));
    expect(modalTitles()).toEqual([]);
    expect(http.countOf('GET /vehicle-requests/:id')).toBe(0);
  });
});

describe('адрес окон: нормализация и чужие параметры', () => {
  it('route и routes в одном адресе оставляют карточку рейса', async () => {
    const http = mockHttp({
      'GET /vehicle-routes/:id': () => json(ROUTE),
      // Карточка предлагает заявки в состав рейса — сценарию они не нужны, но экран их спросит.
      'GET /vehicle-requests': () => json(emptyList()),
      // Ручка списка рейсов: она описана нарочно, чтобы проверять по счётчику, что список не
      // открывался, а не по отсутствию заголовка на экране.
      'GET /vehicle-routes': () => json(list([ROUTE])),
    });
    // Оба ключа сразу приносит собранный руками адрес или закладка, пережившая правку ссылок.
    renderScene('/vehicle-requests?route=route-1&routes=1');

    expect(await screen.findByText(/Маршрут Р-12/)).toBeDefined();
    // Побеждает `route`: просьба конкретнее. Лишний ключ снят нормализацией — в адресе его больше
    // нет, и «назад» не вернёт кадр с двумя окнами.
    await waitFor(() => expect(address()).toBe('/vehicle-requests?route=route-1'));
    expect(modalTitles()).not.toContain('Маршруты');
    expect(http.countOf('GET /vehicle-routes')).toBe(0);
  });

  it('параметры страницы под окном переживают его открытие и закрытие', async () => {
    mockHttp({
      'GET /vehicle-routes/:id': () => json(ROUTE),
      'GET /vehicle-requests': () => json(emptyList()),
    });
    /*
     * Под окном осталась страница со своей вкладкой и своим отбором. Ради этого окна и заводили:
     * прежний переход на вкладку «Маршруты» уносил и то, и другое, а обратная дорога начиналась с
     * восстановления фильтров руками.
     */
    renderScene('/vehicle-requests?tab=requests&kind=weekly&route=route-1');

    expect(await screen.findByText(/Маршрут Р-12/)).toBeDefined();

    fireEvent.click(document.querySelector('.ant-modal-close')!);

    await waitFor(() => expect(address()).toBe('/vehicle-requests?tab=requests&kind=weekly'));
    expect(modalTitles()).toEqual([]);
  });
});

describe('адрес окон: заявка уступает место рейсу', () => {
  it('переход к рейсу из самостоятельно открытой заявки вытесняет её одной записью истории', async () => {
    mockHttp({
      'GET /vehicle-requests/:id': () => json(REQUEST),
      'GET /vehicle-requests/:id/history': () => json([]),
      'GET /vehicle-requests/:id/waybills': () => json([]),
      'GET /vehicle-requests/:id/relocations': () => json([]),
      'GET /vehicle-routes/:id': () => json(ROUTE),
      'GET /vehicle-requests': () => json(emptyList()),
    });
    renderScene('/vehicle-requests?request=vr-1');

    // Заявка открыта сама по себе — так на неё приходят из журнала листов и из занятости гаража.
    expect(await screen.findByText('Заявка Т-42')).toBeDefined();

    const link = [...document.querySelectorAll<HTMLAnchorElement>('a.entity-link')].find(
      (el) => el.textContent === 'Р-12',
    );
    expect(link, 'ссылка на рейс в карточке заявки').toBeTruthy();
    fireEvent.click(link!);

    /*
     * Рейс встал **вместо** заявки, а не под неё: положи мы его под открытую заявку — окно
     * открылось бы невидимым, и клик по номеру выглядел бы как клик, который ни к чему не привёл.
     */
    await waitFor(() => expect(address()).toBe('/vehicle-requests?route=route-1'));
    expect(await screen.findByText(/Маршрут Р-12/)).toBeDefined();

    /*
     * И обе правки адреса — одной записью истории: два вызова подряд дали бы промежуточный кадр с
     * обоими параметрами, и «назад» возвращала бы в него, а не к заявке, из которой ушли. Проверяет
     * это ровно один шаг назад.
     */
    clickButton('проба: назад');
    await waitFor(() => expect(address()).toBe('/vehicle-requests?request=vr-1'));
    expect(await screen.findByText('Заявка Т-42')).toBeDefined();
  });
});

describe('адрес окон: «назад» уносит правку рейса вместе с её окном', () => {
  /**
   * Правка в адресе не отражается: это шаг внутри окна, а не место, куда ходят по ссылке. Отсюда и
   * опасность — форма живёт снаружи обоих окон, в состоянии держателя, и «назад» при открытой
   * правке оставила бы её висеть над пустой страницей, да ещё и с полями чужого рейса, открой
   * человек следом соседний.
   *
   * Дверей к правке две, закрываются они по-разному (`ownerRouteId`), поэтому проверяются обе.
   */
  const EDIT_TITLE = 'Маршрут Р-12 · правка';

  it('правка, открытая из карточки рейса, уходит вместе с карточкой', async () => {
    mockHttp({
      'GET /vehicle-routes/:id': () => json(ROUTE),
      'GET /vehicle-requests': () => json(emptyList()),
      // Форма правки подсказывает, кого посадить за руль (ADR 0064); сценарию список не важен.
      'GET /drivers/available': () =>
        json({ requiredCategory: null, requiredCategoryType: null, drivers: [] }),
    });
    // Рейс открывается кликом, а не начальным адресом: «назад» проверяется настоящей записью
    // истории, а не подменой адреса руками.
    renderScene('/vehicle-requests');

    clickButton('проба: открыть рейс');
    expect(await screen.findByText(/Маршрут Р-12/)).toBeDefined();

    clickButton('Редактировать');
    await waitFor(() => expect(modalTitles()).toContain(EDIT_TITLE));
    // Правка адреса не трогает: ссылку на неё не рассылают, и в закладке она означала бы «открыть
    // форму», а не «показать рейс».
    expect(address()).toBe('/vehicle-requests?route=route-1');

    clickButton('проба: назад');

    await waitFor(() => expect(address()).toBe('/vehicle-requests'));
    // Ушло окно, из которого правку позвали, — уходит и правка. Несохранённые поля теряются ровно
    // так же, как при закрытии окна крестиком.
    await waitFor(() => expect(modalTitles()).toEqual([]));
  });

  it('правка, открытая из строки списка рейсов, уходит вместе со списком', async () => {
    mockHttp({
      'GET /vehicle-routes': () => json(list([ROUTE])),
      // Фильтры списка: техника и водители полосой над таблицей.
      'GET /vehicles': () => json(list([{ id: 'v-own', modelName: 'КамАЗ 65201' } as never])),
      'GET /drivers': () => json(list([{ id: 'p-1', fullName: 'Иванов Иван Иванович' } as never])),
      'GET /drivers/available': () =>
        json({ requiredCategory: null, requiredCategoryType: null, drivers: [] }),
    });
    renderScene('/vehicle-requests');

    clickButton('проба: все маршруты');
    await waitFor(() => expect(address()).toBe('/vehicle-requests?routes=1'));
    expect(await screen.findByText('Р-12')).toBeDefined();

    /*
     * Дверь вторая: «переставить день» и «сменить водителя» — утренние действия диспетчера, ради
     * которых карточку рейса не открывают. У такой правки `route` в адресе нет вовсе, и владельцем
     * записан список — сравнивай держатель форму с адресом рейса, она закрылась бы в том же кадре,
     * в котором открылась.
     */
    fireEvent.click(document.querySelector('button[aria-label="Редактировать маршрут"]')!);
    await waitFor(() => expect(modalTitles()).toContain(EDIT_TITLE));

    clickButton('проба: назад');

    await waitFor(() => expect(address()).toBe('/vehicle-requests'));
    await waitFor(() => expect(modalTitles()).toEqual([]));
  });
});
