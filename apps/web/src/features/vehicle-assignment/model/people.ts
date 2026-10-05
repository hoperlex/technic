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

/**
 * What the assignment dialog says about the person: the ESM-2 machinist and the route driver.
 *
 * Kept apart from the dialog, and not because of length. The dialog is form state: ownership
 * branches, defaults, field resets when the request changes. Everything here is wording and values
 * derived from server answers: it decides nothing and looks at nothing but its arguments.
 *
 * The texts sit together also because they know about each other. The machinist field and the
 * route-driver field explain **the same** emptiness in different words: an empty field means "not
 * changed" (ADR 0083), and both texts must name who stays — otherwise the emptiness reads as "no
 * person". Split across files, they would drift in wording too, while the person reads them in a
 * row, in one dialog.
 *
 * No queries and no `Form.useWatch` here: driver lists, the request's waybills and selected values
 * arrive as arguments — otherwise the module would have to be a hook and stop being a set of pure
 * functions about wording.
 */

/**
 * Driver list row. The order is the server's: suitable first — complete documents, then category
 * (ADR 0064, ADR 0055), and inside them those who worked on this vehicle (ADR 0056). The marks in
 * the row explain why the person is where they are — without them the list would look like broken
 * alphabetical order.
 */
export function driverOption(driver: DriverOptionDto): { label: string; value: string } {
  return {
    value: driver.personId,
    label: [
      driver.fullName,
      driver.categories.join(', '),
      driver.personnelNo && `таб. ${driver.personnelNo}`,
      // Gaps are named by the document the person is admitted with by position (ADR 0095): "no
      // driving licence number" and "no tractor licence number" are different papers and people.
      driverDocumentGapsHint(driver.gaps, driver.credentialTypeCode),
      driver.matchesRequiredCategory ? null : DRIVER_CATEGORY_MISMATCH_HINT,
      driverWorkedOnVehicle(driver) ? DRIVER_WORKED_ON_VEHICLE_HINT : null,
      driver.verificationStatus === 'unverified' ? 'документ не проверен' : null,
    ]
      .filter(Boolean)
      .join(' · '),
  };
}

/**
 * Machinist list row — shorter than the driver's, and not for economy. It has no category and no
 * document gaps because the ESM-2 form does not print those boxes (ADR 0095, decision V1): "category
 * mismatch" under a machine that has no categories would name a nonexistent discrepancy.
 */
export function machinistOption(driver: DriverDto): { label: string; value: string } {
  return {
    value: driver.id,
    label: [driver.fullName, driver.personnelNo && `таб. ${driver.personnelNo}`]
      .filter(Boolean)
      .join(' · '),
  };
}

/**
 * Whether the machinist is asked, and whether it is required.
 *
 * Machinists for ESM-2 forms (migration 0087) are the whole driver directory, without any
 * filtering. That is deliberately not the route-driver list: `drivers/available` requires a SNILS,
 * a licence valid on the date and checks the category for the vehicle — all boxes of the 4-P form,
 * without which that form is invalid. ESM-2 has none of them: the statistics office did not lay out
 * licence or SNILS boxes in it, and the portal does not print them there (ADR 0095, decision V1) —
 * even though it now keeps the tractor-operator licence. So any active driver fits, and neither the
 * vehicle nor the date affects the list.
 *
 * The field is asked in both dialog modes. On a vehicle change (ADR 0048) the person changes with
 * the machine more often than not: another unit brings another machinist, and until now they were
 * changed by reissuing forms by hand, although ESM-2 reconciliation can do it itself (migration
 * 0087). Rentals have the field in neither mode: the lessor issues forms for rented equipment, and
 * the portal does not track its machinist.
 *
 * Required when taking into work: the same move issues weekly ESM-2 forms for the whole term, and a
 * form without a person is invalid. Not for a linear order: no forms are born at that moment (ADR
 * 0100 decision 5), so there is nothing to demand a name for. The field stays: the assignment keeps
 * a default machinist — whoever usually works this machine.
 *
 * On a vehicle change — never, and that is not leniency but the meaning of an empty value (ADR
 * 0083): not named means not changed, and reconciliation takes the person from the request's
 * previous form. The only case with nowhere to take them from — the request ran on rented equipment
 * and had no forms at all — the portal does not try to detect from its list (it includes cancelled
 * forms, while reconciliation inherits from the last issued one); the server answers it with a
 * refusal on the field.
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

/**
 * How many forms taking into work will spend and for which weeks: an ESM-2 form is issued for each
 * week of the term (migration 0087), and the person must see that before the click, not learn it
 * from the journal. Computed by the same `esm2Periods` the server issues with.
 *
 * A linear request has no list because it has no spending: taking it into work spends no form
 * (ADR 0100 decision 5). Promising weeks that will not happen is worse than silence.
 *
 * A vehicle change has no list for another reason: it would have to be computed not from the term
 * but from which weeks are already worked and which forms reconciliation touches — the server knows
 * that answer, and the portal says instead what is always true (see `machinistFieldExtra`).
 */
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

/**
 * Whom the request's active ESM-2 forms name — that person stays if the machinist field is left
 * empty. The name is needed exactly for that: an empty field means "not changed", and without a
 * name it would read as "no machinist".
 *
 * The form of the latest week is taken, not the first one found: an ordinary order has one machinist
 * for all weeks (reconciliation rewrites diverging ones), and names differ only where the past is no
 * longer touched — in worked weeks. Cancelled forms do not count: they tell how the request was run
 * before, while the text under the field is about now.
 */
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

/**
 * What is said under the machinist field — a different conversation in each dialog mode.
 *
 * When taking into work the field asks for the person for the first time, and below it stands the
 * price of the answer: how many forms go out and for which weeks.
 *
 * On a vehicle change (ADR 0048) the field is already occupied — by the previous machinist in the
 * forms — but that name must not be filled in (ADR 0083): a filled-in surname reads as a decision
 * taken, gets skimmed over, and goes into the form for real. So the name stands as text, the field
 * stays empty, and the text must explain what the emptiness means: the previous one stays. The
 * cost of a change is named too — ESM-2 reconciliation cancels and reissues forms of unworked weeks
 * and leaves worked ones: they carry the site's signature, and rewriting them retroactively is a
 * different operation (ADR 0101).
 *
 * A linear order is a third conversation: there is no "request machinist" at all — one is named
 * for each week separately (ADR 0100 decision 6), and an empty field leaves each week its own
 * person, not a common one. Naming one person is still possible: reconciliation then brings unworked
 * weeks to them — exactly what it does for an ordinary order.
 */
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

/**
 * What is wrong with the selected driver's category: the vehicle requires one, the person holds
 * others. The mark in the list row is not enough — it is read while choosing and forgotten — and the
 * decision to seat the person stays with the dispatcher (ADR 0055, ADR 0064): the portal forbids
 * nothing but must name both sides of the discrepancy.
 *
 * Both sides name the document type (ADR 0095): the vehicle requirement refers to a category of any
 * document type, and "C required, C held" would otherwise read as a portal bug.
 */
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

/**
 * The second thing wrong with the selected driver: documents the form prints are not entered.
 * Separate from the category rather than one warning: an empty form box and a foreign category are
 * different things — the first is checked in the driver directory, the second against the document
 * in hand.
 *
 * Gaps are named together with the form: an empty box in 4-P and in form No. 3 are different boxes,
 * and "does this concern me" must be clear without leaving the dialog. A relocation's form is always
 * 4-P (migration 0082); a route's form is the one bound to the selected vehicle's type.
 */
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

/**
 * What is said under the driver field of an existing route — a different conversation than for a
 * new one.
 *
 * For a new route the field asks "who drives", and there is no route without an answer. An existing
 * route already has a person, and the question becomes "replace whoever drives" (ADR 0048). The
 * previous name is not filled into the field (ADR 0083) — a filled-in surname reads as a decision
 * taken, gets skimmed over and goes into the form for real; so the name stands as text and the
 * field's emptiness is explained in words, otherwise it reads as "no driver".
 *
 * Removing the driver is described exactly at its cost. The contract accepts `null`, but the dialog
 * does not offer it: the route is shared, and "remove" here would leave other requests without a
 * driver too. That decision is made by editing the route, where its whole composition is visible
 * (ADR 0082) — and the person must learn the way there from here instead of guessing why the field
 * has no empty item.
 */
export function joinedRouteDriverExtra(route: VehicleRouteDto | null): string | null {
  if (!route) return null;
  return route.driverName
    ? `Сейчас за рулём ${route.driverName} — оставьте пустым, чтобы он и остался. Снимают водителя правкой маршрута; здесь его только меняют.`
    : 'За рулём этого рейса пока никого — оставьте пустым, и рейс так и останется без водителя: лист по нему не выписать, пока человека не назначат.';
}

/**
 * Warning that the driver changes for the whole route.
 *
 * The composition is named request by request, not as a count. A route travels as one task, and its
 * driver is one for all requests: the change affects other people's orders. The route list shows
 * only "3 of 7 requests", not whose, and "changed the driver of my request" would turn out to change
 * it for the neighbours. Request numbers give what a counter does not: whom to call if the decision
 * is disputed.
 *
 * Shown while the route is an existing one, not only once a name is chosen: the composition matters
 * while the person is still being chosen — otherwise the consequence would be learned after the
 * click. With a name chosen the note becomes a warning: the decision now has a cost, and the
 * previous driver leaves the route.
 */
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
  // The leaving driver is named: "the previous driver" says nothing to someone who did not build
  // the route, and the decision is about a specific person.
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
