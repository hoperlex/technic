import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import type { AuthUser, FeatureFlagKey, Permission } from '@technic/contracts';
import { useCandidateIntake } from '../src/auth/candidateIntake';
import { apiFetch } from '../src/shared/api';
import { apiError, json, mockHttp } from './http';
import { renderWithSession } from './render';
import { authUser, loginResponse } from './factories/auth';

/**
 * Рубильник приёма сообщений о технике доезжает до экрана ответом сессии — и, главное, **его
 * отсутствие означает «закрыто»** (план `docs/office-equipment-request-subject-plan.md`, Р10;
 * контракт — `docs/office-equipment-candidate-plan.md`, §14).
 *
 * ЗАЧЕМ ЭТОТ ФАЙЛ, если условие — одна строка в `useCandidateIntake`. Проверяется не строка, а
 * УМОЛЧАНИЕ на границе версий. Портал выкатывается отдельно от приложения, и в окне выката новая
 * сборка получает ответ старого сервера — без поля `features` вовсе. Ошибка здесь не видна ни
 * типом (поле необязательно ровно поэтому), ни глазами: `?? true` выглядит так же безобидно, как
 * `?? false`, — а означает открытый приём кандидатов ровно в том окне, ради которого рубильник и
 * заводился (Р11: миграция прав применяется ДО перезапуска приложения).
 *
 * ЧЕГО ЗДЕСЬ НЕТ. Серверного отказа прямому `POST /service-requests` — он проверяется db-тестом и
 * не зависит от портала вовсе: клиент рубильником только прячет дверь, а запирает её сервер, читая
 * ту же строку базы. Три ветви «Не нашли технику?» живут в `missing-equipment.test.tsx`.
 *
 * НАСТОЯЩИЙ `AuthProvider`, а не подставленный контекст: предмет проверки — что портал прочитал из
 * ОТВЕТА СЕРВЕРА, и подстановка готового пользователя проверяла бы фикстуру, а не чтение.
 */

/** Права заявителя, которому выпуск B выдаст `propose`: без них рубильник нечему открывать. */
const PROPOSER_PERMISSIONS: Permission[] = [
  'serviceRequests.create',
  'serviceRequests.read',
  'officeEquipment.read',
  'officeEquipment.propose',
];

/** Он же с правом разбора очереди: рубильник вход гасит, а проверку — нет. */
const REVIEWER_PERMISSIONS: Permission[] = [...PROPOSER_PERMISSIONS, 'officeEquipment.review'];

/** Учётка старого ответа: поля `features` в ней нет вовсе — не пустое, а отсутствующее. */
function oldApiUser(permissions: Permission[] = PROPOSER_PERMISSIONS): AuthUser {
  return authUser({ role: 'shtab', constructionObjectIds: ['obj-1'], permissions });
}

/** Ответ нового сервера: список включённых ключей приходит всегда, пусть и пустой. */
function withFeatures(user: AuthUser, ...features: FeatureFlagKey[]): AuthUser {
  return { ...user, features };
}

/** Экран, показывающий оба ответа хука: различить «вход закрыт» и «закрыто всё» иначе нечем. */
function IntakeProbe() {
  const { canPropose, canReview } = useCandidateIntake();
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
 * Вкладка открыта ответом `before`, а следующее обновление токена вернёт `after`. Первый `refresh`
 * — bootstrap вкладки, поэтому учётку меняет второй (тот же приём, что в
 * `flow-session-refresh-permissions`).
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
    // Обычный запрос упирается в 401 — сервером учётка уже пересчитана; после обновления проходит.
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
    // Фикстура — это и есть предмет проверки: поле обязано ОТСУТСТВОВАТЬ, а не быть пустым.
    // Пустой массив проверял бы соседнее умолчание («ключа нет в списке»), и подмена одного другим
    // прошла бы незамеченной.
    expect('features' in user).toBe(false);
    mount(user);

    await waitFor(() => expect(shown('propose')).toBe('закрыт'));
    // Право при этом есть: закрыл вход именно рубильник, а не отсутствие полномочия.
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
    const plain = authUser({
      role: 'shtab',
      constructionObjectIds: ['obj-1'],
      permissions: ['serviceRequests.create', 'serviceRequests.read', 'officeEquipment.read'],
    });
    mount(withFeatures(plain, 'office_equipment_candidate_intake'));

    await waitFor(() => expect(shown('propose')).toBe('закрыт'));
  });

  it('выключенный приём оставляет очередь проверки открытой', async () => {
    // Аварийное выключение прекращает приток, но разобрать уже принятое кто-то обязан: заперев
    // вместе со входом и проверку, рубильник оставил бы кандидатов без единственной двери решения.
    mount(oldApiUser(REVIEWER_PERMISSIONS));

    await waitFor(() => expect(shown('review')).toBe('открыт'));
    expect(shown('propose')).toBe('закрыт');
  });

  it('обновление токена доносит аварийное выключение без перезагрузки страницы', async () => {
    const open = withFeatures(oldApiUser(), 'office_equipment_candidate_intake');
    const http = mount(open, withFeatures(open));

    await waitFor(() => expect(shown('propose')).toBe('открыт'));
    screen.getByText('обновить список').click();

    // Сначала само обновление, потом экран: два ожидания вместо одного дают запросам своё окно.
    await waitFor(() => expect(http.countOf('POST /auth/refresh')).toBe(2));
    await waitFor(() => expect(shown('propose')).toBe('закрыт'));
    // Ни перезагрузки, ни повторного «кто я»: рубильник приехал тем же ответом, что и токен.
    expect(http.countOf('GET /auth/me')).toBe(1);
  });
});
