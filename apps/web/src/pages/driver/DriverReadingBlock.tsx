import type { FocusEvent } from 'react';
import { Alert, Button, Checkbox, Input, Space, Switch, Typography, Upload } from 'antd';
import { PaperClipOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { readingAnomalyLabels, type ReportItemDto } from '@technic/contracts';
import { FileLinkList } from '../../components/FileLinks';
import type { DraftItem } from './api';

/**
 * Блок передачи показаний по одной строке ожидания (ADR 0103, Р14).
 *
 * Отдельным файлом от оверлея: оверлей отвечает за протокол — открыть отчёт, сохранить черновик,
 * отправить и разобрать отказ, — а блок за ввод. Держать их вместе значило бы читать разметку трёх
 * полей вперемешку с идемпотентностью отправки.
 *
 * Своего состояния у блока нет ни капли: всё введённое живёт в черновике оверлея, и только там —
 * иначе восстановление после закрытия вкладки восстанавливало бы половину.
 */

const hintStyle = { fontSize: 12 } as const;

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
 */
function normalizeDecimal(raw: string, integer: boolean): string {
  const cleaned = raw.replace(/\s/g, '').replace(',', '.');
  if (!integer) return cleaned.replace(/[^\d.]/g, '');
  // Целое поле отбрасывает дробную часть, а не склеивает её с целой: «145 320,7», превращённое
  // выбрасыванием разделителя в «1453207», — это молча выросший в десять раз пробег, который и
  // схему пройдёт, и в учёт ляжет. Отбросить десятые честнее: одометр целый по схеме.
  return cleaned.split('.')[0]!.replace(/\D/g, '');
}

/**
 * Неподтверждённые аномалии показания — словами, с тем значением, с которым сравнивали.
 *
 * Аномалия не отказ, а предупреждение (Р20): опечатку в одометре ловит сверка, но карьерный
 * самосвал за смену действительно проходит больше любого придуманного порога. Показывать её без
 * предшественника бессмысленно — «невероятный прирост» без «от чего» человеку нечем проверить.
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
  error,
  integer,
  suffix,
  onChange,
}: {
  label: string;
  value: string;
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
      <FieldError text={error} />
    </label>
  );
}

export interface ReadingBlockProps {
  item: ReportItemDto;
  value: DraftItem;
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
  errors,
  uploading,
  onChange,
  onUpload,
  onRemoveFile,
}: ReadingBlockProps) {
  const attached = item.reading?.fileIds.length ?? 0;
  const anomalies = anomalyNotes(item);
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

      {/* Аномалия показывается по прошлой отправке и требует ответа человека: без подтверждения
          день не примут (Р22), а исправлять верную цифру нечем. Подтверждение уезжает следующей
          отправкой — тем же запросом, что и сами числа. */}
      {anomalies.length > 0 && (
        <Alert
          type="warning"
          showIcon
          message="Показание сильно отличается от предыдущего"
          description={
            <>
              {anomalies.map((note) => (
                <div key={note}>{note}</div>
              ))}
              <Checkbox
                checked={value.confirmAnomaly}
                onChange={(e) => onChange({ confirmAnomaly: e.target.checked })}
                style={{ marginTop: 8 }}
              >
                Значение верное, подтверждаю
              </Checkbox>
            </>
          }
        />
      )}

      {/* Переключатель гасит и очищает числа: «нет данных» — это строка с причиной и без чисел
          (Р18), и оставленное в поле значение противоречило бы виду показания. Без него водитель
          не мог бы закрыть день по машине с неисправным счётчиком, а приёмка требует закрытых
          строк (Р22). */}
      <Space size={8}>
        <Switch
          checked={value.noData}
          onChange={(checked) =>
            onChange(
              checked
                ? { noData: true, odometerKm: '', engineHours: '', fuelFilledLiters: '' }
                : { noData: false, noDataReason: '' },
            )
          }
        />
        <span>Нет возможности снять показания</span>
      </Space>

      {value.noData ? (
        <label style={{ display: 'block' }}>
          <Typography.Text type="secondary" style={hintStyle}>
            Причина
          </Typography.Text>
          <Input.TextArea
            value={value.noDataReason}
            autoSize={{ minRows: 2 }}
            maxLength={500}
            status={errors.noDataReason ? 'error' : undefined}
            placeholder="Счётчик неисправен, машину увёл сменщик, кабина опечатана"
            onFocus={keepVisible}
            onChange={(e) => onChange({ noDataReason: e.target.value })}
          />
          <FieldError text={errors.noDataReason} />
        </label>
      ) : (
        <>
          {/* Показание счётчика НА КОНЕЦ СМЕНЫ, а не работа за смену: хранится снимок, разности
              считает сервер — вычитать в уме водителю не за чем (ADR 0103). */}
          <NumberField
            label="Одометр на конец смены"
            suffix="км"
            integer
            value={value.odometerKm}
            error={errors.odometerKm}
            onChange={(next) => onChange({ odometerKm: next })}
          />
          <NumberField
            label="Моточасы на конец смены"
            suffix="ч"
            integer={false}
            value={value.engineHours}
            error={errors.engineHours}
            onChange={(next) => onChange({ engineHours: next })}
          />
          {/* Заправлено ЗА СМЕНУ, а не остаток в баке: остатков портал не хранит и расхода не
              считает (Р28) — подпись обязана называть то, что спрашивают. */}
          <NumberField
            label="Заправлено за смену"
            suffix="л"
            integer={false}
            value={value.fuelFilledLiters}
            error={errors.fuelFilledLiters}
            onChange={(next) => onChange({ fuelFilledLiters: next })}
          />
        </>
      )}

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
