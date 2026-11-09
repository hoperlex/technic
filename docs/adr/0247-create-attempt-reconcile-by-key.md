# ADR 0247. A create attempt whose body the schema refuses is reconciled by its key

- Статус: Реализовано (09.11.2026); not deployed
- Домены: заказ-тс, вывоз-мусора, механизация, оргтехника
- Изменяет: [ADR 0231](0231-request-create-receipts.md) — decision 8 (reconcile accepted only a
  validated body; now a body the schema refuses is answered by its key), decision 1 (the key's binding
  to the body is not checked in that key mode), decision 4 (a new Vehicle Request attempt is not frozen
  when its body fails the schema), decision 9 (a 400/422 answer to a frozen Vehicle Request attempt
  starts the reconciliation by itself); [ADR 0230](0230-request-local-drafts.md) — decision 2 (after a
  confirmed `not-created` the Vehicle Request forks of that attempt are removed)
- Связано: [ADR 0101](0101-backdated-correction.md) (backdated Vehicle Request keeps its correction
  journal), [ADR 0077](0077-release-notes.md) (release entry)
- Область: [receipt service](../../apps/api/src/services/request-create-attempt.ts), [Vehicle Request
  routes](../../apps/api/src/routes/vehicle-requests.ts), [Waste Removal
  routes](../../apps/api/src/routes/waste-requests.ts), [Mechanization
  routes](../../apps/api/src/routes/mech-requests.ts), [Service Request
  routes](../../apps/api/src/routes/service-requests.ts), [Vehicle Request
  draft](../../apps/web/src/widgets/vehicle-request-editor/model/useVehicleRequestLocalDraft.ts),
  [Vehicle Request save](../../apps/web/src/widgets/vehicle-request-editor/model/useVehicleRequestEditorSave.tsx),
  [trip fields](../../apps/web/src/widgets/vehicle-request-editor/ui/RequestTripFields.tsx), [trip
  amount rule](../../packages/contracts/src/vehicle-request-trips.ts), [error
  text](../../apps/web/src/shared/lib/errors.ts)

## Context

On 29–30.10.2026 a requester could not order a truck crane and could not delete eight local drafts.
The trip field «Объём, м³» accepted `0`; the contract requires a positive amount, so the create route
refused the body with `400 validation_error` before its handler ran. Under ADR 0231 the browser had
already frozen that body and its key, so every «Сохранить» resent the same refused body, whatever the
person changed in the form. «Сверить исходную отправку» posted the frozen body to
`/_create-attempts/reconcile`, whose envelope validated it with the same strict schema — and refused it
for the same reason. The attempt could therefore never be released; a pending attempted draft blocks
the form and never expires, so no Vehicle Request could be created from that browser at all. Each
«Восстановить» added a fork with the same key, hence eight rows. The toast «Ошибка валидации данных:
Объём» named the field but not the reason.

Waste Removal, Mechanization and Service Request reconcile routes validate the original body the same
way, so any body their forms let through and their schemas refuse locks those forms too.

## Decision

1. **Key mode.** A reconcile route first parses `originalBody` with exactly the schema of its paired
   `_create-with-receipt` route. When the body fails that schema, the route reconciles **by key**: an
   existing receipt row answers if its kind and actor match (409 otherwise, without a request ID); when
   there is no row, the route writes the permanent tombstone of ADR 0231 decision 8 with the constant
   fingerprint marker `key-mode-v1` and answers `not-created` with a replacement key. It is safe because
   every create route reserves a key only after its body passed the same schema: a body the current
   schema refuses could have been reserved only by an older, looser API, and then its row exists and
   answers. The `INSERT … ON CONFLICT` on the receipt key is unchanged, so key mode still waits for a
   create holding the key, and a create reaching a tombstoned key is still refused.
2. **Unchanged path for a valid body.** A body that passes the schema is reconciled as before, by key,
   kind, actor and the fingerprint of the parsed body (Mechanization: of its create input). In
   reconcile, a row carrying the key-mode marker matches by kind and actor, so a tombstone written in
   either mode yields the same replacement key. Create never matches the marker.
3. **Special bodies stay out**, decided before either mode by the same truthy rule the create routes
   use: a backdated Vehicle Request body (`operationId` or `backdateReason`) and a Service Request
   equipment candidate keep their 422. Each rule is written once per kind and asked by the create route,
   the parsed branch and the raw branch.
4. **The Vehicle Request client does not freeze a body the schema refuses.** Before a new attempt is
   written to the draft, the exact JSON snapshot that would be sent is checked with
   `createVehicleRequestStableSchema`; a refusal raises `LocalValidationError` — nothing is written or
   sent, and the «first request may still commit» warning does not appear. A frozen body is never
   re-checked: it is the only safe retry and is resent unchanged.
5. **A refused send starts the reconciliation.** When the server answers a send of a frozen `receipt-v1`
   Vehicle Request attempt with 400 or 422, the form runs the same reconciliation as the button.
   `not-created` releases the attempt with «Заявка не создана: причина. Исправьте поля и сохраните
   снова.»; nothing is sent automatically. The release still rests on the server's proof, not on the
   400/422 (ADR 0231 decision 4 keeps holding); a network error or a 409 does not start it.
6. **Forks go with a confirmed `not-created`.** The Vehicle Request draft then removes the sibling
   envelopes that carry the same attempt key — exactly that key, as the shared draft hook already did;
   a fork that already holds a newer attempt survives.
7. **The form and the message say what is wrong.** The trip amount fields ask the contract's
   `tripAmountSchema` and show its message on the field. Vehicle Request errors name the reason after the
   field label and the row of a trip (`errorMessage` option `reasons`, opt-in: zod's built-in texts are
   English and are never shown), and `weightTons` reads «Масса», as on the form.

## Consequences

- The fix of the stuck drafts is on the server: after the API deploy the client already in production
  unlocks them — Восстановить → Сохранить (or «Сверить исходную отправку») → «Заявка не создана» →
  fix the fields → Сохранить. A successful create then removes all forks of that attempt.
- Key mode does not bind the key to the body. A schema-refused body reconciling another body's key of
  the same actor and kind gets that key's answer. Keys are random per attempt, so only a client defect
  could cause it. The `mech` kind is also used by the Mechanization duplicate command, so a collision
  with a duplicate key would answer `created` with the copy's ID; the Service Request candidate intake
  reads the same header but keeps its own table, which is why decision 3 refuses candidate bodies
  before key mode. Every key-mode reconcile is logged with kind, key and failing paths.
- Waste Removal, Mechanization and Service Request forms do not yet check the body before freezing it
  and do not reconcile by themselves after a refusal; their «Сверить исходную отправку» works for such
  attempts by decision 1. The notice still lists each fork of an attempt as a separate row until
  `not-created` or a successful create removes them.
- No schema change and no client floor change: a former 400 of reconcile becomes an answer.

## Rejected alternatives

- **Let the person delete an attempted draft after a 400.** A refusal of a retry cannot prove the first
  request failed; the server's proof costs one request and keeps ADR 0231's guarantee.
- **Fingerprint the raw body in key mode.** It cannot match the parsed fingerprint of a create anyway,
  and canonicalizing unvalidated input recurses without bound.
- **A looser reconcile schema without the amount rules.** A copy of the create schema minus some rules
  drifts from it silently — the way this defect's form rule drifted from the contract.
