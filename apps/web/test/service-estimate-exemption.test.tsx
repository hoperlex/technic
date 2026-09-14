import { describe, expect, it } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import type { ServiceRequestDto, ServiceRequestEstimateExemptionDto } from '@technic/contracts';
import { json, mockHttp, type HttpMock, type RouteMap } from './http';
import { renderWithUser } from './render';
import { emptyList, list } from './factories/common';
import {
  autoAcceptedServiceRequest,
  estimatePendingServiceRequest,
  SERVICE_COUNTERPARTY,
  serviceOperator,
  serviceRequest,
} from './factories/service';
import { objectDto } from './factories/waste';
import { RequestsTab } from '../src/pages/service/RequestsTab';
import { ServiceRequestEstimate } from '../src/pages/service/ServiceRequestEstimate';

/**
 * ОСВОБОЖДЕНИЕ ОТ ПОДПИСИ СЛОВАМИ (Р3, Р13 плана
 * `docs/office-equipment-on-site-and-invoice-estimate-plan.md`, этап Э6).
 *
 * Проверяется то, что расходится молча и дорого. Состояний у ревизии стало три, а плашка вкладки
 * знала два, и у автопринятия нет ни подписавшего, ни его времени: покажи вкладка прежнее
 * «Согласована ревизия N · — · дата», человек читал бы это как потерянные данные о живом человеке,
 * а не как «подписи не было вовсе». Обратная ошибка не дешевле: наблюдённое заявление
 * (`observed`, рубильник выключен) выглядело бы принятым, и исполнитель считал бы заявку
 * согласованной, пока по ней ждут подпись.
 *
 * Тег списка и подтверждение согласования — там же и по той же причине: служба обязана видеть
 * деньги, прошедшие мимо подписи, НЕ ОТКРЫВАЯ карточку (Р13, один из четырёх механизмов контроля
 * постфактум), а «Согласовать объём работ на —» звало бы подписаться под утверждением «суммы нет»
 * у заявки, сумма которой лежит в неразобранном счёте (§8 плана).
 *
 * ПОСЛЕДНИЙ СЛУЧАЙ КАЖДОГО РАЗДЕЛА — ЗАЯВКА БЕЗ ОСВОБОЖДЕНИЯ: волна не должна была тронуть её ни
 * на экране, ни в подтверждении, и доказать это можно только спросив.
 */

/** «Ведение»: плашки состояния показываются координатору целиком (`ServiceHint`, Р11). */
const OPERATOR = serviceOperator();

const ITEM = {
  id: 'sri-1',
  kind: 'part' as const,
  name: 'Ролик подачи',
  quantity: 1,
  unitPrice: 1800,
  amount: 1800,
  performed: null,
  actualQuantity: null,
  actualAmount: null,
  warrantyMonths: null,
  warrantyUntil: null,
  warrantyUntilManual: false,
};

/** Заявление об освобождении: исход и ревизия — то, чем состояния и различаются. */
function exemption(
  overrides: Partial<ServiceRequestEstimateExemptionDto> = {},
): ServiceRequestEstimateExemptionDto {
  return {
    revision: 1,
    by: 'user-5',
    byName: 'Сервисов А. А.',
    at: '2026-09-10T09:30:00.000Z',
    note: 'мелкий ремонт на месте',
    outcome: 'applied',
    ...overrides,
  };
}

function renderTab(request: ServiceRequestDto) {
  renderWithUser(<ServiceRequestEstimate request={request} />, { user: OPERATOR });
}

describe('вкладка объёма работ различает три состояния освобождения (Р3)', () => {
  it('применённое — «Принято без согласования», и подписавшего у него нет', () => {
    renderTab(autoAcceptedServiceRequest({ items: [ITEM] }));

    expect(screen.getByText('Принято без согласования — ревизия 1')).toBeDefined();
    // Кем и когда заявлено — на месте подписи: это единственный человек, который в решении участвовал.
    expect(screen.getByText(/Сервисов А. А./)).toBeDefined();
    // Пояснение исполнителя — там же: оно и есть всё, что сказано о причине (Р1).
    expect(screen.getByText(/мелкий ремонт на месте/)).toBeDefined();
    /*
     * Прежнего заголовка нет вовсе, и это главное в случае: «Согласована ревизия 1» обещало бы
     * согласующего, которого не существует, а прочерк на его месте читался бы как потерянные данные.
     */
    expect(screen.queryByText(/Согласована ревизия/)).toBeNull();
  });

  it('заявленное, но не применённое — «Заявлено, ждём подписи», и подпись всё равно ждут', () => {
    renderTab(
      estimatePendingServiceRequest({
        items: [ITEM],
        exemption: exemption({ outcome: 'observed' }),
      }),
    );

    // Состояние ревизии прежнее — ход за согласующим, — а заявление объясняет, почему его ждут.
    expect(screen.getByText(/Ревизия 1 предъявлена — ждём решения/)).toBeDefined();
    expect(screen.getByText(/Заявлено, ждём подписи/)).toBeDefined();
    expect(screen.getByText(/освобождение записано, но не применено/)).toBeDefined();
    expect(screen.queryByText(/Принято без согласования/)).toBeNull();
  });

  it('освобождения нет — обычное согласование человеком, как было всегда', () => {
    renderTab(
      serviceRequest({
        status: 'in_work',
        service: { ...SERVICE_COUNTERPARTY },
        estimateRevision: 1,
        estimatedTotalAmount: 1800,
        approval: {
          by: 'user-2',
          byName: 'Операторов О. О.',
          at: '2026-08-05T10:00:00.000Z',
          revision: 1,
        },
        items: [ITEM],
      }),
    );

    expect(screen.getByText('Согласована ревизия 1')).toBeDefined();
    expect(screen.getByText(/Операторов О. О./)).toBeDefined();
    expect(screen.queryByText(/Принято без согласования/)).toBeNull();
    expect(screen.queryByText(/Заявлено, ждём подписи/)).toBeNull();
  });

  it('заявление по ПРОШЛОЙ ревизии живым не показывается: его сняло переиздание', () => {
    renderTab(
      autoAcceptedServiceRequest({
        estimateRevision: 2,
        items: [ITEM],
        // Ревизию переиздали раскладкой: подпись ушла вместе с ней, а строка заявления осталась.
        approval: null,
        estimatePendingRevision: 2,
        estimateSubmittedAt: '2026-09-11T09:00:00.000Z',
      }),
    );

    expect(screen.queryByText(/Принято без согласования/)).toBeNull();
    expect(screen.queryByText(/Заявлено, ждём подписи/)).toBeNull();
    expect(screen.getByText(/Ревизия 2 предъявлена — ждём решения/)).toBeDefined();
  });

  it('документная ревизия без строк не говорит «объёма работ пока нет»', () => {
    renderTab(
      autoAcceptedServiceRequest({ estimateFormat: 'document', estimatedTotalAmount: null }),
    );

    /*
     * Строк у документной ревизии нет вовсе (Р2), и обе прежние подписи ветки «строк нет» ей лгут:
     * объём работ не «ещё не собран» — он подан счётом, и суммы нет не потому, что работы
     * бесплатны, а потому, что документ не разобран.
     */
    expect(screen.queryByText(/Объёма работ пока нет/)).toBeNull();
    expect(screen.getByText(/сумма из документа не разобрана/)).toBeDefined();
    expect(screen.getByText('Принято без согласования — ревизия 1')).toBeDefined();
  });
});

/* ─── тег списка (Р13) ───────────────────────────────────────────────────────────────────────── */

function renderList(items: ServiceRequestDto[], over: RouteMap = {}): HttpMock {
  const http = mockHttp({
    'GET /service-requests': () => json(list(items)),
    'GET /service-requests/executor-candidates': () => json(emptyList()),
    'GET /service-requests/:id': ({ params }) =>
      json(items.find((r) => r.id === params.id) ?? items[0]!),
    'GET /service-requests/:id/history': () => json([]),
    'GET /objects': () => json(list([objectDto()])),
    'GET /departments': () => json(emptyList()),
    'GET /counterparties': () => json(emptyList()),
    'GET /office-equipment': () => json(emptyList()),
    'GET /office-equipment-types': () => json(emptyList()),
    ...over,
  });
  renderWithUser(<RequestsTab />, { user: OPERATOR });
  return http;
}

/** Есть ли текст на экране: шапку таблицы antd рисует дважды, поэтому «есть», а не «ровно один». */
const shown = (text: string) => screen.queryAllByText(text).length > 0;

describe('заявка, принятая без подписи, помечена в списке (Р13)', () => {
  it('применённое освобождение даёт тег: деньги видно, не открывая карточку', async () => {
    renderList([autoAcceptedServiceRequest()]);
    await screen.findByText('СО-14');

    expect(shown('Без согласования')).toBe(true);
  });

  it('наблюдённое заявление тега не даёт: мимо подписи оно ничего не пропустило', async () => {
    renderList([estimatePendingServiceRequest({ exemption: exemption({ outcome: 'observed' }) })]);
    await screen.findByText('СО-14');

    expect(shown('Без согласования')).toBe(false);
  });

  it('заявление по прошлой ревизии тега не даёт: основание снято переизданием', async () => {
    renderList([autoAcceptedServiceRequest({ estimateRevision: 2, approval: null })]);
    await screen.findByText('СО-14');

    expect(shown('Без согласования')).toBe(false);
  });

  it('у заявки без освобождения список прежний', async () => {
    renderList([estimatePendingServiceRequest({ estimatedTotalAmount: 24500 })]);
    await screen.findByText('СО-14');

    expect(shown('Без согласования')).toBe(false);
    expect(shown('24 500,00 ₽')).toBe(true);
  });

  it('сумма документной заявки — «не разобрана», а не прочерк', async () => {
    renderList([
      estimatePendingServiceRequest({ estimateFormat: 'document', estimatedTotalAmount: null }),
    ]);
    await screen.findByText('СО-14');

    // Прочерк утверждал бы «суммы нет», а она есть — в неразобранном счёте (§8 плана).
    expect(shown('не разобрана')).toBe(true);
  });
});

/* ─── подтверждение согласования (§8 плана) ──────────────────────────────────────────────────── */

async function approveFrom(request: ServiceRequestDto): Promise<void> {
  renderList([request], {
    'PATCH /service-requests/:id/estimate/approval': () => json(request),
  });
  fireEvent.click(await screen.findByRole('button', { name: 'Действия' }));
  fireEvent.click(await screen.findByText('Согласовать объём работ'));
}

describe('подтверждение согласования не выдаёт неизвестную сумму за известную (§8)', () => {
  it('у документной ревизии сумма названа неразобранной, а не прочерком', async () => {
    await approveFrom(
      estimatePendingServiceRequest({ estimateFormat: 'document', estimatedTotalAmount: null }),
    );

    expect(await screen.findByText(/сумма из документа не разобрана/)).toBeDefined();
    // Подписывают сам счёт: сказать это надо прямо, иначе согласие читалось бы как согласие с ценой.
    expect(screen.getByText(/согласовывается сам приложенный счёт/)).toBeDefined();
  });

  it('у построчной ревизии подтверждение прежнее — с цифрой', async () => {
    await approveFrom(estimatePendingServiceRequest({ estimatedTotalAmount: 24500 }));

    expect(await screen.findByText(/Ревизия 1 на 24 500,00 ₽/)).toBeDefined();
    expect(screen.queryByText(/не разобрана/)).toBeNull();
  });
});
