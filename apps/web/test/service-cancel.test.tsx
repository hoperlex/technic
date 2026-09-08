import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { AuthUser, ServiceRequestDto } from '@technic/contracts';
import { json, mockHttp, type HttpMock, type RouteMap } from './http';
import { renderWithUser } from './render';
import { serviceOperator, serviceRequest } from './factories/service';
import { ServiceCancelModal } from '@features/service-cancel';

/**
 * Одиночная отмена заявки на обслуживание (Р10 плана
 * `office-equipment-card-and-list-cleanup-plan.md`).
 *
 * Проверяется то, что расходится молча. Отмена ушла из общего одно-полевого окна причины не ради
 * подписей: у ремонта рядом с причиной спрашивают решение «что делаем вместо» и ставят пометку
 * «рекомендована замена» — единственный вход в этот список после того, как у внутреннего ремонта
 * не стало отказа по объёму работ (Н3). Отсюда три утверждения, каждое из которых иначе обнаружили
 * бы люди:
 *
 * - причина обязательна по-прежнему: без неё в истории останется отменённая заявка без объяснения;
 * - галочка замены делает решение обязательным, а обычная отмена (дубль, ошибка) — нет: пометка
 *   «менять» без ответа «на что» ничего не даёт списку замен, а требование решения у обычной
 *   отмены заставляло бы отвечать на незаданный вопрос;
 * - у расходников этих полей нет вовсе: замене подлежит аппарат, а не картридж, и сервер принимает
 *   оба поля только у ремонта — показанное здесь поле молча терялось бы по дороге.
 */

const OPERATOR: AuthUser = serviceOperator();

/** Ремонт в работе: отмена ему доступна, и поля замены положены именно ему. */
const REPAIR = serviceRequest({ status: 'in_work', version: 4 });

/** Та же заявка на расходники: у неё из содержания отмены остаётся одна причина. */
const CONSUMABLE = serviceRequest({ kind: 'consumable', status: 'in_work', version: 4 });

function renderCancel(
  request: ServiceRequestDto,
  routes: RouteMap = {},
  erases: string[] = [],
): { http: HttpMock; onClose: () => void } {
  const http = mockHttp({
    'PATCH /service-requests/:id/status': () =>
      json({ request: serviceRequest({ status: 'cancelled' }), mail: 'queued' }),
    ...routes,
  });
  const onClose = vi.fn();
  renderWithUser(<ServiceCancelModal request={request} erases={erases} onClose={onClose} />, {
    user: OPERATOR,
  });
  return { http, onClose };
}

/** Причина отказа под полем: её рисует `Form.Item`, а не заголовок и не тост (ADR 0094). */
function fieldError(labelText: string): string | null {
  const label = [...document.querySelectorAll('label')].find(
    (el) => el.textContent?.replace(/\s+/g, ' ').trim() === labelText,
  );
  return (
    label?.closest('.ant-form-item')?.querySelector('.ant-form-item-explain-error')?.textContent ??
    null
  );
}

const cancel = () => fireEvent.click(screen.getByRole('button', { name: 'Отменить заявку' }));

function bodyOf(http: HttpMock): Record<string, unknown> {
  return http.lastCall('PATCH /service-requests/:id/status')?.body as Record<string, unknown>;
}

describe('причина отмены обязательна', () => {
  it('пустая причина помечает поле, а на сервер ничего не уходит', async () => {
    const { http } = renderCancel(REPAIR);
    await screen.findByLabelText('Причина отмены');

    cancel();

    await waitFor(() => expect(fieldError('Причина отмены')).toBe('Укажите причину'));
    expect(http.countOf('PATCH /service-requests/:id/status')).toBe(0);
    // Отказ стоит под полем, а не тостом в углу: правят причину здесь же.
    expect(document.querySelector('.ant-message-notice')).toBeNull();
  });

  it('обычная отмена решения не требует и уходит одной причиной', async () => {
    const { http, onClose } = renderCancel(REPAIR);

    fireEvent.change(await screen.findByLabelText('Причина отмены'), {
      target: { value: 'дубль заявки СО-12' },
    });
    cancel();

    await waitFor(() => expect(http.countOf('PATCH /service-requests/:id/status')).toBe(1));
    const body = bodyOf(http);
    expect(body.status).toBe('cancelled');
    expect(body.reason).toBe('дубль заявки СО-12');
    expect(body.version).toBe(REPAIR.version);
    /*
     * Решения нет — и поле не уходит пустой строкой: «дубль» и «ошиблись при заведении» ответа
     * «что делаем вместо ремонта» не имеют, а пустая строка в этом поле читалась бы как «решение
     * принимали, но не записали».
     */
    expect(body.resolution).toBeUndefined();
    // Пометка не ставится сама: отмена сама по себе не значит «менять».
    expect(body.replacementRecommended).toBe(false);
    expect(await screen.findByText('Заявка отменена')).toBeDefined();
    expect(onClose).toHaveBeenCalled();
  });
});

describe('«Рекомендована замена» спрашивает решение', () => {
  it('галочка без решения не уходит: поле названо', async () => {
    const { http } = renderCancel(REPAIR);

    fireEvent.change(await screen.findByLabelText('Причина отмены'), {
      target: { value: 'ремонт вдвое дороже нового аппарата' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Рекомендована замена аппарата' }));
    cancel();

    await waitFor(() =>
      expect(fieldError('Что делаем вместо ремонта')).toBe(
        'Замену рекомендуют с решением: что делаем вместо ремонта',
      ),
    );
    // Причина заполнена и претензий к ней нет: отказ ровно про то поле, которое обещала галочка.
    expect(fieldError('Причина отмены')).toBeNull();
    expect(http.countOf('PATCH /service-requests/:id/status')).toBe(0);
  });

  it('заполненное решение уходит вместе с пометкой', async () => {
    const { http } = renderCancel(REPAIR);

    fireEvent.change(await screen.findByLabelText('Причина отмены'), {
      target: { value: 'ремонт вдвое дороже нового аппарата' },
    });
    fireEvent.change(screen.getByLabelText('Что делаем вместо ремонта'), {
      target: { value: 'меняем аппарат, заявка на закупку заведена' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Рекомендована замена аппарата' }));
    cancel();

    await waitFor(() => expect(http.countOf('PATCH /service-requests/:id/status')).toBe(1));
    const body = bodyOf(http);
    expect(body.reason).toBe('ремонт вдвое дороже нового аппарата');
    // Решение остаётся полем заявки, причина уходит комментарием перехода — пути у них разные.
    expect(body.resolution).toBe('меняем аппарат, заявка на закупку заведена');
    expect(body.replacementRecommended).toBe(true);
  });

  it('решение без галочки — законный ответ и уходит как есть', async () => {
    // «Чинить не будем, аппарат уезжает на склад» — решение есть, а замены не рекомендуют:
    // требование галочки под каждым решением придумывало бы за человека вторую пометку.
    const { http } = renderCancel(REPAIR);

    fireEvent.change(await screen.findByLabelText('Причина отмены'), {
      target: { value: 'аппарат выводят из эксплуатации' },
    });
    fireEvent.change(screen.getByLabelText('Что делаем вместо ремонта'), {
      target: { value: 'сдаём на склад, замену не заказываем' },
    });
    cancel();

    await waitFor(() => expect(http.countOf('PATCH /service-requests/:id/status')).toBe(1));
    expect(bodyOf(http).resolution).toBe('сдаём на склад, замену не заказываем');
    expect(bodyOf(http).replacementRecommended).toBe(false);
  });
});

describe('у заявки на расходники полей замены нет вовсе', () => {
  it('в окне одна причина, а в теле — ни решения, ни пометки', async () => {
    const { http } = renderCancel(CONSUMABLE);
    await screen.findByLabelText('Причина отмены');

    // Не «спрятано стилем», а не построено: спрятанное поле осталось бы в разметке и уехало бы в
    // теле запроса — сервер принимает оба поля только у ремонта и отвечает отказом на непустые.
    expect(screen.queryByLabelText('Что делаем вместо ремонта')).toBeNull();
    expect(screen.queryByRole('checkbox', { name: 'Рекомендована замена аппарата' })).toBeNull();

    fireEvent.change(screen.getByLabelText('Причина отмены'), {
      target: { value: 'картридж привезли по другой заявке' },
    });
    cancel();

    await waitFor(() => expect(http.countOf('PATCH /service-requests/:id/status')).toBe(1));
    const body = bodyOf(http);
    expect(body.reason).toBe('картридж привезли по другой заявке');
    expect(body.resolution).toBeUndefined();
    expect(body.replacementRecommended).toBeUndefined();
  });
});

describe('что снимется с заявки — до нажатия', () => {
  it('перечень потерь стоит в окне: восстанавливать после нажатия будет нечего', async () => {
    renderCancel(REPAIR, {}, ['Назначенные исполнители: КопиЛайт']);

    expect(await screen.findByText('Что снимется с заявки')).toBeDefined();
    expect(screen.getByText('Назначенные исполнители: КопиЛайт')).toBeDefined();
  });

  it('пустой перечень блока не рисует: он читался бы как недогрузившийся', async () => {
    renderCancel(REPAIR);
    await screen.findByLabelText('Причина отмены');

    expect(screen.queryByText('Что снимется с заявки')).toBeNull();
  });
});
