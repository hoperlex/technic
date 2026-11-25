import { describe, expect, it } from 'vitest';
import { wasteTicketReviewSettled } from '@technic/contracts';
import {
  classifyTicketFile,
  type TicketFileRowState,
  type TicketRecognitionJob,
  WASTE_TICKET_CHECKS_VERSION,
  wasteTicketCheckFingerprint,
  wasteTicketChecks,
  type WasteTicketCheckTicket,
} from '../src/services/waste-ticket-checks';

/**
 * A ticket file as the review sees it with the recognition queue read alongside the stored outcome
 * (snow-removal plan, §3.2). The rule is a branch order, and each case below pins one branch: a
 * reordering that lets an earlier reading settle a rerun in flight, or hides a dead latest attempt
 * behind an old success, would pass every test that looks only at the file row.
 */

const T0 = '2026-11-25 09:00:00.000001';
const T1 = '2026-11-25 09:00:00.000002';
const T2 = '2026-11-25 09:00:00.000003';

function job(status: TicketRecognitionJob['status'], createdAtKey: string): TicketRecognitionJob {
  return {
    id: `job-${status}-${createdAtKey}`,
    status,
    attempts: 0,
    maxAttempts: 5,
    nextRunAt: new Date('2026-11-25T09:00:00Z'),
    createdAtKey,
  };
}

function row(
  status: TicketFileRowState['status'],
  updatedAtKey: string,
  jobStatus: TicketFileRowState['jobStatus'] = null,
): TicketFileRowState {
  return { status, updatedAtKey, jobStatus };
}

describe('classifyTicketFile', () => {
  it('a pending or running job wins over an earlier reading and an earlier failure', () => {
    const live = job('pending', T1);
    expect(classifyTicketFile({ row: row('done', T0), jobs: [live], pageFailed: false })).toEqual({
      state: 'live',
      failedBy: null,
      diedWithoutResult: false,
      liveJob: live,
    });
    expect(
      classifyTicketFile({ row: row('failed', T0), jobs: [job('running', T1)], pageFailed: true })
        .state,
    ).toBe('live');
  });

  it('the newest live job is the one shown', () => {
    const older = job('pending', T0);
    const newer = job('running', T1);
    expect(classifyTicketFile({ row: null, jobs: [older, newer], pageFailed: false }).liveJob).toBe(
      newer,
    );
  });

  it('a job that died before the worker reached the file counts as failed', () => {
    expect(classifyTicketFile({ row: null, jobs: [job('dead', T0)], pageFailed: false })).toEqual({
      state: 'failed',
      failedBy: 'file',
      diedWithoutResult: true,
      liveJob: null,
    });
    // An accepted reading from an earlier attempt does not hide the dead latest one.
    expect(
      classifyTicketFile({ row: row('done', T0), jobs: [job('dead', T1)], pageFailed: false })
        .state,
    ).toBe('failed');
  });

  it('a job that wrote its outcome and then died leaves that outcome standing', () => {
    expect(
      classifyTicketFile({ row: row('done', T1), jobs: [job('dead', T0)], pageFailed: false })
        .state,
    ).toBe('read');
  });

  it('equal times read as "no write since": the dead attempt is not hidden', () => {
    expect(
      classifyTicketFile({ row: row('done', T1), jobs: [job('dead', T1)], pageFailed: false })
        .state,
    ).toBe('failed');
  });

  it('a skipped job reuses the intact earlier outcome, read or failed', () => {
    // Done jobs are not even read by the loader; passing one proves the rule ignores it.
    expect(
      classifyTicketFile({ row: row('done', T0), jobs: [job('done', T1)], pageFailed: false })
        .state,
    ).toBe('read');
    expect(
      classifyTicketFile({ row: row('failed', T0), jobs: [job('done', T1)], pageFailed: false }),
    ).toMatchObject({ state: 'failed', failedBy: 'file', diedWithoutResult: false });
  });

  it('a pending row without a live job: dead job — failed, otherwise interrupted', () => {
    expect(
      classifyTicketFile({ row: row('pending', T0, 'dead'), jobs: [], pageFailed: false }),
    ).toMatchObject({ state: 'failed', diedWithoutResult: true });
    expect(
      classifyTicketFile({ row: row('pending', T0, 'done'), jobs: [], pageFailed: false }).state,
    ).toBe('interrupted');
    // The job row was cleaned up: nothing tells it died, and no outcome was written.
    expect(classifyTicketFile({ row: row('pending', T0), jobs: [], pageFailed: false }).state).toBe(
      'interrupted',
    );
  });

  it('a failed page fails a read file once; a failed file is not counted again by its page', () => {
    expect(classifyTicketFile({ row: row('done', T0), jobs: [], pageFailed: true }).failedBy).toBe(
      'page',
    );
    expect(
      classifyTicketFile({ row: row('unsupported', T0), jobs: [], pageFailed: true }).failedBy,
    ).toBe('file');
  });

  it('no row and no job — the file is unread', () => {
    expect(classifyTicketFile({ row: null, jobs: [], pageFailed: false }).state).toBe('unread');
    expect(classifyTicketFile({ row: row('done', T2), jobs: [], pageFailed: false }).state).toBe(
      'read',
    );
  });
});

describe('paper in flight holds the badge whatever tickets it has', () => {
  const confirmed: WasteTicketCheckTicket = {
    id: 't1',
    numberRaw: '30476',
    numberKey: '30476',
    numberFuzzy: '30476',
    issuedOn: '2026-11-20',
    volumeM3: 20,
    workKind: 'removal',
    addressRaw: '',
    status: 'confirmed',
    operatorCounterpartyId: null,
    pageId: 'page-1',
    pageSha256: 'a'.repeat(64),
    duplicateOverride: false,
    fileId: 'file-1',
    disputed: false,
    hasProposal: false,
    updatedAt: new Date('2026-11-20T09:00:00Z'),
  };

  function badge(pending: boolean) {
    return wasteTicketChecks({
      request: {
        requestedVolumeM3: 20,
        deliveryAt: new Date('2026-11-20T06:00:00Z'),
        objectAddress: '',
        objectName: '',
        operatorCounterpartyId: null,
      },
      completion: { volumeM3: 20, removedOn: '2026-11-20', removedOnSource: 'entered' },
      tickets: [confirmed],
      subsystem: {
        attachedTicketFiles: [{ fileId: 'file-1', broken: false, readOk: true, pending }],
        failedFiles: 0,
        failedPages: 0,
        blindPending: 0,
        blindMismatch: 0,
      },
    }).badge;
  }

  it('a confirmed ticket settles the read file, but not while it is being reread', () => {
    expect(wasteTicketReviewSettled(badge(false))).toBe(true);
    expect(badge(true).unreviewedPaper).toBe(1);
    expect(wasteTicketReviewSettled(badge(true))).toBe(false);
  });
});

describe('an unanswered reread proposal keeps a non-dismissed ticket pending', () => {
  const base: WasteTicketCheckTicket = {
    id: 't1',
    numberRaw: '30476',
    numberKey: '30476',
    numberFuzzy: '30476',
    issuedOn: '2026-11-20',
    volumeM3: 20,
    workKind: 'removal',
    addressRaw: '',
    status: 'confirmed',
    operatorCounterpartyId: null,
    pageId: 'page-1',
    pageSha256: 'a'.repeat(64),
    duplicateOverride: false,
    fileId: 'file-1',
    disputed: false,
    hasProposal: true,
    updatedAt: new Date('2026-11-20T09:00:00Z'),
  };

  function badgeOf(ticket: WasteTicketCheckTicket) {
    return wasteTicketChecks({
      request: {
        requestedVolumeM3: 20,
        deliveryAt: new Date('2026-11-20T06:00:00Z'),
        objectAddress: '',
        objectName: '',
        operatorCounterpartyId: null,
      },
      completion: { volumeM3: 20, removedOn: '2026-11-20', removedOnSource: 'entered' },
      tickets: [ticket],
    }).badge;
  }

  it('even when the earlier reading was confirmed', () => {
    const badge = badgeOf(base);
    expect(badge.pendingConfirmation).toBe(1);
    // Not a one-click case: the button confirms readings, it does not answer proposals.
    expect(badge.confirmable).toBe(0);
    expect(wasteTicketReviewSettled(badge)).toBe(false);
  });

  it('counted once for an unconfirmed ticket, not at all for a dismissed one', () => {
    expect(badgeOf({ ...base, status: 'unconfirmed' }).pendingConfirmation).toBe(1);
    expect(badgeOf({ ...base, status: 'dismissed' }).pendingConfirmation).toBe(0);
    expect(badgeOf({ ...base, hasProposal: false }).pendingConfirmation).toBe(0);
  });
});

describe('accepted discrepancies keep their fingerprints across the badge format bump', () => {
  it('the check rules version and the fingerprint scheme are unchanged', () => {
    // The stored badge FORM moved to version 2; the acceptance fingerprint must not move with it,
    // or every discrepancy people accepted would silently come back (ADR 0114, R21).
    expect(WASTE_TICKET_CHECKS_VERSION).toBe(1);
    const fingerprint = wasteTicketCheckFingerprint({
      request: {
        requestedVolumeM3: 20,
        deliveryAt: new Date('2026-11-20T06:00:00Z'),
        objectAddress: 'ул Снежная, 1',
        objectName: 'Площадка',
        operatorCounterpartyId: null,
      },
      completion: { volumeM3: 20, removedOn: '2026-11-20', removedOnSource: 'entered' },
      tickets: [
        {
          id: 't1',
          numberRaw: '30476',
          numberKey: '30476',
          numberFuzzy: '30476',
          issuedOn: '2026-11-20',
          volumeM3: 20,
          workKind: 'removal',
          addressRaw: 'ул Снежная, 1',
          status: 'confirmed',
          operatorCounterpartyId: null,
          pageId: 'p',
          pageSha256: 'a'.repeat(64),
          duplicateOverride: false,
          fileId: 'f',
          // A proposal changes the badge, not the acceptance input.
          disputed: false,
          hasProposal: true,
          updatedAt: new Date('2026-11-20T09:00:00Z'),
        },
      ],
      checkCode: 'volume_mismatch',
      subjectKey: '',
    });
    expect(fingerprint).toBe('9ad9bb2edb21104158d529679e340adb3cd04535995d3df99b6c07e761e60849');
  });
});
