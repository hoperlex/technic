# ADR 0230. Request forms keep local drafts across a lost connection

- Статус: Принято (15.10.2026); local draft stage implemented
- Домены: заказ-тс, вывоз-мусора, механизация, оргтехника, каркас-портала
- Развивает: [ADR 0004](0004-vehicle-requests.md) (request editor), [ADR 0108](0108-request-trips-and-route-points.md) (full trip list), [ADR 0085](0085-weekly-vehicle-request.md) (weekly composition)
- Связано: [ADR 0101](0101-backdated-correction.md) (correction operation key), [ADR 0129](0129-driver-cabinet-readings-first.md) (local draft precedent), [ADR 0030](0030-responsive-layout.md) (PWA context)
- Область: [localFormDraftStore.ts](../../apps/web/src/shared/lib/localFormDraftStore.ts), [useLocalFormDraft.tsx](../../apps/web/src/shared/lib/useLocalFormDraft.tsx), [localFormDraftDates.ts](../../apps/web/src/shared/lib/localFormDraftDates.ts), [LocalFormDraftNotice.tsx](../../apps/web/src/shared/ui/LocalFormDraftNotice.tsx), [localDraft.ts](../../apps/web/src/features/vehicle-request-editor/model/localDraft.ts), [useVehicleRequestDraftRecovery.ts](../../apps/web/src/widgets/vehicle-request-editor/model/useVehicleRequestDraftRecovery.ts), [useWasteRequestEditor.tsx](../../apps/web/src/features/waste-request-editor/model/useWasteRequestEditor.tsx), [MechRequestForm.tsx](../../apps/web/src/pages/mech/MechRequestForm.tsx), [ServiceRequestForm.tsx](../../apps/web/src/pages/service/ServiceRequestForm.tsx), [useWeeklyRequestCreate.tsx](../../apps/web/src/features/weekly-request-create/model/useWeeklyRequestCreate.tsx), [useWeeklyCompositionDraft.ts](../../apps/web/src/widgets/weekly-request-workspace/model/useWeeklyCompositionDraft.ts)

## Context

The portal creates vehicle, waste removal, mechanization, service/office equipment, and weekly vehicle requests in separate editors. Each lost typed input when a disconnected tab closed or reloaded. Weekly requests have a second, longer assembly step: decisions for standing vehicles, additional rows and a comment. Vehicle request trips and weekly composition are sent as full lists, so restoring an old edit without a version check can remove another person's rows. Ant Design `onValuesChange` misses programmatic changes to those lists.

## Decision

1. A shared, versioned JSON envelope stores an account ID, form kind, target, unique opening ID, save time and form-specific payload in browser storage. The form adapters serialize dates and retain fields that are incomplete at the time of interruption. Drafts older than 30 days are excluded from recovery. Vehicle request drafts additionally retain edit base version, correction operation ID, copy source and every trip with its address metadata.
2. Every opening writes its own key. A matching account, form and target offers the saved drafts for explicit restoration or deletion before editing. Restoration forks to a new key because another tab may own the source. The source remains until explicit deletion. The shared notice reports a successful local write or a storage failure; it never calls an unwritten snapshot safe.
3. Autosave observes the entire Ant form, including programmatic list changes, after a short delay and flushes on page hide. Closing or submitting flushes the latest values. A successful save clears its own draft; failed saves retain it. No draft is submitted automatically on reconnection. Weekly composition uses the same store and autosave path for its state outside Ant Form.
4. Vehicle request edit recovery fetches the current record and requires review when its version changed. Weekly composition recovery retains current server rows while merging saved decisions and additions, then requires explicit review when the request version or suggested row membership changed. Server optimistic locking remains the final guard. The other integrations currently cover creation, not edit recovery.
5. Files are outside the JSON guarantee. Uploaded references and unuploaded binaries must be attached again after a tab closes where the editor cannot recover them. Storage is local to this browser and may be denied, cleared or shared with another device user.
6. An uncertain create response is separate from typed-input recovery. [ADR 0231](0231-request-create-receipts.md) adds durable receipts for the four ordinary create routes and stores the exact attempted body in the draft. The weekly create path reconciles an existing object/week pair.

## Consequences

Unfinished request input can be recovered on the same device in the five creation flows and in the weekly composition workspace. Browser storage failures and missing files are visible. A disconnected submit is not possible; the ordinary create retry guarantee is defined by ADR 0231 and takes effect after its server migration and rollout.
