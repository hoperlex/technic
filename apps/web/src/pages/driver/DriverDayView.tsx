import { Link } from 'react-router';
import { Alert, Button, Typography } from 'antd';
import type { DriverPreviousReading, DriverReportDto, ReportItemDto } from '@technic/contracts';
import { formatDateTime } from '../../utils/format';
import type { DraftItem } from './api';
import { CONTENT_WIDTH } from './DriverLayout';
import { OrphanBlock, type TransferMode, type TransferTarget } from './DriverOrphanBlock';
import { ReadingBlock } from './DriverReadingBlock';
import type { DayState } from './dayState';
import type { Orphan, PendingRow } from './readingsDraft';
import { emptyItem, sourceKey } from './readingsDraft';

/**
 * Матрица состояний дня на экране (план `docs/driver-readings-first-plan.md`, Р3, Р4, Р10).
 *
 * Что решает матрица — в [dayState.ts](dayState.ts); здесь то, как это выглядит: строка состояния
 * над формой, слова вместо формы, пометка на введённом, которое не уехало, и подвал, который либо
 * передаёт день, либо называет причину, по которой передавать его нечем.
 *
 * Отдельным модулем от страницы не по смыслу, а по размеру: вместе они переваливают за 400
 * строк — порог бюджета качества (`scripts/quality.mjs`). Граница честная: здесь ни одного
 * запроса, ни одной записи в хранилище — только слова состояния дня.
 */

const hintStyle = { display: 'block', fontSize: '0.9em' } as const;

/** Причина, по которой нажатие не дало отправки, — строкой над самой кнопкой, а не в углу экрана. */
const noteStyle = { display: 'block', marginBottom: 8 } as const;

/**
 * Открытая строка в дне есть, а чисел нет ни одного (Р6). Прежде это объясняли отказом схемы на
 * КАЖДОМ блоке разом — день из трёх машин краснел целиком, хотя человек просто не начал вводить.
 * Теперь пустой новый блок отправку не держит, и сказать, почему день не ушёл, обязан подвал: без
 * этой строки нажатие «Передать» не отвечало бы вовсе.
 */
const DAY_BLANK = 'Заполните хотя бы одно значение: пока в дне нет ни одного числа';

/**
 * Состояние дня — крупнее основного текста (план типографики, Р6): это первое, что водитель читает,
 * открыв кабинет, и от него зависит, будет ли он вообще набирать числа.
 */
const dayLabelStyle = { fontSize: '1.1em' } as const;

/**
 * Состояние дня строкой над формой — теми же словами, что стояли на кнопке шапки (Р4): кнопка
 * называла состояние отчёта, а не действие, и «Передать» с «Передано» — разные новости.
 *
 * Пустое задание эту строку больше не прячет: существующий отчёт старше живого задания, и день с
 * опустевшим составом остаётся принятым, отправленным или черновиком.
 */
export function DayLine({ day }: { day: DayState }) {
  return (
    <div>
      <Typography.Text strong style={dayLabelStyle}>
        {day.label}
      </Typography.Text>
      {day.hint && (
        <Typography.Text type="secondary" style={hintStyle}>
          {day.hint}
        </Typography.Text>
      )}
    </div>
  );
}

/**
 * Отказ вместо дня: открытие не состоялось или задание не прочиталось. Кнопка «Повторить» стоит
 * только у первого (`onRetry`), и это решение, а не оформление: `open` — тяжёлая транзакция с
 * блокировками машин и источников, автоповтор которой по рвущейся сети бьёт по базе ровно тогда,
 * когда ей и без того плохо (Р8). Повторяет её человек, увидев отказ, — или не повторяет вовсе.
 */
export function DayFailure({
  message,
  onRetry,
}: {
  message: string;
  onRetry: (() => void) | null;
}) {
  return (
    <Alert
      type="error"
      showIcon
      title="Не удалось открыть день"
      description={message}
      action={
        onRetry ? (
          <Button size="small" onClick={onRetry}>
            Повторить
          </Button>
        ) : null
      }
    />
  );
}

/**
 * Слова вместо формы: отчёта нет вовсе, и завести его нечем или незачем (Р6). Пустой экран человек
 * прочитал бы как поломку, а «Передать показания» над днём без единого выезда — как требование.
 *
 * Ссылка на задание идёт рядом, когда задание есть: день, за который показания не передавались,
 * объясняется именно им — что было назначено и было ли вообще.
 */
export function DayNotice({ day, href }: { day: DayState; href: string | null }) {
  return (
    <Alert
      type="info"
      showIcon
      title={day.notice}
      description={href ? <Link to={href}>Открыть задание</Link> : null}
    />
  );
}

/**
 * Введённое, но не переданное (Р10): пометка рядом с числами сервера, а не вместо них. Окно записи
 * закрыто — сдать такой день водитель уже не может, но продиктовать свои цифры диспетчеру обязан
 * мочь, и для этого ему нужны оба числа сразу. Черновик от показа не удаляется: уборка бывает
 * только по успешной отправке, по TTL и по выходу из учётной записи.
 */
export function PendingMark({ row }: { row: PendingRow }) {
  return (
    <Alert
      type="warning"
      showIcon
      title="Введено, но не передано"
      description={`${row.text} · сохранено ${formatDateTime(new Date(row.savedAt).toISOString())}`}
    />
  );
}

/**
 * Строки ожидания блоками — по одной на источник дня, а не одна форма на день: за день по одной
 * машине бывает две смены, и общая форма склеила бы их показания. Состав строк портал не
 * выдумывает: его заводит сервер, и приходит он отчётом.
 *
 * Рядом со строкой встаёт пометка «введено, но не передано» — там, где локальное по ней есть, а
 * окно записи уже закрыто (Р10): числа сервера остаются в полях, введённое человеком стоит рядом.
 *
 * Строк нет вовсе — вместо блоков слова: отчёт без строк это день без источников, рейсы отменили
 * уже после того, как задание показали. Только в дне, который ещё можно сдать: в читающем причину
 * называет подвал, и повторять её над формой незачем.
 */
export function DayRows({
  report,
  values,
  previousOf,
  errors,
  uploadingId,
  readOnly,
  pending,
  onChange,
  onUpload,
  onRemoveFile,
}: {
  report: DriverReportDto;
  /** Показанное — производное от отчёта и черновика, а не третье состояние рядом с ними. */
  values: Record<string, DraftItem>;
  previousOf: (item: ReportItemDto) => DriverPreviousReading | null;
  errors: Record<string, Record<string, string>>;
  uploadingId: string | null;
  readOnly: boolean;
  pending: ReadonlyMap<string, PendingRow>;
  onChange: (item: ReportItemDto, patch: Partial<DraftItem>) => void;
  onUpload: (item: ReportItemDto, file: File) => void;
  onRemoveFile: (item: ReportItemDto, fileId: string) => void;
}) {
  if (report.items.length === 0)
    return readOnly
      ? []
      : [
          <Alert
            key="no-sources"
            type="info"
            showIcon
            title="За этот день передавать нечего: выездов не осталось"
          />,
        ];
  return report.items.flatMap((item) => {
    const mark = pending.get(item.id);
    return [
      <ReadingBlock
        key={item.id}
        item={item}
        value={values[sourceKey(item)] ?? emptyItem()}
        previous={previousOf(item)}
        errors={errors[item.id] ?? {}}
        uploading={uploadingId === item.id}
        readOnly={readOnly}
        onChange={(patch) => onChange(item, patch)}
        onUpload={(file) => onUpload(item, file)}
        onRemoveFile={(fileId) => onRemoveFile(item, fileId)}
      />,
      mark ? <PendingMark key={`pending-${item.id}`} row={mark} /> : null,
    ];
  });
}

/**
 * Введённое, потерявшее свою строку (Р14): рейс переназначили, `itemId` сменился, запись пришла из
 * прежнего формата. Отбросить её нельзя — она единственная копия того, что человек ввёл, — а
 * угадать, к какому рейсу относились цифры, портал не имеет права: привязывает их человек.
 *
 * Целей ноль — кнопки «Перенести» у блока нет вовсе: в закрытом дне перенос сменил бы ключ записи,
 * блок исчез бы как «сопоставленный», а показать его содержимое было бы уже нечем (Р14а п. 1).
 */
export function OrphanList({
  orphans,
  targets,
  onTransfer,
}: {
  orphans: readonly Orphan[];
  targets: readonly TransferTarget[];
  onTransfer: (orphan: Orphan, targetKey: string, mode: TransferMode) => void;
}) {
  return orphans.map((orphan) => (
    <OrphanBlock
      key={orphan.id}
      item={orphan.item}
      savedAt={orphan.savedAt}
      origin={orphan.origin}
      targets={targets}
      onTransfer={(targetKey, mode) => onTransfer(orphan, targetKey, mode)}
    />
  ));
}

/**
 * Закреплённый подвал. Держится у нижнего края окна, а не липнет к концу содержимого, и
 * поднимается над клавиатурой замером `visualViewport` (Р9): показания вводят стоя у машины, и
 * кнопка, уехавшая под клавиатуру, — несданный день. Ширина кнопки — колонка кабинета.
 *
 * В читающем дне кнопки нет вовсе, а не выключенной: выключенная обещает действие, которого в этом
 * дне не будет. Вместо неё — причина, теми же словами, что и строка над формой (Р10). Там, где
 * формы нет совсем, нет и подвала: называть причину дважды незачем.
 *
 * Здесь же встаёт строка пустого дня (`blank`) — почему нажатие не дало отправки (Р6). Место
 * выбрано за неё: человек смотрит на кнопку, которую только что нажал, и объяснение обязано быть у
 * неё под рукой, а не подсветкой всех блоков разом и не тостом, уехавшим за клавиатуру.
 */
export function DayFooter({
  day,
  inset,
  submitting,
  disabled,
  blank,
  onSubmit,
}: {
  /** `null` — состояние дня ещё неизвестно: кнопка есть, но ждёт. */
  day: DayState | null;
  inset: number;
  submitting: boolean;
  disabled: boolean;
  /** День открыт, но пуст: нажатие не дало отправки. Гасит признак страница, первой же правкой. */
  blank: boolean;
  onSubmit: () => void;
}) {
  if (day?.notice) return null;
  return (
    <div className="driver-footer" style={{ bottom: inset }}>
      <div style={{ maxWidth: CONTENT_WIDTH, margin: '0 auto' }}>
        {day && !day.submittable ? (
          <Typography.Text type="secondary">{day.hint}</Typography.Text>
        ) : (
          <>
            {blank && (
              <Typography.Text type="warning" style={noteStyle}>
                {DAY_BLANK}
              </Typography.Text>
            )}
            <Button
              size="large"
              block
              type="primary"
              loading={submitting}
              disabled={disabled}
              onClick={onSubmit}
            >
              Передать
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
