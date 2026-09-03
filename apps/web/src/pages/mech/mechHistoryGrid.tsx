import { Typography, type TableColumnsType } from 'antd';
import { EyeOutlined } from '@ant-design/icons';
import type { MechRequestDto } from '@technic/contracts';
import {
  mechDayLabel,
  mechMoney,
  mechRateLabel,
  mechRequesterLabel,
  mechTermLabel,
  mechWorkedLabel,
  MechPlaceCell,
  MechRateCell,
  MechRequesterCell,
  MechStateTag,
} from '@entities/mech-request';
import { actionsColumn, RowActionButton, type CardConfig } from '@shared/ui';

/**
 * Журнал закрытых аренд: колонки таблицы и карточка телефона (§7, вкладка 3).
 *
 * Набор колонок отвечает на вопросы, которые задают **после** аренды: у кого брали, по какой
 * ставке, сколько техника простояла на самом деле и во сколько это обошлось. Поэтому здесь нет
 * ответственного, файлов и комментария — они про ведение живой заявки, — зато есть три столбца,
 * которых нет нигде больше: факт возврата, отработанное и итоговая стоимость.
 *
 * **Срок и факт стоят рядом и не сливаются в один столбец**: расхождение между «по 18-е» и
 * «вернули 24-го» — это и есть то, ради чего журнал открывают, и склеенные в одну ячейку даты
 * пришлось бы читать по буквам.
 *
 * Прочерки в правой половине не означают потери данных: у отменённой заявки ни выдачи, ни
 * стоимости не бывает вовсе (Р8), и ноль на их месте читался бы как «отработали ноль часов
 * бесплатно».
 *
 * «Сегодня» этому набору не нужно, в отличие от соседних двух: остатка срока у закрытой аренды
 * нет — она кончилась, — и просрочка (Р12) к ней тоже не относится.
 */
export interface MechHistoryGridOptions {
  onOpen: (request: MechRequestDto) => void;
}

/** Пустое значение прочерком: «—» серым, а не пустой ячейкой, чтобы строка читалась целиком. */
function Dash() {
  return <Typography.Text type="secondary">—</Typography.Text>;
}

export function mechHistoryColumns(opts: MechHistoryGridOptions): TableColumnsType<MechRequestDto> {
  return [
    {
      // Номер первым: журнал читают по номеру — «а что там было с МХ-42», — в отличие от вкладки
      // присутствия, где строку узнают по площадке.
      key: 'num',
      title: '№',
      dataIndex: 'displayNumber',
      width: 110,
      sorter: true,
      render: (_v: unknown, r: MechRequestDto) => r.displayNumber,
    },
    {
      key: 'requesterName',
      title: 'Заявитель',
      dataIndex: 'departmentName',
      width: 180,
      sorter: true,
      render: (_v: unknown, r: MechRequestDto) => <MechRequesterCell row={r} />,
    },
    {
      // Площадка отдельно от заявителя (Р20): расходы относятся на отдел, а стояла техника на
      // объекте, и в журнале различие важнее, чем в рабочем списке, — по нему сводят затраты.
      key: 'objectName',
      title: 'Площадка',
      dataIndex: 'objectName',
      width: 200,
      sorter: true,
      render: (_v: unknown, r: MechRequestDto) => <MechPlaceCell row={r} />,
    },
    {
      key: 'kindName',
      title: 'Вид техники',
      dataIndex: 'kindName',
      width: 180,
      sorter: true,
    },
    {
      key: 'lessorName',
      title: 'Арендодатель',
      dataIndex: 'lessorName',
      width: 170,
      sorter: true,
      // Пусто — заявку отменили до договорённости: арендодателя у неё не было, а не «не выбран».
      render: (_v: unknown, r: MechRequestDto) => r.lessorName ?? <Dash />,
    },
    {
      key: 'rate',
      title: 'Ставка',
      dataIndex: 'rate',
      width: 130,
      align: 'right' as const,
      sorter: true,
      render: (_v: unknown, r: MechRequestDto) => (
        <MechRateCell rate={r.rate} rateUnit={r.rateUnit} />
      ),
    },
    {
      // Плановый срок целиком, а не одна его граница: в журнале он служит меркой, с которой
      // сравнивают факт в соседних столбцах.
      key: 'plannedTo',
      title: 'Срок по плану',
      dataIndex: 'plannedTo',
      width: 190,
      sorter: true,
      render: (_v: unknown, r: MechRequestDto) => mechTermLabel(r),
    },
    {
      key: 'actualFrom',
      title: 'Выдана',
      dataIndex: 'actualFrom',
      width: 120,
      sorter: true,
      render: (_v: unknown, r: MechRequestDto) =>
        r.actualFrom ? mechDayLabel(r.actualFrom) : <Dash />,
    },
    {
      key: 'actualTo',
      title: 'Возвращена',
      dataIndex: 'actualTo',
      width: 130,
      sorter: true,
      render: (_v: unknown, r: MechRequestDto) =>
        r.actualTo ? mechDayLabel(r.actualTo) : <Dash />,
    },
    {
      /*
       * Отработанное — всегда с единицей (Р7): часы и смены живут в одной колонке базы, и «120»
       * без слова рядом не значит ничего. Склонение — общее с заказом ТС, своей копии у модуля нет.
       */
      key: 'actualUnits',
      title: 'Отработано',
      dataIndex: 'actualUnits',
      width: 130,
      align: 'right' as const,
      sorter: true,
      render: (_v: unknown, r: MechRequestDto) => mechWorkedLabel(r.actualUnits, r.rateUnit),
    },
    {
      /*
       * Стоимость — та, что ввёл человек при завершении, а не расчёт портала (Р7): расхождение с
       * `ставка × количество` разбирают в окне завершения, а журнал показывает итог как он есть.
       */
      key: 'finalCost',
      title: 'Стоимость',
      dataIndex: 'finalCost',
      width: 150,
      align: 'right' as const,
      sorter: true,
      render: (_v: unknown, r: MechRequestDto) => mechMoney(r.finalCost),
    },
    {
      // Статус тегом, а причина отмены — подсказкой на нём: своего столбца ей не хватит ширины,
      // а без неё половина строк журнала не объясняет, почему у них пусто справа.
      key: 'status',
      title: 'Статус',
      dataIndex: 'status',
      width: 170,
      sorter: true,
      render: (_v: unknown, r: MechRequestDto) => <MechStateTag row={r} />,
    },
    actionsColumn<MechRequestDto>(
      (r) => (
        <RowActionButton
          title="Открыть карточку"
          icon={<EyeOutlined />}
          onClick={() => opts.onOpen(r)}
        />
      ),
      // Действие одно: закрытую заявку не ведут. Ход, продление и завершение живут там, где им
      // место, — в списке заявок и во вкладке «В аренде».
      80,
    ),
  ];
}

/**
 * Карточка закрытой аренды на телефоне (ADR 0030).
 *
 * Порядок строк — порядок вопросов к закрытой аренде: что брали, где стояло, у кого и почём,
 * сколько простояло на самом деле и во сколько обошлось. Пустые строки карточка не рисует вовсе,
 * поэтому у отменённой заявки её нижняя половина просто отсутствует — вместо ряда прочерков.
 */
export function mechHistoryCard(opts: MechHistoryGridOptions): CardConfig<MechRequestDto> {
  return {
    title: (r) => r.displayNumber,
    badge: (r) => <MechStateTag row={r} />,
    primary: (r) => r.kindName,
    lines: [
      (r) => r.objectName,
      (r) => (r.departmentId ? `Заявитель: ${mechRequesterLabel(r)}` : null),
      (r) => (r.lessorName ? `${r.lessorName} · ${mechRateLabel(r.rate, r.rateUnit)}` : null),
      (r) => `План: ${mechTermLabel(r)}`,
      (r) =>
        r.actualFrom
          ? `Факт: ${mechDayLabel(r.actualFrom)} — ${mechDayLabel(r.actualTo)}`
          : // Выдачи не было — это и есть ответ: заявку отменили до подачи, техника не выезжала.
            null,
      (r) =>
        r.actualUnits != null
          ? `Отработано: ${mechWorkedLabel(r.actualUnits, r.rateUnit)} · ${mechMoney(r.finalCost)}`
          : null,
      // Причина отмены — строкой: на телефоне подсказок нет, а без неё отменённая строка молчит.
      (r) => (r.cancelReason ? `Причина отмены: ${r.cancelReason}` : null),
    ],
    onOpen: opts.onOpen,
    actions: (r) => [
      {
        key: 'view',
        label: 'Открыть карточку',
        icon: <EyeOutlined />,
        onClick: () => opts.onOpen(r),
      },
    ],
  };
}
