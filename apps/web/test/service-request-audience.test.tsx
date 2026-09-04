import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { permissionsFor, type AuthUser, type ServiceRequestDto } from '@technic/contracts';
import { json, mockHttp } from './http';
import { renderWithUser } from './render';
import { emptyList, list } from './factories/common';
import {
  serviceCustomer,
  serviceOperator,
  serviceRequest,
  serviceRequestFile,
} from './factories/service';
import { MOBILE_VIEWPORT, type Viewport } from './viewport';
import { RequestsTab } from '../src/pages/service/RequestsTab';
import { ServiceRequestDocuments } from '../src/pages/service/ServiceRequestDocuments';
import { ServiceRequestViewModal } from '../src/pages/service/ServiceRequestViewModal';

/**
 * Карточка и список заявки на обслуживание по аудиториям (ADR 0160, §7.4 плана
 * `docs/office-equipment-requester-card-plan.md`): заявителю не видно денег.
 *
 * ГЛАВНОЕ, ЧТО ЗДЕСЬ ПРОВЕРЯЕТСЯ, — ЧТО ПОРТАЛ ЧИТАЕТ `audience` ИЗ DTO, А НЕ СЧИТАЕТ ЕЁ САМ.
 * Поэтому фикстуры описывают ответ сервера ЦЕЛИКОМ, вместе с уже применённой проекцией: у заявителя
 * `items` пусты, суммы обнулены, а в `files` нет ни акта, ни счёта. Опиши тест «ту же заявку, но с
 * другой учёткой», он проверял бы не разграничение, а собственную формулу прав — ровно ту вторую
 * карту правил, которой в портале быть не должно.
 *
 * Отсюда же и пары сценариев: каждая проверка «заявителю не видно» стоит рядом с проверкой «ведению
 * видно» на ТЕХ ЖЕ данных. Одиночная проверка отсутствия зелена и на сломанном экране, который не
 * показывает ничего никому.
 *
 * Смешанная выдача (последний блок) — не выдуманный случай, а следствие решения 1 ADR: назначение
 * открывает внутреннему исполнителю деньги ровно одной заявки, и в одной странице у него законно
 * лежат обе аудитории. Столбец при этом один на таблицу — и именно на этом стыке портал легче
 * всего заставить соврать прочерком.
 */

const SERVICE = { id: 'cp-1', name: 'КопиЛайт' };

/**
 * Внутренний исполнитель БЕЗ субъектного `serviceRequests.finance`: заказчик своей площадки, которому
 * выдали право вести работы. Набора `office_equipment_executor` в каталоге ещё нет (он предмет плана
 * профилей), поэтому право дописывается прямо в список учётки — портал спрашивает список, а не
 * выводит его из роли (ADR 0106). Аудиторию его строк это никак не меняет: её считает сервер, и
 * тест только описывает, что тот прислал.
 */
const INHOUSE_EXECUTOR: AuthUser = serviceCustomer({
  permissions: [
    ...permissionsFor({ role: 'shtab', counterpartyType: null, addons: [] }),
    'serviceRequests.execute',
  ],
});

/**
 * Закрытая заявка сервисного ремонта: смета, факт по акту и подшитая фотография. Именно такую и
 * режет проекция — на заявке без денег разница между аудиториями не видна вовсе.
 *
 * Закрывающего документа у неё нет намеренно: на этом состоянии и держится плашка «нужен
 * закрывающий документ» (Р12), которую заявителю показывать нельзя.
 */
function repair(over: Partial<ServiceRequestDto> = {}): ServiceRequestDto {
  return serviceRequest({
    status: 'done',
    service: { ...SERVICE },
    files: [serviceRequestFile('attachment')],
    ...over,
  });
}

/** Как эту заявку видит «Ведение»: карточка полная. */
const FINANCE = repair({
  audience: 'finance',
  estimateRevision: 1,
  estimateSubmittedAt: '2026-08-06T09:00:00.000Z',
  estimatedTotalAmount: 7100,
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
  completion: {
    completedAt: '2026-08-14T12:00:00.000Z',
    totalAmount: 7100,
    adjustmentAmount: null,
    adjustmentReason: '',
  },
});

/**
 * Та же заявка глазами заявителя — ровно то, что отдаёт сервер после проекции (Р4): состав работ и
 * суммы обнулены, дата закрытия оставлена («работы закрыты 14 августа» — не деньги, а факт,
 * которого он ждёт).
 */
const REQUESTER = repair({
  audience: 'requester',
  estimateRevision: 0,
  estimateSubmittedAt: null,
  estimatedTotalAmount: null,
  items: [],
  completion: {
    completedAt: '2026-08-14T12:00:00.000Z',
    totalAmount: null,
    adjustmentAmount: null,
    adjustmentReason: '',
  },
});

/** Соседняя заявка той же площадки — вторая строка смешанной выдачи исполнителя. */
const NEIGHBOUR = repair({
  id: 'sr-2',
  num: 15,
  displayNumber: 'СО-15',
  audience: 'requester',
  completion: {
    completedAt: '2026-08-14T12:00:00.000Z',
    totalAmount: null,
    adjustmentAmount: null,
    adjustmentReason: '',
  },
});

// ── Карточка ───────────────────────────────────────────────────────────────

function renderCard(request: ServiceRequestDto, user: AuthUser): void {
  mockHttp({
    'GET /service-requests/:id': () => json(request),
    'GET /service-requests/:id/history': () => json([]),
  });
  renderWithUser(<ServiceRequestViewModal request={request} onClose={() => {}} />, { user });
}

/** Подписи вкладок карточки — по ним и виден её состав. */
function tabNames(): string[] {
  return screen.getAllByRole('tab').map((tab) => tab.textContent ?? '');
}

describe('вкладка «Объём работ» — по аудитории строки (§7.4.1, §7.4.2)', () => {
  it('заявителю вкладки нет в разметке: вкладок три', async () => {
    renderCard(REQUESTER, serviceCustomer());
    await screen.findByRole('tab', { name: 'Заявка' });

    expect(tabNames()).toEqual(['Заявка', 'Документы', 'История']);
    // Не построена, а не «спрятана стилем»: спрятанная осталась бы в разметке вместе с подписью и
    // содержимым, и проверка на видимость зеленела бы на карточке, из которой суммы всё равно
    // вычитываются. Поэтому ищется вообще любое вхождение подписи, а не только вкладка.
    expect(screen.queryByRole('tab', { name: 'Объём работ' })).toBeNull();
    expect(screen.queryAllByText('Объём работ')).toHaveLength(0);
  });

  it('«Ведению» по той же заявке — вкладок четыре, и сумма на месте', async () => {
    renderCard(FINANCE, serviceOperator());
    await screen.findByRole('tab', { name: 'Заявка' });

    expect(tabNames()).toEqual(['Заявка', 'Объём работ', 'Документы', 'История']);

    fireEvent.click(screen.getByRole('tab', { name: 'Объём работ' }));
    // Итог — то самое, ради чего вкладку и открывают; строка состава рядом с ним. Вхождений у суммы
    // два («По объёму работ» и «По акту»), и оба законны: `findAllByText`, а не `findByText`.
    expect(await screen.findAllByText(/7\s?100,00/)).not.toHaveLength(0);
    expect(screen.getByText('Ролик подачи')).toBeDefined();
  });
});

// ── Документы ──────────────────────────────────────────────────────────────

/**
 * Вкладка документов рендерится отдельно от карточки: проверяются форма подшивки и плашка, а
 * прокликивание вкладок к этому ничего не добавляет — состав видов и так решает одна функция.
 */
function renderDocuments(request: ServiceRequestDto, user: AuthUser): void {
  mockHttp({});
  renderWithUser(<ServiceRequestDocuments request={request} />, { user });
}

/**
 * Виды, предлагаемые формой подшивки: подписи вариантов её единственного списка.
 *
 * Список открывается ОДНИМ нажатием, а ожидание стоит после него: `mouseDown` по полю antd
 * переключает выпадашку, и повторённый внутри `waitFor` он закрывал бы её обратно через раз.
 */
async function attachKinds(): Promise<string[]> {
  // Поле у формы одно и подписи не имеет: подпись ему заменяет сам выбранный вид, поэтому
  // общий помощник `openSelectOptions` (он ищет поле по `label`) здесь не годится.
  const select = document.querySelector('.ant-select');
  if (!select) throw new Error('формы подшивки на экране нет');
  fireEvent.mouseDown(select);
  return await waitFor(() => {
    const options = [...document.querySelectorAll('.ant-select-item-option-content')];
    if (options.length === 0) throw new Error('список видов документа не открылся');
    return options.map((option) => option.textContent ?? '');
  });
}

describe('подшивка и плашка закрывающего документа (§7.4.3)', () => {
  it('заявителю предлагается единственный вид «Вложение», плашки нет', async () => {
    renderDocuments(REQUESTER, serviceCustomer());
    await screen.findByRole('button', { name: /Подшить документ/ });

    // Виды считает контракт (`attachableServiceFileKinds`), а не своя копия правила: расхождение
    // означало бы вид, на котором человек получает отказ после выбора.
    expect(await attachKinds()).toEqual(['Вложение']);
    // Плашка соврала бы: акт по этой заявке может быть подшит неделю назад, а в урезанном списке
    // файлов его нет и быть не может (Р12).
    expect(screen.queryByText(/Нужен один из документов/)).toBeNull();
  });

  it('«Ведению» на той же заявке — все виды статуса и плашка на месте', async () => {
    renderDocuments(FINANCE, serviceOperator());
    await screen.findByRole('button', { name: /Подшить документ/ });

    expect(await attachKinds()).toEqual(['Вложение', 'Акт', 'Счёт', 'Гарантийный талон']);
    expect(screen.getByText(/Нужен один из документов/)).toBeDefined();
  });

  /**
   * ФИНАНСОВАЯ АУДИТОРИЯ БЕЗ СТОРОНЫ — вторая половина того же вопроса (план аудита исполнителей,
   * Р3). Заявка ТА ЖЕ, что у «Ведения», и аудитория та же — `finance`: сервер прислал её полной,
   * потому что деньги этому читателю открыты (у ИТ-службы `serviceRequests.finance` сквозной).
   * Стороны при этом нет: заявка назначена подрядчику, поимённо человек в ней не значится, а
   * `serviceRequests.status` ИТ-службе не выдают.
   *
   * Форма обязана предложить ему одно «Вложение». Предложи она акт — кнопка вела бы в 403: сервер
   * спрашивает ту же функцию контрактов (`canAttachServiceFile`), и разойтись им негде.
   */
  it('держателю finance без стороны предлагается одно «Вложение»', async () => {
    renderDocuments(FINANCE, INHOUSE_EXECUTOR);
    await screen.findByRole('button', { name: /Подшить документ/ });

    expect(await attachKinds()).toEqual(['Вложение']);
  });
});

// ── Список ─────────────────────────────────────────────────────────────────

function renderTab(items: ServiceRequestDto[], user: AuthUser, viewport?: Viewport): void {
  mockHttp({
    'GET /service-requests': () => json(list(items)),
    'GET /objects': () => json(emptyList()),
    'GET /departments': () => json(emptyList()),
    'GET /counterparties': () => json(emptyList()),
    'GET /office-equipment': () => json(emptyList()),
    'GET /office-equipment-types': () => json(emptyList()),
  });
  renderWithUser(<RequestsTab />, { user, viewport });
}

/** Заголовки столбцов таблицы — по ним и видно, есть ли «Сумма». */
function headers(): string[] {
  return [...document.querySelectorAll('.ant-table-thead th')].map((th) => th.textContent ?? '');
}

/**
 * Текст ячейки «Сумма» у строки заявки; `null` — столбца нет вовсе.
 *
 * Считается по номеру столбца, а не поиском текста: пустая ячейка текста не имеет по определению,
 * и отличить её от «столбца нет» иначе нечем — а это и есть проверяемая разница.
 */
function amountCell(displayNumber: string): string | null {
  const index = headers().indexOf('Сумма');
  if (index < 0) return null;
  const row = [...document.querySelectorAll('.ant-table-tbody tr.ant-table-row')].find((tr) =>
    tr.textContent?.includes(displayNumber),
  );
  if (!row) throw new Error(`строки ${displayNumber} в списке нет`);
  return row.querySelectorAll('td')[index]?.textContent ?? '';
}

describe('столбец «Сумма» и денежная строка карточки (§7.4.4, §7.4.6)', () => {
  it('у заявителя столбца нет вовсе', async () => {
    renderTab([REQUESTER], serviceCustomer());
    await screen.findByText('СО-14');

    expect(headers()).not.toContain('Сумма');
  });

  it('у «Ведения» столбец на месте и показывает итог по акту', async () => {
    renderTab([FINANCE], serviceOperator());
    await screen.findByText('СО-14');

    expect(headers()).toContain('Сумма');
    expect(amountCell('СО-14')).toMatch(/7\s?100,00/);
  });

  it('на телефоне денежной строки у заявителя нет', async () => {
    renderTab([REQUESTER], serviceCustomer(), MOBILE_VIEWPORT);
    await screen.findByText('СО-14');

    // Столбцов у карточки нет, ровнять между строками нечего: денежная строка решается аудиторией
    // самой заявки — редуцированная просто не показывает её, как не показывает заявка без сметы.
    expect(document.querySelector('.ant-table')).toBeNull();
    expect(screen.queryByText(/7\s?100,00/)).toBeNull();
  });

  it('на телефоне у «Ведения» денежная строка на месте', async () => {
    renderTab([FINANCE], serviceOperator(), MOBILE_VIEWPORT);

    expect(await screen.findByText(/7\s?100,00 ₽ по акту/)).toBeDefined();
  });

  it('в смешанной выдаче исполнителя столбец стабилен, а редуцированная строка молчит', async () => {
    renderTab([FINANCE, NEIGHBOUR], INHOUSE_EXECUTOR);
    await screen.findByText('СО-15');

    // Хоть одна финансовая строка — и столбец есть: снимать его из-за соседней редуцированной
    // значило бы прятать деньги назначенной заявки, которые исполнителю положены.
    expect(headers()).toContain('Сумма');
    expect(amountCell('СО-14')).toMatch(/7\s?100,00/);
    // Пусто, а не прочерк: «—» утверждало бы, что сметы у соседней заявки нет, — а она есть, просто
    // не для этого читателя (ADR 0160, решение 9).
    expect(amountCell('СО-15')).toBe('');
  });
});

describe('отбор «Ожидаются документы» (§7.4.5)', () => {
  it('заявителю не показывается ни отбором, ни очередью', async () => {
    renderTab([REQUESTER], serviceCustomer());
    await screen.findByText('СО-14');

    // Сервер этот параметр такому читателю молча игнорирует, и галочка, которая ставится и ничего
    // не меняет, читалась бы как поломка списка.
    expect(screen.queryByText('Ожидаются документы')).toBeNull();
  });

  it('«Ведению» отбор доступен', async () => {
    renderTab([FINANCE], serviceOperator());
    await screen.findByText('СО-14');

    expect(screen.getByRole('checkbox', { name: 'Ожидаются документы' })).toBeDefined();
  });
});
