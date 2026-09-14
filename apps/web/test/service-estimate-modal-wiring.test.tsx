import { describe, expect, it } from 'vitest';
import { fireEvent, screen } from '@testing-library/react';
import type { ServiceRequestDto } from '@technic/contracts';
import { mockHttp } from './http';
import { renderWithUser } from './render';
import {
  SERVICE_COUNTERPARTY,
  serviceExecutor,
  serviceOperator,
  serviceRequest,
} from './factories/service';
import { useServiceRequestModals } from '../src/pages/service/serviceRequestModals';
import { ServiceRequestEstimate } from '../src/pages/service/ServiceRequestEstimate';

/**
 * ПРОВОДКА К ОКНУ ОБЪЁМА РАБОТ: чекбокс освобождения доходит до боевого входа (Р3 плана
 * `docs/office-equipment-on-site-and-invoice-estimate-plan.md`, этапы Э6 и Э7).
 *
 * ЗАЧЕМ ОТДЕЛЬНАЯ СУИТА, КОГДА САМО ОКНО УЖЕ ПРОВЕРЕНО. Соседний
 * `service-estimate-document-mode.test.tsx` рендерит `EstimateEditorModal` НАПРЯМУЮ и передаёт
 * перевод карточки сам — это верно для предмета той суиты (что окно делает с телом запроса), но
 * ровно поэтому она не видит главного: передал ли перевод тот, кто открывает окно в бою. Пропы
 * необязательны и fail-closed, и забытые они гасят чекбокс МОЛЧА — ни сборка, ни прямой рендер
 * окна не краснеют. Так эта дыра и появилась: окно умело заявление, а оба входа портала его не
 * включали, и денежное решение было недостижимо ни для кого.
 *
 * Поэтому здесь проверяется не окно, а ДОРОГА к нему: хук окон заявки (`useServiceRequestModals`)
 * и вкладка объёма работ — два единственных места портала, откуда этот редактор открывается.
 */

/** Оба ключа волны: сценарию нужен видимый чекбокс, а не разговор о рубильниках. */
const FLAGS = ['service_estimate_document_mode', 'service_estimate_exemption'] as const;

/** Оператор подрядчика: заявление об освобождении делает только он (ответ В1 заказчика). */
const EXECUTOR = serviceExecutor({ features: [...FLAGS] });

/**
 * Заявка, по которой объём работ предъявляют: «В работе», назначен ТОТ подрядчик, предъявление не
 * висит. Все три условия спрашивает `canDeclareExemption`, и на другой фикстуре чекбокса не было бы
 * по причине, о которой сценарий не говорит.
 */
function editableRequest(overrides: Partial<ServiceRequestDto> = {}): ServiceRequestDto {
  return serviceRequest({
    status: 'in_work',
    service: { ...SERVICE_COUNTERPARTY },
    estimatePendingRevision: null,
    items: [],
    ...overrides,
  });
}

/**
 * Боевой вход в окно: набор окон заявки живёт хуком, и открывают его пунктом меню. Кнопка здесь
 * заменяет пункт — предмет проверки не меню, а то, с чем хук монтирует само окно.
 */
function ModalsHarness({ request }: { request: ServiceRequestDto }) {
  const modals = useServiceRequestModals();
  return (
    <>
      <button type="button" onClick={() => modals.estimate(request)}>
        Объём работ
      </button>
      {modals.node}
    </>
  );
}

describe('чекбокс освобождения доходит до боевого входа (Р3)', () => {
  it('окно, открытое набором окон заявки, предлагает заявление оператору сервиса', () => {
    mockHttp({});
    renderWithUser(<ModalsHarness request={editableRequest()} />, { user: EXECUTOR });

    fireEvent.click(screen.getByRole('button', { name: 'Объём работ' }));

    /*
     * Главная строка суиты. Не передай хук перевод карточки — окно ушло бы в fail-closed и
     * чекбокса не нарисовало бы НИКОМУ: денежное решение стало бы недостижимым, а не «недоступным
     * не тому», и заметить это можно только отсюда.
     */
    expect(screen.getByRole('checkbox', { name: 'Согласование не требуется' })).toBeDefined();
  });

  it('«Ведению» — не предлагает: перевод настоящий, и предикат отвечает по нему', () => {
    /*
     * Обратная половина того же утверждения, и без неё первая ничего не стоила бы: показ мог бы
     * оказаться безусловным. Перевод здесь тот же, а ответ другой — значит спрашивают именно
     * предикат, а не наличие пропа.
     */
    mockHttp({});
    renderWithUser(<ModalsHarness request={editableRequest()} />, {
      user: serviceOperator({ features: [...FLAGS] }),
    });

    fireEvent.click(screen.getByRole('button', { name: 'Объём работ' }));

    expect(screen.queryByText('Согласование не требуется')).toBeNull();
  });
});

/**
 * РАСКЛАДКА СЧЁТА ПО ГРАФАМ — ВЫХОД, КОТОРЫЙ ПОРТАЛ ОБЕЩАЕТ СЛОВАМИ (Р8).
 *
 * Окно объёма работ, окно закрытия и сама вкладка зовут «Ведение» разложить счёт по графам: это
 * единственный путь документной заявки к сумме, построчному факту и гарантиям, пока нет разбора
 * документа. Строк у такой ревизии нет вовсе — и кнопка, спрашивающая один лишь состав, делала бы
 * обещанный выход несуществующим: человек шёл бы его искать и не находил.
 */
describe('у документной ревизии есть вход в раскладку (Р8)', () => {
  const documentRequest = (overrides: Partial<ServiceRequestDto> = {}): ServiceRequestDto =>
    editableRequest({
      estimateRevision: 1,
      estimateFormat: 'document',
      estimatedTotalAmount: null,
      ...overrides,
    });

  it('«Ведение» видит кнопку на заявке со счётом, хотя строк у неё ноль', () => {
    mockHttp({});
    renderWithUser(<ServiceRequestEstimate request={documentRequest()} />, {
      user: serviceOperator(),
    });

    expect(screen.getByRole('button', { name: /Разложить по графам/ })).toBeDefined();
  });

  it('и текст вкладки зовёт туда же, а не в пустоту', () => {
    mockHttp({});
    renderWithUser(<ServiceRequestEstimate request={documentRequest()} />, {
      user: serviceOperator(),
    });

    expect(screen.getByText(/разложите счёт по графам/)).toBeDefined();
  });

  it('окно раскладки говорит, откуда брать позиции: счёт лежит на вкладке «Документы»', () => {
    /*
     * Достижимости мало: окно открывается ПУСТЫМ — строк у документной ревизии нет, — и без этой
     * подсказки «Ведение» смотрело бы на пустую таблицу, не понимая, что переносить и откуда.
     */
    mockHttp({});
    renderWithUser(<ServiceRequestEstimate request={documentRequest()} />, {
      user: serviceOperator(),
    });

    fireEvent.click(screen.getByRole('button', { name: /Разложить по графам/ }));

    expect(screen.getByText(/Перенесите позиции счёта в графы/)).toBeDefined();
    expect(screen.getByText(/он на вкладке «Документы» карточки/)).toBeDefined();
  });

  it('у пустого черновика кнопки по-прежнему нет: раскладывать нечего', () => {
    /*
     * Вредность первого сценария: спроси кнопка «не документ ли это» вместо «есть ли что
     * раскладывать», она появилась бы и здесь — а нажатие переиздало бы пустоту, на которую сервер
     * отвечает «нужна хотя бы одна строка».
     */
    mockHttp({});
    renderWithUser(<ServiceRequestEstimate request={editableRequest()} />, {
      user: serviceOperator(),
    });

    expect(screen.queryByRole('button', { name: /Разложить по графам/ })).toBeNull();
  });

  it('исполнителю кнопка не положена: раскладывает «Ведение», у него и право', () => {
    mockHttp({});
    renderWithUser(<ServiceRequestEstimate request={documentRequest()} />, { user: EXECUTOR });

    expect(screen.queryByRole('button', { name: /Разложить по графам/ })).toBeNull();
  });
});
