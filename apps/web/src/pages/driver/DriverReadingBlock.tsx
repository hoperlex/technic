import type { FocusEvent } from 'react';
import { Alert, Button, Checkbox, Input, Typography, Upload } from 'antd';
import { PaperClipOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import {
  readingAnomalyLabels,
  type DriverPreviousReading,
  type ReportItemDto,
} from '@technic/contracts';
import { FileLinkList } from '../../components/FileLinks';
import type { DraftItem } from './api';
import {
  parseReadingNumber,
  previousHintText,
  readingWarnings,
  type ReadingField,
} from './readingLimits';

/**
 * Блок передачи показаний по одной строке ожидания (ADR 0103, Р14).
 *
 * Отдельным файлом от оверлея: оверлей отвечает за протокол — открыть отчёт, сохранить черновик,
 * отправить и разобрать отказ, — а блок за ввод. Держать их вместе значило бы читать разметку трёх
 * полей вперемешку с идемпотентностью отправки.
 *
 * Своего состояния у блока нет ни капли: всё введённое живёт в черновике оверлея, и только там —
 * иначе восстановление после закрытия вкладки восстанавливало бы половину.
 *
 * Переключателя «нет возможности снять показания» здесь нет намеренно (план кабинета, Р4): такую
 * строку закрывает персонал видом `no_data` и с причиной, а у водителя поля, которым можно
 * отписаться от ввода, больше нет.
 */

const hintStyle = { fontSize: '0.85em' } as const;

/**
 * Экранная клавиатура перекрывает поле, к которому её и вызвали. Браузер прокручивает к нему сам
 * не всегда и не сразу, поэтому доводим сами — с задержкой, за которую клавиатура успевает
 * появиться и сжать окно.
 */
function keepVisible(event: FocusEvent<HTMLElement>): void {
  const target = event.currentTarget;
  setTimeout(() => target.scrollIntoView({ block: 'center', behavior: 'smooth' }), 300);
}

/**
 * Запятая нормализуется в точку прямо на вводе: на телефоне десятичный разделитель зависит от
 * раскладки, и человек набирает тот, что есть на клавише, — отказывать ему за это нельзя.
 * `integer` — про одометр: он целый по схеме, и не принять дробную часть на вводе лучше, чем
 * отклонить отправкой целого дня.
 *
 * Разряды при наборе не группируются (П2): пробел, вставленный между цифрами во время ввода,
 * сдвигает позицию курсора, и человек дописывает пробег в середину числа. Группировка — только
 * при выводе, в подписях и предупреждениях.
 */
function normalizeDecimal(raw: string, integer: boolean): string {
  const cleaned = raw.replace(/\s/gu, '').replace(',', '.');
  if (!integer) return cleaned.replace(/[^\d.]/gu, '');
  // Целое поле отбрасывает дробную часть, а не склеивает её с целой: «145 320,7», превращённое
  // выбрасыванием разделителя в «1453207», — это молча выросший в десять раз пробег, который и
  // схему пройдёт, и в учёт ляжет. Отбросить десятые честнее: одометр целый по схеме.
  return cleaned.split('.')[0]!.replace(/\D/gu, '');
}

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

/** Ошибка стоит под своим полем, а не тостом в углу: отказ обязан называть поле (ADR 0094). */
function FieldError({ text }: { text?: string }) {
  if (!text) return null;
  return (
    <Typography.Text type="danger" style={hintStyle}>
      {text}
    </Typography.Text>
  );
}

function NumberField({
  label,
  value,
  hint,
  error,
  integer,
  suffix,
  onChange,
}: {
  label: string;
  value: string;
  /** «предыдущее: 145 320 (10.08)» — то, с чем водитель сверяет набранное (П1). */
  hint?: string;
  error?: string;
  integer: boolean;
  suffix: string;
  onChange: (next: string) => void;
}) {
  return (
    <label style={{ display: 'block' }}>
      <Typography.Text type="secondary" style={hintStyle}>
        {label}
      </Typography.Text>
      <Input
        // `decimal`, а не `numeric`: моточасы и литры дробные, и клавиатура без разделителя
        // сделала бы их ввод невозможным.
        inputMode="decimal"
        size="large"
        value={value}
        suffix={suffix}
        status={error ? 'error' : undefined}
        onFocus={keepVisible}
        onChange={(e) => onChange(normalizeDecimal(e.target.value, integer))}
      />
      {/* Подпись с предыдущим значением остаётся и при ошибке: именно она подсказывает, каким
          число должно быть, — убрать её там, где она нужнее всего, было бы странно. */}
      {hint && (
        <div>
          <Typography.Text type="secondary" style={hintStyle}>
            {hint}
          </Typography.Text>
        </div>
      )}
      <FieldError text={error} />
    </label>
  );
}

export interface ReadingBlockProps {
  item: ReportItemDto;
  value: DraftItem;
  /** Предыдущий снимок счётчиков этой машины; `null` — начало ряда, сравнивать не с чем. */
  previous: DriverPreviousReading | null;
  /** Ошибки по именам полей схемы: их же именами их и подсвечивает форма. */
  errors: Record<string, string>;
  uploading: boolean;
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
  onChange,
  onUpload,
  onRemoveFile,
}: ReadingBlockProps) {
  const attached = item.reading?.fileIds.length ?? 0;

  /*
   * Предупреждения считаются на каждом наборе символа и той же чистой проверкой, которой лист не
   * пускает отправку: одно правило на показ и на запрет — иначе форма предупреждала бы об одном, а
   * не пускала за другое.
   */
  const warnings = readingWarnings(
    {
      odometerKm: parseReadingNumber(value.odometerKm),
      engineHours: parseReadingNumber(value.engineHours),
      fuelFilledLiters: parseReadingNumber(value.fuelFilledLiters),
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
      <div>
        <Typography.Text strong>{item.sourceLabel}</Typography.Text>
        <div>
          <Typography.Text type="secondary" style={hintStyle}>
            {item.vehicleLabel}
          </Typography.Text>
        </div>
      </div>

      {/* Строку без показаний закрывает персонал (Р4). Водителю об этом говорят прямо: иначе он
          видел бы пустой блок, который отказывается уходить, и не понимал, чего от него хотят. */}
      {closedByStaff && (
        <Alert
          type="info"
          showIcon
          message="Строку закрыл диспетчер"
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
          message="Проверьте показание перед отправкой"
          description={
            <>
              {notes.map((note) => (
                <div key={note}>{note}</div>
              ))}
              <Checkbox
                checked={value.confirmAnomaly}
                onChange={(e) => onChange({ confirmAnomaly: e.target.checked })}
                style={{ marginTop: 8 }}
              >
                Всё верно, подтверждаю
              </Checkbox>
            </>
          }
        />
      )}

      {/* Показание счётчика НА КОНЕЦ СМЕНЫ, а не работа за смену: хранится снимок, разности
          считает сервер — вычитать в уме водителю не за чем (ADR 0103). */}
      <NumberField
        label="Одометр на конец смены"
        suffix="км"
        integer
        value={value.odometerKm}
        hint={previousHintText(previous, 'odometerKm')}
        error={errors.odometerKm ?? hardOf('odometerKm')}
        onChange={(next) => onChange({ odometerKm: next })}
      />
      <NumberField
        label="Моточасы на конец смены"
        suffix="ч"
        integer={false}
        value={value.engineHours}
        hint={previousHintText(previous, 'engineHours')}
        error={errors.engineHours ?? hardOf('engineHours')}
        onChange={(next) => onChange({ engineHours: next })}
      />
      {/* Заправлено ЗА СМЕНУ, а не остаток в баке: остатков портал не хранит и расхода не
          считает (Р28) — подпись обязана называть то, что спрашивают. Предыдущего снимка у
          заправки нет вовсе: она разовая, и сравнивать её не с чем. */}
      <NumberField
        label="Заправлено за смену"
        suffix="л"
        integer={false}
        value={value.fuelFilledLiters}
        error={errors.fuelFilledLiters ?? hardOf('fuelFilledLiters')}
        onChange={(next) => onChange({ fuelFilledLiters: next })}
      />

      <label style={{ display: 'block' }}>
        <Typography.Text type="secondary" style={hintStyle}>
          Комментарий
        </Typography.Text>
        <Input.TextArea
          value={value.comment}
          autoSize={{ minRows: 1 }}
          maxLength={500}
          onFocus={keepVisible}
          onChange={(e) => onChange({ comment: e.target.value })}
        />
      </label>

      {/* Файлы грузятся сразу и по одному, независимо от чисел: сорвавшаяся десятая фотография не
          должна уносить с собой заполненные поля. До отправки файл ничей — связь заводит тот же
          запрос, что создаёт показание (Р18). */}
      <div>
        <Upload
          multiple
          showUploadList={false}
          beforeUpload={(file) => {
            onUpload(file);
            // Загрузку ведёт портал (сессия в S3 своя): штатной отправке antd тут делать нечего.
            return false;
          }}
        >
          <Button icon={<PaperClipOutlined />} loading={uploading}>
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
        {value.files.length > 0 && (
          <FileLinkList files={value.files} onRemove={(file) => onRemoveFile(file.id)} />
        )}
      </div>
    </div>
  );
}
