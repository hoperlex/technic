import type { Dayjs } from 'dayjs';
import {
  DRIVER_CATEGORY_MISMATCH_HINT,
  DRIVER_WORKED_ON_VEHICLE_HINT,
  driverCategoryMismatchWarning,
  driverDocumentGapsHint,
  driverDocumentGapsWarning,
  driverWorkedOnVehicle,
  esm2Periods,
  type DriverDto,
  type DriverOptionDto,
  type DriverSelectionDto,
  type Esm2Period,
  type RequestWaybillDto,
  type VehicleRequestType,
  type VehicleRouteDto,
  type WaybillFormCode,
  waybillFormShortLabels,
} from '@technic/contracts';
import { formatDateOnly } from '@shared/lib';

/** Preserve the server's ordering while explaining every degraded driver match in the label. */
export function driverOption(driver: DriverOptionDto): { label: string; value: string } {
  return {
    value: driver.personId,
    label: [
      driver.fullName,
      driver.categories.join(', '),
      driver.personnelNo && `таб. ${driver.personnelNo}`,
      driverDocumentGapsHint(driver.gaps, driver.credentialTypeCode),
      driver.matchesRequiredCategory ? null : DRIVER_CATEGORY_MISMATCH_HINT,
      driverWorkedOnVehicle(driver) ? DRIVER_WORKED_ON_VEHICLE_HINT : null,
      driver.verificationStatus === 'unverified' ? 'документ не проверен' : null,
    ]
      .filter(Boolean)
      .join(' · '),
  };
}

/** ESM-2 has no driving-licence fields, so machinist options intentionally omit those warnings. */
export function machinistOption(driver: DriverDto): { label: string; value: string } {
  return {
    value: driver.id,
    label: [driver.fullName, driver.personnelNo && `таб. ${driver.personnelNo}`]
      .filter(Boolean)
      .join(' · '),
  };
}

/**
 * Own special equipment asks for a machinist. It is required only when confirmation immediately
 * issues weekly ESM-2 sheets; reassignment and linear work preserve an intentional empty value.
 */
export function machinistFieldMode(input: {
  isLinear: boolean;
  isRental: boolean;
  reassign: boolean;
  requestType: VehicleRequestType | undefined;
}): { machinistRequired: boolean; needsMachinist: boolean } {
  const needsMachinist = input.requestType === 'special_equipment' && !input.isRental;
  return {
    needsMachinist,
    machinistRequired: needsMachinist && !input.reassign && !input.isLinear,
  };
}

/** List only the weekly sheets that confirmation will actually issue. */
export function plannedEsm2Weeks(input: {
  dateFrom: Dayjs | null | undefined;
  dateTo: Dayjs | null | undefined;
  isLinear: boolean;
  needsMachinist: boolean;
  reassign: boolean;
}): Esm2Period[] {
  if (!input.needsMachinist || input.reassign || input.isLinear) return [];
  const from = input.dateFrom?.format('YYYY-MM-DD');
  if (!from) return [];
  return esm2Periods(from, input.dateTo?.format('YYYY-MM-DD') ?? null);
}

/** The latest active ESM-2 sheet defines whom an omitted reassignment keeps. */
export function currentMachinistName(waybills: RequestWaybillDto[] | undefined): string | null {
  return (
    (waybills ?? [])
      .filter((waybill) =>
        Boolean(waybill.formCode === 'esm2' && waybill.status === 'issued' && waybill.periodFrom),
      )
      .sort((left, right) => right.periodFrom!.localeCompare(left.periodFrom!))[0]?.driverName ??
    null
  );
}

/** Explain the meaningful empty machinist value and the paper affected by a new choice. */
export function machinistFieldExtra(input: {
  currentMachinist: string | null;
  esm2Weeks: Esm2Period[];
  isLinear: boolean;
  reassign: boolean;
}): string {
  const { reassign, isLinear, currentMachinist, esm2Weeks } = input;
  return reassign
    ? isLinear
      ? 'У линейного заказа машинист свой в каждом недельном листе: оставьте пустым — каждая неделя останется со своим. Выберете человека — листы неотработанных недель будут перевыписаны на него.'
      : currentMachinist
        ? `Сейчас в листах — ${currentMachinist}; оставьте пустым, чтобы он остался. Выберете другого — листы ЭСМ-2 неотработанных недель будут перевыписаны на него, отработанные останутся как есть.`
        : 'Действующих листов ЭСМ-2 у заявки нет — машиниста называют впервые: на него выпишутся листы неотработанных недель. Оставите пустым — человек возьмётся с последнего листа заявки, а если листов не было вовсе (её вели арендной техникой), портал попросит назвать имя.'
    : isLinear
      ? 'Необязательно: листов ЭСМ-2 перевод в работу не выписывает'
      : esm2Weeks.length > 0
        ? `Будет выписано листов ЭСМ-2: ${esm2Weeks.length} — ${esm2Weeks
            .map(
              (week) =>
                `${formatDateOnly(week.from).slice(0, 5)}–${formatDateOnly(week.to).slice(0, 5)}`,
            )
            .join(', ')}`
        : 'На каждую неделю срока работ выписывается свой путевой лист';
}

export function driverCategoryNote(
  selection: DriverSelectionDto | undefined,
  driver: DriverOptionDto | undefined,
): string | null {
  return selection?.requiredCategory &&
    selection.requiredCategoryType &&
    driver &&
    !driver.matchesRequiredCategory
    ? driverCategoryMismatchWarning(
        selection.requiredCategory,
        selection.requiredCategoryType,
        driver.categories,
        driver.credentialTypeCode,
      )
    : null;
}

export function driverGapsNote(
  driver: DriverOptionDto | undefined,
  formCode: WaybillFormCode | null,
): string | null {
  return driver
    ? driverDocumentGapsWarning(
        driver.gaps,
        driver.credentialTypeCode,
        formCode ? waybillFormShortLabels[formCode] : null,
      )
    : null;
}

/** An empty driver field on an existing route means "keep its current driver". */
export function joinedRouteDriverExtra(route: VehicleRouteDto | null): string | null {
  if (!route) return null;
  return route.driverName
    ? `Сейчас за рулём ${route.driverName} — оставьте пустым, чтобы он и остался. Снимают водителя правкой маршрута; здесь его только меняют.`
    : 'За рулём этого рейса пока никого — оставьте пустым, и рейс так и останется без водителя: лист по нему не выписать, пока человека не назначат.';
}

/** A route driver is shared by every request in its task table. */
export function joinedRouteDriverNote(
  route: VehicleRouteDto | null,
  driverPersonId: string | undefined,
): { description: string; message: string; type: 'info' | 'warning' } | null {
  const composition = route
    ? route.requests.length > 0
      ? `Заявок в рейсе: ${route.requests.length} — ${route.requests.map((request) => request.displayNumber).join(', ')}`
      : 'Других заявок в рейсе пока нет'
    : null;
  if (!route || !composition) return null;
  const leaving = route.driverName ? `, а ${route.driverName} из рейса уйдёт` : '';
  return driverPersonId
    ? {
        type: 'warning',
        message: 'Водитель сменится у всего рейса',
        description: `Рейс ${route.displayNumber} едет одним заданием: выбранный водитель поедет за весь его состав, а не за одну эту заявку${leaving}. ${composition}.`,
      }
    : {
        type: 'info',
        message: 'Водитель у рейса один на все заявки',
        description: `Рейс ${route.displayNumber} едет одним заданием, и смена водителя коснётся каждой заявки в нём. ${composition}.`,
      };
}
