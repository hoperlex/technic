import { App, Button, Select, Tooltip, Typography, Upload } from 'antd';
import { DeleteOutlined, PlusCircleOutlined, UploadOutlined } from '@ant-design/icons';
import { useState } from 'react';
import { MAX_VEHICLES_PER_REQUEST, type WasteRequestVehicleInput } from '@technic/contracts';
import { filesApi } from '../api/resources';
import { FileLinkList } from './FileLinks';
import { errorMessage } from '../utils/format';

export interface VehicleDraftFile {
  id: string;
  filename: string;
  /** Нужен ссылке на талон: фото и PDF открываются окном просмотра, остальное скачивается. */
  contentType: string;
  size: number;
}

/** Строка формы машины: объём не вводится — он равен вместимости выбранного типа. */
export interface VehicleDraft {
  /** Локальный ключ строки (в БД не уходит). */
  key: string;
  containerTypeId?: string;
  files: VehicleDraftFile[];
}

/** Тип техники с вместимостью: она и есть объём рейса, поэтому в опции нужна явно. */
export interface VehicleTypeOption {
  value: string;
  label: string;
  /** Вместимость, м³; null — у типа не задана, выбрать его нельзя. */
  volumeM3: number | null;
}

let draftSeq = 0;
export function emptyVehicleDraft(containerTypeId?: string): VehicleDraft {
  draftSeq += 1;
  return { key: `v${draftSeq}`, containerTypeId, files: [] };
}

/**
 * Заполненность строк: тип всегда, талон — когда рейс предъявляется как факт. Талон подтверждает
 * рейс, а не заявку целиком, поэтому спрашивается у каждой машины (ADR 0020); ту же проверку
 * повторяет сервер. У заявки в работе машину заводят и без бумаги — её спросят при закрытии,
 * поэтому `requireTicket` повторяет серверное правило, а не ужесточает его.
 * Нумерация в тексте — сквозная по заявке: строки формы идут после уже заведённых машин.
 */
export function validateVehicleDrafts(
  drafts: readonly VehicleDraft[],
  existingCount = 0,
  requireTicket = true,
): string | null {
  for (const [i, d] of drafts.entries()) {
    const num = existingCount + i + 1;
    if (!d.containerTypeId) return `Машина ${num}: выберите тип машины`;
    if (requireTicket && d.files.length === 0) return `Машина ${num}: приложите талон`;
  }
  return null;
}

/** Черновики → тело запроса. Вызывать после validateVehicleDrafts. */
export function draftsToInput(drafts: readonly VehicleDraft[]): WasteRequestVehicleInput[] {
  return drafts.map((d) => ({
    containerTypeId: d.containerTypeId!,
    fileIds: d.files.map((f) => f.id),
  }));
}

/** Объём строки = вместимость выбранного типа; тот же расчёт делает сервер при сохранении. */
export function draftVolume(
  draft: VehicleDraft,
  typeOptions: readonly VehicleTypeOption[],
): number {
  return typeOptions.find((t) => t.value === draft.containerTypeId)?.volumeM3 ?? 0;
}

export function sumDraftVolume(
  drafts: readonly VehicleDraft[],
  typeOptions: readonly VehicleTypeOption[],
): number {
  const sum = drafts.reduce((acc, d) => acc + draftVolume(d, typeOptions), 0);
  return Math.round(sum * 1000) / 1000;
}

interface Props {
  value: VehicleDraft[];
  onChange: (next: VehicleDraft[]) => void;
  typeOptions: VehicleTypeOption[];
  /** Тип из заявки — им заполняется новая строка: чаще всего вывозят именно им. */
  defaultContainerTypeId?: string;
  /** Сколько машин уже заведено у заявки: лимит общий на заявку. */
  existingCount?: number;
  /**
   * Талон обязателен для этих строк — так же, как его потребует сервер. Ложь только там, где
   * машину заводят до предъявления факта (правка заявки, которую ещё выполняют).
   */
  ticketRequired?: boolean;
}

/**
 * Список машин, вывезших заявку (ADR 0011). Одна строка — один рейс: тип техники и талоны.
 * Строки добавляются кнопкой «+»; объём не вводится, а берётся из вместимости выбранного типа
 * («Самосвал 25 м³» → 25 м³) — тот же расчёт повторяет сервер при сохранении.
 */
export function WasteVehiclesEditor({
  value,
  onChange,
  typeOptions,
  defaultContainerTypeId,
  existingCount = 0,
  ticketRequired = true,
}: Props) {
  const { message } = App.useApp();
  const [uploadingKey, setUploadingKey] = useState<string | null>(null);

  const patch = (key: string, fields: Partial<VehicleDraft>) =>
    onChange(value.map((d) => (d.key === key ? { ...d, ...fields } : d)));

  const addRow = () => onChange([...value, emptyVehicleDraft(defaultContainerTypeId)]);

  const removeRow = (key: string) => {
    const row = value.find((d) => d.key === key);
    // Файлы несохранённой строки удаляем сразу: заявке они уже не достанутся.
    row?.files.forEach((f) => void filesApi.remove(f.id).catch(() => {}));
    onChange(value.filter((d) => d.key !== key));
  };

  const upload = async (key: string, file: File) => {
    setUploadingKey(key);
    try {
      const uploaded = await filesApi.upload(file);
      const row = value.find((d) => d.key === key);
      if (!row) return;
      patch(key, {
        files: [
          ...row.files,
          {
            id: uploaded.id,
            filename: uploaded.filename,
            contentType: uploaded.contentType,
            size: uploaded.size,
          },
        ],
      });
    } catch (e) {
      message.error(errorMessage(e));
    } finally {
      setUploadingKey(null);
    }
  };

  const removeFile = (key: string, fileId: string) => {
    const row = value.find((d) => d.key === key);
    if (!row) return;
    void filesApi.remove(fileId).catch(() => {});
    patch(key, { files: row.files.filter((f) => f.id !== fileId) });
  };

  const limitReached = existingCount + value.length >= MAX_VEHICLES_PER_REQUEST;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {value.map((d, i) => (
        <div
          key={d.key}
          style={{
            border: '1px solid rgba(0,0,0,0.08)',
            borderRadius: 8,
            padding: 12,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Typography.Text strong style={{ whiteSpace: 'nowrap' }}>
              Машина {existingCount + i + 1}
            </Typography.Text>
            <Select
              style={{ flex: 3, minWidth: 0 }}
              placeholder="Тип машины"
              // Тип без заданной вместимости выбрать нельзя: объём рейса брать было бы неоткуда.
              options={typeOptions.map((t) => ({
                ...t,
                disabled: t.volumeM3 == null,
                label: t.volumeM3 == null ? `${t.label} — вместимость не задана` : t.label,
              }))}
              showSearch
              optionFilterProp="label"
              value={d.containerTypeId}
              onChange={(v: string) => patch(d.key, { containerTypeId: v })}
            />
            <Typography.Text style={{ minWidth: 70, textAlign: 'right', whiteSpace: 'nowrap' }}>
              {d.containerTypeId ? `${draftVolume(d, typeOptions)} м³` : '— м³'}
            </Typography.Text>
            {/* Талон стоит в одной строке с машиной: рейс и его бумага — одна запись, и глазу
                не приходится связывать кнопку со строкой выше. */}
            <Upload
              multiple
              showUploadList={false}
              beforeUpload={(file) => {
                void upload(d.key, file);
                return false;
              }}
            >
              <Tooltip
                title={
                  ticketRequired
                    ? 'Талон обязателен: без него заявка не закрывается'
                    : 'Талон можно приложить и позже — его спросят при закрытии'
                }
              >
                <Button
                  size="small"
                  icon={<UploadOutlined />}
                  loading={uploadingKey === d.key}
                  // Незаполненный обязательный ввод подсвечивается сразу, а не только сообщением
                  // при сохранении: строк бывает несколько, и глазу нужно, к какой возвращаться.
                  danger={ticketRequired && d.files.length === 0}
                >
                  Прикрепить талон
                </Button>
              </Tooltip>
            </Upload>
            <Button
              danger
              type="text"
              icon={<DeleteOutlined />}
              aria-label={`Убрать машину ${i + 1}`}
              onClick={() => removeRow(d.key)}
            />
          </div>
          {d.files.length > 0 && (
            <FileLinkList
              files={d.files}
              maxNameWidth={260}
              onRemove={(f) => removeFile(d.key, f.id)}
            />
          )}
        </div>
      ))}
      <Button
        type="text"
        icon={<PlusCircleOutlined style={{ fontSize: 18 }} />}
        onClick={addRow}
        disabled={limitReached}
        style={{ alignSelf: 'flex-start', paddingInline: 4 }}
      >
        {limitReached ? `Не более ${MAX_VEHICLES_PER_REQUEST} машин` : 'Добавить машину'}
      </Button>
    </div>
  );
}

/** Сверка «заявлено ↔ вывезено»: подсказка, а не запрет (ADR 0011). */
export function VolumeSummary({ planned, actual }: { planned: number | null; actual: number }) {
  if (planned == null) {
    return <Typography.Text type="secondary">По машинам: {actual} м³</Typography.Text>;
  }
  const diff = Math.round((actual - planned) * 1000) / 1000;
  if (diff === 0) {
    return (
      <Typography.Text type="success">
        По машинам: {actual} м³ — совпадает с заявкой
      </Typography.Text>
    );
  }
  return (
    <Typography.Text type="warning">
      По машинам: {actual} м³ из {planned} м³ в заявке ({diff > 0 ? `+${diff}` : diff} м³)
    </Typography.Text>
  );
}
