import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { ServiceRequestDto } from '@technic/contracts';
import { serviceClosingDocumentHint } from '@entities/service-request';
import { json, mockHttp, type HttpMock } from './http';
import { renderWithUser } from './render';
import {
  SERVICE_COUNTERPARTY,
  serviceExecutor,
  serviceOperator,
  serviceRequest,
  serviceRequestFile,
} from './factories/service';
import { ServiceCompleteModal } from '../src/features/service-complete/ui/ServiceCompleteModal';
import { ServiceAcceptModal } from '../src/features/service-accept/ui/ServiceAcceptModal';
import { ServiceRequestDocuments } from '../src/pages/service/ServiceRequestDocuments';

/**
 * ЗАКРЫТИЕ РАБОТ И ДОКУМЕНТЫ У ДОКУМЕНТНОЙ ПОДАЧИ (план
 * `docs/office-equipment-on-site-and-invoice-estimate-plan.md`: Р5, Р6, Р8, Р10 и §8 «Узкие места»).
 *
 * ЧТО ЗДЕСЬ НА САМОМ ДЕЛЕ ПРОВЕРЯЕТСЯ — ЧЕТЫРЕ УТВЕРЖДЕНИЯ ПОРТАЛА О ДЕНЬГАХ И БУМАГАХ, каждое из
 * которых ломается молча и читается человеком как факт:
 *
 * 1. **ноль вместо неизвестной суммы** (§8). У документной ревизии суммы нет — она придёт разбором
 *    документа, — и «0,00 ₽» на её месте означает «работы бесплатны». Экран при этом цел, тесты
 *    состава зелены, а денежное решение принимают по цифре, которой никто не называл;
 * 2. **пустая таблица отметок** (Р8). Строк у такой ревизии нет вовсе, и `sent.size !== rows.length`
 *    выполняется само: закрытие проходит. Человек же видит пустое место там, где ищет, что
 *    отмечать, — и объяснение ему нужно раньше кнопки;
 * 3. **перечень закрывающих видов** (Р5). Прежний список из трёх видов предлагал документной
 *    заявке счёт — тот самый документ, которым её ОТКРЫЛИ: подшив его, человек остался бы в той же
 *    очереди «Ожидаются документы» без единого слова на экране;
 * 4. **кнопка снятия у основания и имя карантинного файла** (Р6). Основание денежного решения не
 *    снимается никогда, и кнопка, за которой стоит один отказ, хуже отсутствующей; у карантинного
 *    вложения имя ПУСТОЕ — общий список нарисовал бы пустую ссылку, то есть «файл, у которого
 *    что-то сломалось» вместо «документ закрыт по обращению».
 *
 * КАЖДАЯ ПРОВЕРКА СТОИТ В ПАРЕ С ОБЫЧНОЙ ЗАЯВКОЙ. Проверка отсутствия зелена и на экране, который
 * не показывает ничего никому, — а сдвинуть планку наследия здесь нельзя: у построчной заявки счёт
 * закрывает работы ровно как закрывал (ответ В10 заказчика от 11.09.2026).
 *
 * Документной подачи сегодня не бывает — рубильник выключен, и ручка предъявления такую ревизию не
 * создаёт, — поэтому фикстуры описывают состояние выпуска читателей (§7 плана). Рубильник в
 * условиях НЕ участвует намеренно: он решает, можно ли такую ревизию создать, а уже созданная —
 * факт заявки, и выключенная настройка не должна превращать её на экране обратно в нули.
 */

/** Тот, кто ведёт заявки: ему видны пояснительные плашки (`canCoordinateServiceRequests`). */
const COORDINATOR = serviceOperator();
/** Оператор сервисной компании — он и закрывает работы; пояснений ему не показывают (Р11). */
const EXECUTOR = serviceExecutor();

/** Объём работ подан счётом: ревизия согласована автопринятием, строк и суммы у неё нет (Р2). */
function documentRequest(over: Partial<ServiceRequestDto> = {}): ServiceRequestDto {
  return serviceRequest({
    status: 'in_work',
    service: { ...SERVICE_COUNTERPARTY },
    estimateRevision: 2,
    estimateFormat: 'document',
    // Снимка суммы у документной ревизии нет — и это не пробел фикстуры, а сама её суть (Р2).
    estimatedTotalAmount: null,
    approval: {
      by: null,
      byName: '',
      at: '2026-09-11T09:00:00.000Z',
      revision: 2,
      source: 'auto',
    },
    items: [],
    ...over,
  });
}

/** Та же заявка, поданная строками: планка наследия и счётный итог у неё прежние. */
function itemsRequest(over: Partial<ServiceRequestDto> = {}): ServiceRequestDto {
  return serviceRequest({
    status: 'in_work',
    service: { ...SERVICE_COUNTERPARTY },
    estimateRevision: 1,
    estimateFormat: 'items',
    estimatedTotalAmount: 1800,
    approval: {
      by: 'user-7',
      byName: 'Ведьмина В. В.',
      at: '2026-09-11T09:00:00.000Z',
      revision: 1,
      source: 'human',
    },
    items: [
      {
        id: 'sri-1',
        kind: 'part',
        name: 'Ролик подачи',
        quantity: 1,
        unitPrice: 1800,
        amount: 1800,
        performed: true,
        actualQuantity: 1,
        actualAmount: 1800,
        warrantyMonths: null,
        warrantyUntil: null,
        warrantyUntilManual: false,
      },
    ],
    ...over,
  });
}

function renderComplete(request: ServiceRequestDto, user = COORDINATOR): HttpMock {
  const http = mockHttp({
    'PATCH /service-requests/:id/complete': () => json(request),
  });
  renderWithUser(<ServiceCompleteModal request={request} onClose={() => {}} />, { user });
  return http;
}

/** Весь текст экрана: утверждение «нуля нигде нет» проверяется по странице, а не по одной строке. */
const pageText = () => document.body.textContent ?? '';

describe('окно закрытия работ: неизвестная сумма словами, а не нулём (§8)', () => {
  it('у документной заявки нуля нет ни в плашке, ни в итоге', async () => {
    renderComplete(documentRequest());

    await screen.findByText(/Согласована ревизия 2/);
    // Главное утверждение: ни одной денежной цифры на экране — сумма неизвестна, и сказано это
    // словами. Проверяется по всему тексту окна: мест, где ноль подставлялся, было два.
    expect(pageText()).not.toMatch(/0,00\s?₽/);
    expect(screen.getByText(/сумма не разобрана/)).toBeDefined();
    expect(screen.getByText('не разобрана')).toBeDefined();
  });

  it('у построчной заявки сумма прежняя — планка наследия не сдвинулась', async () => {
    renderComplete(itemsRequest());

    // Согласованная сумма и счётный итог на своих местах: словами их подменять нечем — они есть.
    expect(await screen.findByText(/Согласована ревизия 1 на 1\s?800,00\s?₽/)).toBeDefined();
    expect(screen.getByText('Итого по акту:')).toBeDefined();
    expect(pageText()).not.toMatch(/не разобрана/);
  });
});

describe('окно закрытия работ: документная заявка закрывается без построчного факта (Р8)', () => {
  it('пустая таблица отметок объяснена, а скидка по акту не предлагается', async () => {
    // Исполнителю — он и закрывает работы, а пояснительной плашки ему не показывают: объяснение
    // пустого места обязано быть видно именно ему, и через `ServiceHint` оно бы не дошло.
    renderComplete(documentRequest(), EXECUTOR);

    expect(await screen.findByText(/Отмечать нечего/)).toBeDefined();
    // Строк нет — значит нет и полей факта: ни отметки, ни фактического количества.
    expect(screen.queryByLabelText(/^Фактическое количество: /)).toBeNull();
    /*
     * Скидка убрана СОСТОЯНИЕМ, а не погашена (Р10): сервер отвечает на неё 422 — считать скидку
     * не от чего, пока итог неизвестен, — и погашенное поле звало бы искать несуществующий путь.
     */
    expect(screen.queryByLabelText('Скидка по акту')).toBeNull();
    expect(screen.queryByLabelText('Причина скидки')).toBeNull();
  });

  it('в теле закрытия не уходят ни строки, ни скидка — сервер отвергает их 422', async () => {
    const http = renderComplete(documentRequest(), EXECUTOR);
    await screen.findByText(/Отмечать нечего/);

    fireEvent.click(screen.getByRole('button', { name: 'Закрыть работы' }));
    await waitFor(() => expect(http.countOf('PATCH /service-requests/:id/complete')).toBe(1));

    const body = http.lastCall('PATCH /service-requests/:id/complete')?.body as {
      items: unknown[];
      adjustmentAmount: number | null;
      adjustmentReason: string;
    };
    // `items: []` — законное тело, а не «нечего послать»: поле схемы обязательное, и сервер
    // отвергает только непустое содержимое.
    expect(body.items).toEqual([]);
    expect(body.adjustmentAmount).toBeNull();
    expect(body.adjustmentReason).toBe('');
  });

  it('у построчной заявки таблица отметок на месте', async () => {
    renderComplete(itemsRequest(), EXECUTOR);

    expect(await screen.findByLabelText('Фактическое количество: Ролик подачи')).toBeDefined();
    expect(screen.getByLabelText('Скидка по акту')).toBeDefined();
    expect(pageText()).not.toMatch(/Отмечать нечего/);
  });
});

// ── Планка закрывающих документов ──────────────────────────────────────────

/**
 * Виды, предлагаемые загрузчиком: подписи вариантов его единственного списка. Поле подписи не
 * имеет — её заменяет сам выбранный вид, — поэтому список ищется по разметке antd.
 */
async function attachKinds(): Promise<string[]> {
  const select = document.querySelector('.ant-select');
  if (!select) throw new Error('загрузчика на экране нет');
  fireEvent.mouseDown(select);
  return await waitFor(() => {
    const options = [...document.querySelectorAll('.ant-select-item-option-content')];
    if (options.length === 0) throw new Error('список видов документа не открылся');
    return options.map((option) => option.textContent ?? '');
  });
}

function renderAccept(request: ServiceRequestDto): void {
  mockHttp({});
  renderWithUser(<ServiceAcceptModal request={request} mode="accept" onClose={() => {}} />, {
    user: COORDINATOR,
  });
}

describe('окно приёмки: закрывающие виды считает формат ревизии (Р5)', () => {
  it('документной заявке предлагается один акт, и подсказка называет его же', async () => {
    renderAccept(documentRequest({ status: 'done', files: [serviceRequestFile('invoice')] }));
    await screen.findByRole('button', { name: /Подшить документ/ });

    // Счёт в этом списке был бы предложением закрыть заявку тем, чем её открыли.
    expect(await attachKinds()).toEqual(['Акт']);
    expect(screen.getByText(serviceClosingDocumentHint('document'))).toBeDefined();
    expect(screen.queryByText(serviceClosingDocumentHint(null))).toBeNull();
  });

  it('построчной — прежние три вида', async () => {
    renderAccept(itemsRequest({ status: 'done', files: [] }));
    await screen.findByRole('button', { name: /Подшить документ/ });

    expect(await attachKinds()).toEqual(['Акт', 'Счёт', 'Гарантийный талон']);
    expect(screen.getByText(serviceClosingDocumentHint(null))).toBeDefined();
  });
});

// ── Вкладка документов: роль файла и карантин ──────────────────────────────

function renderDocuments(request: ServiceRequestDto): void {
  mockHttp({});
  renderWithUser(<ServiceRequestDocuments request={request} />, { user: COORDINATOR });
}

/** Кнопки снятия на вкладке: сколько их, столько файлов портал предлагает убрать. */
const removeButtons = () => screen.queryAllByRole('button', { name: 'Удалить' });

describe('вкладка документов: основание не снимается, карантин не показывает имени (Р5, Р6)', () => {
  it('у счёта-основания кнопки снятия нет, а причина и выход названы', async () => {
    renderDocuments(
      documentRequest({
        inCustomerScope: true,
        files: [serviceRequestFile('invoice', { purpose: 'estimate_basis' })],
      }),
    );

    await screen.findByText('Счёт');
    // Сервер отказывает по такому файлу всегда — кнопка вела бы в один отказ.
    expect(removeButtons()).toHaveLength(0);
    expect(screen.getByText(/из заявки он не снимается никогда/)).toBeDefined();
    // Сам документ при этом остаётся читаемым: скрыт не файл, а обещание его убрать.
    expect(screen.getByText('invoice.pdf')).toBeDefined();
  });

  it('обычный счёт той же заявки снимается как прежде', async () => {
    renderDocuments(
      documentRequest({ inCustomerScope: true, files: [serviceRequestFile('invoice')] }),
    );

    await screen.findByText('Счёт');
    expect(removeButtons()).toHaveLength(1);
    expect(screen.queryByText(/из заявки он не снимается никогда/)).toBeNull();
  });

  it('карантинное вложение показывает состояние вместо имени и ссылки', async () => {
    renderDocuments(
      documentRequest({
        inCustomerScope: true,
        // Имя у карантинного файла ПУСТОЕ — так его отдаёт сервер (`fileNameView`), и портал
        // обязан прочитать это как состояние, а не как «имени нет».
        files: [serviceRequestFile('act', { filename: '', quarantined: true })],
      }),
    );

    expect(await screen.findByText(/Документ закрыт по обращению/)).toBeDefined();
    // Ссылки нет вовсе: у неё не было бы даже текста, за который её нажимают.
    expect(document.querySelectorAll('.ant-typography a')).toHaveLength(0);
    // Строка вложения при этом осталась: «доказательство скрыто» и «доказательства не было» —
    // разные факты, и вид документа над состоянием подписан по-прежнему.
    expect(screen.getByText('Акт')).toBeDefined();
  });

  it('обычный акт показывает имя ссылкой — поведение не изменилось', async () => {
    renderDocuments(documentRequest({ inCustomerScope: true, files: [serviceRequestFile('act')] }));

    expect(await screen.findByText('act.pdf')).toBeDefined();
    expect(screen.queryByText(/Документ закрыт по обращению/)).toBeNull();
  });
});
