import { useEffect, useMemo, type CSSProperties, type ReactNode } from 'react';
import { Link, Outlet, useLocation, useNavigate, useSearchParams } from 'react-router';
import { App as AntApp, Button, ConfigProvider, DatePicker, Dropdown, type MenuProps } from 'antd';
import { KeyOutlined, LeftOutlined, LogoutOutlined, RightOutlined } from '@ant-design/icons';
import { useQueries } from '@tanstack/react-query';
import dayjs, { type Dayjs } from 'dayjs';
import {
  DRIVER_ASSIGNMENT_FUTURE_DAYS,
  DRIVER_ASSIGNMENT_PAST_DAYS,
  formatShortName,
} from '@technic/contracts';
import { MOSCOW_TZ } from '@shared/config';
import { useAuth } from '../../auth/AuthContext';
import { PortalLogo } from '../../components/PortalLogo';
import { UserAvatar } from '../../components/UserAvatar';
import { cabinetRead, driverCabinetApi, driverKeys } from './api';
import { clearUserDrafts, pruneDrafts } from './draftStore';
import { DRIVER_FONT_SCALE, DRIVER_NUMBER_SCALE, driverTheme } from './theme';

/**
 * Каркас кабинета водителя (ADR 0102, Р9–Р11; план driver-readings-first, Р4, Р5).
 *
 * Второй контур портала: ни боковой панели, ни нижней навигации, ни меню разделов — разделов у
 * роли `driver` нет вовсе. Всё, что кабинету нужно от каркаса, — три вещи из Р10: «где я во
 * времени» (выбор даты), «куда я могу перейти» (ссылка на вторую страницу дня) и «кто я» (меню
 * учётной записи). Обычный `AppLayout` пришлось бы обвешивать отрицаниями, а отрицания
 * разъезжаются с тем, что отрицают.
 *
 * Кнопки передачи показаний в шапке больше нет (Р4): кабинет открывается самой формой, и состояние
 * дня теперь называет строка над ней. Каркас поэтому не спрашивает ни задания, ни отчёта — кроме
 * прошедших дней, по которым считается долг (П4).
 */

const DATE_FORMAT = 'YYYY-MM-DD';

/**
 * Ширина колонки на планшете и десктопе: кабинет верстается под телефон и растягиваться не должен.
 * Экспортируется ради закреплённого подвала страницы показаний: он лежит во всю ширину экрана, а
 * кнопку держит в этой же колонке — второе число разъехалось бы с первой правкой.
 */
export const CONTENT_WIDTH = 720;

/**
 * «Сегодня» — по Москве, а не по часам устройства: граница суток у водителя из другого региона
 * разошлась бы с той, по которой сервер считает окно записи, и в полночь кнопка отказывала бы без
 * объяснения.
 */
export function driverToday(): string {
  return dayjs().tz(MOSCOW_TZ).format(DATE_FORMAT);
}

/**
 * Выбранная дата. Живёт в адресе, а не в состоянии: то, что нельзя переслать и нельзя обновить
 * страницей, на телефоне теряется первым (Р11). Отсутствие параметра означает «сегодня» — тогда
 * ссылка на кабинет не устаревает к следующему утру.
 *
 * Окно чтения держит сервер, но стрелки и календарь рисует портал: за границей окна ответом будет
 * отказ, а неработающая стрелка честнее отказа.
 */
export function useDriverDate() {
  const [params, setParams] = useSearchParams();
  const today = driverToday();
  const raw = params.get('date') ?? '';
  const min = dayjs(today).subtract(DRIVER_ASSIGNMENT_PAST_DAYS, 'day');
  const max = dayjs(today).add(DRIVER_ASSIGNMENT_FUTURE_DAYS, 'day');
  /*
   * Мусор в адресе и дата за окном чтения дают «сегодня», а не пустой экран: адрес приходит из
   * закладки, из письма и из чужого сообщения — портал обязан открыться при любом. Формат
   * проверяется выражением, а не строгим разбором dayjs: строгий режим живёт в плагине
   * `customParseFormat`, которого портал не подключает, и молча превратился бы в нестрогий.
   */
  const parsed = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? dayjs(raw) : null;
  const inWindow =
    parsed !== null &&
    parsed.isValid() &&
    !parsed.isBefore(min, 'day') &&
    !parsed.isAfter(max, 'day');
  const date = parsed !== null && inWindow ? parsed.format(DATE_FORMAT) : today;

  const setDate = (next: string) => {
    const nextParams = new URLSearchParams(params);
    // Сегодняшний день параметра не получает: адрес «/driver» остаётся адресом сегодняшнего дня.
    if (next === today) nextParams.delete('date');
    else nextParams.set('date', next);
    setParams(nextParams, { replace: true });
  };

  return { date, today, min, max, setDate };
}

/**
 * Подпись дня. «Сегодня» и «Вчера» — словом и без числа: по ним и ориентируются, а число этого же
 * дня стоит заголовком над формой, двумя строками ниже и крупным шрифтом. Года нет ни у одной
 * подписи: окно чтения — считаные дни вокруг сегодняшнего, различать в нём нечего, а места год
 * занимает больше всех — при крупном шрифте кабинета (план типографики, Р2) он вытеснял бы из
 * шапки саму дату.
 */
function dateLabel(value: Dayjs, today: string): string {
  const iso = value.format(DATE_FORMAT);
  if (iso === today) return 'Сегодня';
  if (iso === dayjs(today).subtract(1, 'day').format(DATE_FORMAT)) return 'Вчера';
  return value.format('dd, D MMM');
}

const headerStyle: CSSProperties = {
  position: 'sticky',
  top: 0,
  zIndex: 10,
  background: '#fff',
  borderBottom: '1px solid rgba(0, 0, 0, 0.06)',
  paddingTop: 'var(--safe-top)',
};

const rowStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 4,
  maxWidth: CONTENT_WIDTH,
  margin: '0 auto',
  padding: '4px calc(8px + var(--safe-right)) 4px calc(8px + var(--safe-left))',
};

/** Тач-цель 44×44 при аватаре 24: попасть пальцем важнее, чем сэкономить полоску экрана. */
const accountButtonStyle: CSSProperties = {
  flex: '0 0 auto',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 44,
  height: 44,
  padding: 0,
  border: 'none',
  borderRadius: '50%',
  background: 'transparent',
  cursor: 'pointer',
};

/**
 * Каркас кабинета: масштаб шрифта приходит переменной из TS-константы (Р1), а не правкой каждого
 * компонента. Переменные CSS в инлайновом стиле React пропускает как есть, а `CSSProperties` о них
 * не знает — отсюда приведение типа, и другого способа у React нет.
 */
const shellStyle = {
  minHeight: '100dvh',
  display: 'flex',
  flexDirection: 'column',
  '--driver-scale': DRIVER_FONT_SCALE,
  '--driver-number-scale': DRIVER_NUMBER_SCALE,
} as CSSProperties;

/** Стрелки дня: значок крупнее подписи, тач-цель 48 приходит `controlHeight` темы кабинета. */
const arrowIconStyle: CSSProperties = { fontSize: '1.1em' };

/**
 * Сколько прошедших дней окна записи проверяется на долг (П4). Три, а не все восемь: каждый день
 * стоит двух запросов — отчёта и задания, — и вход в кабинет по сотовой связи в поле дороже
 * полноты списка. Ближайший долг и есть тот, который водитель ещё закрывает сам; про долг
 * недельной давности ему уже сказал диспетчер.
 *
 * Сегодняшний день в проверку не входит намеренно: смена ещё идёт, показания снимают в конце, и
 * «не сдано за сегодня» в шапке было бы упрёком за несделанное вовремя.
 */
const PENDING_DAYS_CHECKED = 3;

/**
 * Прошедшие дни, по которым показания не переданы, от ближайшего к дальнему (П4). Сейчас водитель
 * узнаёт о долге только от диспетчера — а закрыть его можно лишь пока день не вышел из окна записи.
 *
 * Задание спрашивается вместе с отчётом, и это не перестраховка: отчёта нет и у выходного — его
 * заводит показ формы показаний, а в выходной её не открывали. Без задания портал не отличил бы
 * долг от дня отдыха и кричал бы «не сдано» каждый понедельник; ложная тревога учит не смотреть на
 * строку вовсе.
 *
 * Ключи запросов те же, что у экрана дня, и это единственное, чем строка обновляется: отчёт живёт
 * в `driverKeys.report(date)` одним кэшем (Р8), и успешная отправка кладёт свой ответ прямо туда.
 * Прежде день переставал считаться незакрытым от корневой инвалидации — то есть от лишнего чтения
 * того, что портал уже получил ответом; теперь строка пересчитывается по тому же снимку, который
 * показывает форма, и разъехаться им нечем.
 *
 * `shown` — день, открытый в кабинете прямо сейчас; ему настройки чтения достаются урезанные, и
 * причина в том же одном кэше. По показанному дню уходят `open` и `submit`, а страница на время их
 * полёта выключает свои чтения — этим и держится Р7: единственный писатель кэша в полёте — сама
 * мутация. Строка долга — **второй** наблюдатель того же ключа, и про гейт она не знает ничего:
 * обновись она по возврату в приложение или по восстановленной связи (а рвётся связь ровно тогда,
 * когда отправка в пути), снимок «до» лёг бы поверх свежего ответа — и следующая отправка получила
 * бы 409 по устаревшей версии. Читать этот день строке и незачем: кэш общий, и держит его свежим
 * страница, у которой гейт есть.
 */
function usePendingDays(today: string, shown: string): string[] {
  const dates = useMemo(
    () =>
      Array.from({ length: PENDING_DAYS_CHECKED }, (_, index) =>
        dayjs(today)
          .subtract(index + 1, 'day')
          .format(DATE_FORMAT),
      ),
    [today],
  );
  /** Общие настройки чтения кабинета (Р7) — кроме показанного дня: его читает сама страница. */
  const read = (date: string) =>
    date === shown
      ? { ...cabinetRead, refetchOnWindowFocus: false as const, refetchOnReconnect: false as const }
      : cabinetRead;
  const reports = useQueries({
    queries: dates.map((date) => ({
      queryKey: driverKeys.report(date),
      queryFn: () => driverCabinetApi.report(date),
      ...read(date),
    })),
  });
  const assignments = useQueries({
    queries: dates.map((date) => ({
      queryKey: driverKeys.assignment(date),
      queryFn: () => driverCabinetApi.assignment(date),
      ...read(date),
    })),
  });

  return dates.filter((_, index) => {
    const assignment = assignments[index];
    const report = reports[index];
    // Пока ответ не пришёл, дня в списке нет: строка, мигнувшая и пропавшая, читается как сбой.
    if (!assignment?.isSuccess || !report?.isSuccess) return false;
    if (assignment.data.entries.length === 0) return false;
    // `null` — форму дня не открывали вовсе, `draft` — открыли и не отправили. Прочие состояния
    // водителя не ждут: принятый и повторно принимаемый ведёт персонал, аннулированный закрыт.
    return report.data === null || report.data.state === 'draft';
  });
}

/**
 * Подпись строки долга. Числа дней в ней нет намеренно: «2 дня» и «5 дней» требуют склонения ради
 * строки, которую всё равно читают как «долг есть, вот ближайший день».
 */
function pendingLabel(nearest: string, count: number): string {
  const day = dayjs(nearest).format('D MMM');
  return count > 1 ? `Не переданы показания за ${day} и раньше` : `Не переданы показания за ${day}`;
}

export function DriverLayout({ children }: { children?: ReactNode }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const { date, today, min, max, setDate } = useDriverDate();
  const { pathname } = useLocation();

  // Уборка по TTL — при входе в кабинет: фонового процесса у портала нет, а неделю пролежавшие
  // чужие показания на общем телефоне не должны дожидаться следующего открытия того же дня.
  // Чистятся оба формата черновика: прежняя сборка про ключи нынешнего не знает вовсе (Р11б).
  useEffect(() => pruneDrafts(), []);

  const userMenu: MenuProps = {
    items: [
      { key: 'change-password', icon: <KeyOutlined />, label: 'Сменить пароль' },
      { type: 'divider' },
      { key: 'logout', icon: <LogoutOutlined />, label: 'Выйти', danger: true },
    ],
    onClick: ({ key }) => {
      if (key === 'change-password') navigate('/change-password');
      if (key === 'logout') {
        // Черновики принадлежат учётке: телефон в бригаде общий, и следующий вошедший не должен
        // получить ни чужих показаний, ни ссылок на чужие файлы (Р14) — и это одно из трёх мест,
        // где черновик вообще удаляется: успешная отправка, TTL и выход (Р10).
        if (user) clearUserDrafts(user.id);
        void logout().then(() => navigate('/login'));
      }
    },
  };

  const current = dayjs(date);
  const shift = (days: number) => setDate(current.add(days, 'day').format(DATE_FORMAT));
  /*
   * Вторая страница того же дня (Р5). Дата едет с переходом параметром — кроме сегодняшней:
   * «/driver» и «/driver/assignment» без параметра означают сегодня, и такая ссылка не устареет к
   * следующему утру. Признак страницы берётся из адреса, а не из свойства: каркас подключается и
   * вложенным маршрутом, и обёрткой, и во втором случае про детей он не знает ничего.
   */
  const dateParam = date === today ? '' : `?date=${date}`;
  const other = pathname.endsWith('/assignment')
    ? { to: `/driver${dateParam}`, label: 'Показания' }
    : { to: `/driver/assignment${dateParam}`, label: 'Задание' };
  const pending = usePendingDays(today, date);
  const nearestPending = pending[0];

  /*
   * Тема кабинета (план типографики, Р1) — здесь, в каркасе, а не на странице показаний: у кабинета
   * две страницы одного дня, и разъехаться им размером нельзя. Портальную тему она не заменяет, а
   * дополняет: цвета, скругления и локаль приходят от корневого `ConfigProvider` сами.
   *
   * Вложенный `App` рядом с ней — ради сообщений: `App.useApp()` страницы показаний берёт ближайший
   * контекст, и без него отказ хранилища и «Показания переданы» остались бы портальными 16 px
   * посреди экрана, набранного двадцатым. Узел ему нужен свой: в antd 6 включён `cssVar`, и при
   * `component={false}` класс с переменными темы вешать не на что — вложенный `App` оставался без
   * `driverTheme`, а сообщения кабинета снова набирались портальным размером. Отсюда
   * `component="div"` со `style={{ display: 'contents' }}`: узел для класса есть, а лишнего блока
   * между `main` и высотой в 100dvh, на которой держится закреплённый подвал, он не заводит —
   * коробки у такого элемента нет вовсе, дети встают в поток родителя.
   */
  return (
    <ConfigProvider theme={driverTheme}>
      <AntApp component="div" style={{ display: 'contents' }}>
        <div className="driver-shell" style={shellStyle}>
          <header style={headerStyle}>
            <div style={rowStyle}>
              {/* Логотип — ссылка на «сегодня»: единственный способ вернуться из просмотра прошлой
              недели одним нажатием, и он же привычен по основному порталу. */}
              <Link to="/driver" aria-label="Сегодня" style={{ display: 'flex', padding: 8 }}>
                <PortalLogo size={28} />
              </Link>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  flex: '1 1 auto',
                  justifyContent: 'center',
                }}
              >
                <Button
                  type="text"
                  icon={<LeftOutlined style={arrowIconStyle} />}
                  aria-label="Предыдущий день"
                  disabled={!current.isAfter(min, 'day')}
                  onClick={() => shift(-1)}
                />
                {/* Подпись дня — она же вход в календарь (Р10): отдельная кнопка «календарь» отняла бы
                у шапки место, а сама подпись — самая крупная цель в ней. Ввод с клавиатуры закрыт
                (`inputReadOnly`): на телефоне она перекрыла бы половину экрана ради даты, которую
                всё равно выбирают тычком.

                Размер и вес подписи — классом, а не стилем: `style` ложится на корень пикера, а
                величину текста задаёт внутреннее поле ввода, и до него он не доходит. Ширина
                гибкая: фиксированные 168 px при крупном шрифте (план типографики, Р2) обрезали бы
                самую длинную из подписей — «вт, 19 авг». */}
                <DatePicker
                  className="driver-date"
                  value={current}
                  onChange={(value) => value && setDate(value.format(DATE_FORMAT))}
                  format={(value) => dateLabel(value, today)}
                  allowClear={false}
                  inputReadOnly
                  suffixIcon={null}
                  variant="borderless"
                  minDate={min}
                  maxDate={max}
                  style={{ flex: '1 1 auto', minWidth: 0 }}
                />
                <Button
                  type="text"
                  icon={<RightOutlined style={arrowIconStyle} />}
                  aria-label="Следующий день"
                  disabled={!current.isBefore(max, 'day')}
                  onClick={() => shift(1)}
                />
              </div>
              <Dropdown menu={userMenu} trigger={['click']} placement="bottomRight">
                <button type="button" style={accountButtonStyle} aria-label="Учётная запись">
                  <UserAvatar name={user ? formatShortName(user) : undefined} size="small" />
                </button>
              </Dropdown>
            </div>
            {/* Переход между двумя половинами дня (Р5): показания вводят, задание читают. Ссылка во
            всю ширину и на обеих страницах — задание ушло с глаз, и незаметная ссылка прочиталась
            бы как «адреса из кабинета пропали». */}
            <div style={{ ...rowStyle, paddingTop: 0, paddingBottom: 8 }}>
              <Link className="driver-nav" to={other.to}>
                {other.label}
              </Link>
            </div>
            {/* Долг по прошлым дням — одной строкой и ссылкой на ближайший из них (П4): день,
            вышедший из окна записи, водитель уже не закроет сам. */}
            {nearestPending && (
              <div style={{ ...rowStyle, paddingTop: 0, paddingBottom: 8 }}>
                <Link className="driver-pending" to={`/driver?date=${nearestPending}`}>
                  {pendingLabel(nearestPending, pending.length)}
                </Link>
              </div>
            )}
          </header>

          <main
            style={{
              flex: '1 1 auto',
              width: '100%',
              maxWidth: CONTENT_WIDTH,
              margin: '0 auto',
              padding:
                '12px calc(12px + var(--safe-right)) calc(16px + var(--safe-bottom)) calc(12px + var(--safe-left))',
            }}
          >
            {/* Маршрут подключается снаружи, и подключить его можно двумя способами: вложенным
            маршрутом (`Outlet`) и обёрткой вокруг страницы. Каркас поддерживает оба — иначе выбор
            того, кто подключает маршрут, ломал бы кабинет. */}
            {children ?? <Outlet />}
          </main>
        </div>
      </AntApp>
    </ConfigProvider>
  );
}
