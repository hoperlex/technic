import { useEffect, useState } from 'react';
import { App, DatePicker, Form, Input, Typography } from 'antd';
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
import { errorFields } from '@shared/lib';
import { FormGrid, FormModal, useFormBlockers } from '@shared/ui';
import { formatMoney } from '../../utils/format';
import { ReceiptLinesEditor } from './ReceiptLinesEditor';
import { ReceiptScanField, type ScanFile } from './ReceiptScanField';
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
const SHOWN_DATE = 'DD.MM.YYYY';

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
  const invalidate = useReceiptInvalidation();
  /** Сегодня по МСК — тем же днём границу считает сервер (Р13), а не часами браузера. */
  const today = moscowDateKeyOf(new Date());
  const [form] = Form.useForm<Values>();
  const blockers = useFormBlockers(form);

  const [files, setFiles] = useState<ScanFile[]>([]);
  const [filesError, setFilesError] = useState<string | undefined>();
  const [rows, setRows] = useState<ReceiptLineRow[]>([]);
  const [linesError, setLinesError] = useState<string | undefined>();
  const [lineErrors, setLineErrors] = useState<ReceiptLineErrors>({});

  useEffect(() => {
    if (!open) return;
    form.resetFields();
    form.setFieldsValue(
      receipt
        ? {
            purchasedOn: dayjs(receipt.purchasedOn),
            documentNumber: receipt.documentNumber,
            sellerName: receipt.sellerName,
            note: receipt.note,
          }
        : // День по МСК, а не по часам браузера: чек, заводимый в 00:30 МСК, иначе встречал бы
          // отказ «дата в будущем» на ровном месте.
          { purchasedOn: dayjs(today) },
    );
    setFiles((receipt?.files ?? []).map((file) => ({ ...file })));
    setRows(receipt ? receiptLinesFromDto(receipt.lines) : [newReceiptLine()]);
    setFilesError(undefined);
    setLinesError(undefined);
    setLineErrors({});
  }, [open, receipt, today, form]);

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
    setFilesError(files.length === 0 ? RECEIPT_NO_FILES_MESSAGE : undefined);
    setLinesError(rows.length === 0 ? RECEIPT_NO_LINES_MESSAGE : undefined);
    return files.length === 0 || rows.length === 0 || hasLineErrors(lines);
  };

  /**
   * Заполнить форму распознанным (§10 плана распознавания).
   *
   * Шапка подставляется по полям, а не целиком: дата, которой не может быть (в будущем), и
   * слишком длинные значения приходят ПУСТЫМИ — их не подставляют молча, а показывают человеку
   * (Р10а, Р11). Уже набранное руками не затирается пустотой: пустое поле черновика оставляет
   * то, что стоит в форме.
   */
  const applyDraft = (draft: ReceiptDraft) => {
    const current = form.getFieldsValue();
    form.setFieldsValue({
      purchasedOn: draft.header.purchasedOn ? dayjs(draft.header.purchasedOn) : current.purchasedOn,
      documentNumber: draft.header.documentNumber || current.documentNumber,
      sellerName: draft.header.sellerName || current.sellerName,
    });
    const next = receiptRowsFromDraft(draft);
    setRows(next.rows);
    setLineErrors(next.errors);
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

  return (
    <FormModal
      title={receipt ? `Правка чека № ${receipt.documentNumber}` : 'Принять чек'}
      open={open}
      onCancel={onClose}
      onSubmit={() => form.submit()}
      confirmLoading={busy}
      width={960}
    >
      <Form
        form={form}
        layout="vertical"
        onFinish={submit}
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
          onApplyDraft={applyDraft}
        />

        <FormGrid>
          <Form.Item
            name="purchasedOn"
            label="Дата чека"
            rules={[{ required: true, message: 'Укажите дату чека' }]}
            extra="Дата документа: по ней считаются суммы и периоды"
          >
            <DatePicker
              format={SHOWN_DATE}
              style={{ width: '100%' }}
              allowClear={false}
              disabled={busy}
              // Вперёд нельзя, назад — сколько угодно: чек приносят через неделю, и это норма,
              // а не исправление прошлого (Р13).
              disabledDate={(d) => d.format(DATE) > today}
            />
          </Form.Item>

          <Form.Item
            name="documentNumber"
            label="Номер чека"
            rules={[{ required: true, message: 'Номер чека обязателен' }]}
            // Уникальности у номера нет: его выдаёт продавец, и два «0001» из разных магазинов —
            // обычное дело (Р1а).
            extra="Номер с бумаги; своей нумерации у портала нет"
          >
            <Input maxLength={100} placeholder="0001" disabled={busy} />
          </Form.Item>

          <Form.Item
            name="sellerName"
            label="Продавец"
            // Необязателен, и это не непоследовательность рядом с обязательным номером (Р1а):
            // название магазина на ленте бывает нечитаемо.
            extra="Необязательно: на ленте название бывает нечитаемо"
          >
            <Input maxLength={200} placeholder="Автозапчасти на Ленина" disabled={busy} />
          </Form.Item>

          <FormGrid.Full>
            <Form.Item name="note" label="Примечание">
              <Input.TextArea rows={2} maxLength={1000} showCount disabled={busy} />
            </Form.Item>
          </FormGrid.Full>
        </FormGrid>

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
