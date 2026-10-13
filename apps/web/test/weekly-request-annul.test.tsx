import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route, Routes } from 'react-router';
import {
  shiftDateKey,
  weeklyWeekBounds,
  weeklyWeekLabel,
  weekStartKey,
  type AnnulWeeklyRequestBody,
  type AuthUser,
  type Permission,
  type WeeklyAnnulItemDto,
  type WeeklyAnnulPreviewDto,
  type WeeklyRequestStatus,
  type WeeklyReversalResultDto,
  type WeeklyVehicleRequestDto,
} from '@technic/contracts';
import { apiError, json, mockHttp, type MockResponse, type RouteMap } from './http';
import { renderWithUser } from './render';
import { expectModalClosed } from './antd';
import { authUser } from './factories/auth';
import { emptyList } from './factories/common';
import { weeklyItem, weeklyRequest } from './factories/vehicle';
import { weeklyToday } from '@entities/weekly-request';
import { formatDateOnly } from '@shared/lib';
import { WeeklyRequestPage } from '@pages/vehicle';

/**
 * Annulment of an applied week (ADR 0218) on screen.
 *
 * The approval extended orders, created new ones and fixed "leaving" decisions in one transaction;
 * annulment rolls all of it back with one command. The portal computes nothing itself: the button
 * follows the contract predicates over the permission list the server sent, the window retells the
 * server's preview (the plan the command will execute) and sends its fingerprint back, and a 409
 * makes the window ask for the plan again. Checked here is what the portal promises the server and
 * the person: who sees the button, what the window says, what the command body carries and what the
 * card shows after the answer.
 */

/** Next week's Monday: the removed days are ahead, the ordinary branch. */
const WEEK = shiftDateKey(weekStartKey(weeklyToday()), 7);
const WEEK_END = weeklyWeekBounds(WEEK).to;
/** A day already past: the backdated branch is chosen by the first removed day, not the week. */
const PAST_DAY = shiftDateKey(weeklyToday(), -3);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Dispatcher: holds `waybills.correct`, which opens both branches, and reads the waybill journal. */
const dispatcher = authUser({ id: 'user-disp', role: 'dispatcher' });
/** Construction manager of the site: annuls by `weeklyRequests.approve`, the ordinary branch only. */
const rukstroy = authUser({ id: 'user-ruk', role: 'rukstroy', constructionObjectIds: ['obj-1'] });
/** Site staff: reads and composes the week, holds neither annulment right. */
const shtab = authUser({ id: 'user-shtab', role: 'shtab', constructionObjectIds: ['obj-1'] });

/**
 * The server's permission list differs from what the role would give: an account assembled by an
 * administrator. The portal must ask the list, not the role (ADR 0106), or it would offer a button
 * the command refuses or hide one it accepts.
 */
function withPermissions(user: AuthUser, edit: (granted: Permission[]) => Permission[]): AuthUser {
  return { ...user, permissions: edit([...user.permissions]) };
}

function week(overrides: Partial<WeeklyVehicleRequestDto> = {}): WeeklyVehicleRequestDto {
  return weeklyRequest({
    id: 'wr-1',
    status: 'applied',
    comment: '',
    weekStart: WEEK,
    weekEnd: WEEK_END,
    weekLabel: weeklyWeekLabel(WEEK),
    items: [
      weeklyItem({ kind: 'extend', sourceRequestId: 'vr-1', dateTo: WEEK_END, result: 'extended' }),
    ],
    version: 7,
    ...overrides,
  });
}

function previewItem(over: Partial<WeeklyAnnulItemDto> = {}): WeeklyAnnulItemDto {
  return {
    itemId: 'wi-1',
    kind: 'extend',
    title: 'Экскаватор (продление)',
    requestId: 'vr-1',
    displayNumber: 'ТС-42',
    state: 'reversible',
    reason: '',
    reverse: 'shorten_to',
    shortenTo: shiftDateKey(WEEK, -1),
    hadEffect: true,
    ...over,
  };
}

/** The server's plan of the annulment; the window retells it and sends its fingerprint back. */
function preview(over: Partial<WeeklyAnnulPreviewDto> = {}): WeeklyAnnulPreviewDto {
  return {
    weeklyRequestId: 'wr-1',
    weekStart: WEEK,
    weekLabel: weeklyWeekLabel(WEEK),
    today: weeklyToday(),
    effectiveDate: WEEK,
    backdated: false,
    requiresOperation: false,
    correctionFloor: shiftDateKey(weeklyToday(), -30),
    allowed: true,
    blockedReason: null,
    items: [previewItem()],
    blockers: [],
    paper: { cancel: 1, trim: 0, reissue: 0, trimmedTo: null },
    unlockable: [],
    unlockableCount: 0,
    cancelGroups: [],
    cancelGroupsFingerprint: null,
    issues: [],
    linearDays: { detachable: [], frozen: [] },
    shifts: [],
    pendingWeeks: [],
    fingerprint: 'fp-annul',
    asOf: weeklyToday(),
    ...over,
  };
}

const RESULT: WeeklyReversalResultDto = {
  weeklyRequestId: 'wr-1',
  status: 'annulled',
  shortened: [{ requestId: 'vr-1', displayNumber: 'ТС-42', dateTo: shiftDateKey(WEEK, -1) }],
  cancelled: [{ requestId: 'vr-50', displayNumber: 'ТС-50' }],
  released: 0,
  esm2: { cancelled: 2, issued: 0 },
};

/**
 * The card's routes. The header is held in a variable: a successful annulment rewrites it the way
 * the server would, so the reread card is what the person sees next.
 */
function routes(
  initial: WeeklyVehicleRequestDto,
  plan: () => WeeklyAnnulPreviewDto = () => preview(),
  annul: (body: AnnulWeeklyRequestBody) => MockResponse = () => json(RESULT),
): RouteMap {
  let current = initial;
  return {
    // Order matters: `suggestion` would match the `:id` template if it stood below it.
    'GET /weekly-vehicle-requests/suggestion': () => json(null),
    'GET /weekly-vehicle-requests/:id/annul': () => json(plan()),
    'GET /weekly-vehicle-requests/:id/return': () => json(preview({ fingerprint: 'fp-return' })),
    'GET /weekly-vehicle-requests/:id': () => json(current),
    'GET /weekly-vehicle-requests/:id/history': () => json([]),
    'GET /weekly-vehicle-requests/:id/documents': () => json([]),
    'POST /weekly-vehicle-requests/:id/annul': ({ body }) => {
      const sent = body as AnnulWeeklyRequestBody;
      const answer = annul(sent);
      if (answer.status === 200) {
        current = week({
          ...current,
          status: 'annulled',
          annulReason: sent.reason,
          annulledBy: 'user-disp',
          annulledByName: 'Диспетчер Д.Д.',
          annulledAt: '2026-10-12T09:00:00.000Z',
          version: current.version + 1,
        });
      }
      return answer;
    },
    'GET /objects': () => json(emptyList()),
    'GET /vehicle-classifications': () => json(emptyList()),
  };
}

function renderPage(user: AuthUser) {
  return renderWithUser(
    <Routes>
      <Route path="/vehicle-requests/weekly/:id" element={<WeeklyRequestPage />} />
    </Routes>,
    { user, route: '/vehicle-requests/weekly/wr-1' },
  );
}

const ANNUL = 'Аннулировать неделю';

/** Open the window and wait for the server's plan in it. */
async function openWindow(): Promise<HTMLElement> {
  fireEvent.click(await screen.findByRole('button', { name: ANNUL }));
  const dialog = await screen.findByRole('dialog');
  await within(dialog).findByText('Что будет со строками');
  return dialog;
}

/** A composition row of the window and the tag it carries. */
function row(dialog: HTMLElement, text: string) {
  const item = within(dialog).getByText(text);
  return { item, tag: item.querySelector('.ant-tag')?.textContent ?? null };
}

/**
 * Let a submit run its course. Form validation is asynchronous, so a click that slipped past the
 * disabled button would send the command only a moment later; asserting "nothing was sent" at once
 * would pass in that case too.
 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

const okButton = (dialog: HTMLElement) =>
  within(dialog).getByRole<HTMLButtonElement>('button', { name: 'Аннулировать' });

function typeReason(dialog: HTMLElement, value: string) {
  fireEvent.change(within(dialog).getByLabelText('Причина аннулирования'), { target: { value } });
}

describe('аннулирование применённой недели: кто видит действие', () => {
  it.each([
    ['диспетчер — правом прошлого', dispatcher, true],
    ['руководитель строительства — правом визы', rukstroy, true],
    ['штаб площадки — ни одного из двух прав', shtab, false],
    [
      'руководитель, у которого сервер снял визу',
      withPermissions(rukstroy, (granted) => granted.filter((p) => p !== 'weeklyRequests.approve')),
      false,
    ],
    [
      'штаб, которому администратор выдал право прошлого',
      withPermissions(shtab, (granted) => [...granted, 'waybills.correct']),
      true,
    ],
  ])('%s', async (_who, user, visible) => {
    const http = mockHttp(routes(week()));
    renderPage(user);

    // The applied card is on screen: its checklist exists only for an applied week.
    await screen.findByText('Готовность недели');
    expect(!!screen.queryByRole('button', { name: ANNUL })).toBe(visible);
    // The plan is a history and paper computation per row: it is asked when the window opens,
    // never with the card.
    expect(http.countOf('GET /weekly-vehicle-requests/:id/annul')).toBe(0);
  });

  it.each<[WeeklyRequestStatus, string]>([
    ['draft', 'Комментарий к неделе'],
    ['pending', 'Комментарий к неделе'],
    ['cancelled', 'Заявка снята: передумали'],
    ['annulled', 'Заявка аннулирована: не та площадка'],
  ])('у недели в статусе %s кнопки нет — правило шапки контрактов', async (status, landmark) => {
    const http = mockHttp(
      routes(
        week({
          status,
          cancelReason: status === 'cancelled' ? 'передумали' : '',
          annulReason: status === 'annulled' ? 'не та площадка' : '',
        }),
      ),
    );
    renderPage(dispatcher);

    await screen.findByText(landmark);
    expect(screen.queryByRole('button', { name: ANNUL })).toBeNull();
    expect(http.countOf('GET /weekly-vehicle-requests/:id/annul')).toBe(0);
  });
});

describe('аннулирование применённой недели: окно', () => {
  it('пересказывает план сервера: ход каждой строки, бумагу, смены и дни рейсов', async () => {
    const plan = preview({
      items: [
        previewItem(),
        previewItem({
          itemId: 'wi-2',
          kind: 'new',
          title: 'Кран (дополнительно)',
          requestId: 'vr-50',
          displayNumber: 'ТС-50',
          reverse: 'cancel',
          shortenTo: null,
        }),
        previewItem({
          itemId: 'wi-3',
          kind: 'leave',
          title: 'Каток (уезжает)',
          requestId: 'vr-43',
          displayNumber: 'ТС-43',
          reverse: 'release_leave',
          shortenTo: null,
        }),
        // Undone by hand: annulment only closes it — unlike the return, the row stays.
        previewItem({
          itemId: 'wi-4',
          requestId: 'vr-44',
          displayNumber: 'ТС-44',
          state: 'reverted',
          reason: 'Срок заказа уже возвращён: идёт до 10 окт.',
          reverse: 'none',
          shortenTo: null,
        }),
      ],
      paper: { cancel: 2, trim: 1, reissue: 0, trimmedTo: shiftDateKey(WEEK, -1) },
      shifts: [WEEK, shiftDateKey(WEEK, 1)],
      linearDays: { detachable: [shiftDateKey(WEEK, 2)], frozen: [] },
      pendingWeeks: ['НЗ-14'],
    });
    const http = mockHttp(routes(week(), () => plan));
    renderPage(dispatcher);

    const dialog = await openWindow();
    expect(http.countOf('GET /weekly-vehicle-requests/:id/annul')).toBe(1);
    expect(http.countOf('GET /weekly-vehicle-requests/:id/return')).toBe(0);
    within(dialog).getByText('НЗ-12 · аннулировать неделю');

    // The branch first: it changes both the right and the price.
    within(dialog).getByText('Снимаемые дни ещё не наступили');
    within(dialog).getByText(`Первый снимаемый день — ${formatDateOnly(WEEK)}, он ещё впереди.`);
    within(dialog).getByText(
      'Листы ЭСМ-2 будут аннулированы: 2 без замены, 0 с перевыпиской. Списанный номер не возвращается.',
    );
    within(dialog).getByText(
      `Листов с подрезкой периода: 1 — по ${formatDateOnly(shiftDateKey(WEEK, -1))}. Номер у них не горит.`,
    );
    within(dialog).getByText(
      `Снимутся незаполненные смены за 2 дн.: ${formatDateOnly(WEEK)}, ${formatDateOnly(shiftDateKey(WEEK, 1))}.`,
    );
    within(dialog).getByText(`Дни уйдут из рейсов: ${formatDateOnly(shiftDateKey(WEEK, 2))}.`);
    within(dialog).getByText(
      'По тем же заказам собираются недели НЗ-14 — их строки после разворота придётся пересобрать: срок заказа изменится.',
    );

    expect(
      row(dialog, `ТС-42 · Остаётся — срок вернётся к ${formatDateOnly(shiftDateKey(WEEK, -1))}`)
        .tag,
    ).toBe('развернётся');
    expect(row(dialog, 'ТС-50 · Нужна дополнительно — заказ будет отменён').tag).toBe(
      'развернётся',
    );
    expect(row(dialog, 'ТС-43 · Уезжает — решение об отъезде перестанет действовать').tag).toBe(
      'развернётся',
    );
    expect(row(dialog, 'ТС-44 · Остаётся — Срок заказа уже возвращён: идёт до 10 окт.').tag).toBe(
      'уже развёрнута',
    );

    // The return's wording never leaks into annulment: the week is closed, not reapproved.
    expect(within(dialog).queryByText(/уйд[её]т из состава/)).toBeNull();
    expect(within(dialog).queryByText(/Ждёт визы/)).toBeNull();
    // Nothing to name and no journal: the ordinary branch without cancelled decisions.
    expect(within(dialog).queryByText('Листы ЭСМ-2 к перевыписке')).toBeNull();
    expect(within(dialog).queryByText(/журнале коррекций/)).toBeNull();
    within(dialog).getByText('Останется в шапке заявки и в её истории');
  });

  it('у недели, развёрнутой руками целиком, окно говорит, что команда только закроет документ', async () => {
    const plan = preview({
      effectiveDate: null,
      items: [
        previewItem({
          state: 'reverted',
          reason: 'Срок заказа уже возвращён: идёт до 10 окт.',
          reverse: 'none',
          shortenTo: null,
        }),
      ],
      paper: { cancel: 0, trim: 0, reissue: 0, trimmedTo: null },
    });
    mockHttp(routes(week(), () => plan));
    renderPage(dispatcher);

    const dialog = await openWindow();
    within(dialog).getByText('Следствия уже развёрнуты — аннулирование только закроет документ');
    // No days are removed, so no first removed day and no sheets to burn are promised.
    expect(within(dialog).queryByText(/Первый снимаемый день/)).toBeNull();
    expect(within(dialog).queryByText(/Листы ЭСМ-2 будут аннулированы/)).toBeNull();
    expect(okButton(dialog).disabled).toBe(false);
  });

  it('факты работы запирают аннулирование: окно называет их датами, команда не уходит', async () => {
    const signed = [WEEK, shiftDateKey(WEEK, 1)];
    const plan = preview({
      allowed: false,
      blockedReason: 'Аннулировать неделю нельзя: по заказу ТС-42 площадка уже подписала работу',
      items: [
        previewItem({
          itemId: 'wi-2',
          kind: 'new',
          requestId: 'vr-50',
          displayNumber: 'ТС-50',
          state: 'blocked',
          reason: 'Порождённый заказ уже в статусе «В работе» — сначала закройте или откатите его',
          reverse: 'none',
          shortenTo: null,
        }),
      ],
      blockers: [
        {
          code: 'approved_shift',
          itemId: 'wi-1',
          dates: signed,
          message:
            'По заказу ТС-42 площадка уже подписала работу за снимаемые дни — эти дни закрывают фактической датой, а не разворотом недели',
        },
      ],
    });
    const http = mockHttp(routes(week(), () => plan));
    renderPage(dispatcher);

    const dialog = await openWindow();
    // The refusal comes first, in the server's words: the same text the command would answer.
    within(dialog).getByText('Аннулировать нельзя');
    within(dialog).getByText(plan.blockedReason!);
    within(dialog).getByText('Факты работы на снимаемых днях');
    within(dialog).getByText(
      `${plan.blockers[0]!.message}: ${signed.map(formatDateOnly).join(', ')}`,
    );
    expect(
      row(
        dialog,
        'ТС-50 · Нужна дополнительно — Порождённый заказ уже в статусе «В работе» — сначала закройте или откатите его',
      ).tag,
    ).toBe('нельзя развернуть');

    expect(okButton(dialog).disabled).toBe(true);
    typeReason(dialog, 'Ошиблись площадкой');
    fireEvent.click(okButton(dialog));
    await settle();
    expect(http.countOf('POST /weekly-vehicle-requests/:id/annul')).toBe(0);
  });

  it('причина обязательна в обычной ветви: без неё команда не уходит', async () => {
    const http = mockHttp(routes(week()));
    renderPage(rukstroy);

    const dialog = await openWindow();
    fireEvent.click(okButton(dialog));
    await within(dialog).findByText('Укажите причину');
    expect(http.countOf('POST /weekly-vehicle-requests/:id/annul')).toBe(0);
  });
});

describe('аннулирование применённой недели: команда', () => {
  it('обычная ветвь: тело — причина, версия шапки и отпечаток; после ответа карточка перечитана', async () => {
    const http = mockHttp(routes(week()));
    renderPage(rukstroy);

    const dialog = await openWindow();
    typeReason(dialog, 'Ошиблись площадкой');
    fireEvent.click(okButton(dialog));

    await waitFor(() => expect(http.countOf('POST /weekly-vehicle-requests/:id/annul')).toBe(1));
    const sent = http.lastCall('POST /weekly-vehicle-requests/:id/annul')
      ?.body as AnnulWeeklyRequestBody;
    // No operation key and no group fingerprint: the plan asked for neither.
    expect(sent).toEqual({ reason: 'Ошиблись площадкой', version: 7, fingerprint: 'fp-annul' });

    // The result in numbers: the person has just agreed to burn form numbers.
    await screen.findByText(
      'Неделя аннулирована — сроков возвращено: 1, заказов отменено: 1, листов аннулировано: 2',
    );
    await expectModalClosed('НЗ-12 · аннулировать неделю');
    // The card is reread and tells what happened; the header rule takes the button away.
    await screen.findByText('Заявка аннулирована: Ошиблись площадкой');
    expect(http.countOf('GET /weekly-vehicle-requests/:id')).toBeGreaterThan(1);
    expect(screen.queryByRole('button', { name: ANNUL })).toBeNull();
  });

  it('повтор по ключу операции отвечает без счётчиков — окно не выдаёт его за пустой разворот', async () => {
    mockHttp(
      routes(
        week(),
        () => preview(),
        () =>
          json({
            ...RESULT,
            shortened: [],
            cancelled: [],
            esm2: { cancelled: 0, issued: 0 },
            repeated: true,
          }),
      ),
    );
    renderPage(dispatcher);

    const dialog = await openWindow();
    typeReason(dialog, 'Ошиблись площадкой');
    fireEvent.click(okButton(dialog));

    await screen.findByText(
      'Неделя аннулирована — запрос уже был выполнен, повторно ничего не изменено',
    );
  });

  it('гасимые решения истории назначения: свой отпечаток и ключ операции даже в обычной ветви', async () => {
    const plan = preview({
      requiresOperation: true,
      cancelGroups: [
        {
          effectiveDate: shiftDateKey(WEEK, 2),
          dimensions: ['Машина', 'Машинист'],
          title: 'ТС-42: машина А → Б',
        },
      ],
      cancelGroupsFingerprint: 'fp-groups',
    });
    const http = mockHttp(routes(week(), () => plan));
    renderPage(rukstroy);

    const dialog = await openWindow();
    within(dialog).getByText('Погаснут запланированные решения');
    within(dialog).getByText(
      `ТС-42: машина А → Б (Машина, Машинист) — с ${formatDateOnly(shiftDateKey(WEEK, 2))}. Их придётся завести заново, если решение остаётся в силе.`,
    );
    within(dialog).getByText(
      'Причина и ключ операции останутся в журнале коррекций вместе с вашим именем: через месяцы по ним объяснят, почему неделю развернули.',
    );
    within(dialog).getByText(
      'Останется в шапке заявки и в журнале коррекций, а также в листах, переоформленных этой операцией',
    );

    typeReason(dialog, 'Ошиблись площадкой');
    fireEvent.click(okButton(dialog));
    await waitFor(() => expect(http.countOf('POST /weekly-vehicle-requests/:id/annul')).toBe(1));
    const sent = http.lastCall('POST /weekly-vehicle-requests/:id/annul')
      ?.body as AnnulWeeklyRequestBody;
    expect(sent).toEqual({
      reason: 'Ошиблись площадкой',
      version: 7,
      fingerprint: 'fp-annul',
      cancelGroupsFingerprint: 'fp-groups',
      // The sheet list is mounted only when there are sheets to name; the schema defaults it to
      // an empty list, so the key is simply absent here.
      correction: { operationId: expect.stringMatching(UUID) },
    });
  });

  it('ветвь задним числом: отработанные листы называют поимённо, отмеченный уходит в теле', async () => {
    const plan = preview({
      effectiveDate: PAST_DAY,
      backdated: true,
      requiresOperation: true,
      paper: { cancel: 0, trim: 0, reissue: 1, trimmedTo: null },
      unlockable: [
        {
          waybillId: '11111111-1111-4111-8111-111111111111',
          requestId: 'vr-1',
          displayNumber: 'ТС-42',
          number: '260604-646-00000004897',
          periodFrom: shiftDateKey(PAST_DAY, -6),
          periodTo: PAST_DAY,
        },
        {
          waybillId: '22222222-2222-4222-8222-222222222222',
          requestId: 'vr-2',
          displayNumber: 'ТС-77',
          number: '260604-646-00000004898',
          periodFrom: shiftDateKey(PAST_DAY, -6),
          periodTo: PAST_DAY,
        },
      ],
      unlockableCount: 2,
    });
    const http = mockHttp(routes(week(), () => plan));
    renderPage(dispatcher);

    const dialog = await openWindow();
    within(dialog).getByText('Операция идёт задним числом');
    within(dialog).getByText(`Первый снимаемый день — ${formatDateOnly(PAST_DAY)}, он уже прошёл.`);
    within(dialog).getByText(
      'Листы ЭСМ-2 будут аннулированы: 0 без замены, 1 с перевыпиской. Списанный номер не возвращается.',
    );
    const period = `${formatDateOnly(shiftDateKey(PAST_DAY, -6))} – ${formatDateOnly(PAST_DAY)}`;
    // Two vehicles' sheets legally share a week: each is named, a blanket choice would burn the
    // wrong number.
    fireEvent.click(within(dialog).getByLabelText(`ТС-42 · № 260604-646-00000004897 · ${period}`));
    expect(
      within(dialog).getByLabelText<HTMLInputElement>(
        `ТС-77 · № 260604-646-00000004898 · ${period}`,
      ).checked,
    ).toBe(false);

    typeReason(dialog, 'Неделя проведена не по той площадке');
    fireEvent.click(okButton(dialog));
    await waitFor(() => expect(http.countOf('POST /weekly-vehicle-requests/:id/annul')).toBe(1));
    const sent = http.lastCall('POST /weekly-vehicle-requests/:id/annul')
      ?.body as AnnulWeeklyRequestBody;
    expect(sent).toEqual({
      reason: 'Неделя проведена не по той площадке',
      version: 7,
      fingerprint: 'fp-annul',
      correction: {
        operationId: expect.stringMatching(UUID),
        unlockWaybillIds: ['11111111-1111-4111-8111-111111111111'],
      },
    });
  });

  it('номера бланков видит держатель журнала листов, остальным окно называет счётчик и отказ по праву', async () => {
    const plan = preview({
      effectiveDate: PAST_DAY,
      backdated: true,
      requiresOperation: true,
      allowed: false,
      blockedReason:
        'Аннулировать неделю, чьи дни уже идут, может тот, у кого есть право коррекции задним числом',
      unlockable: null,
      unlockableCount: 2,
    });
    const http = mockHttp(routes(week(), () => plan));
    renderPage(rukstroy);

    const dialog = await openWindow();
    within(dialog).getByText('Аннулировать нельзя');
    within(dialog).getByText(plan.blockedReason!);
    within(dialog).getByText('Отработанных листов на снимаемых днях: 2');
    within(dialog).getByText(
      'Номера бланков показываются тому, кто ведёт журнал листов. Отметить их может диспетчер',
    );
    expect(within(dialog).queryByRole('checkbox')).toBeNull();
    expect(within(dialog).queryByText(/00000004897/)).toBeNull();

    expect(okButton(dialog).disabled).toBe(true);
    fireEvent.click(okButton(dialog));
    await settle();
    expect(http.countOf('POST /weekly-vehicle-requests/:id/annul')).toBe(0);
  });

  it('409: окно остаётся открытым, план и шапка спрашиваются заново, повтор несёт новые версию и отпечаток', async () => {
    let planVersion = 1;
    const plan = () =>
      planVersion === 1
        ? preview({ requiresOperation: true, cancelGroups: [], fingerprint: 'fp-1' })
        : preview({
            requiresOperation: true,
            fingerprint: 'fp-2',
            // Between the view and the click someone issued a sheet: the price grew.
            paper: { cancel: 2, trim: 0, reissue: 0, trimmedTo: null },
          });
    let header = week();
    const http = mockHttp({
      ...routes(header, plan),
      'GET /weekly-vehicle-requests/:id': () => json(header),
    });
    http.use({
      'POST /weekly-vehicle-requests/:id/annul': ({ body }) => {
        if ((body as AnnulWeeklyRequestBody).fingerprint === 'fp-1') {
          planVersion = 2;
          header = week({ version: 8 });
          return apiError(409, {
            code: 'version_conflict',
            message: 'Последствия изменились с момента просмотра: посмотрите перечень заново',
          });
        }
        return json(RESULT);
      },
    });
    renderPage(dispatcher);

    const dialog = await openWindow();
    within(dialog).getByText(
      'Листы ЭСМ-2 будут аннулированы: 1 без замены, 0 с перевыпиской. Списанный номер не возвращается.',
    );
    typeReason(dialog, 'Ошиблись площадкой');
    fireEvent.click(okButton(dialog));
    await waitFor(() => expect(http.countOf('POST /weekly-vehicle-requests/:id/annul')).toBe(1));
    const first = http.lastCall('POST /weekly-vehicle-requests/:id/annul')
      ?.body as AnnulWeeklyRequestBody;

    // The plan is asked again and the new price is shown in the same window.
    await within(dialog).findByText(
      'Листы ЭСМ-2 будут аннулированы: 2 без замены, 0 с перевыпиской. Списанный номер не возвращается.',
    );
    expect(http.countOf('GET /weekly-vehicle-requests/:id/annul')).toBe(2);
    expect(screen.getByRole('dialog')).toBe(dialog);
    // The server's words, not the composition's notice: the window has no edits to lose.
    await screen.findByText(
      'Последствия изменились с момента просмотра: посмотрите перечень заново',
      { selector: '.ant-message *' },
    );
    expect(screen.queryByText(/ваши правки не сохранены/)).toBeNull();
    // The reason the person typed survives the reread: the window session is the same.
    expect(within(dialog).getByLabelText<HTMLTextAreaElement>('Причина аннулирования').value).toBe(
      'Ошиблись площадкой',
    );

    fireEvent.click(okButton(dialog));
    await waitFor(() => expect(http.countOf('POST /weekly-vehicle-requests/:id/annul')).toBe(2));
    const second = http.lastCall('POST /weekly-vehicle-requests/:id/annul')
      ?.body as AnnulWeeklyRequestBody;
    expect(first).toMatchObject({ version: 7, fingerprint: 'fp-1' });
    expect(second).toMatchObject({
      reason: 'Ошиблись площадкой',
      version: 8,
      fingerprint: 'fp-2',
    });
    // The key is kept while the window is open on this request: the conflict rolled back the
    // first attempt, and a fresh key would only matter after a dropped connection.
    expect(second.correction?.operationId).toBe(first.correction?.operationId);
    await screen.findByText(/^Неделя аннулирована/);
  });

  it.each([
    [
      422,
      'Аннулировать неделю нельзя: Заказ тронут неделей НЗ-14, применённой позже — разверните сначала её',
    ],
    [403, 'Аннулировать применённую неделю может руководитель этой площадки или диспетчер'],
  ])('отказ %s показывается словами сервера, окно остаётся открытым', async (status, message) => {
    const http = mockHttp(
      routes(
        week(),
        () => preview(),
        () => apiError(status, { code: status === 403 ? 'forbidden' : 'unprocessable', message }),
      ),
    );
    renderPage(rukstroy);

    const dialog = await openWindow();
    typeReason(dialog, 'Ошиблись площадкой');
    fireEvent.click(okButton(dialog));

    // The toast, not the card: the refusal is answered where the person clicked.
    await screen.findByText(message, { selector: '.ant-message *' });
    expect(http.countOf('POST /weekly-vehicle-requests/:id/annul')).toBe(1);
    expect(screen.getByRole('dialog')).toBe(dialog);
    expect(screen.queryByText(/^Неделя аннулирована/)).toBeNull();
  });

  /*
   * A reversal refusal belongs to the window, not to the card. The apply-refusal banner would say
   * "the application failed, the rows are marked in the composition" — nothing was being applied,
   * and an applied card has no composition editor to mark rows in (found by this test, F6).
   */
  it('отказ аннулирования не выдаётся на карточке за отказ применения', async () => {
    const message =
      'Аннулировать неделю нельзя: Заказ тронут неделей НЗ-14, применённой позже — разверните сначала её';
    mockHttp(
      routes(
        week(),
        () => preview(),
        () => apiError(422, { code: 'unprocessable', message }),
      ),
    );
    renderPage(rukstroy);

    const dialog = await openWindow();
    typeReason(dialog, 'Ошиблись площадкой');
    fireEvent.click(okButton(dialog));
    await screen.findByText(message, { selector: '.ant-message *' });

    expect(screen.queryByText('Применение не прошло — неделя осталась там, где была')).toBeNull();
  });

  /*
   * A 422 means the plan the window showed is stale: between the view and the click the server
   * found a blocker. Without a reread the window kept saying "allowed" with an active button, and
   * the person could only click into the same refusal again (F6 tail).
   */
  it('отказ 422 перечитывает план: окно называет блокировку, кнопка гаснет', async () => {
    const message = 'Аннулировать неделю нельзя: по заказу ТС-42 площадка уже подписала работу';
    const signed = [WEEK];
    const blocked = preview({
      allowed: false,
      blockedReason: message,
      blockers: [
        {
          code: 'approved_shift',
          itemId: 'wi-1',
          dates: signed,
          message: 'По заказу ТС-42 площадка уже подписала работу за снимаемые дни',
        },
      ],
    });
    let refused = false;
    const http = mockHttp(
      routes(
        week(),
        () => (refused ? blocked : preview()),
        () => {
          refused = true;
          return apiError(422, { code: 'unprocessable', message });
        },
      ),
    );
    renderPage(rukstroy);

    const dialog = await openWindow();
    expect(okButton(dialog).disabled).toBe(false);
    typeReason(dialog, 'Ошиблись площадкой');
    fireEvent.click(okButton(dialog));
    await screen.findByText(message, { selector: '.ant-message *' });

    // The same window, now retelling the reread plan: the refusal and the blocker by its dates.
    await within(dialog).findByText('Аннулировать нельзя');
    within(dialog).getByText(
      `${blocked.blockers[0]!.message}: ${signed.map(formatDateOnly).join(', ')}`,
    );
    expect(http.countOf('GET /weekly-vehicle-requests/:id/annul')).toBe(2);
    expect(screen.getByRole('dialog')).toBe(dialog);
    expect(okButton(dialog).disabled).toBe(true);
    fireEvent.click(okButton(dialog));
    await settle();
    expect(http.countOf('POST /weekly-vehicle-requests/:id/annul')).toBe(1);
  });
});
