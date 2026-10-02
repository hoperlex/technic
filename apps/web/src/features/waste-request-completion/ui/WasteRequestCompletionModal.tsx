import { App, Form, Upload } from 'antd';
import type { Dayjs } from 'dayjs';
import { useEffect, useEffectEvent, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  calcWasteFactCost,
  type CompleteWasteRequestInput,
  factVolumeOf,
  factWeightOf,
  type FileDto,
  MAX_TICKETS_PER_REQUEST,
  wasteFactUnit,
  WASTE_REMOVAL_CONTAINER_KIND,
  type WasteRequestDto,
} from '@technic/contracts';
import { FILE_MAX_SIZE } from '@shared/config';
import { filesApi } from '@entities/file';
import { wasteTariffResolveQuery } from '@entities/waste-tariff';
import { FormModal, useFormBlockers } from '@shared/ui';
import { wasteRequestErrorMessage as errorMessage } from '@entities/waste-request';
import { WasteRequestCompletionFields } from './WasteRequestCompletionFields';

/**
 * Completion submits evidence atomically with the status change. Waste removal records volume and
 * cost (ADR 0035), scrap removal records weight (ADR 0067), and container operations carry no fact
 * quantity. Tickets are mandatory and belong to the request-wide pool (ADR 0020, ADR 0024).
 *
 * A calculated cost is only a starting point: the operator invoice may include delivery or partial
 * loading, so a manual amount remains valid and its difference is made visible. Missing pricing is
 * likewise not a blocker because completed work must still be recorded.
 */
interface Props {
  /** A null request closes the modal. */
  request: WasteRequestDto | null;
  confirmLoading: boolean;
  onCancel: () => void;
  onSubmit: (v: {
    comment: string;
    /** Container operations have no quantity fact and therefore submit null. */
    completion: CompleteWasteRequestInput | null;
    ticketFileIds: string[];
  }) => void;
}

interface FormValues {
  /** Entered manually so OCR does not validate a ticket date against its own extracted value. */
  removedOn?: Dayjs | null;
  volumeM3?: number | null;
  weightTons?: number | null;
  totalCost?: number | null;
  comment?: string;
  /** Synthetic field that anchors the missing-ticket form error while files stay in local state. */
  ticketIds?: string;
}

export function WasteRequestCompletionModal({
  request,
  confirmLoading,
  onCancel,
  onSubmit,
}: Props) {
  const { message } = App.useApp();
  const [form] = Form.useForm<FormValues>();
  const blockers = useFormBlockers(form);
  const [tickets, setTickets] = useState<FileDto[]>([]);
  const [uploading, setUploading] = useState(false);
  /** Once edited manually, cost must no longer be overwritten by the estimate. */
  const [costTouched, setCostTouched] = useState(false);

  /** A null fact unit means the operation closes with ticket evidence only. */
  const factUnit = request ? wasteFactUnit(request.requestType) : null;
  const byVolume = factUnit === 'volume_m3';
  const byWeight = factUnit === 'weight_tons';

  /**
   * Prefer the request price snapshot (ADR 0009). Legacy requests without one resolve the same
   * truck-kind tariff that the server uses during completion (ADR 0022, ADR 0026).
   */
  const wasteTypeId = request?.wasteTypeId ?? null;
  const operatorId = request?.operatorCounterpartyId ?? null;
  const needTariff = byVolume && request?.pricePerM3 == null && !!wasteTypeId;
  const { data: tariffResult } = useQuery({
    ...wasteTariffResolveQuery({
      wasteTypeId,
      target: { containerKind: WASTE_REMOVAL_CONTAINER_KIND },
      operatorCounterpartyId: operatorId,
    }),
    enabled: needTariff,
    staleTime: 60_000,
  });
  const pricePerM3 = request?.pricePerM3 ?? tariffResult?.tariff?.pricePerM3 ?? null;
  /** A minimum price is provisional because no operator was assigned (ADR 0026). */
  const priceIsMinimum = request?.pricePerM3 == null && !!tariffResult?.tariff?.isMinimum;

  // Reusing the modal must reset drafts between requests. A repeated completion starts from the
  // previous fact, while a first completion starts from planned volume for ticket verification.
  const targetId = request?.id ?? null;
  const fillForRequest = useEffectEvent((_id: string | null) => {
    if (!request) return;
    const previous = request.completion;
    const volumeM3 = factVolumeOf(previous) ?? request.volumeM3 ?? null;
    setTickets([]);
    setCostTouched(!!previous);
    form.setFieldsValue({
      volumeM3,
      // Scrap requests carry no planned weight, so only a previous completion can prefill it.
      weightTons: factWeightOf(previous),
      totalCost:
        previous?.totalCost ??
        (volumeM3 != null ? calcWasteFactCost(volumeM3, request.pricePerM3) : null),
      comment: '',
    });
  });
  // Depend on identity rather than object reference so a cache refresh cannot erase the draft.
  useEffect(() => fillForRequest(targetId), [targetId]);

  const volumeM3 = Form.useWatch('volumeM3', form);
  const totalCost = Form.useWatch('totalCost', form);

  // A legacy tariff can arrive after the modal opens; update cost unless the user already edited it.
  useEffect(() => {
    if (costTouched || pricePerM3 == null) return;
    const current = form.getFieldValue('volumeM3') as number | null | undefined;
    if (current == null || current <= 0) return;
    form.setFieldsValue({ totalCost: calcWasteFactCost(current, pricePerM3) });
  }, [pricePerM3, costTouched, form]);

  /** The same estimate initializes cost and explains a later manual difference. */
  const calculated =
    volumeM3 != null && volumeM3 > 0 ? calcWasteFactCost(volumeM3, pricePerM3) : null;
  const costDiffers = costTouched && calculated != null && (totalCost ?? null) !== calculated;

  /** Before manual editing, cost follows the entered volume. */
  const changeVolume = (value: number | null) => {
    if (costTouched) return;
    form.setFieldsValue({ totalCost: value == null ? null : calcWasteFactCost(value, pricePerM3) });
  };

  /** Remove uploads that never reached a request so they do not become orphaned objects. */
  const discardUploads = () => {
    tickets.forEach((f) => void filesApi.remove(f.id).catch(() => {}));
    setTickets([]);
  };

  const uploadTicket = async (file: File) => {
    setUploading(true);
    try {
      const uploaded = await filesApi.upload(file);
      setTickets((prev) => [...prev, uploaded]);
      // The synthetic ticket field cannot clear its own error when local file state changes.
      form.setFields([{ name: 'ticketIds', errors: [] }]);
    } catch (e) {
      message.error(errorMessage(e));
    } finally {
      setUploading(false);
    }
  };

  const removeTicket = (f: FileDto) => {
    void filesApi.remove(f.id).catch(() => {});
    setTickets((prev) => prev.filter((t) => t.id !== f.id));
  };

  /** Camera capture and file selection share the same ticket limits. */
  const beforeUploadTicket = (file: File) => {
    if (!request) return Upload.LIST_IGNORE;
    if (request.tickets.length + tickets.length >= MAX_TICKETS_PER_REQUEST) {
      message.warning(`Не более ${MAX_TICKETS_PER_REQUEST} талонов`);
      return Upload.LIST_IGNORE;
    }
    if (file.size > FILE_MAX_SIZE) {
      message.warning('Файл больше 50 МБ');
      return Upload.LIST_IGNORE;
    }
    void uploadTicket(file);
    return false;
  };

  const cancel = () => {
    discardUploads();
    onCancel();
  };

  const submit = (v: FormValues) => {
    if (!request) return;
    // Tickets from a previous completion satisfy the same request-wide requirement.
    if (
      blockers.raise({
        volumeM3:
          byVolume &&
          (v.volumeM3 == null || v.volumeM3 <= 0) &&
          'Укажите фактически вывезенный объём',
        weightTons:
          byWeight &&
          (v.weightTons == null || v.weightTons <= 0) &&
          'Укажите фактически вывезенный вес',
        ticketIds:
          request.tickets.length + tickets.length === 0 &&
          'Приложите талон — без него заявка не закрывается',
      })
    ) {
      return;
    }
    // Submit exactly one fact unit. Scrap has no monetary calculation (ADR 0067).
    const removedOn = v.removedOn ? v.removedOn.format('YYYY-MM-DD') : null;
    const completion: CompleteWasteRequestInput | null = byVolume
      ? { volumeM3: v.volumeM3!, totalCost: v.totalCost ?? null, removedOn }
      : byWeight
        ? { weightTons: v.weightTons!, removedOn }
        : null;
    onSubmit({
      comment: (v.comment ?? '').trim(),
      completion,
      ticketFileIds: tickets.map((f) => f.id),
    });
  };

  const noTicketYet = !!request && request.tickets.length + tickets.length === 0;
  /** A plan/fact difference is advisory because payment follows the actual removal. */
  const volumeDiff =
    request?.volumeM3 != null && volumeM3 != null && volumeM3 > 0
      ? Math.round((volumeM3 - request.volumeM3) * 1000) / 1000
      : null;

  return (
    <FormModal
      title="Выполнение заявки"
      open={!!request}
      onCancel={cancel}
      onSubmit={() => form.submit()}
      confirmLoading={confirmLoading}
      okText="Выполнена"
      width={880}
    >
      {request && (
        <Form form={form} layout="vertical" onFinish={submit} {...blockers.formProps}>
          <WasteRequestCompletionFields
            beforeUploadTicket={beforeUploadTicket}
            byVolume={byVolume}
            byWeight={byWeight}
            calculated={calculated}
            changeVolume={changeVolume}
            costDiffers={costDiffers}
            noTicketYet={noTicketYet}
            onCostChange={() => setCostTouched(true)}
            onRemoveTicket={removeTicket}
            priceIsMinimum={priceIsMinimum}
            pricePerM3={pricePerM3}
            request={request}
            tickets={tickets}
            totalCost={totalCost}
            uploading={uploading}
            volumeDiff={volumeDiff}
          />
        </Form>
      )}
    </FormModal>
  );
}
