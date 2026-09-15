import { describe, expect, it } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import type { Role, WaybillDto } from '@technic/contracts';
import { json, mockHttp } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { list } from './factories/common';
import { WaybillsPage } from '../src/pages/WaybillsPage';

/**
 * Журнал путевых листов глазами площадки (ADR 0192): раздел открыт набором полномочия, а справочник
 * водителей — нет.
 *
 * До этого выката журнал видели только роли без оси области, у которых есть всё, чем он пользуется:
 * `drivers.read` для фильтра по водителю, `vehicleRequests.status` для окна рейса. Держатель набора
 * приходит сюда с ОДНИМ правом — `waybills.read`, — и каждая из этих мелочей становится вопросом
 * доступа: запрос за карточками водителей ответил бы ему 403, а фильтр, показанный пустым, читался
 * бы как «водителей в портале нет».
 *
 * Фамилия водителя в строке журнала при этом остаётся: она напечатана в бланке, который у площадки
 * на руках, и прятать её значило бы выдавать бумагу, не говоря, кто по ней поехал. Закрыт именно
 * СПРАВОЧНИК — список людей компании, к бумаге отношения не имеющий.
 */

const SHEET: WaybillDto = {
  id: 'w-1',
  number: '260604-646-00000001',
  formCode: '4p',
  status: 'issued',
  issuedForDate: '2026-09-15',
  periodFrom: null,
  periodTo: null,
  organizationName: 'ООО «СУ-10»',
  vehicleId: 'v-1',
  vehicleLabel: 'КамАЗ 65201 · Е646СК799',
  driverPersonId: 'p-1',
  driverName: 'Иванов Иван Иванович',
  withTrailer: false,
  trailerLabel: '',
  issuedByName: 'Диспетчер',
  issuedAt: '2026-09-15T06:00:00.000Z',
  cancelledByName: null,
  cancelledAt: null,
  cancelReason: '',
  printedAt: null,
  exportedAt: null,
  isCorrection: false,
  correctionReason: '',
  correctsNumber: null,
  correctedByNumber: null,
  periodToOriginal: null,
  trimmedAt: null,
  trimReason: '',
  routeId: 'route-1',
  routeNumber: 'Р-12',
  requests: [
    {
      requestId: 'r-1',
      displayNumber: '№ 12',
      slot: 1,
      objectName: 'Площадка 1',
      status: 'confirmed',
    },
  ],
  files: [],
};

/**
 * Площадка с набором «Путевые листы: просмотр и печать»: право приходит выдачей, а не ролью, —
 * поэтому `grantPermissions`, а не `permissions`. Роль `site` своего `waybills.read` не имеет, и
 * учётка, собранная иначе, описывала бы человека, которого в портале не бывает.
 */
function siteHolder() {
  return authUser({
    id: 'user-site',
    email: 'site@example.test',
    lastName: 'Площадкин',
    firstName: 'Пётр',
    middleName: 'Сергеевич',
    fullName: 'Площадкин Пётр Сергеевич',
    role: 'site' as Role,
    constructionObjectIds: ['object-1'],
    grantCodes: ['waybills_view'],
    grantPermissions: ['waybills.read'],
  });
}

function renderFor(user: ReturnType<typeof authUser>) {
  const http = mockHttp({
    'GET /waybills': () => json(list([SHEET])),
    'GET /vehicles': () => json(list([])),
    'GET /drivers': () => json(list([])),
  });
  const rendered = renderWithUser(<WaybillsPage />, { user });
  return { http, rendered };
}

describe('журнал листов у держателя набора (ADR 0192)', () => {
  it('площадке фильтр по водителю не показывается, и справочник не запрашивается', async () => {
    const { http } = renderFor(siteHolder());
    await waitFor(() => expect(http.countOf('GET /waybills')).toBe(1));

    // Бумага на месте: номер, машина и фамилия водителя — то, ради чего набор и выдан.
    await waitFor(() => expect(screen.getByText('260604-646-00000001')).toBeDefined());
    expect(screen.getByText('Иванов Иван Иванович')).toBeDefined();

    // Фильтра нет ни одной из двух половин — ни полем панели, ни строкой шита телефона.
    const placeholders = [...document.querySelectorAll<HTMLElement>('.ant-select')].map((el) =>
      el.textContent?.trim(),
    );
    expect(placeholders).not.toContain('Все водители');
    // И главное: запрос за карточками людей не уходит вовсе — 403 в журнале сервера на каждое
    // открытие страницы был бы следом права, которого у держателя нет и не должно быть.
    expect(http.countOf('GET /drivers')).toBe(0);
  });

  it('диспетчеру тот же фильтр остаётся на месте', async () => {
    const { http } = renderFor(authUser());
    await waitFor(() => expect(http.countOf('GET /waybills')).toBe(1));

    const placeholders = [...document.querySelectorAll<HTMLElement>('.ant-select')].map((el) =>
      el.textContent?.trim(),
    );
    expect(placeholders).toContain('Все водители');
    await waitFor(() => expect(http.countOf('GET /drivers')).toBe(1));
  });

  /**
   * Рейс и заявка остаются подписями, а не ссылками: окно рейса закрыто правом
   * `vehicleRequests.status`, которого у площадки нет, а читалка заявки — `vehicleRequests.read`,
   * который приходит отдельным набором «Заказ техники». Проверяется отсутствие именно ссылки:
   * номер в строке обязан остаться, иначе журнал перестал бы отвечать, по какому рейсу выдан лист.
   */
  it('номер рейса и номер заявки показаны, но никуда не ведут', async () => {
    renderFor(siteHolder());
    await waitFor(() => expect(screen.getByText('260604-646-00000001')).toBeDefined());

    const row = screen.getByText('260604-646-00000001').closest('tr')!;
    // Оба номера в строке есть — журнал по-прежнему отвечает, по какому рейсу и какой заявке выдан
    // лист. Проверяется по тексту строки целиком: талон собран из нескольких узлов («1. № 12 —
    // Площадка 1»), и поиск по точному совпадению нашёл бы разве что подпись площадки.
    expect(row.textContent).toContain('Р-12');
    expect(row.textContent).toContain('№ 12');
    // А ссылок в ней нет ни одной: и рейс, и заявка закрыты правами, которых у держателя набора
    // нет, — `EntityLink` в этом случае оставляет номер обычным текстом.
    expect(row.querySelectorAll('a')).toHaveLength(0);
  });
});
