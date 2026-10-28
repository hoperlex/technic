import { Space, Tag, Tooltip, Typography, type TableColumnType } from 'antd';
import {
  driverDocumentGapLabel,
  formatPhone,
  type GarageDriverDto,
  garageDriverStateColors,
  garageDriverStateLabels,
} from '@technic/contracts';
import { EntityLink, textColumn, type CardConfig } from '@shared/ui';
import { busyDayColumns, driverBusyLine, type useBusyExpand } from './busyColumns';
import { LicenseCell, licenseCardLine } from './licenseCell';
import { type useBusyRouteActions } from './shared';

/**
 * Чем строка водителя отвечает на десктопе (колонки таблицы) и на телефоне (карточка списка) —
 * гараж → «Водители» (ADR 0076).
 *
 * Собрано фабриками, а не константами: колонки замыкаются на раскрытие дня и право на показания,
 * карточка — на пункты рейсов, и всё это приходит аргументами от вкладки.
 *
 * Отдельным файлом, а не строками в `GarageDriversTab.tsx`: у вкладки бюджет длины
 * (`quality-budget.json`), и разметка ячеек с карточкой в него не помещались. Приём тот же, каким
 * разложены соседи (`busyColumns.tsx`, `maintenanceColumn.tsx`, `odometerColumn.tsx`): колонка
 * живёт рядом со своей ячейкой.
 */

/**
 * Ячейки строки — вровень по верху (`.garage-day-cell` в `styles.css`). Умолчание браузера для
 * ячейки таблицы — «по середине», и стоит «Рейсу/путевому листу» вырасти до трёх строк (номер,
 * бланк, «ещё 2»), как однострочная «Техника» уезжает в вертикальный центр: номер машины оказывается
 * не напротив номера рейса — то самое чтение поперёк, ради которого день и разложен на три графы.
 *
 * Класс идёт всем шести колонкам, а не только трём графам занятости: выравняв правую половину
 * строки, мы получили бы в ней два разных уровня — ФИО с удостоверением по середине, день по
 * верху, — а это заметнее исходной беды. Ставится он через `onCell`: своего `className` таблица
 * `DataTable` наружу не отдаёт, а ячейка чужие свойства принимает.
 *
 * Чужому `onCell` это не мешает: у всех шести колонок он свой единственный, затирать `NO_ROW_CLICK`
 * (класс ячейки, не отдающей клик строке) здесь нечего — да и отдавать некому: нажатие на строку
 * этой таблице не поручено вовсе, `onRowClick` у `DataTable` не задан.
 */
const TOP_CELL = () => ({ className: 'garage-day-cell' });

/**
 * Чего не хватает для листа: тег с расшифровкой — теми же словами, что в справочнике. Документ
 * назван своим именем (ADR 0095): за экскаватор садятся по удостоверению тракториста-машиниста, и
 * «нет действующего ВУ» отправило бы искать не ту бумагу.
 */
function gapsTag(r: GarageDriverDto) {
  if (r.gaps.length === 0) return null;
  return (
    <Tooltip
      title={r.gaps.map((gap) => driverDocumentGapLabel(gap, r.credentialTypeCode)).join('; ')}
    >
      <Tag color="orange" style={{ marginInlineEnd: 0 }}>
        документы: {r.gaps.length}
      </Tag>
    </Tooltip>
  );
}

/** Шесть колонок строки: три своих и три графы дня. Бюджет их ширин считает вкладка. */
export function driverColumns({
  expand,
  hrefOf,
  scheduleHref,
  on,
}: {
  /** Раскрытые дни: набор общий на три графы, поэтому и приходит снаружи (`useBusyExpand`). */
  expand: ReturnType<typeof useBusyExpand>;
  /** Адрес журнала показаний по машине; `null` — смотрящему цифры приборов не положены. */
  hrefOf: (vehicleId: string) => string | null;
  /** The address of the person's «График» window (`driverScheduleAddress.ts`). */
  scheduleHref: (personId: string) => string;
  /**
   * День среза: им меряется годность удостоверения. Приходит сверху, а не берётся «сегодня» —
   * гараж отвечает про выбранный день, и в пятничном срезе годность считается на пятницу.
   */
  on: string;
}): TableColumnType<GarageDriverDto>[] {
  return [
    {
      ...textColumn<GarageDriverDto>({
        key: 'fullName',
        title: 'Водитель',
        dataIndex: 'fullName',
        width: 300,
        render: (_v, r) => (
          // `display: flex` у обёртки не украшение: `Space` иначе inline-flex, ширина у него по
          // содержимому, и однострочному ФИО было бы не от чего отрезаться — оно вылезло бы в
          // соседнюю колонку вместо многоточия.
          <Space orientation="vertical" size={0} style={{ display: 'flex' }}>
            {/* ФИО — строго в одну строку: ячейка обязана остаться двухстрочной (имя и «таб. № …
                телефон»), иначе строки пляшут высотой от длины фамилии. Обрез отдан antd тем же
                приёмом, что у подписи машины (`BusyVehicleCell`), и подсказка у него всплывает по
                факту обреза: имя, поместившееся в 300 px, договаривать нечем, а на странице из 25
                строк безусловная подсказка — шум при каждом наведении. */}
            {/* The «График» link shares the name's line, so the cell stays two lines high; the
                name gives way to it (`minWidth: 0`) and is cut first. No column of its own: the
                table's width budget (see the tab) has no room for one. */}
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
              <Typography.Text ellipsis={{ tooltip: r.fullName }} style={{ flex: 1, minWidth: 0 }}>
                {r.fullName}
              </Typography.Text>
              <EntityLink to={scheduleHref(r.personId)} title="График смен за месяц">
                График
              </EntityLink>
            </div>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {[r.personnelNo ? `таб. № ${r.personnelNo}` : null, formatPhone(r.phone) || null]
                .filter(Boolean)
                .join(' · ')}
            </Typography.Text>
          </Space>
        ),
      }),
      // Снаружи `textColumn`: своего `onCell` он не принимает и не ставит — затирать нечего.
      onCell: TOP_CELL,
    },
    {
      // Удостоверением не сортируют: спрашивают его строкой — по какому документу выпишется лист
      // и годен ли он на этот день. Ячейка живёт рядом (`licenseCell.tsx`): подсветку негодности
      // она считает сама, и разметки в ней больше, чем колонки вокруг.
      key: 'license',
      title: 'Удостоверение',
      // 150 вместо прежних 190: категорий в графе больше нет, а 40 px ушли «Технике» — там подпись
      // машины делит строку с маркой. Бюджет ширин таблицы от этого не двигается (см. вкладку).
      width: 150,
      onCell: TOP_CELL,
      render: (_v, r) => <LicenseCell row={r} on={on} />,
    },
    {
      key: 'state',
      title: 'Состояние',
      width: 120,
      onCell: TOP_CELL,
      sorter: true,
      defaultSortOrder: 'ascend',
      render: (_v, r) => (
        <Space orientation="vertical" size={2}>
          <Tag color={garageDriverStateColors[r.state]} style={{ marginInlineEnd: 0 }}>
            {garageDriverStateLabels[r.state]}
          </Tag>
          {gapsTag(r)}
        </Space>
      ),
    },
    // Три графы дня — готовыми колонками (`busyDayColumns`): заголовки и ширины считаны под свои
    // ячейки и живут рядом с ними. Без права на показания номер машины остаётся текстом: `null` —
    // не «ссылку не нашли», а «смотрящему цифры приборов не положены», и ссылка вела бы в пустое
    // окно.
    ...busyDayColumns({
      expand,
      hrefOf,
      onCell: TOP_CELL,
    }),
  ];
}

/** Та же строка на телефоне: трёх граф дня там нет, и работы дня перечисляет сама карточка. */
export function driverCard({
  routeActions,
  openSchedule,
  on,
}: {
  /** Рейсы дня пунктами шита действий (`useBusyRouteActions`): хук зовёт вкладка. */
  routeActions: ReturnType<typeof useBusyRouteActions>;
  /** Opens the person's «График» window, the same window the row's link opens on a desktop. */
  openSchedule: (personId: string) => void;
  /** День среза — тот же, что у колонок: годность удостоверения меряется им (`licenseCardLine`). */
  on: string;
}): CardConfig<GarageDriverDto> {
  return {
    title: (r) => r.fullName,
    badge: (r) => (
      <Tag color={garageDriverStateColors[r.state]}>{garageDriverStateLabels[r.state]}</Tag>
    ),
    // Главная строка карточки — удостоверение: номер, срок и слово о негодности. Категорий здесь
    // нет по той же причине, что и в таблице, а негодность названа словом, а не цветом — цвет в
    // шапке карточки уже занят тегом состояния.
    primary: (r) => licenseCardLine(r, on),
    lines: [
      (r) => (r.busy.length === 0 ? 'на этот день ничего не назначено' : null),
      // Занятость строкой: на телефоне трёх граф нет, и машину называет сама строка
      // (`driverBusyLine`) — на десктопе на это отвечает графа «Техника» раскрытой строки.
      ...Array.from({ length: 3 }, (_, i) => (r: GarageDriverDto) => {
        const entry = r.busy[i];
        return entry ? driverBusyLine(entry) : null;
      }),
      (r) =>
        r.gaps.length === 0
          ? null
          : r.gaps.map((gap) => driverDocumentGapLabel(gap, r.credentialTypeCode)).join('; '),
    ],
    /*
     * The card's actions: the person's month first, then his routes of this day. Both live here
     * because the card opens nothing by itself (the list has no `onOpen`) and the day is shown as
     * text, so without them a phone could reach neither the month nor a route.
     *
     * The route items are the vehicles tab's (`useBusyRouteActions`): "what is route Р-12" is one
     * question reached from either side, the vehicle or the person driving it. The card's lines
     * name each route's vehicle, so numbers are not repeated in the labels.
     */
    actions: (r) => [
      { key: 'schedule', label: 'График', onClick: () => openSchedule(r.personId) },
      ...routeActions(r.busy),
    ],
  };
}
