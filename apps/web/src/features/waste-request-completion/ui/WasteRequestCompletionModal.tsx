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
 * Completion submits evidence atomically with the status change, not after it:
 *  - waste removal records hauled volume and cost (ADR 0035). Volume is typed by hand from the
 *    ticket and the weighbridge receipt. Vehicles are not asked: removal is priced by the truck
 *    kind (ADR 0022), and which trucks hauled the volume does not affect the calculation;
 *  - scrap removal records one weight in tonnes (ADR 0067), with no estimate and no cost: the price
 *    list is in roubles per m3 for a "waste type x equipment" pair and cannot apply to tonnes;
 *  - container operations carry only a ticket: one trip, nothing hauled to measure (ADR 0013).
 *
 * Cost starts as "volume x price list" and stays freely editable: the operator invoice includes
 * delivery and partial loads, and the amount must match the invoice, not the formula. A manual
 * difference is shown as a hint so it is noticed rather than slipping through. A missing price is
 * not a blocker either: the work is done, and the amount is simply typed in.
 *
 * A ticket is mandatory in every case (ADR 0020) and since ADR 0024 belongs to the request-wide
 * pool: the operator hands over the paper as one batch per completion. The comment becomes an event
 * in the request history.
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
  /**
   * Actual removal day (ADR 0114, R19). Typed by hand and never prefilled from recognition: a value
   * copied from the ticket would be checked against itself, and the "ticket date vs removal day"
   * check would stop meaning anything.
   */
  removedOn?: Dayjs | null;
  volumeM3?: number | null;
  weightTons?: number | null;
  totalCost?: number | null;
  comment?: string;
  /**
   * Placeholder field for tickets: the files live in modal state, but the "no ticket" rejection
   * must be shown by the form like any other field error (ADR 0094). Its value is never read and
   * never sent; the form only needs a name to attach the error to.
   */
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
   * The basis price is the request's own snapshot: the request was issued at it, and later price
   * list edits do not rewrite an issued request (ADR 0009). Requests older than pricing have no
   * snapshot; for them the price list is resolved by the truck kind through the same endpoint the
   * server prices with, because the lookup rule must be one on both sides (ADR 0022, ADR 0026). The
   * server picks the completion price in the same order.
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

  // The modal is reused for different requests, so fields reset when the target changes rather than
  // on unmount. A repeated completion (after an administrator rollback) opens on the previous fact:
  // usually one number is corrected, not everything retyped. A first completion prefills the
  // planned volume, which is then confirmed or corrected from the ticket.
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
  // Depend on the request id, not the object: a re-render of the same request (a list invalidation
  // after a neighbouring action) arrives as a new object and would erase what was already typed.
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

  /** Remove uploads that never reached a request at once, or they would linger in S3 unowned. */
  const discardUploads = () => {
    tickets.forEach((f) => void filesApi.remove(f.id).catch(() => {}));
    setTickets([]);
  };

  const uploadTicket = async (file: File) => {
    setUploading(true);
    try {
      const uploaded = await filesApi.upload(file);
      setTickets((prev) => [...prev, uploaded]);
      // A ticket is attached, so the rejection clears now: the placeholder field is never edited
      // through its value and would not learn about the upload by itself (ADR 0094).
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
    // Exactly one quantity is sent: the one this request type is measured in. Cost goes only with
    // volume: scrap has no cost at all, and the server rejects the field if sent (ADR 0067).
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
  /** A plan/fact difference is a hint, not a block: the request is a plan, payment follows fact. */
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
        // Fact on the left, tickets on the right: they are attached while looking at the entered
        // volume. Phones get one column in the same order.
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
