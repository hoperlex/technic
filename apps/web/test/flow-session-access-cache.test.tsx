import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import type { AuthUser } from '@technic/contracts';
import { accessFingerprint } from '../src/auth/accessFingerprint';
import { useAuth } from '../src/auth/AuthContext';
import { apiFetch } from '../src/shared/api';

import { apiError, json, mockHttp } from './http';
import { renderWithSession } from './render';
import { authUser, loginResponse } from './factories/auth';

/**
 * Кэш запросов переживает продление сессии, но НЕ переживает смену доступа (ADR 0160, Р15).
 *
 * До разграничения карточки по аудиториям вопрос был косметическим: набор прав менял меню и кнопки,
 * а данные оставались теми же. После — одна и та же заявка приходит РАЗНОЙ: заявителю без сумм и
 * без части документов, «Ведению» целиком. Значит ответ, набранный в кэш при прежнем доступе, после
 * выдачи набора описывает уже не то, что сервер отдаёт сейчас, и вкладка «Объём работ», открывшаяся
 * по новому праву, показывала бы пустую таблицу до протухания кэша.
 *
 * Проверяется судьба записи, положенной в кэш вручную и никем не наблюдаемой: её не трогает ничто,
 * кроме сброса. Считать походы в сеть здесь нельзя — контрольный замер показал, что после 401
 * запрос переигрывается и без всякой смены доступа.
 */

const OBJECT_A = '11111111-1111-1111-1111-111111111111';
const OBJECT_B = '22222222-2222-2222-2222-222222222222';

/**
 * Экран без собственных запросов: он нужен только чтобы дотянуться до сессии кнопкой.
 *
 * Данные в кэш кладутся ВРУЧНУЮ и без наблюдателя — и это не упрощение, а единственный честный
 * способ измерить сброс. Живой `useQuery` после 401 перезапрашивается сам: контрольный замер
 * показал два похода в сеть даже там, где доступ не менялся вовсе, — то есть счётчик запросов
 * отвечает на вопрос «переиграла ли сессия отказ», а не «выброшен ли кэш». Неактивную запись не
 * трогает никто, кроме `queryClient.clear()`, и её судьба — прямой ответ.
 */
function SessionProbe() {
  const { user } = useAuth();
  return (
    <div>
      {/* Кто вошёл — не украшение сценария: до конца входа обработчик обновления выходит на
          проверке «сессии ещё нет», и клик по кнопке раньше времени не проверял бы ничего. */}
      <div data-testid="who">{user?.email ?? 'никто'}</div>
      <button type="button" onClick={() => void apiFetch('/ping').catch(() => {})}>
        сходить в сеть
      </button>
    </div>
  );
}

/**
 * Вкладка открыта учёткой `before`, следующее обновление токена вернёт `after`.
 *
 * Первый `refresh` — bootstrap вкладки, поэтому доступ меняет второй; поводом к нему служит 401 на
 * запросе, как это и бывает в работе: администратор пересобрал выдачу, `authVersion` вырос, и
 * ближайший запрос упёрся в отказ.
 */
function mountWith(before: AuthUser, after: AuthUser) {
  let refreshes = 0;
  let pings = 0;
  const http = mockHttp({
    'POST /auth/refresh': () => {
      refreshes += 1;
      return json(loginResponse(refreshes === 1 ? before : after));
    },
    'GET /auth/me': () => json(before),
    'GET /ping': () => {
      pings += 1;
      return pings === 1
        ? apiError(401, { code: 'unauthorized', message: 'Требуется авторизация' })
        : json({ ok: true });
    },
  });
  const { queryClient } = renderWithSession(<SessionProbe />);
  return { http, queryClient };
}

/** Довести сценарий до второго обновления токена — момента, когда доступ доезжает до вкладки. */
async function refreshAccess(
  http: ReturnType<typeof mockHttp>,
  queryClient: { setQueryData: (key: string[], value: unknown) => unknown },
) {
  // Вход завершён — только теперь у вкладки есть сессия, доступ которой можно сменить.
  await waitFor(() => expect(screen.getByTestId('who').textContent).not.toBe('никто'));
  queryClient.setQueryData(['лежит-в-кэше'], 'ответ прежней аудитории');
  screen.getByText('сходить в сеть').click();
  await waitFor(() => expect(http.countOf('POST /auth/refresh')).toBe(2));
}

describe('смена доступа выбрасывает кэш запросов', () => {
  it('выданное право выбрасывает данные, набранные прежней аудиторией', async () => {
    const before = authUser({ role: 'shtab', constructionObjectIds: [OBJECT_A] });
    const after: AuthUser = {
      ...before,
      permissions: [...before.permissions, 'serviceRequests.finance'],
    };
    const { http, queryClient } = mountWith(before, after);

    await refreshAccess(http, queryClient);

    // Прежний ответ собран для другой аудитории: держать его значило бы показывать карточку
    // заявителя тому, кому уже положено видеть деньги.
    await waitFor(() => expect(queryClient.getQueryData(['лежит-в-кэше'])).toBeUndefined());
  });

  it('смена области выбрасывает кэш так же, хотя набор прав не менялся', async () => {
    const before = authUser({ role: 'shtab', constructionObjectIds: [OBJECT_A] });
    const after: AuthUser = { ...before, constructionObjectIds: [OBJECT_B] };
    // Права те же — разъехалась только область: в кэше остались строки чужой теперь площадки.
    expect(after.permissions).toEqual(before.permissions);
    const { http, queryClient } = mountWith(before, after);

    await refreshAccess(http, queryClient);

    await waitFor(() => expect(queryClient.getQueryData(['лежит-в-кэше'])).toBeUndefined());
  });

  it('тот же доступ в другом порядке кэш не трогает', async () => {
    const before = authUser({ role: 'shtab', constructionObjectIds: [OBJECT_A, OBJECT_B] });
    const after: AuthUser = {
      ...before,
      // Тот же набор, переставленный местами: сервер собирает эти списки запросами, и порядок в них
      // не гарантирован ничем. Считай отпечаток по порядку — кэш выбрасывался бы на ровном месте,
      // при каждом продлении сессии.
      constructionObjectIds: [OBJECT_B, OBJECT_A],
      permissions: [...before.permissions].reverse(),
    };
    const { http, queryClient } = mountWith(before, after);

    await refreshAccess(http, queryClient);

    // Продление сессии — не смена доступа: перечитывать нечего.
    expect(queryClient.getQueryData(['лежит-в-кэше'])).toBe('ответ прежней аудитории');
  });
});

describe('отпечаток доступа', () => {
  it('различает права, области, контрагента и наборы, но не порядок в списках', () => {
    const base = authUser({ role: 'shtab', constructionObjectIds: [OBJECT_A, OBJECT_B] });
    const same: AuthUser = {
      ...base,
      constructionObjectIds: [OBJECT_B, OBJECT_A],
      permissions: [...base.permissions].reverse(),
      grantCodes: [...base.grantCodes].reverse(),
    };
    expect(accessFingerprint(same)).toBe(accessFingerprint(base));

    // Каждая ось доступа меняет отпечаток: пропусти любую — и смена доступа по ней осталась бы
    // незамеченной, а кэш прежней аудитории — на экране.
    expect(accessFingerprint({ ...base, role: 'manager' })).not.toBe(accessFingerprint(base));
    expect(accessFingerprint({ ...base, counterpartyId: 'cp-1' })).not.toBe(
      accessFingerprint(base),
    );
    expect(accessFingerprint({ ...base, counterpartyType: 'service' })).not.toBe(
      accessFingerprint(base),
    );
    expect(
      accessFingerprint({ ...base, permissions: [...base.permissions, 'serviceRequests.finance'] }),
    ).not.toBe(accessFingerprint(base));
    expect(accessFingerprint({ ...base, grantCodes: ['office_equipment_operator'] })).not.toBe(
      accessFingerprint(base),
    );
    expect(accessFingerprint({ ...base, departmentIds: ['dep-1'] })).not.toBe(
      accessFingerprint(base),
    );
    expect(accessFingerprint({ ...base, departmentObjectIds: [OBJECT_A] })).not.toBe(
      accessFingerprint(base),
    );
  });

  it('у пустой сессии отпечаток пустой: выход и вход сравнивать не с чем', () => {
    expect(accessFingerprint(null)).toBe('');
  });
});
