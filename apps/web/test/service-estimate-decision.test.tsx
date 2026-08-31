import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { AuthUser, ServiceRequestDto } from '@technic/contracts';
import { json, mockHttp, type HttpMock, type RouteMap } from './http';
import { renderWithUser } from './render';
import { emptyList, list } from './factories/common';
import { estimatePendingServiceRequest, serviceOperator } from './factories/service';
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
