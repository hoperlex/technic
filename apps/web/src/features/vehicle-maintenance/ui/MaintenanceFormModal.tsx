import { useEffect, useState } from 'react';
import { Alert, App, DatePicker, Form, Input, InputNumber } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { MaintenanceBody, VehicleMaintenanceDto } from '@technic/contracts';
import { vehicleMaintenanceApi, vehicleMaintenanceKeys } from '@entities/vehicle-maintenance';
import { errorMessage } from '@shared/lib';
import { FormModal } from '@shared/ui';
import { filesApi } from '../../../api/resources';
import {
  VERSION_CONFLICT_MESSAGE,
  isStaleRecord,
  isVersionConflict,
  maintenanceErrorText,
} from '../model/conflict';
import { DATE, SHOWN_DATE, kmText, previousOdometerKm } from '../model/maintenanceText';
import { MaintenanceScans, type ScanFile } from './MaintenanceScans';

/**
 * Форма записи ТО — одна на заведение и на правку (Р15).
 *
 * Компонент живёт сценарием, а не экраном, и зовут его из двух мест: блок обслуживания в карточке
 * машины и окно сводки из справочника техники. Привяжи форму к карточке — и справочник завёл бы
 * себе вторую, с теми же пятью полями и своим пониманием того, что такое «пробег на момент».
 *
 * Два правила формы важнее остальных, и оба про то, что число из акта — не то же самое, что число
 * с прибора:
 *
 *   1. **Пробег подставляется подсказкой, а не берётся автоматом** (Р11а). Сервер знает последний
 *      одометр машины, и он же чаще всего стоит в акте — но не всегда: акт бывает выписан по
 *      показанию другого дня или прибор не работал вовсе. Подставленное значение правится и
 *      стирается, а поле остаётся необязательным: пустой одометр — это отсутствие якоря расчёта, а
 *      ноль дал бы «пробег с ТО» размером во всю жизнь машины.
 *   2. **Одометр меньше предыдущего — предупреждение, а не отказ** (Р11а). Счётчики меняют, и
 *      монотонности от акта никто не требует; портал только спрашивает, не тот ли это случай.
 *
 * Строк расхода со склада в форме больше нет (план `docs/auto-part-receipts-plan.md`, Р2):
 * купленное учитывается чеком, а не списанием с остатка, и акт снова отвечает ровно на один
 * вопрос — когда обслуживали и при каком пробеге. Поле `parts` форма не шлёт вовсе; сервер до
 * заморозки (выпуск 2) продолжает его принимать и отсутствие толкует как «строки не менять», так
 * что правка реквизитов старого акта его строк не трогает.
 */

interface Values {
  performedOn: Dayjs;
  odometerKm?: number | null;
  documentNumber?: string;
  note?: string;
}

/**
 * Уже подшитые сканы записи. Приходят они именем, типом и размером (`files`), поэтому от
 * свежезагруженных отличаются ровно одним — признаком `isNew`, по которому решается судьба файла
 * при откреплении: только что загруженный сносится сразу, подшитый отвязывает сервер.
 */
function attachedScans(record: VehicleMaintenanceDto | null): ScanFile[] {
  return (record?.files ?? []).map((file) => ({ ...file }));
}

export function MaintenanceFormModal({
  vehicleId,
  vehicleLabel,
  record,
  history,
  lastOdometer,
  defaultOn,
  open,
  onClose,
}: {
  vehicleId: string;
  vehicleLabel: string;
  /** `null` — заводят новую запись; иначе правят эту, с её версией (Р30). */
  record: VehicleMaintenanceDto | null;
  /** Журнал машины: по нему ищется предыдущий акт, с одометром которого сверяется вводимый. */
  history: readonly VehicleMaintenanceDto[];
  /** Последний известный одометр — та самая подсказка (Р14б). */
  lastOdometer: { km: number; measuredOn: string } | null;
  /** День среза, которым подписывается новая запись: сводку смотрят не только за сегодня (Р16). */
  defaultOn?: string;
  open: boolean;
  onClose: () => void;
}) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [form] = Form.useForm<Values>();
  const [files, setFiles] = useState<ScanFile[]>([]);
  const [uploading, setUploading] = useState(false);

  const performedOn = Form.useWatch('performedOn', form);
  const odometerKm = Form.useWatch('odometerKm', form);

  /*
   * Подсказка берётся числом, а не объектом сводки, и это не мелочь: сводка перечитывается сама —
   * по возврату в окно, после чужой правки, — и объект приходит каждый раз новый. Стой он в
   * зависимостях, форма стирала бы набранное на ровном месте.
   */
  const prefillKm = lastOdometer?.km;

  useEffect(() => {
    if (!open) return;
    form.resetFields();
    form.setFieldsValue(
      record
        ? {
            performedOn: dayjs(record.performedOn),
            odometerKm: record.odometerKm ?? undefined,
            documentNumber: record.documentNumber,
            note: record.note,
          }
        : {
            performedOn: dayjs(defaultOn ?? undefined),
            // Подсказка, а не готовый ответ: число из акта бывает своим, и его тут же исправляют.
            odometerKm: prefillKm,
          },
    );
    setFiles(attachedScans(record));
  }, [open, record, defaultOn, prefillKm, form]);

  /**
   * Предыдущий акт с одометром — тот, с которым сверяется вводимое число. Ищется по дате
   * обслуживания из формы, а не «последняя строка журнала»: запись заводят задним числом, и
   * предыдущей для марта бывает не верхняя строка.
   */
  const previous = performedOn
    ? previousOdometerKm(history, performedOn.format(DATE), record?.id)
    : null;
  const goingBack = previous !== null && typeof odometerKm === 'number' && odometerKm < previous.km;

  const upload = async (file: File) => {
    setUploading(true);
    try {
      const dto = await filesApi.upload(file);
      setFiles((prev) => [...prev, { ...dto, isNew: true }]);
    } catch (e) {
      message.error(errorMessage(e));
    } finally {
      setUploading(false);
    }
  };

  /**
   * Снятый файл. Загруженный в этом окне сносится сразу — до сохранения он ничей, и в хранилище
   * иначе копится мусор от передуманных записей. Уже подшитый только выпадает из списка: отвяжет
   * его сервер при сохранении, а снести чужой скан по одному нажатию в форме нельзя.
   */
  const removeFile = (file: ScanFile) => {
    setFiles((prev) => prev.filter((f) => f.id !== file.id));
    if (file.isNew) void filesApi.remove(file.id).catch(() => undefined);
  };

  /**
   * Что гасится после записи акта (Р16). Только записи ТО: чужих предметов акт больше не двигает —
   * покупки живут своими чеками и от акта не зависят.
   */
  function invalidate(): void {
    void qc.invalidateQueries({ queryKey: vehicleMaintenanceKeys.root });
  }

  const save = useMutation({
    mutationFn: (v: Values) => {
      const body: MaintenanceBody = {
        performedOn: v.performedOn.format(DATE),
        odometerKm: v.odometerKm ?? null,
        documentNumber: v.documentNumber?.trim() ?? '',
        note: v.note?.trim() ?? '',
        // Список уходит целиком: сервер сам разберёт, что подшить, а что отвязать.
        fileIds: files.map((f) => f.id),
      };
      if (!record) return vehicleMaintenanceApi.create(vehicleId, body);
      return vehicleMaintenanceApi.update(record.id, { ...body, version: record.version });
    },
    onSuccess: () => {
      message.success(record ? 'Запись ТО изменена' : 'Запись ТО добавлена');
      invalidate();
      onClose();
    },
    onError: (e) => {
      // Версия уехала (Р30): на экране устаревшая запись, и повторять отправку не по чему — та же
      // кнопка с той же версией даст тот же отказ. Поэтому сводка и журнал перечитываются, а окно
      // закрывается: правку продолжают уже поверх чужой.
      if (isVersionConflict(e)) {
        message.error(VERSION_CONFLICT_MESSAGE);
        invalidate();
        onClose();
        return;
      }
      message.error(maintenanceErrorText(e));
      /*
       * Акт закрыли из другого окна (Р6): правку продолжать не над чем — аннулированный не
       * правится вовсе, и исправление вводится новым актом. Окно закрывается, журнал
       * перечитывается: в нём акт уже с пометкой.
       */
      if (isStaleRecord(e)) {
        invalidate();
        onClose();
      }
    },
  });

  return (
    <FormModal
      title={record ? `Правка записи ТО — ${vehicleLabel}` : `Запись о ТО — ${vehicleLabel}`}
      open={open}
      onCancel={onClose}
      onSubmit={() => form.submit()}
      confirmLoading={save.isPending}
      width={560}
    >
      <Form form={form} layout="vertical" onFinish={(v) => save.mutate(v)}>
        <Form.Item
          name="performedOn"
          label="Дата обслуживания"
          rules={[{ required: true, message: 'Укажите дату акта' }]}
          extra="Времени у акта нет: показания того же дня в пробег с ТО не идут"
        >
          <DatePicker format={SHOWN_DATE} style={{ width: '100%' }} allowClear={false} />
        </Form.Item>

        <Form.Item
          name="odometerKm"
          label="Пробег на момент ТО, км"
          extra={
            lastOdometer
              ? `Подставлен последний известный одометр: ${kmText(lastOdometer.km)} на ${dayjs(
                  lastOdometer.measuredOn,
                ).format(SHOWN_DATE)}. В акте бывает своё число — исправьте, если оно другое.`
              : 'Необязательно: акт бывает и без пробега — тогда пробег с ТО будет известен только снизу.'
          }
        >
          <InputNumber min={0} precision={0} style={{ width: '100%' }} placeholder="128400" />
        </Form.Item>

        {/* Не отказ, а вопрос (Р11а): счётчики меняют, и запись с меньшим числом законна. */}
        {goingBack && (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 16 }}
            title="После прошлого ТО счётчик был больше — заменяли прибор?"
            description={`На ${dayjs(previous.performedOn).format(SHOWN_DATE)} в акте стояло ${kmText(
              previous.km,
            )}. Записать можно и так: монотонности от одометра не требуется, но пробег с ТО через замену считается только снизу.`}
          />
        )}

        <Form.Item name="documentNumber" label="Номер документа">
          <Input maxLength={100} placeholder="Акт № 128 от 12.03.2026" />
        </Form.Item>

        <Form.Item name="note" label="Примечание">
          <Input.TextArea rows={3} maxLength={1000} showCount />
        </Form.Item>

        <MaintenanceScans
          files={files}
          uploading={uploading}
          onUpload={(file) => void upload(file)}
          onRemove={removeFile}
        />
      </Form>
    </FormModal>
  );
}
