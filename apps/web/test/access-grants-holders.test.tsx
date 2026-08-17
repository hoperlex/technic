import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { PERMISSION_CATALOG, roleLabels } from '@technic/contracts';
import { json, mockHttp, type HttpMock, type RouteMap } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { list } from './factories/common';
import {
  CUSTOM,
  CUSTOM_ID,
  GRANT_ACCOUNTS,
  grantCard,
  grantImpact,
  HASH,
  holder,
  MANAGER_ID,
  MISMATCHED,
  SHTAB_ID,
  SYSTEM,
} from './factories/grants';
import { openSelectOptions, selectOption } from './antd';
import { AccessGrantsTab } from '../src/pages/admin/AccessGrantsTab';

/**
 * Реестр выдач набора (ADR 0106, план §12): кому полномочие выдано, кем и когда, — и обе операции
 * над этим списком.
 *
 * Проверяется ровно то, ради чего реестр заведён и чем он опасен. Забытая выдача обязана быть видна
 * строкой, держатель с погашенным доступом — объяснён словами, а выдача и отзыв обязаны идти через
 * предпросмотр с отпечатком: без него операция применилась бы к состоянию, которого никто не видел.
 */

const CARD = `GET /grants/${CUSTOM_ID}`;
const PREVIEW = 'POST /users/:id/grants/preview';
const ASSIGN = 'POST /users/:id/grants';
const REVOKE = 'DELETE /users/:id/grants/:grantId';

function renderCatalog(routes: RouteMap = {}): HttpMock {
  const http = mockHttp({
    'GET /grants': () => json(list([CUSTOM, SYSTEM])),
    'GET /users': () => json(list(GRANT_ACCOUNTS)),
    ...routes,
  });
  renderWithUser(<AccessGrantsTab />, { user: authUser({ role: 'admin' }) });
  return http;
}

/** Реестр выдач — своим действием строки: он отвечает на другой вопрос, чем состав набора. */
async function openHolders(): Promise<void> {
  const row = await waitFor(() => {
    const found = [...document.querySelectorAll('tbody tr')].find((tr) =>
      tr.textContent?.includes(CUSTOM.name),
    );
    if (!found) throw new Error('строки набора в каталоге нет');
    return found as HTMLElement;
  });
  fireEvent.click(within(row).getByLabelText('Реестр выдач'));
  await screen.findByText(/Держатели:/);
  // Сам список приезжает своим запросом, поэтому строки реестра проверки ждут (`findBy…`): чтение
  // сразу после открытия застало бы пустое окно и прошло бы мимо смысла.
}

const clickButton = (name: string | RegExp) =>
  fireEvent.click(screen.getByRole('button', { name }));

describe('реестр выдач', () => {
  it('показывает держателей и объясняет пометку «роль не в списке» словами', async () => {
    renderCatalog({ [CARD]: () => json(grantCard()) });
    await openHolders();

    // Кто выдал и когда — то, ради чего реестр и заведён: забытая выдача видна строкой.
    expect(await screen.findByText(/выдал Админов Антон, 11\.08\.2026 12:00/)).toBeTruthy();
    expect(screen.getByText(/выдал Кадровиков Кирилл, 12\.08\.2026 09:30/)).toBeTruthy();
    expect(screen.getByText(MISMATCHED.fullName)).toBeTruthy();
    expect(screen.getByText('роль не в списке')).toBeTruthy();
    // Тег отвечает «что не так», а фраза — «чем это кончилось для человека».
    expect(
      screen.getByText(
        new RegExp(`Роль «${roleLabels.manager}» не входит в список совместимых.*погашен`),
      ),
    ).toBeTruthy();
  });

  it('отзыв уходит с отпечатком и убирает держателя из реестра', async () => {
    const http = renderCatalog({
      [CARD]: () => json(grantCard()),
      [PREVIEW]: () =>
        json(
          grantImpact({
            operation: 'revoke',
            userId: MANAGER_ID,
            users: [
              {
                userId: MANAGER_ID,
                fullName: MISMATCHED.fullName,
                role: 'manager',
                added: [],
                removed: [],
                roleMismatch: true,
              },
            ],
          }),
        ),
      [REVOKE]: () => json({ ok: true }),
    });
    await openHolders();

    // Отзыв — у своей строки: подпись действия несёт имя держателя, иначе в длинном реестре
    // «Отозвать» одинаково у всех.
    fireEvent.click(
      await screen.findByRole('button', { name: `Отозвать: ${MISMATCHED.fullName}` }),
    );

    await waitFor(() => expect(http.countOf(PREVIEW)).toBe(1));
    // Дельта у такого держателя пустая, и это сказано: прав по набору у него и не было.
    expect(screen.getByText(/прав по набору не получает/)).toBeTruthy();

    // Реестр после отзыва перечитывается: он обязан показывать актуальное сразу после операции.
    http.use({ [CARD]: () => json(grantCard({ holders: [holder()], holderCount: 1 })) });
    clickButton('Подтвердить отзыв');

    await waitFor(() => expect(http.countOf(REVOKE)).toBe(1));
    // Отпечаток у отзыва уходит строкой запроса: тело `DELETE` доходит не через каждый прокси.
    expect(http.lastCall(REVOKE)?.query.get('expectedImpactHash')).toBe(HASH);
    await waitFor(() => expect(screen.queryByText(MISMATCHED.fullName)).toBeNull());
  });

  it('выдача предлагает только совместимые учётки и подтверждается предпросмотром', async () => {
    const http = renderCatalog({
      [CARD]: () => json(grantCard({ holders: [] })),
      [PREVIEW]: () =>
        json(
          grantImpact({
            operation: 'assign',
            userId: SHTAB_ID,
            users: [
              {
                userId: SHTAB_ID,
                fullName: 'Штабов Степан Сергеевич',
                role: 'shtab',
                added: ['audit.read'],
                removed: [],
                roleMismatch: false,
              },
            ],
          }),
        ),
      [ASSIGN]: () => json({ ok: true }, 201),
    });
    await openHolders();

    /*
     * Список отфильтрован совместимостью с ролью (§12): несовместимую пару сервер отклоняет 409,
     * и предлагать её значило бы обещать действие, которого не будет. Водитель не появится в нём
     * никогда — его роль наборов не принимает вовсе.
     */
    const options = await openSelectOptions('Кому выдать');
    const texts = options.map((option) => option.textContent ?? '');
    expect(texts.some((text) => text.includes('Штабов Степан Сергеевич'))).toBe(true);
    expect(texts.some((text) => text.includes('Менеджеров Максим'))).toBe(false);
    expect(texts.some((text) => text.includes('Водителев Виктор'))).toBe(false);

    await selectOption('Кому выдать', /Штабов Степан Сергеевич/);
    clickButton('Выдать полномочие');

    await waitFor(() => expect(http.countOf(PREVIEW)).toBe(1));
    expect(
      await screen.findByText(new RegExp(`добавится: ${PERMISSION_CATALOG['audit.read'].label}`)),
    ).toBeTruthy();
    clickButton('Подтвердить выдачу');

    await waitFor(() => expect(http.countOf(ASSIGN)).toBe(1));
    const body = http.lastCall(ASSIGN)?.body as { expectedImpactHash: string };
    expect(body.expectedImpactHash).toBe(HASH);
  });
});
