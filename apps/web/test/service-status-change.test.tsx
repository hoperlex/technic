import { afterEach, describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { AuthUser, ServiceRequestDto } from '@technic/contracts';
import type { QueryClient } from '@tanstack/react-query';
import { officeEquipmentKeys } from '@entities/office-equipment';
import { apiError, json, mockHttp, type HttpMock, type RouteMap } from './http';
import { createTestQueryClient, renderWithUser } from './render';
import { emptyList, list } from './factories/common';
import {
  assignedServiceRequest,
  estimatePendingServiceRequest,
  heldServiceRequest,
  serviceCustomer,
  serviceExecutor,
  serviceOperator,
  serviceRequestFile,
} from './factories/service';
import { objectDto } from './factories/waste';
import { authUser } from './factories/auth';
import { MOBILE_VIEWPORT, resetViewport, setViewport } from './viewport';
import { RequestsTab } from '../src/pages/service/RequestsTab';

/**
 * Быстрая смена статуса заявки оргтехники (ADR 0161): тег статуса открывает список разрешённых
 * переходов, а выбор зовёт **существующую доменную команду**.
 *
 * Проверяется журнал запросов, а не разметка: по экрану «принять в работу» через `/start` и через
 * общий `/status` неотличимы, а разница в них вся — переход с содержанием живёт своей ручкой (Р18
 * маршрутов модуля), и универсальной записи статуса у модуля нет. Второе, что видно только
 * журналом: переход с окном до подтверждения не шлёт ничего.
 */

const EXECUTOR: AuthUser = serviceExecutor();

/** Назначенная «Новая»: исполнителю из неё открыт ровно один ход — принять в работу. */
const ASSIGNED = assignedServiceRequest({ version: 4 });

function renderTab(
  user: AuthUser,
  items: ServiceRequestDto[],
  over: RouteMap = {},
  queryClient?: QueryClient,
): HttpMock {
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
    'GET /service-requests/executor-candidates': () => json(emptyList()),
    ...over,
  });
  renderWithUser(<RequestsTab />, { user, queryClient });
  return http;
}

/**
 * Открыть список переходов на теге. Ищется по `aria-label`, а не ролью: `*ByRole` считает
 * доступные имена всему дереву и на таблице antd уходит в секунды (урок теста вывоза мусора).
 */
async function openTransitions(status: string): Promise<void> {
  const triggers = await screen.findAllByLabelText(`Изменить статус: ${status}`);
  fireEvent.click(triggers[0]!);
}

/** Заголовки открытых окон: закрытые antd какое-то время держит в разметке, лишь пряча их. */
function openModalTitles(): string[] {
  return [...document.querySelectorAll<HTMLElement>('.ant-modal-wrap')]
    .filter((wrap) => wrap.style.display !== 'none')
    .map((wrap) => wrap.querySelector('.ant-modal-title')?.textContent ?? '');
}

/** Слой окна числом: корневой модалке antd ничего не проставляет — она лежит на 1000 из токенов. */
function layerOf(title: string): number {
  const wrap = [...document.querySelectorAll<HTMLElement>('.ant-modal-wrap')]
    .filter((el) => el.style.display !== 'none')
    .find((el) => el.querySelector('.ant-modal-title')?.textContent === title);
  if (!wrap) throw new Error(`окна «${title}» на экране нет`);
  return Number(wrap.style.zIndex || '1000');
}

/** Выбрать пункт открытого списка — по его подписи «<статус> · <действие>». */
async function chooseTransition(label: string): Promise<void> {
  const item = await waitFor(() => {
    const found = [...document.querySelectorAll('.ant-dropdown-menu-title-content')].find(
      (el) => el.textContent === label,
    );
    if (!found) throw new Error(`перехода «${label}» нет в списке`);
    return found;
  });
  fireEvent.click(item);
}

afterEach(resetViewport);

describe('переход зовёт доменную команду, а не общую запись статуса', () => {
  it('«принять в работу» уходит в /start с версией строки и не трогает /status', async () => {
    const http = renderTab(EXECUTOR, [ASSIGNED], {
      'PATCH /service-requests/:id/start': () =>
        json(assignedServiceRequest({ status: 'in_work', version: 5 })),
    });

    await openTransitions('Новая');
    await chooseTransition('«В работе» · принять в работу');

    await waitFor(() => expect(http.countOf('PATCH /service-requests/:id/start')).toBe(1));
    expect(http.lastCall('PATCH /service-requests/:id/start')?.body).toEqual({ version: 4 });
    expect(http.countOf('PATCH /service-requests/:id/status')).toBe(0);
  });

  it('переход с содержанием открывает окно и до подтверждения не шлёт ничего', async () => {
    const inWork = assignedServiceRequest({
      status: 'in_work',
      files: [serviceRequestFile('act')],
    });
    const http = renderTab(EXECUTOR, [inWork]);

    await openTransitions('В работе');
    await chooseTransition('«Решена» · закрыть работы');

    // Окно закрытия работ открылось — но заявка не двинулась: факт ещё не предъявлен.
    expect(await screen.findByText('Закрытие работ СО-14')).toBeDefined();
    expect(http.countOf('PATCH /service-requests/:id/complete')).toBe(0);
    expect(http.countOf('PATCH /service-requests/:id/status')).toBe(0);
  });
});

describe('устаревшая строка и отказ (ADR 0161, решение 6)', () => {
  it('409 объясняет, что заявку изменили, и обновляет список', async () => {
    const http = renderTab(EXECUTOR, [ASSIGNED], {
      'PATCH /service-requests/:id/start': () =>
        apiError(409, { code: 'version_conflict', message: 'Конфликт версий' }),
    });
    const before = http.countOf('GET /service-requests');

    await openTransitions('Новая');
    await chooseTransition('«В работе» · принять в работу');

    expect(await screen.findByText(/Заявку изменили в другом окне/)).toBeDefined();
    await waitFor(() => expect(http.countOf('GET /service-requests')).toBeGreaterThan(before));
  });
});

describe('кому входа нет', () => {
  it('заявителю тег остаётся тегом', async () => {
    renderTab(serviceCustomer(), [ASSIGNED]);

    expect(await screen.findByText('СО-14')).toBeDefined();
    expect(screen.queryByLabelText(/Изменить статус/)).toBeNull();
  });
});

describe('телефон: список переходов шитом снизу (ADR 0030)', () => {
  it('тап по тегу открывает шит и не открывает карточку заявки', async () => {
    setViewport(MOBILE_VIEWPORT);
    renderTab(EXECUTOR, [ASSIGNED]);

    fireEvent.click(await screen.findByLabelText('Изменить статус: Новая'));

    // Шит переходов открыт…
    expect(await screen.findByText('«В работе» · принять в работу')).toBeDefined();
    // …а карточка заявки — нет: тап по тегу и тап по карточке означают разное.
    expect(screen.queryByText('Заявка СО-14')).toBeNull();
  });

  it('шит закрывается до того, как откроется окно перехода', async () => {
    setViewport(MOBILE_VIEWPORT);
    const inWork = assignedServiceRequest({
      status: 'in_work',
      files: [serviceRequestFile('act')],
    });
    renderTab(EXECUTOR, [inWork]);

    fireEvent.click(await screen.findByLabelText('Изменить статус: В работе'));
    fireEvent.click(await screen.findByText('«Решена» · закрыть работы'));

    // Окно закрытия работ открыто, а шит уже ушёл: половина переходов открывает своё окно, и
    // оставленный под ним список читался бы как два открытых экрана сразу.
    await waitFor(() => expect(openModalTitles()).toContain('Закрытие работ СО-14'));
    await waitFor(() => expect(document.querySelector('.ant-drawer-open')).toBeNull());
  });
});

describe('карточка заявки: тот же вход в поле «Статус» (ADR 0161, решение по карточке)', () => {
  it('тег в карточке открывает переходы, а окно перехода живёт внутри карточки', async () => {
    renderTab(EXECUTOR, [ASSIGNED]);

    // Карточка открывается так, как её открывает человек: кликом по строке списка.
    fireEvent.click(await screen.findByText('СО-14'));
    expect(await screen.findByText('Заявка СО-14')).toBeDefined();

    // Тегов статуса на экране теперь два — строки списка и карточки: берётся карточкин.
    const triggers = await screen.findAllByLabelText('Изменить статус: Новая');
    fireEvent.click(triggers[triggers.length - 1]!);

    expect(await screen.findByText('«В работе» · принять в работу')).toBeDefined();
  });
});

describe('перечень потерь перед отменой (ADR 0161, решение 6 плана)', () => {
  it('окно причины называет исполнителей и согласование, которые снимутся', async () => {
    const inWork = assignedServiceRequest({
      status: 'in_work',
      approval: {
        by: 'user-2',
        byName: 'Оператор О. О.',
        at: '2026-08-07T10:00:00.000Z',
        revision: 2,
      },
    });
    renderTab(serviceOperator(), [inWork]);

    await openTransitions('В работе');
    await chooseTransition('«Отменена» · отменить заявку');

    expect(await screen.findByText('Что снимется с заявки')).toBeDefined();
    expect(screen.getByText(/Назначенные исполнители: КопиЛайт/)).toBeDefined();
    expect(screen.getByText('Согласование объёма работ (ревизия 2)')).toBeDefined();
  });
});

describe('переход открывает своё окно (ADR 0161, решение 2)', () => {
  it('две дороги в «Отменена» ведут в разные окна', async () => {
    // Висящее предъявление: только при нём согласующему открыт отказ по объёму работ (Р11).
    const pending = estimatePendingServiceRequest({
      service: { id: 'cp-1', name: 'КопиЛайт' },
      estimatedTotalAmount: 12000,
    });
    const http = renderTab(serviceOperator(), [pending]);

    await openTransitions('В работе');
    await chooseTransition('«Отменена» · не согласовать объём работ');
    await waitFor(() => expect(openModalTitles()).toContain('Отказ по объёму работ СО-14'));
    // Окно решения ничего не отправляет само: решение и пометка замены спрашиваются в нём.
    expect(http.countOf('PATCH /service-requests/:id/estimate/approval')).toBe(0);

    fireEvent.click(screen.getByRole('button', { name: 'Отмена' }));
    await waitFor(() => expect(openModalTitles()).not.toContain('Отказ по объёму работ СО-14'));

    await openTransitions('В работе');
    await chooseTransition('«Отменена» · отменить заявку');
    await waitFor(() => expect(openModalTitles()).toContain('Отмена заявки СО-14'));
  });

  it('возврат из заморозки уходит в /resume, а не в общую запись статуса', async () => {
    const held = heldServiceRequest('in_work', {
      executors: [
        { userId: 'user-9', name: 'Сисадминов С. С.', assignedAt: '2026-08-05T10:00:00.000Z' },
      ],
      service: { id: 'cp-1', name: 'КопиЛайт' },
    });
    const http = renderTab(serviceOperator(), [held], {
      'PATCH /service-requests/:id/resume': () =>
        json(assignedServiceRequest({ status: 'in_work', version: 5 })),
    });

    await openTransitions('Отложена');
    await chooseTransition('«В работе» · возобновить');
    await waitFor(() => expect(openModalTitles()).toContain('Вернуть в работу СО-14'));

    fireEvent.click(screen.getByRole('button', { name: 'Возобновить' }));
    await waitFor(() => expect(http.countOf('PATCH /service-requests/:id/resume')).toBe(1));
    expect(http.countOf('PATCH /service-requests/:id/status')).toBe(0);
  });
});

describe('отказ сервера и кэши (ADR 0161, решение 6)', () => {
  it('403 показывает слова сервера и гасит оба кэша', async () => {
    /*
     * Второй корень проверяется по КЭШУ, а не по счётчику запросов: сам список оргтехники страница
     * заявок больше не спрашивает (гарантия приезжает в строке заявки), и мерить гашение сетью
     * стало нечем. Карточка единицы при этом по-прежнему собирает историю обслуживания join-ом —
     * после действия по заявке она показала бы вчерашние ремонты, если бы корень не гасили.
     */
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(officeEquipmentKeys.detail('oe-1'), { id: 'oe-1' });
    const http = renderTab(
      authUser({ role: 'admin' }),
      [ASSIGNED],
      {
        'PATCH /service-requests/:id/start': () =>
          apiError(403, { code: 'forbidden', message: 'Оператор не принимает заявку в работу' }),
      },
      queryClient,
    );
    const requests = http.countOf('GET /service-requests');

    await openTransitions('Новая');
    await chooseTransition('«В работе» · принять в работу');

    expect(await screen.findByText('Оператор не принимает заявку в работу')).toBeDefined();
    await waitFor(() => expect(http.countOf('GET /service-requests')).toBeGreaterThan(requests));
    await waitFor(() =>
      expect(queryClient.getQueryState(officeEquipmentKeys.detail('oe-1'))?.isInvalidated).toBe(
        true,
      ),
    );
  });
});

describe('ожидание — по строке, а не по экрану (Р12)', () => {
  it('пока идёт действие, ждёт только своя строка', async () => {
    const other = assignedServiceRequest({ id: 'sr-2', num: 15, displayNumber: 'СО-15' });
    renderTab(EXECUTOR, [ASSIGNED, other], {
      // Ответ не приходит вовсе: тест смотрит на состояние ожидания, а не на его конец.
      'PATCH /service-requests/:id/start': () => new Promise(() => {}),
    });

    await openTransitions('Новая');
    await chooseTransition('«В работе» · принять в работу');

    await waitFor(() => {
      const triggers = screen.getAllByLabelText('Изменить статус: Новая');
      expect(triggers.filter((el) => el.hasAttribute('disabled'))).toHaveLength(1);
    });
  });
});

describe('доступность с клавиатуры (Р13)', () => {
  it('список открывается с клавиатуры, Esc закрывает и возвращает фокус', async () => {
    renderTab(EXECUTOR, [ASSIGNED]);

    const trigger = await screen.findByLabelText('Изменить статус: Новая');
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');

    trigger.focus();
    fireEvent.keyDown(trigger, { key: 'Enter', code: 'Enter' });
    fireEvent.click(trigger);
    expect(await screen.findByText('«В работе» · принять в работу')).toBeDefined();
    await waitFor(() => expect(trigger.getAttribute('aria-expanded')).toBe('true'));

    // Фокус переводится в меню — так же, как это делает стрелка вниз: без этого шага проверка
    // возврата ничего не значила бы, фокус и так остался бы на триггере.
    const item = document.querySelector<HTMLElement>('.ant-dropdown-menu-item');
    item?.focus();
    expect(document.activeElement).toBe(item);

    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape', code: 'Escape' });
    await waitFor(() => expect(trigger.getAttribute('aria-expanded')).toBe('false'));
    // Фокус возвращается на тег: antd его не возвращает сам, и без этого следующий Tab уводил бы в
    // начало документа — для того, кто ведёт заявки с клавиатуры, это потеря места (ADR 0162).
    expect(document.activeElement).toBe(trigger);
  });

  it('причина запрета достаётся и мыши, и озвучиванию', async () => {
    // Заявка без закрывающего документа: «Закрыть работы» выключено, и причина обязана быть видна
    // обоим читателям — подсказкой на пункте и текстом внутри его доступного имени.
    renderTab(EXECUTOR, [assignedServiceRequest({ status: 'in_work' })]);

    await openTransitions('В работе');
    const disabled = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('.ant-dropdown-menu-item-disabled');
      if (!found) throw new Error('выключенного пункта в списке переходов нет');
      return found;
    });

    expect(disabled.getAttribute('title')).toContain('Сначала подшейте');
    expect(disabled.querySelector('.visually-hidden')?.textContent).toContain('Сначала подшейте');
    // Видимая подпись остаётся отдельным узлом: поиск по ней глазами и тестом не ломается.
    expect(disabled.querySelector('.ant-dropdown-menu-title-content > span')?.textContent).toBe(
      '«Решена» · закрыть работы',
    );
  });
});

describe('карточка заявки: окно перехода живёт внутри карточки (ADR 0140)', () => {
  it('выбор перехода с окном кладёт окно поверх карточки', async () => {
    const inWork = assignedServiceRequest({
      status: 'in_work',
      files: [serviceRequestFile('act')],
    });
    renderTab(EXECUTOR, [inWork]);

    fireEvent.click(await screen.findByText('СО-14'));
    await waitFor(() => expect(openModalTitles()).toContain('Заявка СО-14'));

    const triggers = await screen.findAllByLabelText('Изменить статус: В работе');
    fireEvent.click(triggers[triggers.length - 1]!);
    await chooseTransition('«Решена» · закрыть работы');

    await waitFor(() => expect(openModalTitles()).toContain('Закрытие работ СО-14'));
    // Слой у вложенного окна выше карточкиного: снаружи оно делило бы слой с карточкой и пряталось
    // бы под ней — человек нажал бы пункт и увидел, что «ничего не произошло».
    expect(layerOf('Закрытие работ СО-14')).toBeGreaterThan(layerOf('Заявка СО-14'));
  });
});
