import { useMemo, useState } from 'react';
import { Form } from 'antd';
import { useQuery } from '@tanstack/react-query';
import {
  allowedVehicleRequestTypes,
  canOrderVehicleRequestType,
  costTargetKeyOf,
  costTargetOf,
  isCargoAmountRequired,
  isVehicleKindAllowedForRequest,
  moscowDateKeyOf,
  requestTypeChangeBlocker,
  type VehicleRequestDto,
  type VehicleRequestType,
  vehicleRequestTypeLabels,
} from '@technic/contracts';
import { departmentPlatformQuery } from '@entities/department';
import { useAuth, usePlaceObjectScope } from '@entities/session';
import {
  classificationKeyOf,
  useVehicleClassifications,
  withSavedClassification,
} from '@entities/vehicle-type';
import { useRequestCustomerOptions, type RequestCustomerOptions } from '@features/request-customer';
import {
  blankTrip,
  copyFormValues,
  editFormValues,
  tripsNeedExpanding,
  type CopySource,
  type FormValues,
} from '@features/vehicle-request-editor';
import { withSavedOption } from '@shared/lib';
import { useFileEditor, type EditorFile } from './useFileEditor';
import { requestTypeChangeHandler } from './requestTypeChange';
import { useRequestEditorCalendar } from './useRequestEditorCalendar';

/**
 * The comment is the only place where the author explains the substance of the order, and the
 * explanation differs: for freight the dispatcher needs the cargo (it decides the vehicle and the
 * loading), for on-site equipment the work awaiting it. So the label is refined by request type and
 * an example sits in the field itself: without it the comment arrives empty or useless ("urgent"),
 * and the details are clarified by phone anyway.
 */
const COMMENT_HINTS: Record<VehicleRequestType, { label: string; placeholder: string }> = {
  special_equipment: {
    label: 'Комментарий (планируемые задачи)',
    placeholder:
      'Например: разработка котлована под фундамент, погрузка грунта в самосвалы; заезд с ул. Ленина, работы с 08:00',
  },
  freight_transport: {
    label: 'Комментарий (опишите груз)',
    placeholder:
      'Например: плиты перекрытия ПК 60-15, 12 шт, 14 т; погрузка краном поставщика, на объекте нужен манипулятор',
  },
};

export interface VehicleRequestEditorStateInput {
  canChangeStatus: boolean;
}

export function useVehicleRequestEditorState({ canChangeStatus }: VehicleRequestEditorStateInput) {
  const { user, can } = useAuth();
  const { ownObjectIds: ownPlaceObjectIds } = usePlaceObjectScope();
  const { byKey: classificationByKey, groups, loading: typesLoading } = useVehicleClassifications();
  const requestTypeOptions = canOrderOptions(user);
  const [open, setOpen] = useState(false);
  const [record, setRecord] = useState<VehicleRequestDto | null>(null);
  // The request a copy was taken from, with the frozen calendar (`CopySource` explains the freeze).
  // Kept apart from `record`, which answers whether saving is an edit or a creation.
  const [copy, setCopy] = useState<CopySource | null>(null);
  const [tripsExpanded, setTripsExpanded] = useState(false);
  /*
   * Backdate operation key (ADR 0101, R31) — one per open dialog, not per click.
   *
   * That is how it works: the connection dropped, no answer came, the person presses "Save" again,
   * and the server returns the previous result for the same key instead of a second request and a
   * second burnt strict-reporting form number. A new uuid per click would make the key useless in
   * exactly the case it exists for. `resetWindow` issues a fresh key only when a dialog is opened.
   *
   * A failed attempt does not burn the key: the operation row is written in the same transaction
   * as the edit and rolls back with it, so "fixed the reason and saved again" goes through normally
   * instead of hitting "key taken by another command".
   *
   * The 4-P day batch deliberately does the opposite — a key per click (ADR 0207, decision 11, see
   * `dayBatchBody` in `features/vehicle-assignment`): there a repeated click collects the remainder
   * of the period, which is a different operation, while here a repeated click is the same edit.
   */
  const [operationId, setOperationId] = useState(() => crypto.randomUUID());
  const [form] = Form.useForm<FormValues>();
  const files = useFileEditor();

  // The request type is chosen first: it drives the fields, the vehicle-type list and the customer
  // picker — on-site equipment goes to a site, and departments are not offered for it at all (R4).
  const requestType = Form.useWatch('requestType', form);
  const isSpecial = requestType === 'special_equipment';
  const isFreight = requestType === 'freight_transport';
  /**
   * Customer of the edited request (K7): the reference and label come from the record itself, not
   * from the live directory. The object may be closed or the department disbanded while the request
   * still points at it; the field is mandatory, and without a saved option the edit would start
   * with an empty customer. Exactly one half of the column pair is filled (CHECK), and the cost
   * target arrives in the DTO, computed by the same `costTargetOf` as on the server.
   *
   * `open &&` is load-bearing (R3a): a closed dialog still holds the previous edit's record, and
   * its option added to the list would break the "single option" count by which creation auto-fills
   * the customer. A kind cancelled by the type (a department for on-site equipment, ADR 0091) is
   * filtered by the picker itself: the rule about the field's composition lives with the
   * composition (R4, K8).
   */
  const savedTarget = open && record ? costTargetOf(record) : null;
  const savedCustomer = savedTarget
    ? { target: savedTarget, label: `${savedTarget.code} — ${savedTarget.name}` }
    : null;
  /**
   * The form customer — groups, lock, single option and saved value as one answer (R3). Spread out,
   * they would diverge: the lock is computed over both groups at once, and the saved value must
   * land in its own group.
   */
  const customer = useRequestCustomerOptions({
    // On-site equipment knows no departments (R4): the "Departments" group is absent, and a
    // department already in the field is removed by the form (K8). Objects follow the place axis
    // (ADR 0201): a department role is offered its sites — the ones the server accepts the order
    // on.
    objects: isSpecial ? 'place' : 'scope',
    departments: isSpecial ? 'none' : 'scope',
    saved: savedCustomer,
  });
  // The customer changes only while the request is "new" (R7): once in work, the cost target has
  // been snapshotted into waybill task rows, and moving the request would contradict issued paper.
  // The restriction is server-side (422); the field only shows it in advance and says why.
  const customerLocked = !!record && record.status !== 'new';

  /**
   * First rows of the place suggestions (ADR 0069): the request site, then ALL sites of the
   * department customer (ADR 0144), then the account's sites. The pair is read from the form — the
   * customer changes without closing it, and a department has no site of its own there; the
   * department map supplies them. The whole set goes in: there is no "main" site, the order follows
   * the object code, and keeping only one would hide the rest. This does not widen access: it is an
   * address hint, not a scope — the object directory defines the list, these rows only reorder it,
   * and the field component itself rejects entries without an address.
   */
  const formCustomer = customer.customerPairOf(Form.useWatch('customerKey', form));
  const { data: departmentPlatforms } = useQuery(departmentPlatformQuery());
  const suggestObjectIds = useMemo(() => {
    const departmentObjectIds = formCustomer.departmentId
      ? (departmentPlatforms?.get(formCustomer.departmentId) ?? [])
      : [];
    // Account sites from the place axis, not direct objects (ADR 0201): a department role has none.
    const ids = [formCustomer.objectId, ...departmentObjectIds, ...ownPlaceObjectIds];
    return [...new Set(ids.filter((id): id is string => !!id))];
  }, [formCustomer.objectId, formCustomer.departmentId, departmentPlatforms, ownPlaceObjectIds]);

  // The edited request's type stays in the list even if the role cannot order it (ADR 0040):
  // `AutoSelect` has no other way to label a value outside its options — it would show the code.
  const formRequestTypeOptions = withSavedOption(requestTypeOptions, {
    id: record?.requestType,
    name: record ? vehicleRequestTypeLabels[record.requestType] : null,
  });
  /**
   * Whether the edited request may be converted to the other type (ADR 0091), and if not, why. Rule
   * and text come from contracts: the server answers with them too, and if they diverged the field
   * would offer a choice that is then rejected.
   *
   * The vehicle kind is looked up in the classification directory by the request's own position.
   * The position may be missing — switched off, or the request predates categories — and then
   * conversion is closed: the server would not accept that position anyway
   * (`resolveClassification`).
   */
  const recordKindCode = record
    ? (classificationByKey.get(classificationKeyOf(record))?.kindCode ?? null)
    : null;
  const otherRequestType: VehicleRequestType | null = record
    ? record.requestType === 'special_equipment'
      ? 'freight_transport'
      : 'special_equipment'
    : null;
  // Why the type is locked; `null` — it may change, `undefined` — the request is new.
  const retypeBlocker =
    record && otherRequestType
      ? requestTypeChangeBlocker(record, recordKindCode, otherRequestType)
      : undefined;
  // The other type must also be available to the role: a department never orders on-site
  // equipment (ADR 0040).
  const canRetype =
    retypeBlocker === null &&
    !!otherRequestType &&
    canOrderVehicleRequestType(user, otherRequestType);

  /**
   * Trips of the edited request (R1, R2 of `docs/route-trips-plan.md`); `null` — an on-site order
   * is edited or a new request is created. From them the trip list learns each row's previous
   * state: its number ("ТС-40/2", R13a) and the R2a exemptions — an unverified address and an empty
   * contact do not block the edit while untouched. A row without a saved pair is new and fully
   * strict.
   */
  const recordTrips = record?.requestType === 'freight_transport' ? record.trips : null;
  // Whether cargo is required. A passenger car (form No. 3) carries people, and demanding "volume
  // or weight" would make the requester invent a number. Same rule as the server, asked by the
  // waybill form of the ordered type, not by its code.
  const classificationKey = Form.useWatch('classificationKey', form);
  const cargoRequired = isCargoAmountRequired(
    (classificationKey ? classificationByKey.get(classificationKey)?.waybillFormCode : null) ??
      null,
  );
  const {
    backdated,
    dateToLocked,
    effectiveDateKey,
    formCalendar,
    isBeforeCurrentDateTo,
    leadTimeHint,
    minDate,
    minDateRule,
    periodHint,
  } = useRequestEditorCalendar({ form, isSpecial, record, requestType, user });
  /**
   * Whether this request's 4-P relocations are editable (migration 0082): delivery to the site and
   * pickup from it. Same conditions as the server — an on-site order taken into work with company
   * equipment: a relocation drives the assigned unit, and for rented equipment the lessor issues
   * the waybill. A new request has no block at all — no vehicle is chosen yet.
   */
  const relocationsEditable =
    !!record &&
    record.requestType === 'special_equipment' &&
    record.status === 'confirmed' &&
    record.assignment?.ownership === 'own' &&
    canChangeStatus;
  // On-site orders accept any vehicle kind, freight only cargo vehicles. The edited request's
  // position may have left the directory (switched off) or never existed (older than categories) —
  // it is added as a separate disabled row, otherwise the field looks empty and nobody can tell
  // what was ordered.
  const typeGroups = requestType
    ? withSavedClassification(
        groups.filter((group) => isVehicleKindAllowedForRequest(requestType, group.kindCode)),
        record
          ? {
              vehicleTypeId: record.vehicleTypeId,
              vehicleCategoryId: record.vehicleCategoryId,
              typeName: record.vehicleTypeName,
              categoryName: record.vehicleCategoryName,
            }
          : null,
      )
    : [];

  const handleRequestTypeChange = requestTypeChangeHandler({
    classificationByKey,
    customer,
    form,
    minDate,
  });

  const resetWindow = () => {
    form.resetFields();
    setOperationId(crypto.randomUUID());
  };
  const openCreate = () => {
    setRecord(null);
    setCopy(null);
    resetWindow();
    // Site staff create requests only for their site, department staff only from their department:
    // the customer is filled when the account has a single option, and the field is then locked.
    // The form sets it, not the field: a disabled `AutoSelect` deliberately does not fill itself
    // (R3a, K6).
    if (customer.soleCustomerKey) form.setFieldsValue({ customerKey: customer.soleCustomerKey });
    // A department has one request type — fill it so the field does not ask a choice that does not
    // exist.
    if (requestTypeOptions.length === 1) {
      form.setFieldsValue({ requestType: requestTypeOptions[0]!.value });
    }
    // A new request starts with one trip and looks exactly like a pre-plan request (R24, §4.1); the
    // list expands only on "+ trip".
    form.setFieldsValue({ trips: [blankTrip()] });
    setTripsExpanded(false);
    files.reset([]);
    setOpen(true);
  };
  const openEdit = (request: VehicleRequestDto) => {
    setRecord(request);
    setCopy(null);
    resetWindow();
    setTripsExpanded(tripsNeedExpanding(request));
    form.setFieldsValue(editFormValues(request));
    files.reset(request.files.map((file): EditorFile => ({ ...file, isNew: false })));
    setOpen(true);
  };
  /**
   * Request copy (ADR 0173): the same form, but as a creation, not an edit — `record` stays empty
   * and saving goes to `create`. What is carried over is decided by `copyFormValues`. Attachments
   * are not carried (`files.reset([])`): a file belongs to at most one request.
   */
  const openCopy = (request: VehicleRequestDto) => {
    const today = moscowDateKeyOf(new Date());
    setRecord(null);
    setCopy({ source: request, minDate, today });
    resetWindow();
    setTripsExpanded(tripsNeedExpanding(request));
    // The customer is checked by the same question the form uses to build the body (K8): a value
    // outside the picker goes out as an empty pair, and filling it would show a customer the server
    // will not accept. The pair is computed once: two calls would answer one question twice.
    const pair = customer.customerPairOf(costTargetKeyOf(request));
    form.setFieldsValue(
      copyFormValues(request, {
        minDate,
        today,
        hasClassification: classificationByKey.has(classificationKeyOf(request)),
        hasCustomer: !!pair.objectId || !!pair.departmentId,
      }),
    );
    files.reset([]);
    setOpen(true);
  };
  /**
   * Copy a request (ADR 0173) — any request except an archived one: the action does not look at the
   * source status at all (ADR 0206). It repeats the order, not the record's state — same type, same
   * object, same composition — and the server does not ask about status either: the copy is an
   * ordinary creation. Its gates are those of "New request": the create permission and the
   * account's type corridor — a department may order only freight, and a copy of an on-site order
   * would be refused by the server.
   */
  const canCopy = (request: VehicleRequestDto) =>
    !request.deletedAt &&
    can('vehicleRequests.create') &&
    requestTypeOptions.some((option) => option.value === request.requestType);

  return {
    backdated,
    canCopy,
    canRetype,
    cargoRequired,
    commentHint: requestType ? COMMENT_HINTS[requestType] : null,
    copy,
    customer,
    customerLocked,
    dateToLocked,
    editor: files,
    effectiveDateKey,
    form,
    formCalendar,
    formRequestTypeOptions,
    handleRequestTypeChange,
    isBeforeCurrentDateTo,
    isFreight,
    isSpecial,
    leadTimeHint,
    minDateRule,
    open,
    openCopy,
    openCreate,
    openEdit,
    operationId,
    periodHint,
    record,
    recordTrips,
    relocationsEditable,
    requestType,
    requestTypeOptions,
    retypeBlocker,
    setOpen,
    setTripsExpanded,
    suggestObjectIds,
    tripsExpanded,
    typeGroups,
    typesLoading,
  };
}

function canOrderOptions(user: Parameters<typeof canOrderVehicleRequestType>[0]) {
  return allowedVehicleRequestTypes(user).map((value) => ({
    value,
    label: vehicleRequestTypeLabels[value],
  }));
}

export type VehicleRequestEditorState = ReturnType<typeof useVehicleRequestEditorState>;
export type VehicleRequestCustomerPort = RequestCustomerOptions;
