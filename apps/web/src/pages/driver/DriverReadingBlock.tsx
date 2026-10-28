import { Alert, Button, Input, Typography, Upload } from 'antd';
import { PaperClipOutlined } from '@ant-design/icons';
import type { DriverPreviousReading, ReportItemDto } from '@technic/contracts';
import { type ReadingField } from '@entities/vehicle-reading';
import { FileLinkList } from '@entities/file';
import type { DraftItem } from './api';
import { ReadingFields } from './DriverReadingFields';
import { RouteTimes } from './DriverRouteTimes';
import { fieldLabelStyle, hintStyle, keepVisible } from './readingFieldStyles';
import { blockChecks } from './readingChecks';
import { blockChanged } from './readingsSubmit';
import type { ShownStop } from './readingStops';

/**
 * Блок передачи показаний по одной строке ожидания (ADR 0103, Р14).
 *
 * Отдельным файлом от оверлея: оверлей отвечает за протокол — открыть отчёт, сохранить черновик,
 * отправить и разобрать отказ, — а блок за ввод. Держать их вместе значило бы читать разметку
 * полей вперемешку с идемпотентностью отправки. Сама разметка пяти чисел уехала ещё дальше — в
 * [DriverReadingFields](DriverReadingFields.tsx): блоку остались предупреждения, аномалии,
 * комментарий и файлы.
 *
 * Своего состояния у блока нет ни капли: всё введённое живёт в черновике оверлея, и только там —
 * иначе восстановление после закрытия вкладки восстанавливало бы половину.
 *
 * Переключателя «нет возможности снять показания» здесь нет намеренно (план кабинета, Р4): такую
 * строку закрывает персонал видом `no_data` и с причиной, а у водителя поля, которым можно
 * отписаться от ввода, больше нет.
 *
 * Читающий режим — свойство блока, а не одного подвала (план кабинета, Р10): принятый, повторно
 * принимаемый и аннулированный день правит диспетчер, а день старше семи суток не принимают вовсе.
 * Выключается в нём всё, чем можно ввести; а какие значения показать — серверные или локальные —
 * решает страница: читающих режима два, и с черновиком они обращаются по-разному.
 */

/** Госномер — первым и крупным (Р3): им водитель узнаёт строку среди своих машин за день. */
const vehicleStyle = { fontSize: '1.2em' } as const;

/** Источник строки — вторым: им различают две смены одной машины за один день. */
const sourceStyle = { fontSize: '0.9em' } as const;

export interface ReadingBlockProps {
  item: ReportItemDto;
  value: DraftItem;
  /** Предыдущий снимок счётчиков этой машины; `null` — начало ряда, сравнивать не с чем. */
  previous: DriverPreviousReading | null;
  /** Stops of a route item (`stopsOf`); empty for an ESM-2 item and a relocation. */
  stops: readonly ShownStop[];
  /** Ошибки по именам полей схемы: их же именами их и подсвечивает форма. */
  errors: Record<string, string>;
  uploading: boolean;
  /**
   * Read-only mode (Р10): everything that takes input is off — the five numbers, the comment,
   * «Прикрепить фото» and the file removal. Otherwise a driver edits an accepted day and the refusal
   * comes from the server after he has typed it all.
   *
   * Показанное режим не выбирает: чьи значения лежат в `value` — серверные или локальные — решает
   * страница, и решает по-разному (Р10). Блок знает только, что ввод закрыт.
   */
  readOnly?: boolean;
  onChange: (patch: Partial<DraftItem>) => void;
  onUpload: (file: File) => void;
  onRemoveFile: (fileId: string) => void;
}

export function ReadingBlock({
  item,
  value,
  previous,
  stops,
  errors,
  uploading,
  readOnly = false,
  onChange,
  onUpload,
  onRemoveFile,
}: ReadingBlockProps) {
  const attached = item.reading?.fileIds.length ?? 0;

  /*
   * Ввод уходит наружу одной дверью, и в читающем режиме она заперта. Это не перестраховка поверх
   * `disabled`: атрибут разметки — обещание браузеру, а событие `change` до обработчика доходит и
   * помимо человека (автозаполнение, восстановление формы). Запрет обязан быть свойством блока.
   */
  const edit = (patch: Partial<DraftItem>) => {
    if (!readOnly) onChange(patch);
  };

  /*
   * The checks are computed on every keystroke by the same pure function the submit uses: one rule
   * for showing and for refusing, or the form would warn about one thing and the window ask about
   * another (`readingChecks`).
   */
  const { hard, notes } = blockChecks(item, value, previous, blockChanged(item, value, stops));
  // A hard one stands under its field in red: it is not a question to the person but a typo in a
  // digit, and there is nothing to confirm. A soft one is a general warning — a strange number can
  // be true (Р6) — and the person answers it in the window when sending.
  const hardOf = (field: ReadingField): string | undefined =>
    hard.find((warning) => warning.field === field)?.text;
  const closedByStaff = item.reading?.kind === 'no_data';

  return (
    <div
      // Идентификатор нужен отказу отправки: он приводит к первому незаполненному блоку.
      id={`reading-${item.id}`}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        padding: 12,
        border: '1px solid rgba(0, 0, 0, 0.06)',
        borderRadius: 8,
      }}
    >
      {/* Госномер первым и крупным, источник — под ним (Р3): сначала опознание машины во дворе,
          потом различение двух её смен за день. Подпись машины приходит с сервера общим правилом
          `vehicleLabel` — у своей техники это госномер, у аренды описание (ADR 0018), и разбирать
          её здесь на части нечем и незачем. Пустой она бывает у машины, удалённой из справочника:
          тогда наверх встаёт источник — заголовок из пустой строки не назвал бы ничего. */}
      <div>
        <Typography.Text strong style={vehicleStyle}>
          {item.vehicleLabel || item.sourceLabel}
        </Typography.Text>
        {item.vehicleLabel && (
          <div>
            <Typography.Text type="secondary" style={sourceStyle}>
              {item.sourceLabel}
            </Typography.Text>
          </div>
        )}
      </div>

      {/* Строку без показаний закрывает персонал (Р4). Водителю об этом говорят прямо: иначе он
          видел бы пустой блок, который отказывается уходить, и не понимал, чего от него хотят. */}
      {closedByStaff && (
        <Alert
          type="info"
          showIcon
          title="Строку закрыл диспетчер"
          description={item.reading?.noDataReason}
        />
      )}

      {/* A warning wants an answer, it does not refuse: a server anomaly (a day without confirmation
          is not accepted, Р22) and a mismatch with the previous shift both happen to be true — a
          counter was replaced, the tank was topped up from the side. The answer is the window at
          «Передать» (ADR 0237); the block only says in advance that it will be asked. */}
      {notes.length > 0 && (
        <Alert
          type="warning"
          showIcon
          title="Проверьте показание перед передачей"
          description={
            <>
              {notes.map((note) => (
                <div key={note}>{note}</div>
              ))}
              <div style={{ marginTop: 8 }}>При передаче потребуется подтверждение.</div>
            </>
          }
        />
      )}

      {/* Пять чисел тремя группами по ходу смены (Р7). Ввод уходит наружу той же запертой
          дверью, что и остальное: `edit` молчит в читающем дне, а `disabled` гасит все пять полей
          разом — выключать их поимённо значило бы однажды забыть шестое. */}
      {/* The route's stops above the counters (ADR 0234, D9): the day is filled against the task,
          stop by stop, and the counters close it. */}
      {stops.length > 0 && (
        <RouteTimes
          stops={stops}
          value={value.stops}
          errors={errors}
          disabled={readOnly}
          onChange={(key, patch) =>
            edit({
              stops: {
                ...value.stops,
                [key]: { arrivedAt: '', departedAt: '', ...value.stops[key], ...patch },
              },
            })
          }
        />
      )}
      <ReadingFields
        value={value}
        previous={previous}
        errors={errors}
        hardOf={hardOf}
        disabled={readOnly}
        timed={item.sourceKind === 'esm2'}
        onChange={edit}
      />

      <label style={{ display: 'block' }}>
        <Typography.Text style={fieldLabelStyle}>Комментарий</Typography.Text>
        <Input.TextArea
          value={value.comment}
          autoSize={{ minRows: 1 }}
          maxLength={500}
          disabled={readOnly}
          onFocus={keepVisible}
          onChange={(e) => edit({ comment: e.target.value })}
        />
      </label>

      {/* Файлы грузятся сразу и по одному, независимо от чисел: сорвавшаяся десятая фотография не
          должна уносить с собой заполненные поля. До отправки файл ничей — связь заводит тот же
          запрос, что создаёт показание (Р18). */}
      <div>
        <Upload
          multiple
          showUploadList={false}
          disabled={readOnly}
          beforeUpload={(file) => {
            // Той же запертой дверью, что и числа: выбор файла приходит и от системного диалога.
            if (!readOnly) onUpload(file);
            // Загрузку ведёт портал (сессия в S3 своя): штатной отправке antd тут делать нечего.
            return false;
          }}
        >
          <Button icon={<PaperClipOutlined />} loading={uploading} disabled={readOnly}>
            Прикрепить фото
          </Button>
        </Upload>
        {/* Уже привязанные файлы показываются числом: повторно они не отправляются, а имён их
            строка ожидания не несёт — в показании лежат одни идентификаторы. */}
        {attached > 0 && (
          <Typography.Text type="secondary" style={{ ...hintStyle, marginLeft: 8 }}>
            уже приложено: {attached}
          </Typography.Text>
        )}
        {/* Удаление снимают не запретом, а отсутствием: список без `onRemove` кнопки «Удалить» не
            рисует вовсе — выключенная кнопка удаления там, где удалять нельзя ничем, только
            обещала бы действие. Сами снимки остаются видимыми: они введены человеком. */}
        {value.files.length > 0 && (
          <FileLinkList
            files={value.files}
            onRemove={readOnly ? undefined : (file) => onRemoveFile(file.id)}
          />
        )}
      </div>
    </div>
  );
}
