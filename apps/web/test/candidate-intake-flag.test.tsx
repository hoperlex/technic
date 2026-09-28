import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import type { AuthUser, FeatureFlagKey, Permission } from '@technic/contracts';
import { candidateIntakeAccess } from '@entities/office-equipment-candidate';
import { useAuth } from '@entities/session';
import { apiFetch } from '../src/shared/api';
import { apiError, json, mockHttp } from './http';
import { renderWithSession } from './render';
import { authUser, loginResponse } from './factories/auth';

/**
 * The candidate intake switch reaches the screen through the session response — and, above all, its
 * ABSENCE means "closed" (plan `docs/office-equipment-request-subject-plan.md`, R10; the contract —
 * `docs/office-equipment-candidate-plan.md`, §14).
 *
 * WHY THIS FILE EXISTS when the condition is one line in `candidateIntakeAccess`. What is checked is
 * not the line but the DEFAULT ON A VERSION BOUNDARY. The portal is deployed separately from the
 * application, and inside the deploy window a new bundle gets the answer of an old server — with no
 * `features` field at all. The mistake is invisible both to the type (that is exactly why the field
 * is optional) and to the eye: `?? true` looks as harmless as `?? false` — and means intake wide
 * open in the very window the switch was built for (R11: the permission migration is applied BEFORE
 * the application restarts).
 *
 * THE ACCOUNTS CARRY A SUBJECT, NOT A HAND-WRITTEN LIST OF EFFECTIVE PERMISSIONS. The predicate now
 * asks the server list (`useAuth().can`), so a hand-written list would work here — and would test
 * half the path. The fixture builds the list from the subject the way the server does
 * (`permissionsFor` inside `authUser`), which keeps the account whole: the proposer is a role that
 * grants `officeEquipment.propose`, and the reviewer gets `officeEquipment.review` the way
 * production gives it — with a grant set, not with a role.
 *
 * WHAT IS NOT HERE. The server refusing a direct `POST /service-requests` — that is checked by a db
 * test and does not depend on the portal at all: the client only hides the door with the switch, the
 * server locks it, reading the same database row. The three branches of "Equipment not found?" live
 * in `missing-equipment.test.tsx`.
 *
 * A REAL `AuthProvider`, not a substituted context: the subject under test is what the portal read
 * FROM THE SERVER ANSWER, and substituting a ready-made user would test the fixture instead.
 */

/**
 * The role of a requester who may report a device: `officeEquipment.propose` comes to five site and
 * department roles plus the office `manager` as part of the requester circle (ADR 0165), and `shtab`
 * is one of them. Without the permission the switch would have nothing to open.
 */
const PROPOSER_ROLE = 'shtab';

/**
 * The permission to work the review queue, exactly as production hands it out: with the grant set
 * «Оргтехника: ведение», never with a role. The switch stops the inflow, not the review.
 */
const REVIEWER_GRANT: Permission[] = ['officeEquipment.review'];

/** An account from an old answer: it has no `features` field at all — not empty, absent. */
function oldApiUser(grantPermissions: Permission[] = []): AuthUser {
  return authUser({ role: PROPOSER_ROLE, constructionObjectIds: ['obj-1'], grantPermissions });
}

/** The answer of a new server: the list of enabled keys always arrives, even if empty. */
function withFeatures(user: AuthUser, ...features: FeatureFlagKey[]): AuthUser {
  return { ...user, features };
}

/** A screen showing both answers: nothing else tells "entrance closed" from "everything closed". */
function IntakeProbe() {
  // The account is read here and handed to the predicate whole — the entity layer that owns the
  // composition "switch plus permission" cannot reach the session itself.
  const { user, can } = useAuth();
  const { canPropose, canReview } = candidateIntakeAccess(user, can);
  return (
    <div>
      <div data-testid="propose">{canPropose ? 'открыт' : 'закрыт'}</div>
      <div data-testid="review">{canReview ? 'открыт' : 'закрыт'}</div>
      <button type="button" onClick={() => void apiFetch('/objects').catch(() => {})}>
        обновить список
      </button>
    </div>
  );
}

/**
 * The tab opens with the `before` answer, and the next token refresh returns `after`. The first
 * `refresh` is the tab bootstrap, so it is the second one that swaps the account (the same device as
 * in `flow-session-refresh-permissions`).
 */
function mount(before: AuthUser, after: AuthUser = before) {
  let refreshes = 0;
  let objectCalls = 0;
  const http = mockHttp({
    'POST /auth/refresh': () => {
      refreshes += 1;
      return json(loginResponse(refreshes === 1 ? before : after));
    },
    'GET /auth/me': () => json(before),
    // An ordinary request hits a 401 — the server has already recomputed the account; after the
    // refresh it goes through.
    'GET /objects': () => {
      objectCalls += 1;
      return objectCalls === 1
        ? apiError(401, { code: 'unauthorized', message: 'Требуется авторизация' })
        : json({ items: [], total: 0, page: 1, pageSize: 100 });
    },
  });
  renderWithSession(<IntakeProbe />);
  return http;
}

const shown = (id: 'propose' | 'review') => screen.getByTestId(id).textContent;

describe('приём кандидатов открывает только ответ сессии', () => {
  it('ответ БЕЗ поля features закрывает приём даже держателю propose', async () => {
    const user = oldApiUser();
    // The fixture is the subject under test: the field must be ABSENT, not empty. An empty array
    // would check the neighbouring default ("the key is not in the list"), and swapping one for the
    // other would go unnoticed.
    expect('features' in user).toBe(false);
    mount(user);

    await waitFor(() => expect(shown('propose')).toBe('закрыт'));
    // The permission is there: what closed the entrance is the switch, not a missing right.
    expect(user.permissions).toContain('officeEquipment.propose');
  });

  it('пустой список включённых ключей закрывает приём так же', async () => {
    mount(withFeatures(oldApiUser()));

    await waitFor(() => expect(shown('propose')).toBe('закрыт'));
  });

  it('ключ в списке открывает приём держателю права', async () => {
    mount(withFeatures(oldApiUser(), 'office_equipment_candidate_intake'));

    await waitFor(() => expect(shown('propose')).toBe('открыт'));
  });

  it('включённый рубильник не заменяет права: без propose вход закрыт', async () => {
    // A role that sees the equipment directory but is not in the requester circle: the dispatcher
    // does not report devices. The permission has to be absent from the SUBJECT — stripping it from
    // the effective list alone would describe an account the server never sends.
    const plain = authUser({ role: 'dispatcher', constructionObjectIds: ['obj-1'] });
    expect(plain.permissions).not.toContain('officeEquipment.propose');
    mount(withFeatures(plain, 'office_equipment_candidate_intake'));

    await waitFor(() => expect(shown('propose')).toBe('закрыт'));
  });

  it('выключенный приём оставляет очередь проверки открытой', async () => {
    // An emergency shutdown stops the inflow, but somebody still has to work through what was
    // already accepted: locking the review away with the entrance would leave candidates without
    // their only door to a decision.
    mount(oldApiUser(REVIEWER_GRANT));

    await waitFor(() => expect(shown('review')).toBe('открыт'));
    expect(shown('propose')).toBe('закрыт');
  });

  it('обновление токена доносит аварийное выключение без перезагрузки страницы', async () => {
    const open = withFeatures(oldApiUser(), 'office_equipment_candidate_intake');
    const http = mount(open, withFeatures(open));

    await waitFor(() => expect(shown('propose')).toBe('открыт'));
    screen.getByText('обновить список').click();

    // First the refresh itself, then the screen: two waits instead of one give the requests their
    // own window.
    await waitFor(() => expect(http.countOf('POST /auth/refresh')).toBe(2));
    await waitFor(() => expect(shown('propose')).toBe('закрыт'));
    // No reload and no second "who am I": the switch arrived in the same answer as the token.
    expect(http.countOf('GET /auth/me')).toBe(1);
  });
});
