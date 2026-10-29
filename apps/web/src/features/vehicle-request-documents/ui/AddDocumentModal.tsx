import { useEffect, useMemo, useRef } from 'react';
import { App, Form } from 'antd';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  VEHICLE_REQUEST_DOCUMENT_TYPE_SUGGESTIONS,
  type VehicleRequestDocumentDto,
} from '@technic/contracts';
import { filesApi } from '@entities/file';
import { vehicleRequestKeys, vehicleRequestsApi } from '@entities/vehicle-request';
import { errorMessage } from '@shared/lib';
import { FormModal, useFormBlockers } from '@shared/ui';
import { DocumentRows, EMPTY_DOCUMENT_ROW, type DocumentRow } from './DocumentRows';

interface Values {
  rows: DocumentRow[];
}

/** A row the rules let through: all three chosen, the type trimmed, the date as the wire has it. */
interface ReadyRow {
  file: File;
  docType: string;
  docDate: string;
}

interface Outcome {
  /** Rows linked before the run ended, counted from the top. */
  done: number;
  /** The row that stopped the run; the rows below it were not tried. */
  failure: { error: unknown; filename: string } | null;
  /** The window was closed while the run was going: the form it would touch is not this run's. */
  stopped: boolean;
}

/**
 * Adding documents: one row per document — the file, its type and its date, both typed by hand (D5;
 * the date may be any date — owner correction to P4). Every file goes to storage first and is
 * linked second, the order of every attachment in the portal: the server links an id of an object
 * already uploaded.
 *
 * The server takes one document per call, so the rows go one after another, in the order of the
 * window. It is not one transaction and does not pretend to be: the first failure stops the run,
 * the rows already linked leave the form and the rest stay in it with the reason in a toast, so
 * the next press of «Добавить» sends only what is still missing. Closing the window stops the run
 * after the row in flight — «Отмена» must not keep adding paper the person has walked away from.
 *
 * The type is free text with suggestions (P11) — the usual papers and the types this request already
 * has, so the second УПД is spelled like the first one. Nothing outside the list is refused.
 */
export function AddDocumentModal({
  requestId,
  open,
  usedTypes,
  onClose,
}: {
  requestId: string;
  open: boolean;
  /** Types the request's documents already carry — offered first. */
  usedTypes: string[];
  onClose: () => void;
}) {
  const [form] = Form.useForm<Values>();
  const blockers = useFormBlockers(form);
  const { message } = App.useApp();
  const qc = useQueryClient();
  const running = useRef<{ stopped: boolean } | null>(null);

  useEffect(() => {
    if (open) form.resetFields();
  }, [open, form]);

  const typeOptions = useMemo(
    () =>
      [...new Set([...usedTypes, ...VEHICLE_REQUEST_DOCUMENT_TYPE_SUGGESTIONS])].map((value) => ({
        value,
      })),
    [usedTypes],
  );

  const add = useMutation({
    // Never throws: a refusal is an outcome with the rows before it already in place, not a failed
    // call to roll back.
    mutationFn: async (batch: ReadyRow[]): Promise<Outcome> => {
      const run = { stopped: false };
      running.current = run;
      let done = 0;
      try {
        for (const row of batch) {
          if (run.stopped) return { done, failure: null, stopped: true };
          try {
            const uploaded = await filesApi.upload(row.file);
            const res = await vehicleRequestsApi.addDocument(requestId, {
              fileId: uploaded.id,
              docType: row.docType,
              docDate: row.docDate,
            });
            // The answer is the table whole: put it in place, so the card shows the new row at once.
            qc.setQueryData<{ items: VehicleRequestDocumentDto[] }>(
              vehicleRequestKeys.documents(requestId),
              res,
            );
            done += 1;
          } catch (error) {
            return { done, failure: { error, filename: row.file.name }, stopped: run.stopped };
          }
        }
        return { done, failure: null, stopped: false };
      } finally {
        if (running.current === run) running.current = null;
      }
    },
    onSuccess: ({ done, failure, stopped }, batch) => {
      // The request history gained an event per document. Not the request root: it is the prefix
      // of the table put in place above, and would fetch it again.
      if (done > 0) void qc.invalidateQueries({ queryKey: vehicleRequestKeys.events(requestId) });
      if (failure) {
        if (!stopped) {
          const rows: DocumentRow[] = form.getFieldValue('rows') ?? [];
          form.setFieldValue('rows', rows.slice(done));
        }
        message.error(
          done === 0 && batch.length === 1
            ? errorMessage(failure.error)
            : `Добавлено ${done} из ${batch.length}. «${failure.filename}»: ${errorMessage(failure.error)}`,
        );
        return;
      }
      if (stopped) {
        if (done > 0) message.info(`Добавлено ${done} из ${batch.length}`);
        return;
      }
      message.success(done === 1 ? 'Документ добавлен' : `Добавлено документов: ${done}`);
      onClose();
    },
  });

  const submit = ({ rows }: Values) => {
    const batch: ReadyRow[] = [];
    for (const { file, docType, docDate } of rows) {
      // The rules have held every row back by now; the check keeps the types honest.
      if (!file || !docDate) return;
      batch.push({ file, docType: (docType ?? '').trim(), docDate: docDate.format('YYYY-MM-DD') });
    }
    add.mutate(batch);
  };

  const close = () => {
    if (running.current) running.current.stopped = true;
    onClose();
  };

  return (
    <FormModal
      title="Добавить документы"
      open={open}
      onCancel={close}
      onSubmit={() => form.submit()}
      confirmLoading={add.isPending}
      okText="Добавить"
      width={880}
    >
      {/* Disabled while a run is going: the rows are indexed, and a row added or removed under it
          would shift what «the first `done` rows» means. */}
      <Form
        form={form}
        layout="vertical"
        initialValues={{ rows: [{ ...EMPTY_DOCUMENT_ROW }] }}
        disabled={add.isPending}
        onFinish={submit}
        {...blockers.formProps}
      >
        <DocumentRows typeOptions={typeOptions} />
      </Form>
    </FormModal>
  );
}
