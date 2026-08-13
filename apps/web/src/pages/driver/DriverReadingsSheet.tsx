import { useEffect, useState } from 'react';
import { App, Alert, Button, Drawer, Skeleton, Space } from 'antd';
import { useQueryClient } from '@tanstack/react-query';
import dayjs from 'dayjs';
import {
  readingInputSchema,
  type DriverReportDto,
  type ReadingInput,
  type ReportItemDto,
  type ReportItemSubmit,
} from '@technic/contracts';
import { isApiError } from '@shared/api';
import { FILE_MAX_COUNT, FILE_MAX_SIZE } from '@shared/config';
import { errorMessage } from '@shared/lib';
import { filesApi } from '../../api/resources';
import { ReadingBlock } from './DriverReadingBlock';
import {
  clearDraft,
  driverCabinetApi,
  driverKeys,
  loadDraft,
  newIdempotencyKey,
  saveDraft,
  type DraftFile,
  type DraftItem,
} from './api';

/**
 * Оверлей передачи показаний (ADR 0103, Р14).
 *
 * Лист во весь экран с прокруткой и кнопкой в липком подвале — не оформление, а требование:
 * показания вводят стоя у машины, экранная клавиатура занимает половину экрана, и кнопка,
 * уехавшая под неё, означает несданный день.
 *
 * Блок на каждую строку ожидания, а не одна форма на день: строки заводит сервер по источникам
 * (рейсам и недельным листам), и состав их портал не выдумывает — он приходит из `open`.
 */

interface Props {
  open: boolean;
  date: string;
  /** Учётка, а не человек: черновик лежит по ключу «учётка + дата» — телефон бывает общим. */
  userId: string;
  onClose: () => void;
}

const emptyItem = (): DraftItem => ({
  odometerKm: '',
  engineHours: '',
  fuelFilledLiters: '',
  comment: '',
  noData: false,
  noDataReason: '',
  files: [],
  confirmAnomaly: false,
});

/** Число из уже сохранённого показания — обратно в строку поля. */
const show = (value: number | null): string => (value === null ? '' : String(value));

/**
 * Что показать в блоке при открытии: сохранённое сервером, поверх — незавершённый черновик.
 * Черновик главнее намеренно: он новее отправленного и содержит именно то, что не доехало.
 */
function seedValues(
  report: DriverReportDto,
  draft: Record<string, DraftItem> | undefined,
): Record<string, DraftItem> {
  const values: Record<string, DraftItem> = {};
  for (const item of report.items) {
    const reading = item.reading;
    const base: DraftItem = reading
      ? {
          odometerKm: show(reading.odometerKm),
          engineHours: show(reading.engineHours),
          fuelFilledLiters: show(reading.fuelFilledLiters),
          comment: reading.comment,
          noData: reading.kind === 'no_data',
          noDataReason: reading.noDataReason,
          // Уже привязанные файлы сюда не попадают: отправка принимает только непривязанные
          // (Р18), и повтор их идентификаторов был бы отказом сервера.
          files: [],
          // Подтверждение не наследуется от прошлой отправки: подтверждают показанную аномалию,
          // а показывают её заново — вместе с числами, к которым она относится.
          confirmAnomaly: false,
        }
      : emptyItem();
    values[item.id] = draft?.[item.id] ?? base;
  }
  return values;
}

/** Пусто — это `null` (поля нет физически), а не ноль: ноль в учёте счётчика был бы ложью. */
function parseNumber(raw: string): number | null | 'invalid' {
  const text = raw.trim();
  if (text === '') return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : 'invalid';
}

/**
 * Куда встал низ листа при открытой клавиатуре.
 *
 * Android сжимает окно, и лист «во весь экран» ужимается вместе с ним; iOS кладёт клавиатуру
 * ПОВЕРХ страницы, ничего не сжимая, — и подвал с кнопкой уезжает под неё. Различие видит только
 * `visualViewport`: его высота и смещение и дают ту полосу, которую занимает клавиатура. Без этой
 * поправки требование «клавиатура не закрывает кнопку» (Р14) держалось бы на одной операционной
 * системе из двух.
 */
function useKeyboardInset(active: boolean): { height: number; bottom: number } | null {
  const [inset, setInset] = useState<{ height: number; bottom: number } | null>(null);
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!active || !viewport) {
      setInset(null);
      return;
    }
    const sync = () => {
      const bottom = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
      // Полоса в несколько десятков пикселей — это не клавиатура, а полоса прокрутки или панель
      // браузера: подниматься над ними означало бы дёргать лист на каждой прокрутке страницы.
      setInset(bottom > 80 ? { height: viewport.height, bottom } : null);
    };
    sync();
    viewport.addEventListener('resize', sync);
    viewport.addEventListener('scroll', sync);
    return () => {
      viewport.removeEventListener('resize', sync);
      viewport.removeEventListener('scroll', sync);
    };
  }, [active]);
  return inset;
}

export function DriverReadingsSheet({ open, date, userId, onClose }: Props) {
  const { message } = App.useApp();
  const queryClient = useQueryClient();
  const [report, setReport] = useState<DriverReportDto | null>(null);
  const [values, setValues] = useState<Record<string, DraftItem>>({});
  const [errors, setErrors] = useState<Record<string, Record<string, string>>>({});
  const [idempotencyKey, setIdempotencyKey] = useState('');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [uploadingId, setUploadingId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const keyboardInset = useKeyboardInset(open);

  /**
   * Открытие оверлея и есть открытие отчёта: сервер заводит черновик и строки ожидания по
   * источникам дня. Ключ идемпотентности берётся из черновика, если он есть, — тем и держится
   * правило «ключ живёт вместе с черновиком»: повторная отправка после обрыва связи остаётся той
   * же отправкой, а не второй.
   */
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoadError(null);
    setErrors({});
    setReport(null);
    void driverCabinetApi
      .open(date)
      .then((dto) => {
        if (cancelled) return;
        const draft = loadDraft(userId, date);
        setReport(dto);
        setIdempotencyKey(draft?.idempotencyKey ?? newIdempotencyKey());
        setValues(seedValues(dto, draft?.items));
      })
      .catch((e: unknown) => {
        if (!cancelled) setLoadError(errorMessage(e));
      });
    return () => {
      cancelled = true;
    };
  }, [open, date, userId]);

  /** Любая правка сразу ложится в черновик: отправка бывает неудачной, введённое — нет. */
  const update = (itemId: string, patch: Partial<DraftItem>) => {
    const next = { ...values, [itemId]: { ...(values[itemId] ?? emptyItem()), ...patch } };
    setValues(next);
    saveDraft(userId, date, { idempotencyKey, savedAt: Date.now(), items: next });
    // Правка снимает отказ со всего блока, а не с одного поля: «заполните хотя бы одно значение»
    // относится к трём полям сразу, и держать его над исправленным блоком значило бы врать.
    if (errors[itemId]) {
      const { [itemId]: _removed, ...rest } = errors;
      setErrors(rest);
    }
  };

  const upload = async (itemId: string, file: File) => {
    const current = values[itemId] ?? emptyItem();
    if (current.files.length >= FILE_MAX_COUNT) {
      message.error(`Не более ${FILE_MAX_COUNT} файлов`);
      return;
    }
    if (file.size > FILE_MAX_SIZE) {
      message.error('Файл больше 50 МБ');
      return;
    }
    setUploadingId(itemId);
    try {
      const dto = await filesApi.upload(file);
      const added: DraftFile = {
        id: dto.id,
        filename: dto.filename,
        contentType: dto.contentType,
        size: dto.size,
      };
      update(itemId, { files: [...current.files, added] });
    } catch (e) {
      message.error(errorMessage(e));
    } finally {
      setUploadingId(null);
    }
  };

  const removeFile = (itemId: string, fileId: string) => {
    const current = values[itemId] ?? emptyItem();
    update(itemId, { files: current.files.filter((f) => f.id !== fileId) });
    // Файл ещё ничей: убрать его из списка — значит удалить, иначе он останется сиротой в
    // хранилище до уборки воркером.
    void filesApi.remove(fileId).catch(() => undefined);
  };

  /** Собирает строку отправки либо ошибки блока: числа и вид показания проверяет схема контракта. */
  const buildItem = (
    item: ReportItemDto,
  ): { submit: ReportItemSubmit } | { errors: Record<string, string> } => {
    const value = values[item.id] ?? emptyItem();
    if (value.noData) {
      const reading: ReadingInput = {
        kind: 'no_data',
        noDataReason: value.noDataReason,
        comment: value.comment,
      };
      const parsed = readingInputSchema.safeParse(reading);
      if (!parsed.success) return { errors: issueMessages(parsed.error.issues) };
      return { submit: submitItem(item.id, parsed.data, value) };
    }

    const numbers = {
      odometerKm: parseNumber(value.odometerKm),
      engineHours: parseNumber(value.engineHours),
      fuelFilledLiters: parseNumber(value.fuelFilledLiters),
    };
    const broken = Object.entries(numbers).filter(([, v]) => v === 'invalid');
    if (broken.length > 0)
      return { errors: Object.fromEntries(broken.map(([field]) => [field, 'Введите число'])) };

    const parsed = readingInputSchema.safeParse({
      kind: 'values',
      ...numbers,
      comment: value.comment,
    });
    if (!parsed.success) return { errors: issueMessages(parsed.error.issues) };
    return { submit: submitItem(item.id, parsed.data, value) };
  };

  const doSubmit = async () => {
    if (!report) return;
    const items: ReportItemSubmit[] = [];
    const nextErrors: Record<string, Record<string, string>> = {};
    for (const item of report.items) {
      const built = buildItem(item);
      if ('submit' in built) items.push(built.submit);
      else nextErrors[item.id] = built.errors;
    }
    setErrors(nextErrors);
    const firstBad = report.items.find((item) => nextErrors[item.id]);
    if (firstBad) {
      // Отказ называет поле и приводит к нему, а не уходит тостом в угол экрана (ADR 0094).
      document.getElementById(`reading-${firstBad.id}`)?.scrollIntoView({ block: 'center' });
      return;
    }

    setSubmitting(true);
    try {
      await driverCabinetApi.submit(date, { version: report.version, items }, idempotencyKey);
      // Черновик уходит только после успеха: до него он — единственная копия введённого.
      clearDraft(userId, date);
      await queryClient.invalidateQueries({ queryKey: driverKeys.root });
      message.success('Показания переданы');
      onClose();
    } catch (e) {
      message.error(errorMessage(e));
      /*
       * 409 — либо расхождение версий (состав дня успели изменить), либо тот же ключ
       * идемпотентности с другим телом. И в том, и в другом случае лечится одним: перечитать
       * строки. Введённое при этом остаётся на экране — оно и есть то, что не доехало.
       */
      if (isApiError(e) && e.status === 409) {
        const fresh = await driverCabinetApi.open(date).catch(() => null);
        if (fresh) setReport(fresh);
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Drawer
      open={open}
      onClose={onClose}
      placement="bottom"
      size="100%"
      mask={{ closable: false }}
      title={`Показания за ${dayjs(date).format('D MMMM')}`}
      // Лист занимает видимую часть окна, а не всё окно: при поднятой клавиатуре это и есть
      // разница между «кнопка на экране» и «кнопка под клавиатурой».
      styles={keyboardInset ? { wrapper: keyboardInset } : undefined}
      footer={
        <div className="sheet-footer">
          <Button size="large" block onClick={onClose}>
            Закрыть
          </Button>
          <Button
            size="large"
            block
            type="primary"
            loading={submitting}
            disabled={!report || report.items.length === 0}
            onClick={() => void doSubmit()}
          >
            Передать
          </Button>
        </div>
      }
    >
      {loadError ? (
        <Alert type="error" showIcon message="Не удалось открыть отчёт" description={loadError} />
      ) : !report ? (
        <Skeleton active paragraph={{ rows: 8 }} />
      ) : report.items.length === 0 ? (
        // Отчёт без строк — это день без источников: рейсы отменили уже после того, как задание
        // показали. Отправлять нечего, и форма обязана сказать это словами, а не пустотой.
        <Alert type="info" showIcon message="За этот день передавать нечего: выездов не осталось" />
      ) : (
        <Space direction="vertical" size={12} style={{ display: 'flex' }}>
          {report.items.map((item) => (
            <ReadingBlock
              key={item.id}
              item={item}
              value={values[item.id] ?? emptyItem()}
              errors={errors[item.id] ?? {}}
              uploading={uploadingId === item.id}
              onChange={(patch) => update(item.id, patch)}
              onUpload={(file) => void upload(item.id, file)}
              onRemoveFile={(fileId) => removeFile(item.id, fileId)}
            />
          ))}
        </Space>
      )}
    </Drawer>
  );
}

/** Сообщения схемы — по именам полей блока: их и подсвечивает форма. */
function issueMessages(issues: readonly { path: PropertyKey[]; message: string }[]) {
  const result: Record<string, string> = {};
  for (const issue of issues) result[String(issue.path[0] ?? 'form')] = issue.message;
  return result;
}

/**
 * Строка отправки: показание, вновь загруженные файлы и подтверждение показанных аномалий.
 *
 * Флаг один на оба счётчика намеренно: подтверждают не «одометр» и «моточасы» по отдельности, а
 * показанное предупреждение целиком — и сервер применяет подтверждение только там, где аномалия
 * действительно есть.
 */
function submitItem(itemId: string, reading: ReadingInput, value: DraftItem): ReportItemSubmit {
  return {
    itemId,
    reading,
    fileIds: value.files.map((file) => file.id),
    confirmOdometerAnomaly: value.confirmAnomaly,
    confirmEngineHoursAnomaly: value.confirmAnomaly,
  };
}
