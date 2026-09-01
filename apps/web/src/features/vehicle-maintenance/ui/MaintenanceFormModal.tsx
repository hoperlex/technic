import { useEffect, useState } from 'react';
import { Alert, App, DatePicker, Form, Input, InputNumber } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import type { MaintenanceBody, VehicleMaintenanceDto } from '@technic/contracts';
import { autoPartKeys } from '@entities/auto-part';
import { vehicleMaintenanceApi, vehicleMaintenanceKeys } from '@entities/vehicle-maintenance';
import { errorMessage } from '@shared/lib';
import { FormModal } from '@shared/ui';
import { filesApi } from '../../../api/resources';
import { useAuth } from '../../../auth/AuthContext';
import {
  VERSION_CONFLICT_MESSAGE,
  isStaleRecord,
  isVersionConflict,
  maintenanceErrorText,
} from '../model/conflict';
import { DATE, SHOWN_DATE, kmText, previousOdometerKm } from '../model/maintenanceText';
import {
  partsBefore,
  partsIssue,
  rowsFromRecord,
  rowsToPayload,
  type PartRow,
} from '../model/parts';
import { MaintenancePartsBlock } from './MaintenancePartsBlock';
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
 * С выпуском автозапчастей у формы появилось третье правило, и оно про склад (план
 * `docs/auto-parts-plan.md`, Р18):
 *
 *   3. **Правка всегда несёт полный набор строк — тот, что показан в блоке.** Отсутствие `parts` в
 *      PATCH означает «строки не менять», и это защита от старого клиента, а не режим работы
 *      нового: угадывать «трогали блок или нет» портал не станет — состояние «пользователь коснулся
 *      поля» разъезжается с действительностью первым. Неизменённый набор сервер видит нулевой
 *      разницей, склад не двигает и `autoParts.stock` не спрашивает (Р19), поэтому правка номера
 *      документа диспетчером проходит ровно как раньше.
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
  const { can } = useAuth();
  const qc = useQueryClient();
  const [form] = Form.useForm<Values>();
  const [files, setFiles] = useState<ScanFile[]>([]);
  const [uploading, setUploading] = useState(false);
  /** Строки расхода живут состоянием окна, а не полями формы: итог считается на каждое нажатие. */
  const [parts, setParts] = useState<PartRow[]>([]);
  /**
   * Показывать ли отказ по строкам. До первого нажатия «Сохранить» его нет: только что заведённая
   * строка ещё пуста по определению, и краснеть на неё значило бы ругаться на собственную кнопку.
   */
  const [issueShown, setIssueShown] = useState(false);
  const canStock = can('autoParts.stock');

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
    setParts(rowsFromRecord(record));
    setIssueShown(false);
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
   * Что гасится после записи акта (Р16). Не только машина: строки акта двигают **склад**, и
   * вкладка автозапчастей с карточками позиций обязана узнать новый остаток — иначе она показывала
   * бы прежнее число до перезагрузки страницы.
   */
  function invalidate(): void {
    void qc.invalidateQueries({ queryKey: vehicleMaintenanceKeys.root });
    void qc.invalidateQueries({ queryKey: autoPartKeys.root });
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
        parts: rowsToPayload(parts),
      };
      if (!record) return vehicleMaintenanceApi.create(vehicleId, body);
      return vehicleMaintenanceApi.update(record.id, {
        ...body,
        version: record.version,
        /*
         * Набор строк уходит и в правке — полным, а не разницей (Р5, Р18). Единственное, что может
         * его отменить, — акт, пришедший вовсе без строк: так отвечал бы сервер до выката, и
         * присланный ему пустой массив означал бы «снять все». Тогда поля в теле нет — «строки не
         * менять», — и правка реквизитов проходит, не тронув склад.
         */
        parts: Array.isArray(record.parts) ? rowsToPayload(parts) : undefined,
      });
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
        return;
      }
      /*
       * Отказ по строке (нехватка остатка, погашенная позиция) окно НЕ закрывает: набранное в нём
       * — это и есть то, что надо поправить, а закрытие стоило бы человеку всей формы. Склад при
       * этом перечитывается: раз сервер назвал остаток, показанный устарел.
       */
      void qc.invalidateQueries({ queryKey: autoPartKeys.root });
    },
  });

  /**
   * Строки проверяются до отправки: пустая строка — это забытый выбор, а не «нисколько».
   *
   * Отказ показывается **в самом блоке**, а не тостом в углу (ADR 0094): строки живут состоянием
   * окна, полем формы их не пометить, но место, где ошиблись, назвать обязательно — тост уходит в
   * угол экрана и ничего не показывает.
   */
  const submit = (v: Values) => {
    if (partsIssue(parts)) {
      setIssueShown(true);
      return;
    }
    setIssueShown(false);
    save.mutate(v);
  };

  return (
    <FormModal
      title={record ? `Правка записи ТО — ${vehicleLabel}` : `Запись о ТО — ${vehicleLabel}`}
      open={open}
      onCancel={onClose}
      onSubmit={() => form.submit()}
      confirmLoading={save.isPending}
      width={560}
    >
      <Form form={form} layout="vertical" onFinish={submit}>
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

        <MaintenancePartsBlock
          vehicleId={vehicleId}
          rows={parts}
          onChange={setParts}
          before={partsBefore(record)}
          performedOn={performedOn ? performedOn.format(DATE) : null}
          canStock={canStock}
          recordParts={record?.parts ?? []}
          issue={issueShown ? partsIssue(parts) : null}
        />

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
