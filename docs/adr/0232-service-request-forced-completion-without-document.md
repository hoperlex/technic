# ADR 0232. Office-equipment operators can complete contractor repairs without closing evidence

- Статус: Принято (23.10.2026)
- Домены: оргтехника, доступ
- Изменяет: [ADR 0174](0174-service-request-internal-repair-without-estimate.md) (the closing-document gate for a contractor repair has an explicit operator override)
- Связано: [ADR 0125](0125-service-request-cycle-changes.md) (document and acceptance history), [ADR 0208](0208-service-work-completed-document-flow.md) (the work-completion step remains separate from acceptance)
- Область: [contract](../../packages/contracts/src/service-requests.ts), [API route](../../apps/api/src/routes/service-requests.ts), [permission manifest](../../apps/api/src/lib/access-manifest.ts), [side manifest](../../apps/api/src/lib/service-access-manifest.ts), [actions](../../apps/web/src/pages/service/serviceRequestMenu.tsx), [completion form](../../apps/web/src/features/service-complete/ui/ServiceCompleteModal.tsx)

## Context

The transition from `in_work` to `done` requires closing evidence for a contractor repair. A contractor may finish the work but fail to provide an act, invoice or warranty card. Keeping the request in `in_work` then misstates the work's actual state. The office-equipment operator needs an accountable way to record completion without inventing a file.

## Decision

1. The existing completion command accepts an optional, explicit `forceWithoutDocument` flag. Absent or false means the existing document requirement. Only an administrator or a holder of `serviceRequests.status` outside the service counterparty can use the flag, and only for a contractor repair. Both server and portal require closing evidence to be absent for this action. A manager without the office-equipment operator grant has no such permission.
2. A forced completion needs a nonblank reason. The status transition records the actor and a comment that states the document was bypassed and gives the reason. The completion audit also records the flag.
3. The override changes only the document gate and executor-side permission for this explicit action. The request must still be `in_work`, within the actor's action scope, and at the submitted version. Estimate approval, item facts, quantities, warranties, totals and stock rules retain their existing checks. The server checks the permission and status again after locking the request row.
4. The command moves to `done` (`Решена`). Acceptance into `accepted` (`Закрыта`) remains a separate operator action. A completed request without a document stays visible to the missing-documents queue. Existing clients and ordinary contractor completion keep their previous behavior; no database migration is needed.

## Verification

The API scenario covers a contractor's refusal, an empty reason's refusal and the operator's successful completion without a file. Portal tests cover visibility by role and the explicit payload from the form.
