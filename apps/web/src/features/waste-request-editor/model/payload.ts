import dayjs from 'dayjs';
import {
  isManualCostOnly,
  isPricedRequestType,
  normalizeTimeInput,
  requesterSelectsWasteType,
  requiresOrderedVolume,
  serviceWasteTypeCode,
  usesContainerGroup,
  type RequestType,
  type WasteRequestDto,
} from '@technic/contracts';
import {
  parseContainerGroupKey,
  type WasteRequestPayload,
  type WasteRequestUpdatePayload,
} from '@entities/waste-request';
import { MOSCOW_TZ } from '@shared/config';
import type { WasteRequestFormValues } from './types';

/**
 * Which subject fields a request type shows. Each field answers its own contract question
 * (snow-removal plan, §2): garbage and snow share the ordered volume but not the waste type picker,
 * and only garbage has a price list. A single "is it removal" flag would hand snow the garbage
 * picker and tariff lookup, or take the volume away from it.
 */
export interface SubjectFields {
  /** Installation brings its own container and picks the type from the directory. */
  containerType: boolean;
  /** Replacement and removal pick a container standing on the site as a "type + owner" group. */
  containerGroup: boolean;
  wasteType: boolean;
  volume: boolean;
  /** The price list is asked for an estimate (ADR 0009). */
  tariff: boolean;
  /** «Стоимость вносится при закрытии заявки»: money is entered by hand at completion (S6). */
  costAtCompletion: boolean;
}

export function subjectFields(type: RequestType | undefined): SubjectFields {
  if (!type) {
    return {
      containerType: false,
      containerGroup: false,
      wasteType: false,
      volume: false,
      tariff: false,
      costAtCompletion: false,
    };
  }
  return {
    containerType: type === 'container_install',
    containerGroup: usesContainerGroup(type),
    wasteType: requesterSelectsWasteType(type),
    volume: requiresOrderedVolume(type),
    tariff: isPricedRequestType(type),
    costAtCompletion: isManualCostOnly(type),
  };
}

/**
 * The form values with the fields of other request types dropped. antd keeps the value of an
 * unmounted field, so after a type switch the form still holds what the previous type showed;
 * the payload, the local draft and its restore all pass through here, so a hidden waste type or
 * container never travels with snow and a draft restores exactly what the person could see.
 */
export function withoutHiddenFields<Values extends Partial<WasteRequestFormValues>>(
  values: Values,
): Values {
  const fields = subjectFields(values.requestType);
  const next = { ...values };
  if (!fields.containerType) delete next.containerTypeId;
  if (!fields.containerGroup) {
    delete next.containerGroupKey;
    delete next.ownerMismatchReason;
  }
  if (!fields.wasteType) delete next.wasteTypeId;
  if (!fields.volume) delete next.volumeM3;
  return next;
}

/** Fields both bodies share; the subject is decided by the type, never by what the form kept. */
function commonBody(values: WasteRequestFormValues) {
  const visible = withoutHiddenFields(values);
  const fields = subjectFields(visible.requestType);
  // Date and time are composed in Moscow time, the zone in which the server checks the working
  // window. No time means Moscow midnight plus the unspecified flag: a request "for the day".
  const time = normalizeTimeInput(visible.deliveryTime ?? '');
  const deliveryAt = dayjs.tz(
    `${visible.deliveryDate.format('YYYY-MM-DD')} ${time ?? '00:00'}`,
    MOSCOW_TZ,
  );
  const group = visible.containerGroupKey
    ? parseContainerGroupKey(visible.containerGroupKey)
    : null;
  return {
    fields,
    group,
    body: {
      objectId: visible.objectId,
      requestType: visible.requestType,
      containerTypeId: fields.containerGroup ? group?.containerTypeId : visible.containerTypeId,
      containersCount: fields.containerGroup ? (visible.containersCount ?? 1) : 1,
      // The reason is sent only with a mismatch: matching parties have no reason field.
      ownerMismatchReason: fields.containerGroup ? visible.ownerMismatchReason : undefined,
      deliveryAt: deliveryAt.toISOString(),
      deliveryTimeUnspecified: time === undefined,
      responsibleName: visible.responsibleName!,
      responsiblePhone: visible.responsiblePhone!,
      comment: visible.comment ?? '',
    },
    visible,
  };
}

/**
 * Body of `POST /waste-requests`. Snow sends its ordered volume and no waste type: the server sets
 * the service type «Снег» and would discard a sent one anyway (S2). `operatorCounterpartyId` is
 * sent only for a counterparty-scoped creator, who may file only for their own organisation.
 */
export function createPayload(
  values: WasteRequestFormValues,
  input: { fileIds: string[]; ownOperatorId?: string },
): WasteRequestPayload {
  const { fields, group, body, visible } = commonBody(values);
  return {
    ...body,
    containerOwnerCounterpartyId: fields.containerGroup
      ? (group?.ownerCounterpartyId ?? undefined)
      : undefined,
    wasteTypeId: fields.wasteType ? visible.wasteTypeId : undefined,
    volumeM3: fields.volume ? visible.volumeM3 : undefined,
    operatorCounterpartyId: input.ownOperatorId,
    fileIds: input.fileIds,
  };
}

/**
 * Body of `PATCH /waste-requests/:id`, where an omitted field means "unchanged". Fields a type does
 * not have are therefore sent as explicit null (a container operation keeps no waste type or
 * volume, a type without a group keeps no owner), except the snow waste type: it is the server's
 * to set, and the portal omits it rather than asking to clear it.
 */
export function updatePayload(
  values: WasteRequestFormValues,
  record: WasteRequestDto,
  input: { addFileIds: string[]; removeFileIds: string[]; operator: 'send' | 'omit' },
): WasteRequestUpdatePayload {
  const { fields, group, body, visible } = commonBody(values);
  return {
    ...body,
    containerOwnerCounterpartyId: fields.containerGroup
      ? (group?.ownerCounterpartyId ?? null)
      : null,
    wasteTypeId: fields.wasteType
      ? (visible.wasteTypeId ?? null)
      : serviceWasteTypeCode(visible.requestType)
        ? undefined
        : null,
    volumeM3: fields.volume ? (visible.volumeM3 ?? null) : null,
    // An empty field from a dispatcher means "remove the executor": that is null, not "leave".
    operatorCounterpartyId:
      input.operator === 'send' ? (visible.operatorCounterpartyId ?? null) : undefined,
    addFileIds: input.addFileIds,
    removeFileIds: input.removeFileIds,
    version: record.version,
  };
}
