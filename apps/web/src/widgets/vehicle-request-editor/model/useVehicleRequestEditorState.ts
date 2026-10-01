import { useMemo, useState } from 'react';
import { Form } from 'antd';
import type { Dayjs } from 'dayjs';
import { useQuery } from '@tanstack/react-query';
import {
  allowedVehicleRequestTypes,
  canOrderVehicleRequestType,
  canShortenWorkPeriodByEdit,
  costTargetKeyOf,
  costTargetOf,
  isCargoAmountRequired,
  isVehicleKindAllowedForRequest,
  moscowDateKeyOf,
  movedRequestDateKey,
  requestTypeChangeBlocker,
  type RequestCalendar,
  type VehicleRequestDto,
  type VehicleRequestType,
  vehicleRequestTypeLabels,
} from '@technic/contracts';
import { departmentPlatformQuery } from '@entities/department';
import { useAuth, usePlaceObjectScope } from '@entities/session';
import { vehicleRequestDateRules } from '@entities/vehicle-request';
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
  type TripFormValue,
} from '@features/vehicle-request-editor';
import { calendarDaysLabel, withSavedOption } from '@shared/lib';
import { useFileEditor, type EditorFile } from '../ui/editorFields';

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

const SPECIAL_FIELDS = ['dateFrom', 'dateTo', 'responsibleName', 'responsiblePhone'] as const;
// Addresses, cargo and contacts are nested in trips, so switching kind clears the list atomically.
const FREIGHT_FIELDS = ['scheduledDate', 'scheduledTime', 'trips'] as const;

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
  const [copy, setCopy] = useState<CopySource | null>(null);
  const [tripsExpanded, setTripsExpanded] = useState(false);
  const [operationId, setOperationId] = useState(() => crypto.randomUUID());
  const [form] = Form.useForm<FormValues>();
  const files = useFileEditor();

  // The request kind drives both the field set and the customer axes.
  const requestType = Form.useWatch('requestType', form);
  const isSpecial = requestType === 'special_equipment';
  const isFreight = requestType === 'freight_transport';
  const savedTarget = open && record ? costTargetOf(record) : null;
  const savedCustomer = savedTarget
    ? { target: savedTarget, label: `${savedTarget.code} — ${savedTarget.name}` }
    : null;
  const customer = useRequestCustomerOptions({
    objects: isSpecial ? 'place' : 'scope',
    departments: isSpecial ? 'none' : 'scope',
    saved: savedCustomer,
  });
  const customerLocked = !!record && record.status !== 'new';

  // Suggestions prefer the request place, then every department place, then the account scope.
  const formCustomer = customer.customerPairOf(Form.useWatch('customerKey', form));
  const { data: departmentPlatforms } = useQuery(departmentPlatformQuery());
  const suggestObjectIds = useMemo(() => {
    const departmentObjectIds = formCustomer.departmentId
      ? (departmentPlatforms?.get(formCustomer.departmentId) ?? [])
      : [];
    const ids = [formCustomer.objectId, ...departmentObjectIds, ...ownPlaceObjectIds];
    return [...new Set(ids.filter((id): id is string => !!id))];
  }, [formCustomer.objectId, formCustomer.departmentId, departmentPlatforms, ownPlaceObjectIds]);

  const formRequestTypeOptions = withSavedOption(requestTypeOptions, {
    id: record?.requestType,
    name: record ? vehicleRequestTypeLabels[record.requestType] : null,
  });
  const recordKindCode = record
    ? (classificationByKey.get(classificationKeyOf(record))?.kindCode ?? null)
    : null;
  const otherRequestType: VehicleRequestType | null = record
    ? record.requestType === 'special_equipment'
      ? 'freight_transport'
      : 'special_equipment'
    : null;
  const retypeBlocker =
    record && otherRequestType
      ? requestTypeChangeBlocker(record, recordKindCode, otherRequestType)
      : undefined;
  const canRetype =
    retypeBlocker === null &&
    !!otherRequestType &&
    canOrderVehicleRequestType(user, otherRequestType);

  const recordTrips = record?.requestType === 'freight_transport' ? record.trips : null;
  const classificationKey = Form.useWatch('classificationKey', form);
  const cargoRequired = isCargoAmountRequired(
    (classificationKey ? classificationByKey.get(classificationKey)?.waybillFormCode : null) ??
      null,
  );
  const dateFrom = Form.useWatch('dateFrom', form);
  const dateTo = Form.useWatch('dateTo', form);
  const periodHint = dateFrom
    ? calendarDaysLabel(dateFrom.format('YYYY-MM-DD'), dateTo?.format('YYYY-MM-DD'))
    : null;
  const { minDate, disabledDate: minDateRule, leadTimeHint } = vehicleRequestDateRules(user);

  // The same calendar comparison as the API decides whether a correction reason is required.
  const scheduledDate = Form.useWatch('scheduledDate', form);
  const formCalendar: RequestCalendar = isSpecial
    ? {
        dateFrom: dateFrom?.format('YYYY-MM-DD'),
        dateTo: dateTo ? dateTo.format('YYYY-MM-DD') : null,
      }
    : { scheduledDay: scheduledDate?.format('YYYY-MM-DD') };
  const retyping = !!record && record.requestType !== requestType;
  const recordCalendar: RequestCalendar | null =
    !record || retyping
      ? null
      : record.requestType === 'freight_transport'
        ? { scheduledDay: moscowDateKeyOf(new Date(record.scheduledAt)) }
        : { dateFrom: record.dateFrom, dateTo: record.dateTo };
  const effectiveDateKey = recordCalendar
    ? movedRequestDateKey(recordCalendar, formCalendar)
    : (formCalendar.dateFrom ?? formCalendar.scheduledDay ?? null);
  const backdated =
    !retyping && !!effectiveDateKey && effectiveDateKey < moscowDateKeyOf(new Date());

  const dateToLocked =
    !!record &&
    record.requestType === 'special_equipment' &&
    !canShortenWorkPeriodByEdit(record.status);
  const currentLastDay =
    record?.requestType === 'special_equipment' ? record.dateTo || record.dateFrom : null;
  const isBeforeCurrentDateTo = (day: Dayjs) =>
    !!currentLastDay && day.format('YYYY-MM-DD') < currentLastDay;
  const relocationsEditable =
    !!record &&
    record.requestType === 'special_equipment' &&
    record.status === 'confirmed' &&
    record.assignment?.ownership === 'own' &&
    canChangeStatus;
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

  const handleRequestTypeChange = (next: VehicleRequestType) => {
    const key: string | undefined = form.getFieldValue('classificationKey');
    const kindCode = key ? classificationByKey.get(key)?.kindCode : undefined;
    if (kindCode && !isVehicleKindAllowedForRequest(next, kindCode)) {
      form.resetFields(['classificationKey']);
    }
    const trips: TripFormValue[] | undefined = form.getFieldValue('trips');
    if (next === 'special_equipment') {
      if (customer.customerPairOf(form.getFieldValue('customerKey')).departmentId) {
        form.resetFields(['customerKey']);
      }
      const previousDate: Dayjs | undefined = form.getFieldValue('scheduledDate');
      const name = trips?.[0]?.toResponsibleName;
      const phone = trips?.[0]?.toResponsiblePhone;
      form.resetFields([...FREIGHT_FIELDS]);
      form.setFieldsValue({
        dateFrom: form.getFieldValue('dateFrom') ?? previousDate ?? minDate,
        responsibleName: form.getFieldValue('responsibleName') || name,
        responsiblePhone: form.getFieldValue('responsiblePhone') || phone,
      });
      return;
    }
    const previousDate: Dayjs | undefined = form.getFieldValue('dateFrom');
    const name: string | undefined = form.getFieldValue('responsibleName');
    const phone: string | undefined = form.getFieldValue('responsiblePhone');
    form.resetFields([...SPECIAL_FIELDS]);
    const [first = blankTrip(), ...rest] = trips ?? [];
    form.setFieldsValue({
      scheduledDate: form.getFieldValue('scheduledDate') ?? previousDate ?? minDate,
      trips: [
        {
          ...first,
          toResponsibleName: first.toResponsibleName || name,
          toResponsiblePhone: first.toResponsiblePhone || phone,
        },
        ...rest,
      ],
    });
  };

  const resetWindow = () => {
    form.resetFields();
    setOperationId(crypto.randomUUID());
  };
  const openCreate = () => {
    setRecord(null);
    setCopy(null);
    resetWindow();
    if (customer.soleCustomerKey) form.setFieldsValue({ customerKey: customer.soleCustomerKey });
    if (requestTypeOptions.length === 1) {
      form.setFieldsValue({ requestType: requestTypeOptions[0]!.value });
    }
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
  const openCopy = (request: VehicleRequestDto) => {
    const today = moscowDateKeyOf(new Date());
    setRecord(null);
    setCopy({ source: request, minDate, today });
    resetWindow();
    setTripsExpanded(tripsNeedExpanding(request));
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
