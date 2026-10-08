import { queryOptions } from '@tanstack/react-query';
import type { TicketAuditEventsQuery, TicketAuditPeriod } from '@technic/contracts';
import { wasteTicketsApi } from './wasteTicketsApi';
import { wasteTicketKeys } from './keys';

/**
 * Ticket observations belong to a permission-gated endpoint. The caller controls `enabled` so a
 * user without `ticketReview` does not receive a 403 each time the card opens.
 */
export const wasteTicketsQuery = (requestId: string | null, enabled: boolean) =>
  queryOptions({
    queryKey: wasteTicketKeys.list(requestId ?? ''),
    queryFn: () => wasteTicketsApi.list(requestId!),
    enabled: enabled && !!requestId,
  });

/**
 * Recognition runs asynchronously. While its banner is visible, health must update without a
 * page reload so an outage that begins after the card opened is still visible.
 */
export const ticketRecognitionHealthQuery = (enabled: boolean) =>
  queryOptions({
    queryKey: wasteTicketKeys.health(),
    queryFn: () => wasteTicketsApi.health(),
    enabled,
    // query-freshness: exception — recognition health is polled while its banner is visible
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

/**
 * A blind-check task goes to the first reviewer who submits a result. The queue is a LIVE read;
 * returning to its tab after the freshness term must not show a task already resolved elsewhere.
 */
export const wasteTicketBlindQueueQuery = (enabled: boolean) =>
  queryOptions({
    queryKey: wasteTicketKeys.blindQueue(),
    queryFn: () => wasteTicketsApi.blindCheckQueue(),
    enabled,
  });

/**
 * The caller owns the `ticketAudit` permission check. This report covers a past period and stays
 * stable for one minute while someone reads it; a background change in its figures would look like
 * a counting error.
 */
export const ticketAuditSummaryQuery = (period: TicketAuditPeriod, enabled: boolean) =>
  queryOptions({
    queryKey: wasteTicketKeys.auditSummary(period),
    queryFn: () => wasteTicketsApi.auditSummary(period),
    enabled,
    // query-freshness: exception — historical audit reports stay stable while read
    staleTime: 60_000,
  });

/**
 * Cohorts share the historical report's one-minute term and permission check. They are loaded
 * separately because a user viewing the summary does not always need the expensive breakdown by
 * configuration.
 */
export const ticketAuditCohortsQuery = (period: TicketAuditPeriod, enabled: boolean) =>
  queryOptions({
    queryKey: wasteTicketKeys.auditCohorts(period),
    queryFn: () => wasteTicketsApi.auditCohorts(period),
    enabled,
    // query-freshness: exception — historical audit reports stay stable while read
    staleTime: 60_000,
  });

/**
 * The paginated audit events share the historical report's term and permission check. A page
 * change shows loading until its own rows arrive, so events from the previous page are never
 * displayed beneath a new page number.
 */
export const ticketAuditEventsQuery = (query: TicketAuditEventsQuery, enabled: boolean) =>
  queryOptions({
    queryKey: wasteTicketKeys.auditEvents(query),
    queryFn: () => wasteTicketsApi.auditEvents(query),
    enabled,
    // query-freshness: exception — historical audit reports stay stable while read
    staleTime: 60_000,
  });

/**
 * Accuracy is a separate historical report with the same permission check and one-minute term.
 * Its figures answer a different question from the summary, so they cannot share one response.
 */
export const ticketAuditAccuracyQuery = (period: TicketAuditPeriod, enabled: boolean) =>
  queryOptions({
    queryKey: wasteTicketKeys.auditAccuracy(period),
    queryFn: () => wasteTicketsApi.auditAccuracy(period),
    enabled,
    // query-freshness: exception — historical audit reports stay stable while read
    staleTime: 60_000,
  });

/**
 * Operations are a current health snapshot rather than a past-period report. An open tab polls
 * once a minute so it cannot show yesterday's queue or describe the last hour from an old answer.
 * The server's `generatedAt` remains visible when a refresh has not arrived.
 */
export const ticketAuditOperationsQuery = (enabled: boolean) =>
  queryOptions({
    queryKey: wasteTicketKeys.auditOperations(),
    queryFn: () => wasteTicketsApi.auditOperations(),
    enabled,
    // query-freshness: exception — audit operations need a live health snapshot
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
