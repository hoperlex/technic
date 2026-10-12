import { and, eq, isNull, ne } from 'drizzle-orm';
import {
  formatServiceRequestNumber,
  serviceRequestStatusLabels,
  type ModuleMailOutcome,
  type ServiceMailTargets,
  type ServiceRequestStatus,
} from '@technic/contracts';
import type { db } from '../db/client';
import { serviceRequests, users } from '../db/schema';
import { config } from '../config';
import { logger } from '../logger';
import { writeAuditTx } from '../lib/audit';
import { renderMail, type MailContent } from './mail-templates';
import { queuePreparedMail } from './mail';
import {
  assigneesOf,
  currentHour,
  loadServiceLetterData,
  logServiceMailFailure,
  putBulkMailItem,
  queueActivitySummary,
  renderServiceLetter,
  REQUESTER_LETTER_FOOTER,
  requestDetailLines,
  SERVICE_MAIL_ACCOUNT,
  SERVICE_MAIL_AUDIENCE_FIELDS,
  windowCount,
  type ServiceLetterData,
  type ServiceLetterExtra,
  type ServiceMailBulkSink,
} from './service-request-mail';
import {
  addressOf,
  collectServiceMailRecipients,
  copyRecipients,
  isServiceMailEventEnabled,
  readServiceMailEventEnabled,
  type ServiceMailAudienceCtx,
  type ServiceMailRecipient,
} from './service-request-mail-audience';

/**
 * LETTERS TO THE REQUEST AUTHOR (ADR 0227; reverses ADR 0159 decision 9).
 *
 * Requesters do not read the portal discussion, so a message addressed to them and a change of
 * their request's state reach them by mail. The addressee is the author only
 * (`service_requests.created_by`, D1); colleagues and the free-text «Ответственный» get nothing.
 *
 * WHY A MODULE OF ITS OWN (E2). The service planner (`queueServiceMailForIntent`) returns early on
 * `event_off` and `not_needed` of the SERVICE event, and the owner wants the two flows independent
 * (D5): the requester letter must go when the service event is switched off, and vice versa. Living
 * inside that function, it would inherit every early return. What is shared is taken, not copied:
 * the switch reader, the copies, the recipient accumulator, the frequency cap with its summary, the
 * bulk sink, the letter data and the detail lines of the body.
 *
 * THREE HOOKS, ONE PLANNER. Every status history row is written by `recordServiceStatusTransition`
 * (routes) or by the auto-close (`runAutoClose`, raw SQL), and every chat message by
 * `postChatMessage`. Each calls `queueRequesterMail` in the same transaction as the fact: the letter
 * is an atomic outbox row, and a SQL failure here rolls the fact back like the service letter does
 * (ADR 0159 decision 5); a body that fails to render is a soft `mail_failed`.
 */

/** Drizzle transaction: the letter is queued together with the fact it is about. */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type RequesterMailEvent =
  'service_request_requester_comment' | 'service_request_requester_status';

/**
 * WHICH STATUSES THE AUTHOR HEARS ABOUT (D3, E2) — a closed `Record`, so a new status has to answer
 * this question when it is added rather than when someone notices the silence.
 *
 * Four groups: «В работе» (taken into work, back from «Решена» for rework, resumed from hold),
 * «Отложена» (with the reason), «Решена» and «Закрыта» (including auto-close), «Отменена» (any arc,
 * including the estimate refusal). «Новая» is out (D3, §7): creation is the author's own act, and a
 * rollback into it is the service re-reading the request. The dead statuses never occur.
 */
export const REQUESTER_STATUS_LETTERS = {
  new: false,
  it_approved: false,
  assigned: false,
  diagnostics: false,
  estimate_review: false,
  in_work: true,
  on_hold: true,
  done: true,
  accepted: true,
  cancelled: true,
} as const satisfies Record<ServiceRequestStatus, boolean>;

type RequesterLetterStatus = {
  [K in ServiceRequestStatus]: (typeof REQUESTER_STATUS_LETTERS)[K] extends true ? K : never;
}[ServiceRequestStatus];

/**
 * Whether a history row means a letter to the author. Entering the SAME status is not a state
 * change: the executors handle writes `from = to` for a reassignment, and assignment letters are
 * out of scope for the requester (§7) — «your request was taken into work» on every reassignment
 * would be false.
 */
export function requesterHearsAbout(
  from: ServiceRequestStatus | null,
  to: ServiceRequestStatus,
): to is RequesterLetterStatus {
  return REQUESTER_STATUS_LETTERS[to] && from !== to;
}

/**
 * The words of the status letter (E4). The headline is the subject's second half; the line opens
 * the body and carries the reason where the transition has one. Keyed by exactly the statuses
 * marked `true` above, so a status that starts sending must also say what the letter says.
 */
const REQUESTER_STATUS_WORDING: Record<
  RequesterLetterStatus,
  (ctx: { reason: string; automatic: boolean }) => { headline: string; line: string }
> = {
  in_work: () => ({ headline: 'Заявку приняли в работу', line: 'Заявку приняли в работу' }),
  on_hold: ({ reason }) => ({
    headline: 'Заявку отложили',
    line: reason ? `Заявку отложили. Причина: ${reason}` : 'Заявку отложили',
  }),
  done: () => ({
    headline: 'Работы по заявке выполнены',
    line:
      'Работы по заявке выполнены. Если неисправность осталась — напишите в обсуждении заявки ' +
      'в портале',
  }),
  accepted: ({ automatic }) => {
    const text = automatic ? 'Заявка закрыта автоматически' : 'Заявка закрыта';
    return { headline: text, line: text };
  },
  cancelled: ({ reason }) => ({
    headline: 'Заявка отменена',
    line: reason ? `Заявка отменена. Причина: ${reason}` : 'Заявка отменена',
  }),
};

// ── Configuration ──

/**
 * What the process environment allows, read without the database (ADR 0159 §5.9): mail on, the
 * `repair` channel configured (the sender, D7), and a Reply-To to set.
 *
 * REPLY-TO IS SET EXPLICITLY AND IS NEVER EMPTY (D4, E5): the default channel's `MAIL_REPLY_TO`,
 * falling back to its `MAIL_FROM` address. Empty would not mean "the portal's address": the worker
 * transport lets the channel's own Reply-To win over an empty one, and for `repair` that is the
 * service mailbox — the opposite of D4, a reply landing with the service while the footer says
 * nobody reads it. A portal without either address therefore counts as a missing channel: the
 * letter is not sent rather than sent with the wrong Reply-To.
 */
export interface RequesterMailConfig {
  outcome: 'mail_disabled' | 'channel_missing' | null;
  /** The `repair` channel address: the sender, and the Reply-To of copies (ADR 0159 decision 8). */
  channelEmail: string;
  /** The portal's general address: the Reply-To of every letter to the author. */
  replyTo: string;
}

export function requesterMailConfig(): RequesterMailConfig {
  const channel = config.mail.accounts[SERVICE_MAIL_ACCOUNT];
  const channelEmail = channel.configured ? addressOf(channel.from) : '';
  const replyTo = config.mail.replyTo.trim() || addressOf(config.mail.from);
  const outcome = !config.mail.enabled
    ? 'mail_disabled'
    : !channelEmail || !replyTo
      ? 'channel_missing'
      : null;
  return { outcome, channelEmail, replyTo };
}

/**
 * Whether the author gets letters for chat messages at all — the composer's
 * `requesterMailEnabled` (E9). The same configuration rule as the planner, plus the switch read
 * without a lock: it is a form hint asked by every list page, not a delivery decision.
 */
export async function requesterCommentMailEnabled(reader: typeof db): Promise<boolean> {
  if (requesterMailConfig().outcome) return false;
  return readServiceMailEventEnabled(reader, 'service_request_requester_comment');
}

// ── The recipient ──

/**
 * THE AUTHOR, LOCKED (E3) — the reader of `candidateAuthorRecipients` (the existing letter to an
 * author): `FOR SHARE` inside the transaction, so a deactivation or an email change committed
 * earlier excludes him, and a concurrent one serializes with the queue row. Active, not deleted,
 * non-empty email; otherwise there is nobody behind the mailbox.
 *
 * NO PERMISSION CHECK, deliberately: the letter is about the author's own request. A permission
 * revoked after filing must not leave him without news of what happened to it.
 */
async function authorRecipient(
  tx: Tx,
  authorId: string,
  replyTo: string,
): Promise<ServiceMailRecipient | null> {
  const [row] = await tx
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(
      and(
        eq(users.id, authorId),
        eq(users.isActive, true),
        isNull(users.deletedAt),
        ne(users.email, ''),
      ),
    )
    .for('share');
  if (!row) return null;
  return {
    key: row.id,
    email: row.email,
    replyTo,
    audience: 'requester',
    source: 'requester',
    sortId: row.id,
    counterpartyId: null,
  };
}

function normalized(email: string): string {
  return email.trim().toLowerCase();
}

// ── Queueing ──

export interface RequesterMailResult {
  outcome: ModuleMailOutcome;
  targets: ServiceMailTargets;
  recipients: ServiceMailRecipient[];
}

/** Why the author got no letter: the audit names it, the outcome alone does not tell them apart. */
type RequesterSkip = 'actor_is_author' | 'service_letter_covers_author' | 'author_unreachable';

/**
 * Queues the author's letter inside the open transaction of the fact (E2).
 *
 * THE ORDER OF STEPS IS THE SERVICE PLANNER'S (ADR 0159 §5.10): the switch first — if writing is
 * not wanted, the state of addresses does not matter; then "was a letter needed at all"; then the
 * configuration; then the recipients.
 *
 * NOT NEEDED (E3) — no letter, and rightly so:
 *   · the actor is the author (his own message, his own cancellation);
 *   · the author's address is already among the recipients of the service letter about the same
 *     fact (staff who filed a request and are on the service side) — two letters about one fact to
 *     one person is noise. With the service event off that list is empty and the letter goes.
 * Copies are not sent on `not_needed`, as with the service planner: they observe the author's
 * letter, and there is none.
 *
 * NO RECIPIENTS — the author is inactive, deleted or without email; copies still get theirs.
 *
 * The outcome goes to the audit only (E8): the handler's answer and the portal notice of the
 * acting person stay those of the service letter.
 */
export async function queueRequesterMail(
  tx: Tx,
  params: {
    event: RequesterMailEvent;
    requestId: string;
    /**
     * The dedupe anchor: the message id or the status history row id. Without colons: the key is
     * `<event>:<anchor>:<recipient>`, and the recipient is read as its third field.
     */
    anchor: string;
    /** Who caused the fact; `null` — the portal itself (auto-close). */
    actorId: string | null;
    /** Recipients of the service letter about the same fact (E3); empty when there was none. */
    serviceRecipients: readonly ServiceMailRecipient[];
    extra: ServiceLetterExtra;
    /** The bulk sink of a bulk row (E7); absent — the single-request path. */
    bulk?: ServiceMailBulkSink | null;
  },
): Promise<RequesterMailResult> {
  const { event, requestId } = params;
  const targets: ServiceMailTargets = {};

  /**
   * The only exit and the only place of the trace: the audit row is written on EVERY outcome —
   * "why did the author get nothing" is asked a month later, and `event_off` versus
   * `author_unreachable` is told apart exactly here.
   */
  const finish = async (
    outcome: ModuleMailOutcome,
    recipients: ServiceMailRecipient[] = [],
    skip?: RequesterSkip,
  ): Promise<RequesterMailResult> => {
    await writeAuditTx(tx, {
      actorUserId: params.actorId,
      action: 'serviceRequest.mailPlanned',
      entityType: 'serviceRequest',
      entityId: requestId,
      metadata: {
        event,
        outcome,
        targets,
        recipients: recipients.map((r) => r.email),
        sources: recipients.map((r) => r.source),
        ...(skip ? { skip } : {}),
        ...(params.bulk
          ? { bulkOperationId: params.bulk.operationId, bulkRowIndex: params.bulk.rowIndex }
          : {}),
      },
    });
    logger.info(
      { requestId, event, outcome, recipients: recipients.length, ...(skip ? { skip } : {}) },
      'письмо заявителю: итог планирования',
    );
    return { outcome, targets, recipients };
  };

  if (!(await isServiceMailEventEnabled(tx, event))) return finish('event_off');

  const [request] = await tx
    .select({ createdBy: serviceRequests.createdBy })
    .from(serviceRequests)
    .where(eq(serviceRequests.id, requestId));
  if (!request) throw new Error(`Заявка ${requestId} не найдена при сборке письма заявителю`);

  if (params.actorId !== null && params.actorId === request.createdBy) {
    targets.requester = 'not_needed';
    return finish('not_needed', [], 'actor_is_author');
  }

  const cfg = requesterMailConfig();
  if (cfg.outcome) {
    targets.requester = cfg.outcome;
    return finish(cfg.outcome);
  }

  const author = await authorRecipient(tx, request.createdBy, cfg.replyTo);
  if (
    author &&
    params.serviceRecipients.some((r) => normalized(r.email) === normalized(author.email))
  ) {
    targets.requester = 'not_needed';
    return finish('not_needed', [], 'service_letter_covers_author');
  }

  const ctx: ServiceMailAudienceCtx = {
    channelEmail: cfg.channelEmail,
    internalReplyTo: cfg.channelEmail,
    // The author is excluded above by id; copies are never excluded (ADR 0159 decision 6), so the
    // accumulator needs no actor address here.
    actor: { id: params.actorId ?? '', email: '', counterpartyId: null },
  };
  // Copies last: the first source wins, and a trusted body is never replaced by an observer's.
  const candidates = [...(author ? [author] : []), ...(await copyRecipients(tx, event, ctx))];
  const recipients = collectServiceMailRecipients(candidates, ctx.actor);
  const reached = recipients.some((r) => r.source === 'requester');
  targets.requester = reached ? 'queued' : 'no_recipients';
  if (recipients.some((r) => r.source === 'copy')) targets.copies = 'queued';
  const skip: RequesterSkip | undefined = reached ? undefined : 'author_unreachable';

  if (recipients.length === 0) return finish('no_recipients', [], skip);

  const data = await loadServiceLetterData(tx, requestId);
  let letters: Partial<Record<'requester' | 'copy', RenderedLetter>>;
  try {
    letters = {};
    for (const audience of new Set(recipients.map((r) => r.audience))) {
      if (audience === 'requester')
        letters.requester = renderRequesterLetter(event, data, params.extra);
      else if (audience === 'copy')
        letters.copy = renderServiceLetter(event, data, 'copy', params.extra);
      else throw new Error(`Письмо заявителю: неожиданная аудитория ${audience}`);
    }
  } catch (e) {
    logServiceMailFailure(requestId, e);
    targets.requester = 'mail_failed';
    return finish('mail_failed', [], skip);
  }
  const letterOf = (r: ServiceMailRecipient): RenderedLetter =>
    letters[r.audience === 'requester' ? 'requester' : 'copy']!;

  if (params.bulk) {
    // The bulk sink (E7): one digest per (recipient, audience) for the whole operation, its line
    // being this audience's subject — the same projection rule as the service planner's.
    const displayNumber = formatServiceRequestNumber(data.num);
    for (const recipient of recipients) {
      await putBulkMailItem(tx, {
        sink: params.bulk,
        recipient,
        event,
        line: letterOf(recipient).subject,
        displayNumber,
      });
    }
    if (reached) targets.requester = 'batched_for_summary';
    if (targets.copies) targets.copies = 'batched_for_summary';
    return finish(reached ? 'batched_for_summary' : 'no_recipients', recipients, skip);
  }

  /**
   * The same cap as every module letter (E6): all module letters per request + address + UTC hour,
   * the author's included — he and a staff member on the service side share the count of their
   * own address, not a separate allowance.
   */
  const limit = config.serviceRequests.mailMaxPerRequestHour;
  const hour = await currentHour(tx);
  let deadSummary = false;
  for (const recipient of recipients) {
    if (limit > 0 && (await windowCount(tx, requestId, recipient.email, hour)) >= limit) {
      const summary = await queueActivitySummary(tx, { requestId, recipient, hour, data });
      if (summary === 'mail_failed') deadSummary = true;
      continue;
    }
    const letter = letterOf(recipient);
    await queuePreparedMail(
      {
        kind: event,
        dedupeKey: `${event}:${params.anchor}:${recipient.key}`,
        to: recipient.email,
        account: SERVICE_MAIL_ACCOUNT,
        replyTo: recipient.replyTo,
        subject: letter.subject,
        text: letter.text,
        html: letter.html,
        entityType: 'serviceRequest',
        entityId: requestId,
      },
      { tx },
    );
  }
  if (deadSummary) {
    targets.requester = 'mail_failed';
    return finish('mail_failed', recipients, skip);
  }
  return finish(reached ? 'queued' : 'no_recipients', recipients, skip);
}

// ── The body ──

interface RenderedLetter {
  subject: string;
  text: string;
  html: string;
}

/**
 * The author's letter (E4). Built from the same letter data and the same detail lines as the
 * service bodies, behind `SERVICE_MAIL_AUDIENCE_FIELDS.requester`: no money, no attachments count,
 * no document names, no "who filed it". What differs is the letter itself — the subject speaks to
 * the author («по вашей заявке»), the first line says what happened in his words, the link opens
 * the card (and the discussion for a message), and the footer says not to reply by mail (D4).
 */
function buildRequesterLetter(
  event: RequesterMailEvent,
  data: ServiceLetterData,
  extra: ServiceLetterExtra,
): { subject: string; content: MailContent } {
  const fields = SERVICE_MAIL_AUDIENCE_FIELDS.requester;
  const number = formatServiceRequestNumber(data.num);
  const comment = event === 'service_request_requester_comment';
  const status = extra.toStatus ?? data.status;

  let headline: string;
  const opening: MailContent['blocks'] = [];
  if (comment) {
    if (!extra.message) {
      // A message letter without the message is a caller bug, not an empty letter: the caller
      // answers `mail_failed` aloud instead of sending the author a letter about nothing.
      throw new Error(`Заявка ${number}: письмо заявителю о сообщении собирается без сообщения`);
    }
    headline = 'Новое сообщение по вашей заявке';
  } else {
    if (!REQUESTER_STATUS_LETTERS[status]) {
      throw new Error(
        `Заявка ${number}: письма заявителю о статусе «${serviceRequestStatusLabels[status]}» нет`,
      );
    }
    const wording = REQUESTER_STATUS_WORDING[status as RequesterLetterStatus]({
      // The reason is free text of a person: the description field gates it, as in every body.
      reason: fields.description ? (extra.comment ?? '').trim() : '',
      automatic: extra.automatic === true,
    });
    headline = wording.headline;
    opening.push({ kind: 'paragraph', text: wording.line });
  }

  const assignees = fields.assignees ? assigneesOf(data) : '';
  const lines = [
    ...(comment && fields.description && extra.message
      ? [`Написал: ${extra.message.authorName}`, `Кому: ${extra.message.addressees}`]
      : []),
    `Статус: ${serviceRequestStatusLabels[status]}`,
    ...(assignees ? [`Исполнитель: ${assignees}`] : []),
    ...requestDetailLines(data, fields, 'requester'),
  ];

  const href = `${config.publicOrigin}/office-equipment?tab=requests&open=${data.requestId}${
    comment ? '&chat=1' : ''
  }`;
  const content: MailContent = {
    title: `${number} — ${headline}`,
    blocks: [
      ...opening,
      { kind: 'lines', lines },
      ...(comment && fields.description && extra.message
        ? [
            { kind: 'heading' as const, text: 'Сообщение' },
            { kind: 'paragraph' as const, text: extra.message.body },
          ]
        : []),
      ...(fields.description
        ? [
            { kind: 'heading' as const, text: 'Описание' },
            { kind: 'paragraph' as const, text: data.description },
          ]
        : []),
      ...(fields.portalLink
        ? [
            {
              kind: 'link' as const,
              // `chat=1` opens the discussion over the card (`RequestsTab.tsx`): the letter is
              // about a message, and the author answers right there.
              href,
              label: comment ? 'Открыть обсуждение заявки в портале' : 'Открыть заявку в портале',
            },
          ]
        : []),
      { kind: 'note', text: REQUESTER_LETTER_FOOTER },
    ],
  };
  return { subject: `${number} · ${headline}`, content };
}

/** The ready letter: subject and rendered body — what goes to the queue. */
export function renderRequesterLetter(
  event: RequesterMailEvent,
  data: ServiceLetterData,
  extra: ServiceLetterExtra,
): RenderedLetter {
  const letter = buildRequesterLetter(event, data, extra);
  const rendered = renderMail(letter.content);
  return { subject: letter.subject, text: rendered.text, html: rendered.html };
}

/**
 * The same letter before rendering, for the debug send (`POST /admin/mail/test`): it marks the
 * letter «ТЕСТ», which only `MailContent` can carry. One path with `renderRequesterLetter`, so the
 * sample is the letter people get.
 */
export function requesterLetterContent(
  event: RequesterMailEvent,
  data: ServiceLetterData,
  extra: ServiceLetterExtra,
): { subject: string; content: MailContent } {
  return buildRequesterLetter(event, data, extra);
}
