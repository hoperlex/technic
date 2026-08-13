import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import { Link, Outlet, useNavigate, useSearchParams } from 'react-router';
import { Button, DatePicker, Dropdown, Tooltip, type MenuProps } from 'antd';
import { KeyOutlined, LeftOutlined, LogoutOutlined, RightOutlined } from '@ant-design/icons';
import { useQueries, useQuery } from '@tanstack/react-query';
import dayjs, { type Dayjs } from 'dayjs';
import {
  DRIVER_ASSIGNMENT_FUTURE_DAYS,
  DRIVER_ASSIGNMENT_PAST_DAYS,
  DRIVER_SUBMIT_PAST_DAYS,
  formatShortName,
  type DriverReportDto,
} from '@technic/contracts';
import { MOSCOW_TZ } from '@shared/config';
import { useAuth } from '../../auth/AuthContext';
import { PortalLogo } from '../../components/PortalLogo';
import { UserAvatar } from '../../components/UserAvatar';
import { clearUserDrafts, driverCabinetApi, driverKeys, loadDraft, pruneDrafts } from './api';
import { DriverReadingsSheet } from './DriverReadingsSheet';
import { DRIVER_FONT_SCALE } from './readingLimits';

/**
 * Каркас кабинета водителя (ADR 0102, Р9–Р11).
 *
 * Второй контур портала: ни боковой панели, ни нижней навигации, ни меню разделов — разделов у
 * роли `driver` нет вовсе. Всё, что кабинету нужно от каркаса, — три вещи из Р10: «где я во
 * времени» (выбор даты), «что я должен сделать» (кнопка передачи показаний) и «кто я» (меню
 * учётной записи). Обычный `AppLayout` пришлось бы обвешивать отрицаниями, а отрицания
 * разъезжаются с тем, что отрицают.
 */

const DATE_FORMAT = 'YYYY-MM-DD';

/** Ширина колонки на планшете и десктопе: кабинет верстается под телефон и растягиваться не должен. */
const CONTENT_WIDTH = 720;

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

/** Подпись дня. «Сегодня» и «Вчера» стоят впереди даты: по ним и ориентируются, а не по числу. */
function dateLabel(value: Dayjs, today: string): string {
  const iso = value.format(DATE_FORMAT);
  if (iso === today) return `Сегодня, ${value.format('D MMM')}`;
  if (iso === dayjs(today).subtract(1, 'day').format(DATE_FORMAT))
    return `Вчера, ${value.format('D MMM')}`;
  return value.format('dd, D MMM YYYY');
}

/** Состояние кнопки шапки: подпись, доступность и объяснение, почему нажать нельзя. */
interface SubmitButton {
  label: string;
  disabled: boolean;
  hint: string;
}

/**
 * Кнопка называет состояние отчёта дня (Р10), а не действие: «Передать» и «Передано» — разные
 * новости, и человек, закрывший день, должен видеть это, не открывая оверлей.
 *
 * После приёмки водитель отчёт не правит (Р23): правки вносит персонал, и кнопка это говорит.
 */
function submitButtonState(
  report: DriverReportDto | null | undefined,
  hasLocalDraft: boolean,
  canSubmit: boolean,
): SubmitButton {
  if (report?.state === 'accepted')
    return {
      label: 'Принято',
      disabled: true,
      hint: 'Показания приняты — правки вносит диспетчер',
    };
  if (report?.state === 'needs_reacceptance')
    return {
      label: 'На повторном приёме',
      disabled: true,
      hint: 'День уже принимали — правки вносит диспетчер',
    };
  if (report?.state === 'voided')
    return { label: 'Аннулирован', disabled: true, hint: 'Отчёт этого дня аннулирован' };
  if (!canSubmit)
    return {
      label: 'Передать показания',
      disabled: true,
      hint: `Показания принимаются за сегодня и ${DRIVER_SUBMIT_PAST_DAYS} предыдущих дней`,
    };
  if (report?.state === 'submitted')
    return { label: 'Передано', disabled: false, hint: 'Можно поправить, пока день не приняли' };
  if (hasLocalDraft || report?.state === 'draft')
    return { label: 'Черновик', disabled: false, hint: 'Заполнено, но не передано' };
  return { label: 'Передать показания', disabled: false, hint: '' };
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
} as CSSProperties;

/**
 * Сколько прошедших дней окна записи проверяется на долг (П4). Три, а не все восемь: каждый день
 * стоит двух запросов — отчёта и задания, — и вход в кабинет по сотовой связи в поле дороже
 * полноты списка. Ближайший долг и есть тот, который водитель ещё закрывает сам; про долг
 * недельной давности ему уже сказал диспетчер.
 *
 * Сегодняшний день в проверку не входит намеренно: смена ещё идёт, показания снимают в конце, и
 * «не сдано за сегодня» над кнопкой «Передать показания» было бы упрёком за несделанное вовремя.
 */
const PENDING_DAYS_CHECKED = 3;

/**
 * Прошедшие дни, по которым показания не переданы, от ближайшего к дальнему (П4). Сейчас водитель
 * узнаёт о долге только от диспетчера — а закрыть его можно лишь пока день не вышел из окна записи.
 *
 * Задание спрашивается вместе с отчётом, и это не перестраховка: отчёта нет и у выходного — его
 * заводит открытие оверлея, а в выходной оверлей не открывали. Без задания портал не отличил бы
 * долг от дня отдыха и кричал бы «не сдано» каждый понедельник; ложная тревога учит не смотреть на
 * строку вовсе. Ключи запросов те же, что у экрана дня: уже открытый день второй раз не
 * запрашивается, а отправка показаний сбрасывает весь корень кабинета — строка обновится сама.
 */
function usePendingDays(today: string): string[] {
  const dates = useMemo(
    () =>
      Array.from({ length: PENDING_DAYS_CHECKED }, (_, index) =>
        dayjs(today)
          .subtract(index + 1, 'day')
          .format(DATE_FORMAT),
      ),
    [today],
  );
  const reports = useQueries({
    queries: dates.map((date) => ({
      queryKey: driverKeys.report(date),
      queryFn: () => driverCabinetApi.report(date),
    })),
  });
  const assignments = useQueries({
    queries: dates.map((date) => ({
      queryKey: driverKeys.assignment(date),
      queryFn: () => driverCabinetApi.assignment(date),
    })),
  });

  return dates.filter((_, index) => {
    const assignment = assignments[index];
    const report = reports[index];
    // Пока ответ не пришёл, дня в списке нет: строка, мигнувшая и пропавшая, читается как сбой.
    if (!assignment?.isSuccess || !report?.isSuccess) return false;
    if (assignment.data.entries.length === 0) return false;
    // `null` — оверлей не открывали вовсе, `draft` — открыли и не отправили. Прочие состояния
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
  const [sheetOpen, setSheetOpen] = useState(false);

  // Уборка по TTL — при входе в кабинет: фонового процесса у портала нет, а неделю пролежавшие
  // чужие показания на общем телефоне не должны дожидаться следующего открытия того же дня.
  useEffect(() => pruneDrafts(), []);

  const assignment = useQuery({
    queryKey: driverKeys.assignment(date),
    queryFn: () => driverCabinetApi.assignment(date),
  });
  const report = useQuery({
    queryKey: driverKeys.report(date),
    queryFn: () => driverCabinetApi.report(date),
  });

  /**
   * Черновик лежит в localStorage, и об его изменении React не извещает — поэтому он перечитывается
   * на каждом рендере, а не запоминается. Своё состояние здесь пришлось бы держать в согласии с
   * хранилищем, которое пишет оверлей: два источника одной правды разошлись бы на первой же
   * отправке, и кнопка осталась бы «Черновиком» над уже переданным днём.
   */
  const hasLocalDraft = user ? loadDraft(user.id, date) !== null : false;

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
        // получить ни чужих показаний, ни ссылок на чужие файлы (Р14).
        if (user) clearUserDrafts(user.id);
        void logout().then(() => navigate('/login'));
      }
    },
  };

  const current = dayjs(date);
  const entries = assignment.data?.entries ?? [];
  const button = submitButtonState(report.data, hasLocalDraft, assignment.data?.canSubmit ?? false);
  const shift = (days: number) => setDate(current.add(days, 'day').format(DATE_FORMAT));
  const pending = usePendingDays(today);
  const nearestPending = pending[0];

  return (
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
              icon={<LeftOutlined />}
              aria-label="Предыдущий день"
              disabled={!current.isAfter(min, 'day')}
              onClick={() => shift(-1)}
            />
            {/* Подпись дня — она же вход в календарь (Р10): отдельная кнопка «календарь» отняла бы
                у шапки место, а сама подпись — самая крупная цель в ней. Ввод с клавиатуры закрыт
                (`inputReadOnly`): на телефоне она перекрыла бы половину экрана ради даты, которую
                всё равно выбирают тычком. */}
            <DatePicker
              value={current}
              onChange={(value) => value && setDate(value.format(DATE_FORMAT))}
              format={(value) => dateLabel(value, today)}
              allowClear={false}
              inputReadOnly
              suffixIcon={null}
              variant="borderless"
              minDate={min}
              maxDate={max}
              style={{ width: 168, textAlign: 'center' }}
            />
            <Button
              type="text"
              icon={<RightOutlined />}
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
        {/* День без задания кнопки не заслуживает: передавать по нему нечего, а кнопка, которая
            ничего не откроет, читается как поломка (Р10). */}
        {entries.length > 0 && (
          <div style={{ ...rowStyle, paddingTop: 0, paddingBottom: 8 }}>
            <Tooltip title={button.hint}>
              <div style={{ width: '100%' }}>
                <Button
                  type="primary"
                  size="large"
                  block
                  // Пока состояние отчёта неизвестно, кнопка ждёт: открыть оверлей над днём,
                  // который уже приняли, значило бы показать правку там, где её не примут.
                  loading={report.isPending}
                  disabled={button.disabled}
                  onClick={() => setSheetOpen(true)}
                >
                  {button.label}
                </Button>
              </div>
            </Tooltip>
          </div>
        )}
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

      {user && (
        <DriverReadingsSheet
          open={sheetOpen}
          date={date}
          userId={user.id}
          onClose={() => setSheetOpen(false)}
        />
      )}
    </div>
  );
}
