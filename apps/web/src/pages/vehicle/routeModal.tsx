import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { App, Button, Skeleton } from 'antd';
import { Outlet, useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { VehicleRequestDto, VehicleRouteDto } from '@technic/contracts';
import { garageKeys } from '@entities/garage';
import { ViewModal } from '@shared/ui';
import { useOpenedRecord } from '@shared/lib';
import { vehicleRequestsApi, vehicleRoutesApi } from '../../api/resources';
import { useAuth } from '../../auth/AuthContext';
import { canOpenRoute } from '../../utils/links';
import { VehicleRequestViewModal } from './VehicleRequestViewModal';
import { VehicleRouteEditModal } from './VehicleRouteEditModal';
import { VehicleRouteModal } from './VehicleRouteModal';
import { VehicleRoutesModal } from './VehicleRoutesModal';

/**
 * Рейс, список рейсов и заявка — окнами поверх той страницы, где о них спросили (план
 * `docs/vehicle-routes-modal-plan.md`, ADR 0120).
 *
 * Вкладки «Маршруты» больше нет, и это не перестановка экранов. Вопрос «а что там за маршрут»
 * задают, стоя в строке заявки, в срезе гаража или в журнале листов, — и раньше ответ на него
 * стоил ухода с экрана, потери фильтров и обратной дороги. Держатель окон поэтому живёт над всеми
 * страницами портала (`App.tsx`), а места вызова знают о нём ровно три функции.
 *
 * Состояние окон — сам адрес, и ничего кроме: `openRoute` — это запись параметра. Продублируй его
 * React-состоянием, и «назад» разошлась бы с экраном на первом же переходе; а ссылку на рейс,
 * которую рассылают письмами и кладут в закладки, было бы неоткуда взять.
 */

/**
 * Имена параметров. Те же, что печатают `vehicleRoutePath`, `VEHICLE_ROUTES_PATH` и
 * `vehicleRequestViewPath` в контрактах: адрес собирают там (его печатает ещё и почта), а разбирают
 * здесь, и разойдись эти две стороны — ссылка из письма открывала бы пустую страницу.
 */
const ROUTE_PARAM = 'route';
const LIST_PARAM = 'routes';
const REQUEST_PARAM = 'request';

export interface RouteModalApi {
  /** Карточка рейса поверх текущей страницы. Заявку, если она открыта, вытесняет (см. ниже). */
  openRoute: (routeId: string) => void;
  /**
   * Список рейсов. `focusDate` — просьба встать на этот день: пришли из рейса позавчерашнего дня,
   * и список, оставшийся на сегодняшнем, этого рейса не показал бы вовсе.
   */
  openRoutesList: (options?: { focusDate?: string }) => void;
  /** Карточка заявки на чтение — ложится поверх рейса или списка, из которых её открыли. */
  openRequest: (requestId: string) => void;
  /**
   * Правка реквизитов рейса — окном поверх того, откуда её позвали: карточки рейса или строки
   * списка. Единственный метод контракта, который адреса не трогает вовсе: правка — шаг внутри
   * окна, а не место, куда ходят по ссылке (§3.1 плана).
   */
  editRoute: (route: VehicleRouteDto) => void;
}

/**
 * Экспортируется ради тестов — по той же причине, что и `AuthContext`: они подставляют заглушку
 * значением контекста, а не поднимают провайдер с настоящими окнами и запросами внутри.
 */
export const RouteModalContext = createContext<RouteModalApi | undefined>(undefined);

/**
 * Чем открыть рейс, список рейсов и заявку с любого экрана портала.
 *
 * Отсутствие контекста — ошибка монтажа, а не «нет прав»: провайдер стоит над всей веткой
 * `AppLayout`, и любая страница портала под ним. Молча проглоченный клик по номеру рейса читался
 * бы как поломка самого рейса, а не сборки приложения, — поэтому падаем громко.
 */
export function useRouteModal(): RouteModalApi {
  const ctx = useContext(RouteModalContext);
  if (!ctx) throw new Error('useRouteModal должен использоваться внутри RouteModalProvider');
  return ctx;
}

export function RouteModalProvider(): ReactElement {
  const [searchParams, setSearchParams] = useSearchParams();
  const { message } = App.useApp();
  const { can } = useAuth();
  const qc = useQueryClient();

  /**
   * Рейсом распоряжается тот же, кто ведёт заявки и видит водителя, — условие то же, что на ручках
   * рейсов и на ссылках, которые сюда ведут (`utils/links`). Заявка спрашивается отдельно: у
   * механика есть журнал листов и гараж, а заявок нет вовсе.
   */
  const mayOpenRoute = canOpenRoute(can);
  const mayOpenRequest = can('vehicleRequests.read');

  /** Рейс, названный в адресе: сюда приходят по ссылке из строки заявки, из письма, из закладки. */
  const openedRoute = useOpenedRecord<VehicleRouteDto>({
    /*
     * Без права запись не показать всё равно, а запрос успел бы уйти на сервер и вернуть отказ —
     * поверх сообщения о доступе легло бы второе, «Маршрут не найден», объясняющее не то.
     */
    active: mayOpenRoute,
    param: ROUTE_PARAM,
    notFoundMessage: 'Маршрут не найден',
    // Ключ общий с карточкой: рейс спрашивается один раз на двоих, react-query их склеит.
    queryKey: (id) => ['vehicle-routes', id],
    fetch: (id) => vehicleRoutesApi.get(id),
  });

  /**
   * Заявка, названная в адресе. «Не найдена **или недоступна**» — потому что сервер отвечает одним
   * 404 и на чужую область видимости, и на удалённую заявку без права архива: «не найдена» на
   * существующей заявке читалось бы как потеря данных.
   */
  const openedRequest = useOpenedRecord<VehicleRequestDto>({
    active: mayOpenRequest,
    param: REQUEST_PARAM,
    notFoundMessage: 'Заявка не найдена или недоступна',
    queryKey: (id) => ['vehicle-requests', id],
    fetch: (id) => vehicleRequestsApi.get(id),
  });

  const routeParam = searchParams.get(ROUTE_PARAM);
  const listParam = searchParams.get(LIST_PARAM);
  const requestParam = searchParams.get(REQUEST_PARAM);

  /**
   * Убрать свои параметры, не тронув чужие: под окном осталась страница со своей вкладкой, своей
   * открытой карточкой (`open`), своим номером и своими фильтрами, и все они обязаны пережить
   * открытие и закрытие окна. Отсюда функциональная форма — тем же приёмом правит адрес
   * `useOpenedRecord.clear`.
   *
   * Заменой записи в истории: «назад» после закрытия крестиком или Esc возвращает туда, откуда
   * пришли, а не открывает окно заново.
   */
  const dropParams = useCallback(
    (names: readonly string[]) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          for (const name of names) next.delete(name);
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  /*
   * Нормализация адреса, вход первый: `route` и `routes` взаимоисключающие. Собранный руками адрес
   * или старая закладка могут принести оба — побеждает `route`, просьба конкретнее. Лишний ключ
   * снимается здесь, одной веткой, а не проверкой у каждого места вызова.
   */
  useEffect(() => {
    if (!routeParam || listParam === null) return;
    dropParams([LIST_PARAM]);
  }, [routeParam, listParam, dropParams]);

  /*
   * Вход второй: право. Параметр снимается, окно не открывается, сообщение показывается — молча
   * исчезнувший из адреса ключ читается как поломка портала. Тот же путь отрабатывает потерю права
   * на лету: смена набора полномочий приходит обновлением сессии, и окно, открытое до неё, обязано
   * закрыться само.
   */
  useEffect(() => {
    if (mayOpenRoute || (!routeParam && listParam === null)) return;
    message.error('Маршруты вам недоступны');
    dropParams([ROUTE_PARAM, LIST_PARAM]);
  }, [mayOpenRoute, routeParam, listParam, message, dropParams]);

  useEffect(() => {
    if (mayOpenRequest || !requestParam) return;
    message.error('Заявки на технику вам недоступны');
    dropParams([REQUEST_PARAM]);
  }, [mayOpenRequest, requestParam, message, dropParams]);

  /**
   * Список открыт, только если карточки рейса в адресе нет: тот же инвариант 2, но посчитанный на
   * отрисовке. Ждать, пока адрес почистит эффект, нельзя — кадр с обоими окнами человек увидел бы
   * раньше нормализации.
   */
  const listOpen = mayOpenRoute && !routeParam && listParam !== null;

  /**
   * Куда встать списку при открытии. В адрес не пишется намеренно: это разовая просьба, а не
   * состояние, и в закладке она означала бы «всегда прыгать на этот день».
   *
   * Токен — счётчик вызовов, а не сама дата: список ставит период эффектом по нему, и повторное
   * «Все маршруты» с тем же днём обязано вернуть период на место, если его руками увели в другой
   * месяц. По значению даты второй такой вызов не сработал бы вовсе.
   */
  const [focus, setFocus] = useState<{ date?: string; token: number }>({ token: 0 });

  /**
   * Рейс, открытый на правку реквизитов, и окно, из которого её позвали (`ownerRouteId === null` —
   * список). В адресе правка не отражается, как и остальные дочерние окна — коррекция, перенос
   * талона, создание: это шаг внутри окна, а не место, куда ходят по ссылке.
   *
   * Владелец хранится вместе с рейсом, потому что дверей к правке две, и закрываются они по-разному
   * (см. эффект сброса ниже).
   */
  const [editing, setEditing] = useState<{
    route: VehicleRouteDto;
    ownerRouteId: string | null;
  } | null>(null);

  /**
   * Экран под окном после правки рейса устарел целиком, и обновляется он весь: рейс теперь правят,
   * стоя в журнале путевых листов или в срезе гаража, а не только в списке рейсов.
   *
   * Список заявок показывает номер рейса и предупреждение «без маршрута»; журнал листов — потому
   * что лист рождается ручкой рейса, а правка состава и даты переписывает уже выписанный;
   * гараж — потому что занятость машины и водителя на день это и есть рейсы.
   */
  const refresh = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ['vehicle-routes'] });
    void qc.invalidateQueries({ queryKey: ['vehicle-requests'] });
    void qc.invalidateQueries({ queryKey: ['waybills'] });
    void qc.invalidateQueries({ queryKey: garageKeys.root });
  }, [qc]);

  /**
   * Рейс поверх текущей страницы.
   *
   * Заявка уступает место рейсу: положи мы рейс под неё — окно открылось бы невидимым. Обе правки
   * идут **одной** записью `setSearchParams`: два вызова подряд дали бы промежуточный кадр с обоими
   * параметрами и лишнюю запись в истории, из-за которой «назад» возвращал бы в этот кадр, а не к
   * заявке, из которой ушли.
   *
   * История: `replace` только на переходе список → карточка — цикл «список ↔ карточка» иначе
   * раздувает её до бесконечности. Вытеснение заявки — `push`, один: «назад» обязано вернуть
   * заявку. Клик по номеру на обычной странице — тоже `push`: от «назад» здесь ждут закрытия окна.
   */
  const openRoute = useCallback(
    (routeId: string) => {
      const replace = !requestParam && listParam !== null;
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.delete(LIST_PARAM);
          next.delete(REQUEST_PARAM);
          next.set(ROUTE_PARAM, routeId);
          return next;
        },
        { replace },
      );
    },
    [listParam, requestParam, setSearchParams],
  );

  /**
   * Список рейсов. Заявку вытесняет по той же причине, что и карточка: «Все маршруты» зовут в том
   * числе из читалки заявки, и оставленная поверх заявка спрятала бы открытый список.
   *
   * История: `replace` на переходе карточка → список (тот же цикл) и на повторном фокусе при уже
   * открытом списке — адрес там не меняется вовсе, и новая запись была бы пустой. `push` — при
   * открытии с обычной страницы и при вытеснении заявки.
   */
  const openRoutesList = useCallback(
    (options?: { focusDate?: string }) => {
      setFocus((prev) => ({ date: options?.focusDate, token: prev.token + 1 }));
      const replace = !requestParam && (!!routeParam || listParam !== null);
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.delete(ROUTE_PARAM);
          next.delete(REQUEST_PARAM);
          next.set(LIST_PARAM, '1');
          return next;
        },
        { replace },
      );
    },
    [listParam, requestParam, routeParam, setSearchParams],
  );

  /**
   * Заявка на чтение. Ложится **поверх** рейса или списка, из которых её открыли, и потому их
   * параметры не трогает: «назад» обязано вернуть к рейсу, а не выкинуть на страницу под ним.
   */
  const openRequest = useCallback(
    (requestId: string) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        next.set(REQUEST_PARAM, requestId);
        return next;
      });
    },
    [setSearchParams],
  );

  /**
   * Правка реквизитов рейса: день, водитель, графы шапки.
   *
   * Дверей к ней две. Из карточки рейса — там правку и открывают, разобравшись в составе; и прямо
   * из строки списка, потому что «переставить день» и «сменить водителя» — утренние действия
   * диспетчера, ради которых открывать карточку незачем. Вторая дверь и есть причина, по которой
   * правка попала в контракт: окно живёт здесь, а зовут его снаружи.
   *
   * Замороженный выписанным листом рейс сюда не попадает, и проверять это здесь незачем:
   * `isRouteEditable` спрашивают оба места вызова, гася кнопку подсказкой `ROUTE_FROZEN_MESSAGE`,
   * и сама форма отказывается сохранять такой рейс. Третья копия правила дала бы третий ответ на
   * вопрос «правится ли рейс» и разошлась бы с остальными при первой же правке модели.
   */
  const editRoute = useCallback(
    // Владелец — то окно, что открыто сейчас: карточка называет себя идентификатором, список
    // (карточки в адресе нет) остаётся с `null`.
    (route: VehicleRouteDto) => setEditing({ route, ownerRouteId: openedRoute.id }),
    [openedRoute.id],
  );

  const api = useMemo<RouteModalApi>(
    () => ({ openRoute, openRoutesList, openRequest, editRoute }),
    [openRoute, openRoutesList, openRequest, editRoute],
  );

  /*
   * Ушло окно, из которого правку позвали, — уходит и правка. Дочерние окна карточки исчезают
   * вместе с ней сами (живут в её состоянии и умирают с монтажом), а правка живёт здесь, снаружи
   * обоих окон: «назад» при открытой форме оставила бы её висеть над пустой страницей — да ещё и с
   * полями чужого рейса, открой человек следом соседний. Несохранённые поля теряются ровно так же,
   * как при закрытии окна крестиком.
   *
   * Владельца обязательно спрашивать поимённо, и это главное здесь. У правки, открытой из строки
   * списка, `route` в адресе нет вовсе — сравнение с ним закрыло бы форму в том же кадре, в котором
   * её открыли. Поэтому список сверяется со своим признаком (`listOpen`), а карточка — со своим
   * идентификатором, который заодно ловит переключение на соседний рейс.
   */
  useEffect(() => {
    if (!editing) return;
    const alive =
      editing.ownerRouteId === null ? listOpen : editing.ownerRouteId === openedRoute.id;
    if (!alive) setEditing(null);
  }, [editing, listOpen, openedRoute.id]);

  const closeRoutesList = useCallback(() => dropParams([LIST_PARAM]), [dropParams]);

  return (
    <RouteModalContext.Provider value={api}>
      <Outlet />

      {/*
       * Условным монтажом, а не флагом `open`: `destroyOnHidden` чистит только тело `ViewModal`,
       * тогда как состояние дочерних окон — коррекция, перенос, добавление заявки, правка — живёт
       * снаружи него. Спрятанное окно оставило бы их взведёнными, и следующий рейс открылся бы с
       * чужим окном коррекции поверх.
       */}
      {listOpen && (
        <VehicleRoutesModal
          open
          onClose={closeRoutesList}
          focusDate={focus.date}
          focusToken={focus.token}
          onChanged={refresh}
        />
      )}

      {openedRoute.id && (
        <VehicleRouteModal
          routeId={openedRoute.id}
          onClose={openedRoute.clear}
          onChanged={refresh}
          onEdit={editRoute}
        />
      )}

      {editing && (
        <VehicleRouteEditModal
          route={editing.route}
          onClose={() => setEditing(null)}
          onSaved={(updated) => {
            setEditing(null);
            refresh();
            /*
             * Рейс, уехавший на другую дату, из периода списка пропадает — и человек должен
             * увидеть его там, куда перенёс, а не гадать, куда он делся. Только при открытом
             * списке: правку зовут и из карточки рейса, а она со списком взаимоисключающа —
             * «фокус» подменил бы списком то самое окно, в котором человек стоит.
             */
            if (listOpen) openRoutesList({ focusDate: updated.routeDate });
          }}
        />
      )}

      {openedRequest.id && (
        <RequestViewById requestId={openedRequest.id} onClose={openedRequest.clear} />
      )}
    </RouteModalContext.Provider>
  );
}

/**
 * Заявка окном: карточка списка принимает готовый DTO из строки, а здесь строки нет — есть один
 * идентификатор из адреса.
 *
 * Ключ запроса тот же, которым заявку грузят держатель адреса и вкладки, — сетевой запрос от этого
 * один. Разделение при этом честное: за ошибку и очистку адреса отвечает держатель (там же живёт
 * сообщение «не найдена или недоступна»), за показ — эта обёртка; ошибка снимет параметр, и окно
 * уйдёт вместе с ним.
 *
 * Режим чтения — это отсутствие действий: правка, смена техники, перенос в рейс, перегон, ЭСМ-2 и
 * решение по досрочному завершению приходят в карточку необязательными пропами, и не передать их
 * значит не показать. Один `readOnly` при этом всё же нужен — вкладку «Дни работ» линейного заказа
 * карточка монтирует сама, и её собственные кнопки планирования пропами не закрываются.
 */
function RequestViewById({
  requestId,
  onClose,
}: {
  requestId: string;
  onClose: () => void;
}): ReactElement {
  const { data } = useQuery({
    queryKey: ['vehicle-requests', requestId],
    queryFn: () => vehicleRequestsApi.get(requestId),
  });

  /*
   * Пока заявка грузится, окно уже открыто: идентификатор известен раньше записи, и ожидание
   * внутри окна честнее задержки его появления — иначе клик по номеру заявки полсекунды выглядит
   * как клик, который никуда не привёл.
   */
  if (!data) {
    return (
      <ViewModal
        title="Заявка"
        open
        onClose={onClose}
        width={1000}
        footer={<Button onClick={onClose}>Закрыть</Button>}
      >
        <Skeleton active paragraph={{ rows: 6 }} />
      </ViewModal>
    );
  }

  return <VehicleRequestViewModal request={data} onClose={onClose} readOnly />;
}
