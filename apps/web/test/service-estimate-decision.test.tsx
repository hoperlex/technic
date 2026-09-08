import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { AuthUser, ServiceRequestDto } from '@technic/contracts';
import { json, mockHttp, type HttpMock, type RouteMap } from './http';
import { renderWithUser } from './render';
import { emptyList, list } from './factories/common';
import {
  estimatePendingServiceRequest,
  serviceOperator,
  serviceRequest,
} from './factories/service';
import { objectDto } from './factories/waste';
import { RequestsTab } from '../src/pages/service/RequestsTab';
import { EstimateApprovalModal } from '../src/features/estimate-approval/ui/EstimateApprovalModal';

/**
 * Решение по объёму работ (Р8, Р11, Р12): согласие подтверждением, отказ — окном.
 *
 * Прежде исходов было два в одном окне согласования, и оба — переходы: «Смета на согласовании» →
 * «В работе» либо → «Отменена». После Р1 статуса нет вовсе, и решение принимается по
 * `estimatePendingRevision`, оставляя заявку в «В работе». Поэтому и дороги разошлись:
 *
 * - **согласие содержания не имеет** — есть ревизия и сумма, которые человек только что видел, — и
 *   идёт оно подтверждением прямо из набора действий. Тело запроса при этом обязано остаться
 *   полным: `approved: true` и `replacementRecommended: false`, иначе схема ручки не примет его;
 * - **у отказа содержание есть, и его два** — причина («почему») и решение («что делаем вместо»),
 *   и путь у них разный: причина уходит комментарием перехода в историю, решение остаётся полем
 *   заявки. Пропущенное дописать будет негде: отказ закрывает заявку в «Отменена» (В1).
 *
 * Проверяется именно это разделение и обязательность ОБОИХ полей отказа: пропусти портал одно —
 * человек узнавал бы о нём из 422 после нажатия, а спор по отклонённой заявке через месяц начинался
 * бы с пустого поля «Решение».
 */

const OPERATOR: AuthUser = serviceOperator();

/** Заявка с висящим предъявлением: только на ней решение по объёму работ и предлагают. */
const PENDING = estimatePendingServiceRequest({
  estimatedTotalAmount: 24500,
  service: { id: 'cp-1', name: 'КопиЛайт' },
});

function renderModal(over: RouteMap = {}): HttpMock {
  const http = mockHttp(over);
  renderWithUser(<EstimateApprovalModal request={PENDING} onClose={() => {}} />, {
    user: OPERATOR,
  });
  return http;
}

function renderTab(items: ServiceRequestDto[], over: RouteMap = {}): HttpMock {
  const http = mockHttp({
    'GET /service-requests': () => json(list(items)),
    // Карточка спрашивает заявку сама, строкой списка лишь рисуется, пока едет свежая.
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

/** Причина отказа под полем: её рисует `Form.Item`, а не заголовок и не тост. */
function fieldError(labelText: string): string | null {
  const label = [...document.querySelectorAll('label')].find(
    (el) => el.textContent?.replace(/\s+/g, ' ').trim() === labelText,
  );
  return (
    label?.closest('.ant-form-item')?.querySelector('.ant-form-item-explain-error')?.textContent ??
    null
  );
}

const reject = () => fireEvent.click(screen.getByRole('button', { name: 'Не согласовано' }));

function bodyOf(http: HttpMock): Record<string, unknown> {
  return http.lastCall('PATCH /service-requests/:id/estimate/approval')?.body as Record<
    string,
    unknown
  >;
}

describe('окно отказа по объёму работ (Р12)', () => {
  const decided = {
    'PATCH /service-requests/:id/estimate/approval': () =>
      json(estimatePendingServiceRequest({ status: 'cancelled', estimatePendingRevision: null })),
  };

  it('исход у окна один: согласиться в нём нечем', async () => {
    renderModal(decided);
    await screen.findByText(/Ревизия 1/);

    // Кнопка одна и красная: согласие содержания не имеет и идёт подтверждением из набора действий.
    // Оставь окно обе, пункт «Не согласовано» открывал бы окно, где заново спрашивают, соглашаться
    // ли, а «Согласовать» жило бы двумя дорогами с разными телами запроса.
    expect(screen.queryByRole('button', { name: 'Согласовать' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Не согласовано' })).toBeDefined();
  });

  it('без причины и без решения отказ не уходит, и оба поля названы', async () => {
    const http = renderModal(decided);
    await screen.findByText(/Ревизия 1/);

    reject();

    // Оба сразу, а не по очереди: пропущенное дописать будет негде — отказ закрывает заявку.
    await waitFor(() =>
      expect(fieldError('Причина')).toBe('Укажите, почему объём работ не согласован'),
    );
    expect(fieldError('Решение')).toBe('Опишите решение: что делаем вместо ремонта');
    expect(http.countOf('PATCH /service-requests/:id/estimate/approval')).toBe(0);
  });

  it('одной причины мало: решение спрашивают отдельным вопросом', async () => {
    const http = renderModal(decided);
    await screen.findByText(/Ревизия 1/);

    fireEvent.change(screen.getByLabelText('Причина'), {
      target: { value: 'ремонт вдвое дороже нового аппарата' },
    });
    reject();

    // Причина отвечает «почему», решение — «что делаем вместо», и одним полем они не отвечаются:
    // причина уходит комментарием в историю, решение остаётся полем заявки (Р12).
    await waitFor(() =>
      expect(fieldError('Решение')).toBe('Опишите решение: что делаем вместо ремонта'),
    );
    expect(fieldError('Причина')).toBeNull();
    expect(http.countOf('PATCH /service-requests/:id/estimate/approval')).toBe(0);
  });

  it('заполненный отказ уходит исходом, причиной, решением и галочкой замены', async () => {
    const http = renderModal(decided);
    await screen.findByText(/Ревизия 1/);

    fireEvent.change(screen.getByLabelText('Причина'), {
      target: { value: 'ремонт вдвое дороже нового аппарата' },
    });
    fireEvent.change(screen.getByLabelText('Решение'), {
      target: { value: 'меняем аппарат, заявка на закупку заведена' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Рекомендована замена аппарата' }));
    reject();

    await waitFor(() =>
      expect(http.countOf('PATCH /service-requests/:id/estimate/approval')).toBe(1),
    );
    const body = bodyOf(http);
    // `approved: false` — не значение поля, а само назначение окна.
    expect(body.approved).toBe(false);
    expect(body.reason).toBe('ремонт вдвое дороже нового аппарата');
    expect(body.resolution).toBe('меняем аппарат, заявка на закупку заведена');
    // Галочка — рукой: «не согласовано» само по себе не значит «менять» (Р8, Р10).
    expect(body.replacementRecommended).toBe(true);
    expect(body.version).toBe(PENDING.version);

    // Что стало с заявкой — в самом тосте: искавший «объём в правке» должен узнать про «Отменена»
    // здесь, а не по пропавшей из списка заявке.
    expect(await screen.findByText('Объём работ не согласован — заявка отменена')).toBeDefined();
  });

  it('галочка замены не проставляется сама: по умолчанию её нет', async () => {
    const http = renderModal(decided);
    await screen.findByText(/Ревизия 1/);

    fireEvent.change(screen.getByLabelText('Причина'), { target: { value: 'дорого' } });
    fireEvent.change(screen.getByLabelText('Решение'), { target: { value: 'списываем аппарат' } });
    reject();

    await waitFor(() =>
      expect(http.countOf('PATCH /service-requests/:id/estimate/approval')).toBe(1),
    );
    // Поле обязательно и в схеме: «не слать, раз галочка не стоит» сломало бы тело запроса.
    expect(bodyOf(http).replacementRecommended).toBe(false);
  });
});

/**
 * Согласие — подтверждением из набора действий (Р11), а не вторым исходом окна.
 *
 * Проверяется и подтверждение, и тело: подпись под цифрой обязана показывать цифру — из меню строки
 * таблицы объёма работ не видно вовсе, и «Согласовать» без числа означало бы подпись вслепую.
 */
describe('согласие идёт подтверждением, а не окном', () => {
  it('пункт «Согласовать объём работ» показывает ревизию с суммой и шлёт `approved: true`', async () => {
    const http = renderTab([PENDING], {
      'PATCH /service-requests/:id/estimate/approval': () =>
        json(estimatePendingServiceRequest({ estimatePendingRevision: null })),
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Действия' }));
    fireEvent.click(await screen.findByText('Согласовать объём работ'));

    // Цифра в подтверждении, а не «вы уверены»: подписывают именно её.
    expect(await screen.findByText(/Ревизия 1 на 24 500,00 ₽/)).toBeDefined();
    // Статуса согласие не меняет — заявка остаётся в «В работе» (Р8), и подтверждение это говорит.
    expect(screen.getByText(/Заявка останется в «В работе»/)).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Согласовать' }));
    await waitFor(() =>
      expect(http.countOf('PATCH /service-requests/:id/estimate/approval')).toBe(1),
    );

    const body = bodyOf(http);
    expect(body.approved).toBe(true);
    // Галочку замены согласие не ставит никогда: «менять аппарат» — исход отказа, и проставленная
    // здесь она была бы решением, которого никто не принимал.
    expect(body.replacementRecommended).toBe(false);
    // Ни причины, ни решения у согласия нет: спрашивать нечего.
    expect(body.reason).toBeUndefined();
    expect(body.resolution).toBeUndefined();
  });
});

/**
 * Внутренний ремонт: решать нечего, потому что и объёма работ не бывает (Р4–Р7 плана
 * `office-equipment-card-and-list-cleanup-plan.md`).
 *
 * Свой сисадмин стоимости не фиксирует, поэтому у СВЕЖЕЙ внутренней заявки нет ни вкладки, ни
 * решений: пустая вкладка отвечала бы «объём собирает исполнитель» на вопрос, которого по такой
 * заявке не задают. У ИСТОРИЧЕСКОЙ — той, что вели подрядчиком, а потом передали своему, — вкладка
 * остаётся: строки настоящие, и по ним объясняли уже принятое решение; спрятать их значило бы
 * стереть основание. Но решать по ним нечего, и кнопок под таблицей нет.
 *
 * Проверяется пара «есть вкладка / нет вкладки» на заявках, различающихся ровно одним полем:
 * ревизией. Иначе первый же случай доказывал бы лишь, что вкладка исчезла отовсюду.
 */
describe('внутренний ремонт: объёма работ по нему не бывает (Р7)', () => {
  /** Свежая внутренняя: подрядчика нет, ревизия нулевая — считать по такой заявке нечего. */
  const FRESH_IN_HOUSE = serviceRequest({
    status: 'in_work',
    service: null,
    executors: [
      { userId: 'user-9', name: 'Сисадминов С. С.', assignedAt: '2026-08-05T10:00:00.000Z' },
    ],
  });

  /**
   * Историческая внутренняя: объём работ предъявляли и согласовывали, пока заявку вёл подрядчик, —
   * до этой волны иначе её было не закрыть вовсе (Н1). Сейчас подрядчика у неё нет.
   */
  const HISTORICAL_IN_HOUSE = serviceRequest({
    status: 'in_work',
    service: null,
    estimateRevision: 1,
    estimateSubmittedAt: '2026-08-06T09:00:00.000Z',
    estimatedTotalAmount: 1800,
    approval: {
      by: 'user-2',
      byName: 'Оператор О. О.',
      at: '2026-08-07T10:00:00.000Z',
      revision: 1,
    },
    items: [
      {
        id: 'sri-1',
        kind: 'part',
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
      },
    ],
  });

  /** Окно карточки: заголовок — единственное, чем окна на экране различаются. */
  function cardWrap(): HTMLElement {
    const wrap = [...document.querySelectorAll<HTMLElement>('.ant-modal-wrap')]
      .filter((el) => el.style.display !== 'none')
      .find((el) => el.querySelector('.ant-modal-title')?.textContent === 'Заявка СО-14');
    if (!wrap) throw new Error('карточки «Заявка СО-14» на экране нет');
    return wrap;
  }

  /** Открыть карточку так, как её открывает человек: нажатием на номер в списке. */
  async function openCard(request: ServiceRequestDto): Promise<HTMLElement> {
    renderTab([request]);
    fireEvent.click(await screen.findByText('СО-14'));
    return await waitFor(() => cardWrap());
  }

  const tabNames = (wrap: HTMLElement): string[] =>
    within(wrap)
      .getAllByRole('tab')
      .map((tab) => tab.textContent ?? '');

  /**
   * Подписи меню карточки. Кнопка ищется по разметке подвала, а не по доступному имени:
   * одноимённая кнопка есть и в строке списка под окном, и поиск по документу вернул бы обе.
   */
  async function cardMenuLabels(wrap: HTMLElement): Promise<string[]> {
    const button = [...wrap.querySelectorAll<HTMLElement>('.ant-modal-footer button')].find(
      (el) => el.textContent === 'Действия',
    );
    if (!button) throw new Error('в подвале карточки нет кнопки «Действия»');
    fireEvent.click(button);
    const menu = await waitFor(() => {
      const found = [...document.querySelectorAll<HTMLElement>('.ant-dropdown')]
        .filter((el) => !el.classList.contains('ant-dropdown-hidden'))
        .map((el) => el.querySelector<HTMLElement>('.ant-dropdown-menu'))
        .filter((el): el is HTMLElement => !!el)
        .at(-1);
      if (!found) throw new Error('меню действий не открылось');
      return found;
    });
    return [...menu.querySelectorAll('.ant-dropdown-menu-item')].map((el) => el.textContent ?? '');
  }

  it('у свежей внутренней заявки вкладки нет вовсе: их остаётся три', async () => {
    const wrap = await openCard(FRESH_IN_HOUSE);

    expect(tabNames(wrap)).toEqual(['Заявка', 'Документы', 'История']);
    // Не построена, а не «спрятана стилем»: спрятанная осталась бы в разметке вместе с подписью и
    // содержимым, и проверка на видимость зеленела бы на карточке с пустой таблицей внутри.
    expect(within(wrap).queryByText('Объём работ')).toBeNull();
  });

  it('решений по ней не предлагает и меню', async () => {
    const wrap = await openCard(FRESH_IN_HOUSE);
    const labels = await cardMenuLabels(wrap);

    /*
     * Пункты вычёркивает не карточка, а предикаты контрактов: у заявки без подрядчика
     * `canSubmitServiceEstimate` и соседи отвечают «нельзя», и второй проверки прав портал не
     * заводит — она разошлась бы с сервером молча.
     */
    expect(labels).not.toContain('Объём работ');
    expect(labels).not.toContain('Согласовать объём работ');
    expect(labels).not.toContain('Не согласовать объём работ');
    expect(labels).not.toContain('Вернуть объём в правку');
    // Якорь: меню не опустело заодно — отмена из него не вычёркивалась.
    expect(labels).toContain('Отменить заявку');
  });

  it('исторический объём остаётся видимым, но только на чтение', async () => {
    const wrap = await openCard(HISTORICAL_IN_HOUSE);

    // Вкладка на месте: по этим строкам объясняли уже принятое решение, и стирать основание нельзя.
    expect(tabNames(wrap)).toEqual(['Заявка', 'Объём работ', 'Документы', 'История']);

    fireEvent.click(within(wrap).getByRole('tab', { name: 'Объём работ' }));
    expect(await within(wrap).findByText('Ролик подачи')).toBeDefined();

    // Кнопок решений под таблицей нет: решать по историческому объёму нечего и некому.
    const buttons = [...wrap.querySelectorAll('button')].map((el) => el.textContent ?? '');
    expect(buttons).not.toContain('Согласовать');
    expect(buttons).not.toContain('Не согласовано');
    expect(buttons).not.toContain('Вернуть в правку');
  });
});
