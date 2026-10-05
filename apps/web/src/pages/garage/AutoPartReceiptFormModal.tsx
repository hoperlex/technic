import { useCallback, useEffect, useState } from 'react';
import { App, Form, Typography } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useMutation } from '@tanstack/react-query';
import {
  RECEIPT_NO_FILES_MESSAGE,
  RECEIPT_NO_LINES_MESSAGE,
  moscowDateKeyOf,
  type AutoPartReceiptDto,
  type CreateReceiptBody,
  type ReceiptDraft,
} from '@technic/contracts';
import { autoPartReceiptApi } from '@entities/auto-part-receipt';
import { useAuth } from '@entities/session';
import { errorFields, formatMoney } from '@shared/lib';
import { FormModal, useFormBlockers } from '@shared/ui';
import { ReceiptHeaderFields } from './ReceiptHeaderFields';
import { ReceiptLinesEditor } from './ReceiptLinesEditor';
import { WAREHOUSE_DESTINATION_VALUE } from './receiptVehicleOptions';
import { ReceiptScanField, type ScanFile } from './ReceiptScanField';
import {
  clearReceiptCreateDraft,
  loadReceiptCreateDraft,
  saveReceiptCreateDraft,
} from './receiptCreateDraftStorage';
import {
  hasLineErrors,
  newReceiptLine,
  receiptLineErrorsFromApi,
  receiptLinesFromDto,
  receiptLinesPayload,
  receiptLinesTotal,
  receiptRowsFromDraft,
  validateReceiptLines,
  type ReceiptLineErrors,
  type ReceiptLineRow,
} from './receiptLines';
import {
  isReceiptVersionConflict,
  receiptErrorText,
  receiptVehicleIds,
  useReceiptInvalidation,
} from './receiptMutations';

/**
 * Окно «Принять чек» — одно на заведение и на правку (план `docs/auto-part-receipts-plan.md`, §8,
 * Р6, Р11, Р12).
 *
 * Порядок в окне повторяет порядок работы: сверху скан, ниже шапка, ниже строки. Скан идёт первым
 * не для красоты — **без файла чека не существует** (Р6): запись без бумаги это ведомость,
 * перепроверить её не по чему, и распознаванию следующего выпуска не к чему приложиться. Сам блок
 * скана живёт отдельным файлом (`ReceiptScanField.tsx`), там же и причина.
 *
 * **Поля «итог с бумаги» здесь нет вовсе** (Р11). Под таблицей стоит сумма строк, она
 * пересчитывается на глазах при вводе — и это предпросмотр: сверяют с чеком именно её, но
 * сохранённой правдой становится `total` из ответа сервера. Две суммы разошлись бы в первый же
 * день, и дальше в каждом отчёте пришлось бы решать, какая правда.
 *
 * Правка отдаёт чек **целиком** — шапку, строки и сканы одним телом, с версией, которую видел
 * правящий (Р12): два механика, открывшие один чек, не затирают друг друга молча. Пометку на
 * удаление правка не трогает: очередь администратора не должна опустошаться заодно с исправлением
 * опечатки.
 */

const DATE = 'YYYY-MM-DD';

interface Values {
  purchasedOn: Dayjs;
  documentNumber: string;
  sellerName?: string;
  note?: string;
}

export function AutoPartReceiptFormModal({
  receipt,
  open,
  onClose,
}: {
  /** `null` — принимают новый чек; иначе правят этот, с его версией (Р12). */
  receipt: AutoPartReceiptDto | null;
  open: boolean;
  onClose: () => void;
}) {
  const { message } = App.useApp();
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const invalidate = useReceiptInvalidation();
  /** Сегодня по МСК — тем же днём границу считает сервер (Р13), а не часами браузера. */
  const today = moscowDateKeyOf(new Date());
  const [form] = Form.useForm<Values>();
  const blockers = useFormBlockers(form);

  const [files, setFiles] = useState<ScanFile[]>([]);
  const [draftReady, setDraftReady] = useState(false);
  const [filesError, setFilesError] = useState<string | undefined>();
  const [rows, setRows] = useState<ReceiptLineRow[]>([]);
  const [appliedFileIds, setAppliedFileIds] = useState<string[]>([]);
  const [uploadsInFlight, setUploadsInFlight] = useState(0);
  const [linesError, setLinesError] = useState<string | undefined>();
  const [lineErrors, setLineErrors] = useState<ReceiptLineErrors>({});

  useEffect(() => {
    if (!open) return;
    setDraftReady(false);
    form.resetFields();
    const restored = !receipt && userId ? loadReceiptCreateDraft(userId) : null;

    if (receipt) {
      form.setFieldsValue({
        purchasedOn: dayjs(receipt.purchasedOn),
        documentNumber: receipt.documentNumber,
        sellerName: receipt.sellerName,
        note: receipt.note,
      });
      setFiles(receipt.files.map((file) => ({ ...file })));
      setRows(receiptLinesFromDto(receipt.lines));
      setAppliedFileIds([]);
    } else if (restored) {
      form.setFieldsValue({
        purchasedOn: dayjs(restored.values.purchasedOn),
        documentNumber: restored.values.documentNumber,
        sellerName: restored.values.sellerName,
        note: restored.values.note,
      });
      setFiles(restored.files.map((file) => ({ ...file })));
      setRows(restored.rows.map((row) => ({ ...row })));
      setAppliedFileIds(restored.appliedFileIds ?? []);
    } else {
      // The Moscow day is the same boundary the API validates around midnight.
      form.setFieldsValue({ purchasedOn: dayjs(today) });
      setFiles([]);
      setRows([newReceiptLine()]);
      setAppliedFileIds([]);
    }

    setFilesError(undefined);
    setLinesError(undefined);
    setLineErrors({});
    setDraftReady(true);
  }, [open, receipt, today, form, userId]);

  const persistCreateDraft = useCallback(() => {
    if (!open || receipt || !draftReady || !userId) return;
    const values = form.getFieldsValue();
    saveReceiptCreateDraft(userId, {
      values: {
        purchasedOn: values.purchasedOn?.format(DATE) ?? today,
        documentNumber: values.documentNumber ?? '',
        sellerName: values.sellerName ?? '',
        note: values.note ?? '',
      },
      files,
      rows,
      appliedFileIds,
    });
  }, [appliedFileIds, draftReady, files, form, open, receipt, rows, today, userId]);

  useEffect(() => {
    persistCreateDraft();
  }, [persistCreateDraft]);

  const changeRow = (key: string, patch: Partial<ReceiptLineRow>) => {
    setRows((prev) => prev.map((row) => (row.key === key ? { ...row, ...patch } : row)));
    // Правленая ячейка перестаёт быть красной сразу: пометка, снятая только на следующей отправке,
    // читалась бы как «исправил, а всё равно ругается».
    setLineErrors((prev) => (prev[key] ? { ...prev, [key]: {} } : prev));
  };

  const save = useMutation({
    mutationFn: (v: Values) => {
      const body: CreateReceiptBody = {
        purchasedOn: v.purchasedOn.format(DATE),
        documentNumber: v.documentNumber.trim(),
        sellerName: v.sellerName?.trim() ?? '',
        note: v.note?.trim() ?? '',
        // Сканы и строки уходят полным набором: сервер разберёт, что подшить, а что отвязать.
        fileIds: files.map((f) => f.id),
        lines: receiptLinesPayload(rows),
      };
      if (!receipt) return autoPartReceiptApi.create(body);
      return autoPartReceiptApi.update(receipt.id, { ...body, version: receipt.version });
    },
    onSuccess: (saved) => {
      if (!receipt && userId) clearReceiptCreateDraft(userId);
      message.success(receipt ? 'Чек изменён' : 'Чек принят');
      /*
       * Машины считаются по двум наборам сразу — бывшему и записанному (Р18): та, у которой строку
       * отобрали правкой, иначе показывала бы её в своём итоге до перезагрузки страницы.
       */
      invalidate({
        kind: 'write',
        id: saved.id,
        vehicleIds: receiptVehicleIds([...(receipt?.lines ?? []), ...rows]),
      });
      onClose();
    },
    onError: (e) => {
      /*
       * Версия уехала (Р12): на экране устаревший чек, и повторять отправку не по чему — та же
       * кнопка с той же версией даст тот же отказ. Карточка перечитывается, окно закрывается:
       * правку продолжают уже поверх чужой.
       */
      if (receipt && isReceiptVersionConflict(e)) {
        message.error(receiptErrorText(e));
        invalidate({ kind: 'write', id: receipt.id, vehicleIds: receiptVehicleIds(receipt.lines) });
        onClose();
        return;
      }
      // Отказ сервера ложится на те же ячейки и поля, что и свои проверки (§7, ADR 0094): путь
      // `lines.2.vehicleId` он присылает именно для этого. Тост — только для того, что на форме
      // показать негде.
      const lines = receiptLineErrorsFromApi(e, rows);
      setLineErrors(lines);
      const fields = errorFields(e);
      setFilesError(fields?.fileIds);
      setLinesError(fields?.lines);
      const shown = blockers.fromApi(e) || hasLineErrors(lines) || !!fields?.fileIds;
      if (!shown) message.error(receiptErrorText(e));
    },
  });

  /**
   * Что не отпустит форму помимо её собственных правил (ADR 0094): скан, строки и содержимое
   * ячеек. Отказ называет поле, а не «проверьте введённое».
   *
   * Зовётся из двух мест — из удавшейся проверки правил и из провалившейся, — и это не подстраховка:
   * `onFinish` при незаполненном номере чека не вызывается вовсе, и человек, нажавший «Сохранить»
   * на пустой форме, узнавал бы про скан только вторым нажатием. Отказ обязан быть один и полный.
   */
  const markOutsideForm = (): boolean => {
    const lines = validateReceiptLines(rows);
    setLineErrors(lines);
    setFilesError(
      uploadsInFlight > 0
        ? 'Дождитесь загрузки всех сканов'
        : files.length === 0
          ? RECEIPT_NO_FILES_MESSAGE
          : undefined,
    );
    setLinesError(rows.length === 0 ? RECEIPT_NO_LINES_MESSAGE : undefined);
    return uploadsInFlight > 0 || files.length === 0 || rows.length === 0 || hasLineErrors(lines);
  };

  /**
   * Заполнить форму распознанным (§10 плана распознавания).
   *
   * Шапка подставляется по полям, а не целиком: дата, которой не может быть (в будущем), и
   * слишком длинные значения приходят ПУСТЫМИ — их не подставляют молча, а показывают человеку
   * (Р10а, Р11). Уже набранное руками не затирается пустотой: пустое поле черновика оставляет
   * то, что стоит в форме.
   */
  const applyDraft = (draft: ReceiptDraft, fileIds: string[], mode: 'replace' | 'append') => {
    const current = form.getFieldsValue();
    form.setFieldsValue({
      purchasedOn:
        mode === 'append'
          ? current.purchasedOn
          : draft.header.purchasedOn
            ? dayjs(draft.header.purchasedOn)
            : current.purchasedOn,
      documentNumber:
        mode === 'append'
          ? current.documentNumber || draft.header.documentNumber
          : draft.header.documentNumber || current.documentNumber,
      sellerName:
        mode === 'append'
          ? current.sellerName || draft.header.sellerName
          : draft.header.sellerName || current.sellerName,
    });
    const next = receiptRowsFromDraft(draft);
    if (mode === 'append') {
      // Previously applied pages may have been corrected by hand; append only the new file rows.
      setRows((previous) => {
        const placeholder =
          previous.length === 1 && !previous[0]?.name.trim() && previous[0]?.amount === null;
        const existing = placeholder ? [] : previous;
        return [...existing, ...next.rows];
      });
      setLineErrors((previous) => ({ ...previous, ...next.errors }));
      setAppliedFileIds((previous) => [...new Set([...previous, ...fileIds])]);
    } else {
      setRows(next.rows);
      setLineErrors(next.errors);
      setAppliedFileIds(fileIds);
    }
    setLinesError(undefined);
    // Дата в будущем формой не принимается вовсе, и подставлять её значило бы заполнить поле
    // заведомым отказом. Прочитанное называется на самом поле даты, а не тостом в углу (ADR 0094):
    // заполнять его человеку, и красная пометка с причиной стоит ровно там, куда он смотрит; она
    // же снимется, как только дату поправят.
    if (draft.header.purchasedOnIssue) {
      blockers.raise({
        purchasedOn: `${draft.header.purchasedOnIssue}: на бумаге «${draft.header.purchasedOnRaw}»`,
      });
    }
  };

  const submit = (v: Values) => {
    if (markOutsideForm()) return;
    save.mutate(v);
  };

  const total = receiptLinesTotal(rows);
  const busy = save.isPending;

  const cancel = () => {
    if (!receipt && userId) clearReceiptCreateDraft(userId);
    onClose();
  };

  return (
    <FormModal
      title={receipt ? `Правка чека № ${receipt.documentNumber}` : 'Принять чек'}
      open={open}
      onCancel={cancel}
      onSubmit={() => form.submit()}
      confirmLoading={busy}
      width={960}
    >
      <Form
        form={form}
        layout="vertical"
        onFinish={submit}
        onValuesChange={persistCreateDraft}
        {...blockers.formProps}
        // Своё поверх общего: прокрутку к первому блокеру делает хук, а скан и строки живут вне
        // формы, и пометить их некому, кроме этой строки.
        onFinishFailed={(info) => {
          blockers.formProps.onFinishFailed?.(info);
          markOutsideForm();
        }}
      >
        {/* Скан первым: чек начинается с бумаги, а не с реквизитов (Р6). */}
        <ReceiptScanField
          files={files}
          onChange={setFiles}
          error={filesError}
          onError={setFilesError}
          disabled={busy}
          formFilled={rows.some((row) => row.name.trim() !== '' || row.amount !== null)}
          lineCount={
            rows.length === 1 && !rows[0]?.name.trim() && rows[0]?.amount === null ? 0 : rows.length
          }
          appliedFileIds={appliedFileIds}
          onApplyDraft={applyDraft}
          onResetApplied={() => setAppliedFileIds([])}
          onUploadCountChange={setUploadsInFlight}
        />

        <ReceiptHeaderFields today={today} busy={busy} />

        <Form.Item
          label="Строки чека"
          required
          validateStatus={linesError ? 'error' : undefined}
          help={linesError}
        >
          <ReceiptLinesEditor
            rows={rows}
            errors={lineErrors}
            disabled={busy}
            onChange={changeRow}
            onAssignAll={(destination) => {
              setRows((current) =>
                current.map((row) => ({
                  ...row,
                  toWarehouse: destination === WAREHOUSE_DESTINATION_VALUE,
                  vehicleId:
                    destination === null || destination === WAREHOUSE_DESTINATION_VALUE
                      ? null
                      : destination,
                })),
              );
              setLineErrors({});
            }}
            onAdd={() => {
              setRows((prev) => [...prev, newReceiptLine()]);
              setLinesError(undefined);
            }}
            onRemove={(key) => setRows((prev) => prev.filter((row) => row.key !== key))}
          />
        </Form.Item>

        {/* Предпросмотр, а не итог чека: сохранённой правдой станет сумма из ответа (Р11). */}
        <div style={{ textAlign: 'right' }}>
          <Typography.Text strong>Всего по чеку: {formatMoney(total)}</Typography.Text>
          <div>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              Считается по строкам — итог с бумаги в портал не вводится
            </Typography.Text>
          </div>
        </div>
      </Form>
    </FormModal>
  );
}
