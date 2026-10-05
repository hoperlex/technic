import { Checkbox, Form, Typography } from 'antd';
import type { HitchedTrailerDto } from '@technic/contracts';
import { FormGrid } from '@shared/ui';
import {
  graphsAreHitched,
  hitchedTrailerNote,
  TRACTOR_TRAILER_HINT,
  type TrailerGraphs,
} from '@entities/vehicle-route';
import { TrailerSlot } from './TrailerSlot';
import { useTrailerGraphs } from '../model/useTrailerGraphs';

/**
 * Trailer boxes in a route form: the "with trailer" checkbox, two "make / plate" pairs below it and
 * a caption saying where the boxes came from.
 *
 * One block for the five route-creating dialogs — route edit, taking a request into work, backdated
 * correction, a linear order day and "New route". Keeping copies already backfired: the second box
 * pair was added by copying, and in the assignment dialog it stayed on screen only — half the
 * composition reached the server. The form has one box, and it must be asked by one piece of code.
 *
 * **Why two pairs.** The 4-P holds two trailers, and their columns were in the database since
 * waybills existed. There was nowhere to ask them, and a two-trailer composition reached the paper
 * by half. Order is mandatory — the server rejects a second trailer with an empty first one
 * (`docs/vehicle-trailers-plan.md`, §4.6).
 *
 * **The default lives here, not in the dialogs.** The rule of reading the hitch is one for all
 * dialogs (§4.2.2), and spread across five forms it would drift on the first edit. Here it also
 * switches off by itself where the trailer is not asked: the block is not rendered — nowhere to
 * fill.
 *
 * **Where the block is not shown.** Form No. 3 has no trailer boxes at all (ADR 0071), so the
 * trailer is asked only where it is printed. The calling dialog decides: it knows the route form,
 * and the assignment has its own condition anyway ("an existing route has its own departure
 * details").
 *
 * Labels and hints differ per dialog on purpose and come as props: the correction speaks of the
 * route in the past tense, and examples differ per dialog — rewriting them along with the
 * extraction would change the screen under a refactoring pretext.
 *
 * The box pair itself lives next door (`TrailerSlot.tsx`): here is the rule of what goes into the
 * boxes and when, there is how they are shown and switched. The split follows meaning: the rule is
 * read with the plan, the display with the screen.
 */
export function TrailerFields({
  withTrailer,
  checkboxLabel,
  checkboxFullWidth = false,
  modelPlaceholder,
  regNumberPlaceholder,
  secondPlaceholder,
  hitched,
  vehicleId,
  vehicleTypeId,
  keepOwnGraphs = false,
  substituteOnOpen = true,
  record,
  asks = true,
}: {
  /**
   * The checkbox state as the form sees it right now (`Form.useWatch('withTrailer', form)`). A
   * prop, not an own watch: the dialog needs the same value for the driver list — with a trailer
   * the requirement rises to CE, and the list is rebuilt (ADR 0055, ADR 0064).
   */
  withTrailer: boolean;
  /**
   * Checkbox label: the correction describes a day that already happened and speaks in the past
   * tense.
   */
  checkboxLabel: string;
  /**
   * The checkbox takes the whole row. In edit and correction it does; in the assignment it does
   * not: there it pairs with a neighbouring field, and moving it to its own row would rearrange the
   * form.
   */
  checkboxFullWidth?: boolean;
  /** Example make of the first trailer — per dialog, by the vehicles ordered there. */
  modelPlaceholder: string;
  /** Example plate of the first trailer. */
  regNumberPlaceholder: string;
  /** Placeholder of both second-trailer boxes: it also says the pair is optional. */
  secondPlaceholder: string;
  /**
   * Trailers hitched to the vehicle — the `hitched` field of `GET /vehicle-routes/suggest`.
   * `undefined` — no answer yet (too early to fill); an empty array — no hitch, and such a vehicle
   * never gets a new default at all (§4.2.2, item 2).
   */
  hitched?: readonly HitchedTrailerDto[];
  /**
   * The vehicle whose hitch was asked: its change is a reason to fill again.
   *
   * A change of the **vehicle in the form** and a change of the **record the dialog shows** are
   * different events with the same trace in this prop, and there is no way to tell them apart from
   * inside. So dialogs that outlive one record (all five — antd does not unmount a closed dialog)
   * give the block a `key` by record id: another route, another day, another request — another
   * block instance with a clean memory of what it filled.
   */
  vehicleId?: string | null;
  /** This vehicle's type: the checkbox is set for a tractor unit by it (§4.4 (a)). */
  vehicleTypeId?: string | null;
  /**
   * Do not displace what the record already describes: that is how the route edit dialog opens —
   * its boxes came from the route itself, and overwriting them with the hitch would replace the
   * record the person opened to edit.
   *
   * "Described" means filled boxes **or** an unticked checkbox (R20): a route without a trailer is
   * described as definitely as a route with a semi-trailer. A ticked checkbox with empty boxes
   * describes nothing, and the edit must fill the hitch into them — otherwise a tractor unit, whose
   * checkbox sets itself, would stay with empty boxes forever.
   */
  keepOwnGraphs?: boolean;
  /**
   * Whether to fill for the vehicle the dialog opened with. The correction says "no": it rewrites a
   * **day that already happened**, and today's hitch knows nothing about last Tuesday — while
   * filling it changes the form by itself and passes the "a correction must change something" check
   * (R31), burning a form number for an edit the person did not make. A vehicle change inside a
   * correction is different: the boxes no longer describe that unit, and the new one's hitch is the
   * best the portal knows about it.
   */
  substituteOnOpen?: boolean;
  /**
   * Boxes of the route the dialog opened to edit — the **form readiness barrier** (R21).
   *
   * The default waits until the form boxes match them: the block's effects run before the dialog's
   * filling effect, and before the barrier the decision was taken by a form still holding the
   * **previous record** — having read someone else's "no trailer", the default stayed silent,
   * marked the source as applied and never came back to the decision. The dialog outlives the
   * record (antd does not unmount a closed one), so "previous" is not rare — it is the second route
   * opened in a row.
   *
   * It waits only until the vehicle changes: after that the boxes describe another unit, and there
   * is nothing to compare the form with — the change itself decides.
   *
   * Record-creating dialogs do not edit and do not pass the prop: there is nothing to compare with.
   */
  record?: TrailerGraphs | null;
  /**
   * Whether to ask the trailer at all. `false` — the selected vehicle's form does not print it
   * (form No. 3, ADR 0071) or the route's departure details are its own: the block is not rendered,
   * **and the boxes are cleared**.
   *
   * A prop, not a condition at the call site: rc-field-form keeps hidden fields (`preserve`), and a
   * block taken off screen would take only the question with it, not the answer — the previous
   * vehicle's semi-trailer would silently go into the route body. The condition moved here
   * entirely, so clearing cannot be forgotten in the next dialog.
   */
  asks?: boolean;
}) {
  const form = Form.useFormInstance();
  const trailer1Model = Form.useWatch('trailer1Model', form);
  const trailer1RegNumber = Form.useWatch('trailer1RegNumber', form);
  const trailer2Model = Form.useWatch('trailer2Model', form);
  const trailer2RegNumber = Form.useWatch('trailer2RegNumber', form);
  const graphs: TrailerGraphs = {
    withTrailer,
    trailer1Model: trailer1Model ?? '',
    trailer1RegNumber: trailer1RegNumber ?? '',
    trailer2Model: trailer2Model ?? '',
    trailer2RegNumber: trailer2RegNumber ?? '',
  };

  /*
   * Default, clearing and the tractor checkbox live next door (`useTrailerGraphs`). Markup stays
   * here: the rule and its order are read with the plan, the box pair with the screen. The hook is
   * called **before** the refusal to render (`asks`): it also clears the boxes, and a hook skipped
   * together with the markup would leave another vehicle's trailer in the form.
   */
  const { modes, setMode, isTractor, noteWithTrailerTouched } = useTrailerGraphs({
    form,
    asks,
    hitched,
    vehicleId,
    vehicleTypeId,
    keepOwnGraphs,
    substituteOnOpen,
    record,
    watched: graphs,
  });

  /**
   * The caption speaks of what the boxes hold **now**, not of what the portal once filled: if the
   * person typed another trailer, the caption goes away and has nothing to lie about.
   */
  const note = graphsAreHitched(hitched, graphs)
    ? hitchedTrailerNote(hitched)
    : isTractor && withTrailer
      ? TRACTOR_TRAILER_HINT
      : null;

  const checkbox = (
    <Form.Item name="withTrailer" valuePropName="checked">
      {/* Our `onChange` lives next to the form's own: `Form.Item` wraps it rather than replacing
        it. It raises the "the person touched the checkbox" barrier — after that the tractor default
        stays silent. */}
      <Checkbox onChange={noteWithTrailerTouched}>{checkboxLabel}</Checkbox>
    </Form.Item>
  );

  // No question — no markup. Placed **after** the hook: the hook clears the boxes, and skipped
  // together with the markup it would leave another vehicle's trailer in the form.
  if (!asks) return null;

  return (
    <>
      {checkboxFullWidth ? <FormGrid.Full>{checkbox}</FormGrid.Full> : checkbox}
      {withTrailer && (
        <>
          <TrailerSlot
            slot={1}
            mode={modes.slot1}
            onMode={(mode) => setMode(1, mode)}
            modelPlaceholder={modelPlaceholder}
            regNumberPlaceholder={regNumberPlaceholder}
            vehicleId={vehicleId}
          />
          <TrailerSlot
            slot={2}
            mode={modes.slot2}
            onMode={(mode) => setMode(2, mode)}
            modelPlaceholder={secondPlaceholder}
            regNumberPlaceholder={secondPlaceholder}
            vehicleId={vehicleId}
            // One unit does not stand in two boxes: the second slot does not offer what is already
            // in the first (§13.6). By plate, not id: the plate is what the boxes hold, and the
            // rule works the same whether the trailer was picked from the list or typed by hand.
            excludeRegNumber={trailer1RegNumber}
          />
          {note && (
            <FormGrid.Full>
              <Typography.Text type="secondary">{note}</Typography.Text>
            </FormGrid.Full>
          )}
        </>
      )}
    </>
  );
}
