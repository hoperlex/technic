# ADR 0231. Durable receipts for ordinary request creation

- Статус: Принято (15.10.2026); implementation staged, migration pending
- Домены: заказ-тс, вывоз-мусора, механизация, оргтехника, схема-и-выкат
- Развивает: [ADR 0230](0230-request-local-drafts.md) (a draft also retains one exact submitted body and key)
- Связано: [ADR 0101](0101-backdated-correction.md) (backdated Vehicle Request uses its correction journal), [ADR 0085](0085-weekly-vehicle-request.md) (weekly object/week uniqueness), [ADR 0226](0226-client-floor-seven-and-deploy-preflight.md) (old clients remain valid)
- Область: [receipt service](../../apps/api/src/services/request-create-attempt.ts), [pending SQL](../../apps/api/drizzle/pending/request-create-idempotency.sql), [draft store](../../apps/web/src/shared/lib/localFormDraftStore.ts), [Vehicle Request](../../apps/api/src/routes/vehicle-requests.ts), [Vehicle Request validation](../../packages/contracts/src/vehicle-requests.ts), [Waste Removal](../../apps/api/src/routes/waste-requests.ts), [Mechanization](../../apps/api/src/routes/mech-requests.ts), [Service Request](../../apps/api/src/routes/service-requests.ts)

## Context

An ordinary create can commit and lose its HTTP response. Repeating the same POST then creates a second Vehicle, Waste Removal, Mechanization or Service Request. Local drafts preserve entered fields but cannot prove whether the first POST committed. Weekly Vehicle Request creation already has a unique active object/week pair and a reconciliation flow. Backdated Vehicle Request creation already uses the correction journal, and the Service Request candidate branch already has a separate candidate intake receipt.

## Decision

1. The four ordinary create routes accept an optional UUID `Idempotency-Key`. A missing header keeps old API behavior. The route hashes the validated body using canonical object-key order. One key belongs to one request kind, actor and body; reuse for another combination returns 409.
2. The server reserves a shared receipt row in the same transaction that inserts the request, its child rows, file links and mail outbox entries. A concurrent retry waits on the receipt primary key and cannot repeat those writes. The receipt retains the request ID without a foreign key so later hard deletion never frees the key.
3. Before the first 201, the server freezes the response JSON in the receipt. A retry returns it with 200. If the process dies after committing the request and before freezing the response, the next retry completes it from the saved request ID and metadata. A request deleted in that gap yields 409 instead of creating another. Existing best-effort audit writes remain after the request transaction; a retry never duplicates them, while a crash in that gap can leave them absent.
4. The browser stores the key and exact first submitted body synchronously in its local draft before every send or retry. It keeps both after **any** HTTP error, including 400/422. A later retry may fail validation while the first POST is still in flight and later commits; that refusal cannot prove the original operation failed. Changed form fields do not alter the frozen body. Storage failure prevents sending because a reload could otherwise lose the only safe retry token. Restored drafts retain the attempt; a restored fork writes its own envelope but reuses the same key and body. The UI shows the key, explains that a retry sends the original body, and blocks discarding a pending attempted draft until the result is reconciled outside the form.
5. Backdated Vehicle Request creation remains with its correction operation ID and journal. The candidate intake branch retains its own receipt and response semantics. Weekly creation remains protected by its object/week uniqueness and list reconciliation; no second receipt is added. Uploaded file references remain in the submitted body, but unuploaded binary data still requires reattachment after a tab closes.
6. Vehicle Request and Waste Removal receipt replays pass stable structural validation before their clock-dependent new-request date gates. Otherwise a request created just before Moscow midnight could fail validation on an exact retry after midnight before the route sees its receipt. The SQL is additive and can run while the old API is live; its transaction-local lock timeout bounds waiting on the users FK. The code must be released after this pending SQL is numbered and applied. The migration number is assigned by the release train.

## Consequences

- Retrying an uncertain ordinary create is safe while the draft and its attempted body remain available. A persistent rejection requires checking the request list and reconciling the original attempt before starting a different request; the form never infers failure from a 400/422.
- Receipt rows remain after request deletion and need storage monitoring.
- The old clients continue to create without a header; protection requires a client that sends one.
