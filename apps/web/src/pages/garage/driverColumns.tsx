import { Space, Tag, Tooltip, Typography, type TableColumnType } from 'antd';
import {
  driverDocumentGapLabel,
  formatPhone,
  type GarageDriverDto,
  garageDriverStateColors,
  garageDriverStateLabels,
} from '@technic/contracts';
import { textColumn, type CardConfig } from '@shared/ui';
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
  on,
}: {
  /** Раскрытые дни: набор общий на три графы, поэтому и приходит снаружи (`useBusyExpand`). */
  expand: ReturnType<typeof useBusyExpand>;
  /** Адрес журнала показаний по машине; `null` — смотрящему цифры приборов не положены. */
  hrefOf: (vehicleId: string) => string | null;
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
          <Space direction="vertical" size={0} style={{ display: 'flex' }}>
            {/* ФИО — строго в одну строку: ячейка обязана остаться двухстрочной (имя и «таб. № …
                телефон»), иначе строки пляшут высотой от длины фамилии. Обрез отдан antd тем же
                приёмом, что у подписи машины (`BusyVehicleCell`), и подсказка у него всплывает по
                факту обреза: имя, поместившееся в 300 px, договаривать нечем, а на странице из 25
                строк безусловная подсказка — шум при каждом наведении. */}
            <Typography.Text ellipsis={{ tooltip: r.fullName }}>{r.fullName}</Typography.Text>
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
        <Space direction="vertical" size={2}>
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
  on,
}: {
  /** Рейсы дня пунктами шита действий (`useBusyRouteActions`): хук зовёт вкладка. */
  routeActions: ReturnType<typeof useBusyRouteActions>;
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
     * Единственные действия карточки водителя — его рейсы этого дня, и заведены они здесь ровно
     * поэтому: своей карточки человек в гараже не открывает (`onOpen` у списка нет), занятость
     * показана строкой текста, и до сих пор с телефона нельзя было попасть в рейс никак —
     * оставалось искать его номер на десктопе.
     *
     * Пункты те же, что у техники (`useBusyRouteActions`): вопрос «что за рейс Р-12» один, а
     * пришли к нему с разных сторон — от машины или от человека за рулём. Машину каждого рейса
     * при этом называет строка карточки, так что номера в подписях не двоятся.
     */
    actions: (r) => routeActions(r.busy),
  };
}
