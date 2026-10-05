import { useEffect, useRef, useState } from 'react';
import type { FormInstance } from 'antd';
import { useQuery } from '@tanstack/react-query';
import type { HitchedTrailerDto } from '@technic/contracts';
import {
  emptyTrailerGraphs,
  hitchedTrailerGraphs,
  MANUAL_TRAILER_MODES,
  sameTrailerGraphs,
  substitutedTrailerModes,
  TRACTOR_TRAILERS_TYPE_CODE,
  type TrailerGraphs,
  trailerGraphsFilled,
  type TrailerSlotMode,
  type TrailerSlotModes,
  trailerSubstitution,
  vehicleTypesForTrailerKey,
} from '@entities/vehicle-route';
import { vehicleTypesApi } from '@entities/vehicle-type';

/**
 * Applying the trailer default rule (`docs/vehicle-trailers-plan.md`, §14, R20–R21).
 *
 * The rule itself is pure and lives in the entity (`trailerSubstitution`); here is only its
 * application to a live form: when to ask, what counts as "own" and in which order. Extracted from
 * the box block not for file length but because these are different subjects: there the markup of
 * the box pair, here the ordering on which this work broke twice.
 *
 * **Two independent processes, not one.** The boxes (default and clearing) do not depend on the
 * vehicle type at all and do not wait for the type directory: a live hitch must not stall because
 * of a slow or failed list. The tractor checkbox (§4.4 (a)) waits for the type and has its own
 * one-shot memory per vehicle — otherwise a query recovering after an error would change the source
 * fingerprint and repeat the default, bringing back a checkbox the person unticked.
 */
export interface TrailerGraphsHook {
  modes: TrailerSlotModes;
  setMode: (slot: 1 | 2, mode: TrailerSlotMode) => void;
  /** The vehicle is a tractor unit: the block explains the self-set checkbox by this. */
  isTractor: boolean;
  /**
   * The person touched the checkbox. Raised **by the checkbox itself**, not by effect memory: while
   * "the checkbox was already set" served as the barrier, the case "the type directory was down,
   * the person unticked the inherited checkbox, the directory came back" slipped through — the
   * memory was empty, and the tractor default put the checkbox back over the person's decision.
   */
  noteWithTrailerTouched: () => void;
}

export function useTrailerGraphs({
  form,
  asks,
  hitched,
  vehicleId,
  vehicleTypeId,
  keepOwnGraphs,
  substituteOnOpen,
  record,
  watched,
}: {
  form: FormInstance;
  /**
   * The box block is on screen. `false` — the selected vehicle's form does not print a trailer, or
   * the route's departure details are its own: the boxes are then **cleared**, not just hidden.
   * rc-field-form keeps hidden fields (`preserve`), and the previous vehicle's semi-trailer would
   * silently go into the route body — exactly how it went while the display condition sat in the
   * dialogs and clearing lived only here.
   */
  asks: boolean;
  hitched?: readonly HitchedTrailerDto[];
  vehicleId?: string | null;
  vehicleTypeId?: string | null;
  keepOwnGraphs: boolean;
  substituteOnOpen: boolean;
  record?: TrailerGraphs | null;
  /** Form boxes as the render sees them: by them the effect learns it is time to try again. */
  watched: TrailerGraphs;
}): TrailerGraphsHook {
  /**
   * Mode of each box pair (R17): dialog state, not a form field — the form has no such box, and the
   * route remembers the boxes, not the gesture that filled them (R11). Slots switch independently:
   * a hitched semi-trailer is taken from the registry while a one-off trailer is typed, and vice
   * versa.
   */
  const [modes, setModes] = useState<TrailerSlotModes>(MANUAL_TRAILER_MODES);
  const setMode = (slot: 1 | 2, mode: TrailerSlotMode) =>
    setModes((prev) => ({ ...prev, [`slot${slot}`]: mode }));

  /**
   * Vehicle types — for one question: is this type a tractor unit. The whole directory is asked
   * because the vehicle card (`VehicleDto`) has no type code — only an id and a name, and a name in
   * the condition would be a match by spelling. One query for the portal: the key is shared, the
   * answer cached, and five dialogs share one load.
   */
  const { data: tractorTypeIds } = useQuery({
    queryKey: vehicleTypesForTrailerKey,
    queryFn: () => vehicleTypesApi.list({ page: 1, pageSize: 500 }),
    staleTime: 5 * 60 * 1000,
    select: (page) =>
      new Set(page.items.filter((t) => t.code === TRACTOR_TRAILERS_TYPE_CODE).map((t) => t.id)),
  });
  const isTractor = !!vehicleTypeId && !!tractorTypeIds?.has(vehicleTypeId);

  /**
   * Hitch fingerprint: the default repeats when the vehicle or its trailer set changed, and never
   * otherwise. Else a checkbox unticked by hand would come back on every form render — and it must
   * be untickable (§4.4). The vehicle type is not in the fingerprint: it arrives by a separate
   * query, and its arrival is no reason to fill again.
   */
  const signature = (hitched ?? [])
    .map((t) => `${t.position}:${t.id}:${t.model}:${t.registrationNumber}:${t.status}`)
    .join('|');

  /**
   * Trailer boxes as they lie in the form right now. Read, not taken from watches: the effect runs
   * before the re-render, and watched values lag one commit behind in it.
   */
  const formGraphs = (): TrailerGraphs => ({
    withTrailer: !!form.getFieldValue('withTrailer'),
    trailer1Model: form.getFieldValue('trailer1Model') ?? '',
    trailer1RegNumber: form.getFieldValue('trailer1RegNumber') ?? '',
    trailer2Model: form.getFieldValue('trailer2Model') ?? '',
    trailer2RegNumber: form.getFieldValue('trailer2RegNumber') ?? '',
  });

  /** No server answer yet — a separate name: lint does not check an expression in the deps list. */
  const hitchedUnknown = hitched === undefined;

  const applied = useRef<string | null>(null);
  /**
   * Vehicle that already got the checkbox by type: its own memory, separate from the boxes' memory.
   */
  const tractorApplied = useRef<string | null>(null);
  /** Vehicle whose checkbox the person touched: their decision outranks the type default. */
  const tractorTouched = useRef<string | null>(null);
  /**
   * The vehicle the dialog opened with, and whether it was changed: `substituteOnOpen` lives by
   * them.
   */
  const openVehicle = useRef<string | null | undefined>(undefined);
  const vehicleChanged = useRef(false);

  /** The shared part of the decision: both effects read it and must read it the same way. */
  const decide = (): ReturnType<typeof trailerSubstitution> =>
    trailerSubstitution({
      hasHitched: !!hitchedTrailerGraphs(hitched),
      keepOwnGraphs,
      vehicleChanged: vehicleChanged.current,
      withTrailer: formGraphs().withTrailer,
      // Hidden boxes count like visible ones: with the checkbox unticked the trailer fields leave
      // the page, but their values stay in the form and reach the route body.
      graphsFilled: trailerGraphsFilled(formGraphs()),
      // Only the second effect knows the type: the first does not ask about it at all.
      isTractor: tractorTypeIds === undefined ? undefined : isTractor,
    });

  // ── Boxes: default and clearing ──
  useEffect(() => {
    /*
     * No question or no vehicle — the boxes go. Both cases are one: nothing to describe, and what
     * is left describes **someone else's** unit. The "rental -> own" return comes here too: the
     * block mounts anew with an empty vehicle, and old boxes are cleared before a new one is
     * chosen.
     */
    if (!asks || !vehicleId) {
      applied.current = null;
      tractorApplied.current = null;
      tractorTouched.current = null;
      openVehicle.current = undefined;
      vehicleChanged.current = false;
      // The mode goes with the boxes: a list left open over an empty box would promise a choice
      // nobody made.
      setModes(MANUAL_TRAILER_MODES);
      const current = formGraphs();
      if (current.withTrailer || trailerGraphsFilled(current)) {
        form.setFieldsValue(emptyTrailerGraphs());
      }
      return;
    }

    /*
     * The vehicle the dialog opened with is remembered FIRST — before any exit from the effect
     * (R21). It used to sit lower, after waiting for the hint, and a vehicle change faster than the
     * server answer went unnoticed: `openVehicle` was set to the new unit, `vehicleChanged` stayed
     * false, and the correction (`substituteOnOpen = false`) did nothing — the previous vehicle's
     * boxes reached the new form.
     */
    if (openVehicle.current === undefined) openVehicle.current = vehicleId;
    else if (vehicleId !== openVehicle.current) vehicleChanged.current = true;

    // The form is not yet filled with the record's values: nothing to decide "what the route
    // already described" by (R21).
    if (record && !vehicleChanged.current && !sameTrailerGraphs(record, formGraphs())) return;
    // No server answer yet: that does not mean empty boxes — it means "not known yet".
    if (hitchedUnknown) return;

    const source = `${vehicleId}|${signature}`;
    if (applied.current === source) return;
    applied.current = source;

    if (!substituteOnOpen && !vehicleChanged.current) return;

    const graphs = hitchedTrailerGraphs(hitched);
    const action = decide().graphs;
    if (action === 'substitute' && graphs) {
      form.setFieldsValue(graphs);
      // The default switches on directory mode (R17, item 1) — as requested: the portal repeats the
      // decision taken in the trailer card and shows it with the same list a person would pick
      // from. It also reveals someone else's hitch if the default turned out to be one.
      setModes(substitutedTrailerModes(hitched));
    } else if (action === 'clear') {
      // The new vehicle has no hitch, while the boxes hold the previous one's trailer: an empty box
      // is more honest than someone else's plate, which reads as truth on paper.
      form.setFieldsValue(emptyTrailerGraphs());
      setModes(MANUAL_TRAILER_MODES);
    }
    /*
     * Dependencies are the default source plus the form boxes. The form is not here for the
     * decision (the effect reads it fresh) but for the **retry**: the barrier above skips a run
     * while the form still holds the previous record, and without watching it, a dialog that filled
     * the form in the next commit would get no second run. It causes no extra runs: an applied
     * source is cut off by the fingerprint above, and before that there was no default.
     */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    asks,
    vehicleId,
    signature,
    hitchedUnknown,
    record,
    watched.withTrailer,
    watched.trailer1Model,
    watched.trailer1RegNumber,
    watched.trailer2Model,
    watched.trailer2RegNumber,
  ]);

  // ── Checkbox by vehicle type ──
  useEffect(() => {
    /*
     * Waits for two things: the type directory answer (`isTractor` is false before it) and the hint
     * answer — with a live hitch the default sets the checkbox itself, and the decision here
     * depends on whether there is one. Its own one-shot memory per vehicle: a type query recovering
     * after an error gives no second run, and nobody brings back a checkbox the person unticked.
     */
    if (!asks || !vehicleId || !isTractor || hitchedUnknown) return;
    if (tractorApplied.current === vehicleId || tractorTouched.current === vehicleId) return;
    tractorApplied.current = vehicleId;
    if (!substituteOnOpen && !vehicleChanged.current) return;
    if (decide().tractorDefault && !form.getFieldValue('withTrailer')) {
      form.setFieldsValue({ withTrailer: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [asks, vehicleId, isTractor, hitchedUnknown, signature]);

  return {
    modes,
    setMode,
    isTractor,
    noteWithTrailerTouched: () => {
      tractorTouched.current = vehicleId ?? null;
    },
  };
}
