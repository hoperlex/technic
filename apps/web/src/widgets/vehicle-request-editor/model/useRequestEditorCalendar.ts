import type { FormInstance } from 'antd';
import { Form } from 'antd';
import type { Dayjs } from 'dayjs';
import {
  canShortenWorkPeriodByEdit,
  moscowDateKeyOf,
  movedRequestDateKey,
  type RequestCalendar,
  type VehicleRequestDto,
  type VehicleRequestType,
} from '@technic/contracts';
import { vehicleRequestDateRules } from '@entities/vehicle-request';
import type { FormValues } from '@features/vehicle-request-editor';
import { calendarDaysLabel } from '@shared/lib';

interface Input {
  form: FormInstance<FormValues>;
  isSpecial: boolean;
  record: VehicleRequestDto | null;
  requestType: VehicleRequestType | undefined;
  user: Parameters<typeof vehicleRequestDateRules>[0];
}

/**
 * Calendar side of the request editor: date limits, the term hint, the backdate boundary and the
 * shortening lock. Split from `useVehicleRequestEditorState` only to keep that file within the
 * length budget; the editor state remains its only caller.
 */
export function useRequestEditorCalendar({ form, isSpecial, record, requestType, user }: Input) {
  // Term length hint: an empty end date is a one-day term (the server reads it the same way). The
  // request card shows the same hint.
  const dateFrom = Form.useWatch('dateFrom', form);
  const dateTo = Form.useWatch('dateTo', form);
  const periodHint = dateFrom
    ? calendarDaysLabel(dateFrom.format('YYYY-MM-DD'), dateTo?.format('YYYY-MM-DD'))
    : null;
  // Request date limits (ADR 0104): the earliest available day depends on who creates the request
  // and is the same in the form as on the server — details live with the rule itself.
  const { minDate, disabledDate: minDateRule, leadTimeHint } = vehicleRequestDateRules(user);

  /*
   * Backdating (ADR 0101, R6 and R15): whether the chosen date goes into the past and by which
   * boundary. The contract computes it (`movedRequestDateKey`) — the same one the server uses to
   * decide whether to demand the permission. If they diverged, the form would either require a
   * reason where the handler does not expect one, or silently send an edit that gets 403.
   *
   * For an edit the effective date is the earliest **moved** boundary, not just "the request date":
   * a yesterday's request may have its phone or comment edited, and that is not a correction.
   */
  const scheduledDate = Form.useWatch('scheduledDate', form);
  const formCalendar: RequestCalendar = isSpecial
    ? {
        dateFrom: dateFrom?.format('YYYY-MM-DD'),
        dateTo: dateTo ? dateTo.format('YYYY-MM-DD') : null,
      }
    : { scheduledDay: scheduledDate?.format('YYYY-MM-DD') };
  // Conversion to another type (ADR 0091) goes through its own handler with no date boundary: a
  // request created yesterday may be converted today, and demanding the correction permission for
  // that would mean changing the order just to change its kind. Calendars of different types have
  // different fields and nothing to compare anyway.
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
  // The past is measured in Moscow time, like the server: a dispatcher east of Moscow has their own
  // "today", and by it the boundary would diverge from the handler's answer.
  const backdated =
    !retyping && !!effectiveDateKey && effectiveDateKey < moscowDateKeyOf(new Date());

  // A running request's term is only extended by an edit: shortening goes through an early end
  // with approval (ADR 0044), and the server rejects a direct edit.
  const dateToLocked =
    !!record &&
    record.requestType === 'special_equipment' &&
    !canShortenWorkPeriodByEdit(record.status);
  const currentLastDay =
    record?.requestType === 'special_equipment' ? record.dateTo || record.dateFrom : null;
  const isBeforeCurrentDateTo = (day: Dayjs) =>
    !!currentLastDay && day.format('YYYY-MM-DD') < currentLastDay;

  return {
    backdated,
    dateToLocked,
    effectiveDateKey,
    formCalendar,
    isBeforeCurrentDateTo,
    leadTimeHint,
    minDate,
    minDateRule,
    periodHint,
  };
}
