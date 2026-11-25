import { Alert, App, Form, Upload } from 'antd';
import dayjs, { type Dayjs } from 'dayjs';
import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  calcWasteFactCost,
  type CompleteWasteRequestInput,
  factVolumeOf,
  factWeightOf,
  type FileDto,
  isManualCostOnly,
  MAX_TICKETS_PER_REQUEST,
  wasteFactUnit,
  WASTE_REMOVAL_CONTAINER_KIND,
  type WasteRequestDto,
} from '@technic/contracts';

import { FILE_MAX_SIZE } from '@shared/config';
import { filesApi } from '@entities/file';
import { wasteTariffResolveQuery } from '@entities/waste-tariff';
import { ticketFileOutcome, wasteTicketsQuery } from '@entities/waste-ticket';
import { FormModal, useFormBlockers } from '@shared/ui';
import { wasteRequestErrorMessage as errorMessage } from '@entities/waste-request';
import { WasteRequestCompletionFields } from './WasteRequestCompletionFields';
import { savedFactLine } from './savedFact';

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
/**
 * The window's side of the lifecycle render prop. A neighbouring feature is not importable here,
 * so the shapes are restated; the page passes the lifecycle's props through, and the compiler
 * checks that both sides still agree.
 */
type CompletionOutcome = 'saved' | 'rejected' | 'unknown';

interface Props {
  /** A null request closes the modal. */
  request: WasteRequestDto | null;
  confirmLoading: boolean;
  onCancel: () => void;
  /** Container operations have no quantity fact and therefore submit a null completion. */
  onSubmit: (v: {
    comment: string;
    completion: CompleteWasteRequestInput | null;
    ticketFileIds: string[];
  }) => Promise<CompletionOutcome>;
  /** Reads the review state of attached paper to name unread files on a re-close. */
  canReviewTickets?: boolean;
  /** After a 409: the request is reloaded (`pending`), and may no longer be completable. */
  reload?: { pending: boolean; blocked: boolean } | null;
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
  canReviewTickets = false,
  confirmLoading,
  onCancel,
  onSubmit,
  reload,
}: Props) {
  const { message } = App.useApp();
  const [form] = Form.useForm<FormValues>();
  const blockers = useFormBlockers(form);
  const [tickets, setTickets] = useState<FileDto[]>([]);
  const [uploading, setUploading] = useState(false);
  /** Once edited manually, cost must no longer be overwritten by the estimate. */
  const [costTouched, setCostTouched] = useState(false);
  /**
   * The current opening of the window: it moves on with every change of the target, closing
   * included. An upload that finishes in a later opening belongs to no form and is deleted rather
   * than added — it must not satisfy the ticket requirement of the window opened after it, the
   * same request reopened included (snow-removal plan, §3.3).
   */
  const opening = useRef(0);
  /**
   * Uploads a sent completion refers to. `sending` — the answer has not come; `kept` — the answer
   * was lost and the completion may have committed. Neither is deleted when the window closes:
   * removing them could strip the paper from a completion that went through (§3.3).
   */
  const sending = useRef(new Set<string>());
  const kept = useRef(new Set<string>());

  /** A null fact unit means the operation closes with ticket evidence only. */
  const factUnit = request ? wasteFactUnit(request.requestType) : null;
  const byVolume = factUnit === 'volume_m3';
  const byWeight = factUnit === 'weight_tons';
  /**
   * Snow has no price list (S6): no tariff lookup, no price line, no estimate following the
   * volume. The cost is the invoice amount, optional, and an explicit 0 is a known amount.
   */
  const manualCost = !!request && isManualCostOnly(request.requestType);

  /**
   * The basis price is the request's own snapshot: the request was issued at it, and later price
   * list edits do not rewrite an issued request (ADR 0009). Requests older than pricing have no
   * snapshot; for them the price list is resolved by the truck kind through the same endpoint the
   * server prices with, because the lookup rule must be one on both sides (ADR 0022, ADR 0026). The
   * server picks the completion price in the same order.
   */
  const wasteTypeId = request?.wasteTypeId ?? null;
  const operatorId = request?.operatorCounterpartyId ?? null;
  const needTariff = byVolume && !manualCost && request?.pricePerM3 == null && !!wasteTypeId;
  const { data: tariffResult } = useQuery({
    ...wasteTariffResolveQuery({
      wasteTypeId,
      target: { containerKind: WASTE_REMOVAL_CONTAINER_KIND },
      operatorCounterpartyId: operatorId,
    }),
    enabled: needTariff,
    // query-freshness: exception — tariff quotes may change during completion
    staleTime: 60_000,
  });
  /*
   * A re-close over paper whose last recognition left a file without a result (snow-removal plan,
   * §3.2): the file stays unread, a manual ticket does not settle it, and the rerun is possible
   * only once the request is «Выполнена» again. The window names such files so the closer knows
   * to press «Перераспознать» in the card right after closing.
   */
  const { data: paper } = useQuery(
    wasteTicketsQuery(request?.id ?? null, canReviewTickets && (request?.tickets.length ?? 0) > 0),
  );
  const unreadPaper = (paper?.files ?? [])
    .filter((file) => ticketFileOutcome(file).unread)
    .map((file) => file.filename || 'скан');
  const pricePerM3 = manualCost
    ? null
    : (request?.pricePerM3 ?? tariffResult?.tariff?.pricePerM3 ?? null);
  /** A minimum price is provisional because no operator was assigned (ADR 0026). */
  const priceIsMinimum = request?.pricePerM3 == null && !!tariffResult?.tariff?.isMinimum;

  // The modal is reused for different requests, so fields reset when the target changes rather than
  // on unmount — volume, cost AND the removal day: nothing is carried from another request or an
  // earlier opening. A repeated completion (after a rollback) opens on the saved fact, its cost and
  // removal day included: usually one number is corrected, not everything retyped. A first
  // completion prefills the planned volume, which is then confirmed or corrected from the ticket;
  // its cost starts from the estimate for garbage and blank for snow, which has none.
  const targetId = request?.id ?? null;
  const fillForRequest = useEffectEvent((_id: string | null) => {
    opening.current += 1;
    sending.current = new Set();
    kept.current = new Set();
    if (!request) return;
    const previous = request.completion;
    const volumeM3 = factVolumeOf(previous) ?? request.volumeM3 ?? null;
    setTickets([]);
    setCostTouched(!!previous);
    form.setFieldsValue({
      volumeM3,
      // Scrap requests carry no planned weight, so only a previous completion can prefill it.
      weightTons: factWeightOf(previous),
      totalCost: previous
        ? previous.totalCost
        : !manualCost && volumeM3 != null
          ? calcWasteFactCost(volumeM3, request.pricePerM3)
          : null,
      removedOn: previous?.removedOn ? dayjs(previous.removedOn) : null,
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

  /** Before manual editing, cost follows the entered volume; a snow cost never does. */
  const changeVolume = (value: number | null) => {
    if (costTouched || manualCost) return;
    form.setFieldsValue({ totalCost: value == null ? null : calcWasteFactCost(value, pricePerM3) });
  };

  const removeUpload = (id: string) => void filesApi.remove(id).catch(() => {});

  /**
   * Remove uploads that never reached a request at once, or they would linger in S3 unowned. Files
   * of a completion still in flight or with a lost answer stay: the outcome decides their fate.
   */
  const discardUploads = () => {
    tickets
      .filter((f) => !sending.current.has(f.id) && !kept.current.has(f.id))
      .forEach((f) => removeUpload(f.id));
    setTickets([]);
  };

  const uploadTicket = async (file: File) => {
    const startedIn = opening.current;
    setUploading(true);
    try {
      const uploaded = await filesApi.upload(file);
      if (startedIn !== opening.current) {
        removeUpload(uploaded.id);
        return;
      }
      setTickets((prev) => [...prev, uploaded]);
      // A ticket is attached, so the rejection clears now: the placeholder field is never edited
      // through its value and would not learn about the upload by itself (ADR 0094).
      form.setFields([{ name: 'ticketIds', errors: [] }]);
    } catch (e) {
      if (startedIn === opening.current) message.error(errorMessage(e));
    } finally {
      setUploading(false);
    }
  };

  const removeTicket = (f: FileDto) => {
    if (sending.current.has(f.id)) {
      message.warning('Талон уже отправлен с выполнением — дождитесь ответа');
      return;
    }
    if (!kept.current.has(f.id)) removeUpload(f.id);
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
    // A cleared cost is sent as null — "no amount" — and a typed 0 as 0, a known amount: the
    // server stores both as they are, and statistics tell them apart (S7).
    const removedOn = v.removedOn ? v.removedOn.format('YYYY-MM-DD') : null;
    const completion: CompleteWasteRequestInput | null = byVolume
      ? { volumeM3: v.volumeM3!, totalCost: v.totalCost ?? null, removedOn }
      : byWeight
        ? { weightTons: v.weightTons!, removedOn }
        : null;
    const ticketFileIds = tickets.map((f) => f.id);
    const sentIn = opening.current;
    ticketFileIds.forEach((id) => sending.current.add(id));
    void Promise.resolve(
      onSubmit({ comment: (v.comment ?? '').trim(), completion, ticketFileIds }),
    ).then((outcome) => {
      if (sentIn !== opening.current) {
        // The window was closed while the answer was on its way; nobody holds these files now.
        if (outcome === 'rejected') ticketFileIds.forEach(removeUpload);
        return;
      }
      ticketFileIds.forEach((id) => sending.current.delete(id));
      if (outcome === 'unknown') ticketFileIds.forEach((id) => kept.current.add(id));
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
      confirmLoading={confirmLoading || !!reload?.pending}
      okDisabled={!!reload?.blocked}
      okText="Выполнена"
      width={880}
    >
      {request && reload && !reload.pending && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          title={
            reload.blocked
              ? 'Заявку уже закрыли — повторно её не выполнить'
              : 'Заявку изменили, пока окно было открыто'
          }
          description={
            <>
              {savedFactLine(request)}
              {reload.blocked
                ? ' Закройте окно: загруженные здесь талоны будут удалены.'
                : ' Проверьте поля и отправьте снова.'}
            </>
          }
        />
      )}
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
            manualCost={manualCost}
            unreadPaper={unreadPaper}
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
