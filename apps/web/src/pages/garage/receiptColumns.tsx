import type { ReactNode } from 'react';
import { Space, Tag, Tooltip, Typography, type TableColumnType } from 'antd';
import { PaperClipOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import type { AutoPartReceiptDeletionDto, AutoPartReceiptListItemDto } from '@technic/contracts';
import { textColumn, type CardConfig } from '@shared/ui';
import { formatMoney } from '../../utils/format';

/**
 * Как лента чеков выглядит списком: колонки таблицы и карточка строки на телефоне (план
 * `docs/auto-part-receipts-plan.md`, §8).
 *
 * Отдельным модулем от самой вкладки: там остаётся работа с данными — отбор, запросы, сводка и
 * окна, — а описание представления читается целиком, не пролистывая их. Обе фабрики принимают
 * действия, а не берут их из контекста: строка одинакова и в таблице, и в карточке, и различать
 * их должно одно место.
 *
 * Ничего здесь не считается. `total` — сумма строк, посчитанная сервером (Р11), `vehiclesLabel` —
 * готовая подпись «первые машины и ещё N» (§6): собери её портал сам, правило «как называется
 * машина» жило бы в каждом экране заново, а лента и карточка чека называли бы одну машину
 * по-разному.
 */

const SHOWN_DATE = 'DD.MM.YYYY';

/** Прочерк там, где значения нет: пустую ячейку читают как недоделку, а не как «не заполняли». */
const dash = <Typography.Text type="secondary">—</Typography.Text>;

/**
 * Тег пометки на удаление (Р12). Пометка ничего не прячет и ничего не пересчитывает — она говорит
 * одно: «этот чек предлагается удалить, вот почему», — поэтому причина и автор стоят подсказкой на
 * самом теге: в колонку они не помещаются, а очередь администратора без них — список без просьб.
 */
export function receiptDeletionTag(deletion: AutoPartReceiptDeletionDto): ReactNode {
  const asked = `${dayjs(deletion.requestedAt).format(SHOWN_DATE)} — ${deletion.requestedByName}`;
  return (
    <Tooltip title={`${asked}: ${deletion.reason}`}>
      <Tag color="orange" style={{ marginInlineEnd: 0 }}>
        К удалению
      </Tag>
    </Tooltip>
  );
}

/** Скрепка со счётом: файлов у чека всегда хотя бы один (Р6), поэтому число, а не признак. */
function filesCell(filesCount: number): ReactNode {
  return (
    <Tooltip title={`Сканов: ${filesCount}`}>
      <Space size={4}>
        <PaperClipOutlined />
        {filesCount}
      </Space>
    </Tooltip>
  );
}

/**
 * Машины чека одной строкой. Пусто — законное состояние (Р8): весь чек не отнесён ни к одной
 * машине, и это общий инструмент или расходники гаража, а не незаполненное поле. Так и написано —
 * прочерк здесь читался бы как «забыли указать».
 */
function vehiclesCell(label: string): ReactNode {
  if (label) return label;
  return <Typography.Text type="secondary">не отнесено</Typography.Text>;
}

export interface ReceiptGridActions {
  /**
   * Открыть карточку чека — единственное действие строки (§8): в ней строки, сканы, оба итога и
   * кнопки, зависящие от права. Читают её все, кому виден гараж (Р5), поэтому действие одно и на
   * права не смотрит.
   */
  onOpen: (receipt: AutoPartReceiptListItemDto) => void;
}

export function receiptColumns(): TableColumnType<AutoPartReceiptListItemDto>[] {
  return [
    textColumn<AutoPartReceiptListItemDto>({
      key: 'purchasedOn',
      // Дата документа, а не внесения в портал (Р13): по ней считаются все суммы и периоды, и
      // именно её ищут глазами, сверяя ленту с пачкой бумаги.
      title: 'Дата чека',
      dataIndex: 'purchasedOn',
      searchable: false,
      width: 130,
      render: (value: unknown) => dayjs(value as string).format(SHOWN_DATE),
    }),
    textColumn<AutoPartReceiptListItemDto>({
      key: 'documentNumber',
      title: 'Номер',
      dataIndex: 'documentNumber',
      // Поиск живёт в панели над таблицей: сервер ищет сразу по продавцу, номеру и наименованию
      // строки, и лупа у одного столбца обещала бы поиск только по нему.
      searchable: false,
      width: 150,
    }),
    textColumn<AutoPartReceiptListItemDto>({
      key: 'sellerName',
      title: 'Продавец',
      dataIndex: 'sellerName',
      searchable: false,
      ellipsis: true,
      // Продавца может не быть вовсе (Р1а): название магазина на ленте бывает нечитаемо, и это
      // законная запись, а не пропущенное поле.
      render: (value: unknown) => (value as string) || dash,
    }),
    {
      key: 'linesCount',
      title: 'Строк',
      dataIndex: 'linesCount',
      width: 90,
      // Сортировки нет: среди полей контракта числа строк нет, и сортируемый заголовок обещал бы
      // порядок, на который маршрут ответит 400.
    },
    {
      key: 'total',
      title: 'Сумма',
      dataIndex: 'total',
      width: 150,
      /*
       * Итога среди полей сортировки тоже нет, и это решение, а не упущение (§6): он складывается
       * из строк, и «самые дорогие чеки» — вопрос не к ленте документов, а к отчёту, которого этот
       * выпуск не заводит.
       */
      render: (value: unknown) => (
        <Typography.Text strong>{formatMoney(value as number)}</Typography.Text>
      ),
    },
    {
      key: 'vehicles',
      title: 'Машины',
      width: 260,
      render: (_value: unknown, r: AutoPartReceiptListItemDto) => vehiclesCell(r.vehiclesLabel),
    },
    {
      key: 'files',
      title: 'Сканы',
      width: 90,
      render: (_value: unknown, r: AutoPartReceiptListItemDto) => filesCell(r.filesCount),
    },
    {
      key: 'deletion',
      title: 'Пометка',
      width: 130,
      render: (_value: unknown, r: AutoPartReceiptListItemDto) =>
        r.deletion ? receiptDeletionTag(r.deletion) : dash,
    },
  ];
}

/** Строка списка на телефоне (ADR 0030, ADR 0042): та же запись, другой способ показать. */
export function receiptCard({
  onOpen,
}: ReceiptGridActions): CardConfig<AutoPartReceiptListItemDto> {
  return {
    // Номер — то, чем чек называют вслух и по чему его ищут в пачке; дата стоит рядом строкой ниже.
    title: (r) => `№ ${r.documentNumber}`,
    badge: (r) => (r.deletion ? receiptDeletionTag(r.deletion) : null),
    primary: (r) => `${dayjs(r.purchasedOn).format(SHOWN_DATE)} · ${formatMoney(r.total)}`,
    lines: [
      (r) => r.sellerName || null,
      (r) => `Строк: ${r.linesCount} · сканов: ${r.filesCount}`,
      (r) => (r.vehiclesLabel ? `Машины: ${r.vehiclesLabel}` : 'Не отнесено к машинам'),
    ],
    onOpen,
    // Действий у карточки нет: правку, пометку и удаление ведут из самой карточки чека, где видны
    // строки и сканы, — предлагать их из ленты значило бы предлагать решение вслепую.
  };
}
