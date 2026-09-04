import { Alert, Button, Checkbox, Input, Typography, Upload } from 'antd';
import { PaperClipOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import {
  readingAnomalyLabels,
  type DriverPreviousReading,
  type ReportItemDto,
} from '@technic/contracts';
import { parseReadingNumber, readingWarnings, type ReadingField } from '@entities/vehicle-reading';
import { FileLinkList } from '../../components/FileLinks';
import type { DraftItem } from './api';
import { ReadingFields, fieldLabelStyle, hintStyle, keepVisible } from './DriverReadingFields';

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

/**
 * Неподтверждённые аномалии показания — словами, с тем значением, с которым сравнивали.
 *
 * Это аномалии, записанные СЕРВЕРОМ по прошлой отправке (Р20), а не предупреждения при вводе:
 * первые уже лежат в учёте и ждут ответа человека, вторые считаются здесь же по ходу набора.
 * Показываются они вместе, одним предупреждением — водителю всё равно, кто именно усомнился.
 */
function anomalyNotes(item: ReportItemDto): string[] {
  const reading = item.reading;
  if (!reading) return [];
  const counters = [
    { name: 'Одометр', anomaly: reading.odometerAnomaly },
    { name: 'Моточасы', anomaly: reading.engineHoursAnomaly },
  ];
  return counters
    .filter((counter) => counter.anomaly && !counter.anomaly.confirmed)
    .map(({ name, anomaly }) => {
      const previous =
        anomaly?.previousValue != null
          ? ` (предыдущее ${anomaly.previousValue}${
              anomaly.previousDate ? ` от ${dayjs(anomaly.previousDate).format('DD.MM.YYYY')}` : ''
            })`
          : '';
      return `${name}: ${anomaly ? readingAnomalyLabels[anomaly.kind] : ''}${previous}`;
    });
}

export interface ReadingBlockProps {
  item: ReportItemDto;
  value: DraftItem;
  /** Предыдущий снимок счётчиков этой машины; `null` — начало ряда, сравнивать не с чем. */
  previous: DriverPreviousReading | null;
  /** Ошибки по именам полей схемы: их же именами их и подсвечивает форма. */
  errors: Record<string, string>;
  uploading: boolean;
  /**
   * Читающий режим (Р10): выключено всё, чем можно ввести, — пять чисел, комментарий, подтверждение
   * аномалии, «Прикрепить фото» и удаление файла. Иначе водитель правит принятый день, а отказ
   * приходит с сервера — после того, как он всё набрал.
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
   * Предупреждения считаются на каждом наборе символа и той же чистой проверкой, которой лист не
   * пускает отправку: одно правило на показ и на запрет — иначе форма предупреждала бы об одном, а
   * не пускала за другое.
   */
  const warnings = readingWarnings(
    {
      odometerKm: parseReadingNumber(value.odometerKm),
      engineHours: parseReadingNumber(value.engineHours),
      fuelStartLiters: parseReadingNumber(value.fuelStartLiters),
      fuelFilledLiters: parseReadingNumber(value.fuelFilledLiters),
      fuelEndLiters: parseReadingNumber(value.fuelEndLiters),
    },
    previous,
  );
  // Грубое — под полем красным: это не вопрос к человеку, а опечатка в разряде, и подтверждать её
  // нечем. Мягкое — общим предупреждением с галочкой: странное число бывает правдой (Р6).
  const hardOf = (field: ReadingField): string | undefined =>
    warnings.find((w) => w.hard && w.field === field)?.text;
  const notes = [...anomalyNotes(item), ...warnings.filter((w) => !w.hard).map((w) => w.text)];
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

      {/* Предупреждение требует ответа человека, а не отказывает: и серверная аномалия (день без
          подтверждения не примут, Р22), и расхождение с предыдущим снимком бывают правдой —
          счётчик заменили, машина неделю стояла в поле. Подтверждение уезжает той же отправкой,
          что и сами числа. */}
      {notes.length > 0 && (
        <Alert
          type="warning"
          showIcon
          title="Проверьте показание перед отправкой"
          description={
            <>
              {notes.map((note) => (
                <div key={note}>{note}</div>
              ))}
              <Checkbox
                checked={value.confirmAnomaly}
                disabled={readOnly}
                onChange={(e) => edit({ confirmAnomaly: e.target.checked })}
                style={{ marginTop: 8 }}
              >
                Всё верно, подтверждаю
              </Checkbox>
            </>
          }
        />
      )}

      {/* Пять чисел тремя группами по ходу смены (Р7). Ввод уходит наружу той же запертой
          дверью, что и остальное: `edit` молчит в читающем дне, а `disabled` гасит все пять полей
          разом — выключать их поимённо значило бы однажды забыть шестое. */}
      <ReadingFields
        value={value}
        previous={previous}
        errors={errors}
        hardOf={hardOf}
        disabled={readOnly}
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
