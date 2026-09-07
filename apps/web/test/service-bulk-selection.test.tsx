import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { AuthUser, ServiceRequestDto } from '@technic/contracts';
import { json, mockHttp, type RouteMap } from './http';
import { renderWithUser } from './render';
import { emptyList, list } from './factories/common';
import {
  assignedServiceRequest,
  heldServiceRequest,
  serviceCustomer,
  serviceOperator,
  serviceRequest,
} from './factories/service';
import { objectDto } from './factories/waste';
import { RequestsTab } from '../src/pages/service/RequestsTab';

/**
 * Полоса массовых действий: что в ней есть и кому её вообще показывают (план
 * `docs/office-equipment-bulk-actions-plan.md`, §11.3).
 *
 * Проверяется связка «набор действий строки → команда полосы» и её границы. Ошибка здесь молчит:
 * лишняя команда ведёт в 403 по каждой строке, недостающая — прячет работу, а полоса у заявителя
 * означала бы возможность, которой продукт не давал (Н11).
 *
 * Правила самого выбора — гашение при смене отбора, потолок пачки, отсутствие полосы на телефоне —
 * живут общим списком портала и проверены в `data-table-selection.test.tsx`: здесь их повторять
 * незачем, разойтись они могут только вместе.
 */

const OPERATOR: AuthUser = serviceOperator();
/** Заказчик: заявки заводит, решений по ним не принимает — массового режима у него нет. */
const CUSTOMER: AuthUser = serviceCustomer();

function renderTab(user: AuthUser, items: ServiceRequestDto[], over: RouteMap = {}) {
  const http = mockHttp({
    'GET /service-requests': () => json(list(items)),
    'GET /objects': () => json(list([objectDto()])),
    'GET /departments': () => json(emptyList()),
    'GET /counterparties': () => json(emptyList()),
    'GET /office-equipment': () => json(emptyList()),
    'GET /office-equipment-types': () => json(emptyList()),
    'GET /service-requests/executor-candidates': () => json(emptyList()),
    ...over,
  });
  renderWithUser(<RequestsTab />, { user });
  return http;
}

const rowOf = (text: string): HTMLElement => screen.getByText(text).closest('tr') as HTMLElement;
const boxOf = (text: string): HTMLInputElement =>
  rowOf(text).querySelector('input[type="checkbox"]') as HTMLInputElement;

/** Подписи кнопок полосы: команда и счётчик применимых стоят в одной строке (Р6). */
function barButtons(): string[] {
  const bar = document.querySelector('.table-footer__bar');
  if (!bar) return [];
  return [...bar.querySelectorAll('button')].map((b) => b.textContent ?? '');
}

/** Новая заявка с исполнителем и отложенная: у них разные ходы, и полоса обязана это показать. */
const NEW_ASSIGNED = assignedServiceRequest({ id: 'sr-1', num: 14, displayNumber: 'СО-14' });
const HELD = heldServiceRequest('in_work', { id: 'sr-2', num: 15, displayNumber: 'СО-15' });

describe('состав полосы', () => {
  it('команда появляется от одной строки, а счётчик считает применимые', async () => {
    renderTab(OPERATOR, [NEW_ASSIGNED, HELD]);
    expect(await screen.findByText('СО-14')).toBeDefined();

    fireEvent.click(boxOf('СО-14'));
    fireEvent.click(boxOf('СО-15'));

    await waitFor(() => expect(barButtons().length).toBeGreaterThan(0));
    const labels = barButtons().join(' | ');
    expect(document.querySelector('.table-footer__bar')?.textContent).toContain('Выбрано 2 заявки');
    // «Отложить» есть только у живой заявки, «Возобновить» — только у отложенной: обе команды в
    // полосе, и каждая называет, к скольким строкам применима.
    expect(labels).toContain('Отложить (1 из 2)');
    expect(labels).toContain('Возобновить (1 из 2)');
    // Отмена доступна обеим — счётчик её и не сужает.
    expect(labels).toContain('Отменить (2 из 2)');
  });

  it('строка без пакетных команд не выбирается и объясняет себя', async () => {
    // Принятая работа: ход по ней закончен, а распоряжаться записью оператор не вправе — заявка
    // чужой площадки (`inCustomerScope: false`).
    renderTab(OPERATOR, [
      serviceRequest({ id: 'sr-9', num: 20, displayNumber: 'СО-20', status: 'accepted' }),
    ]);
    expect(await screen.findByText('СО-20')).toBeDefined();

    const box = boxOf('СО-20');
    expect(box.disabled).toBe(true);
    fireEvent.mouseEnter(box.closest('td')?.firstElementChild as Element);
    expect(await screen.findByText('Массовых действий по этой заявке нет')).toBeDefined();
  });
});

describe('кому массовый режим не положен', () => {
  it('у заявителя нет ни колонки выбора, ни полосы', async () => {
    renderTab(CUSTOMER, [serviceRequest({ audience: 'requester', inCustomerScope: true })]);
    expect(await screen.findByText('СО-14')).toBeDefined();

    /*
     * Не «полоса пустая», а «выбирать нечем»: допуск к массовому режиму — продуктовое
     * ограничение поверх прав (Р5), и портал спрашивает тот же предикат, что и сервер. Разойдись
     * они — чекбоксы вели бы в 403.
     */
    expect(rowOf('СО-14').querySelector('input[type="checkbox"]')).toBeNull();
    expect(document.querySelector('.table-footer__bar')).toBeNull();
  });
});
