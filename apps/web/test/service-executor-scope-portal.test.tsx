import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { AuthUser, ServiceRequestDto } from '@technic/contracts';
import { json, mockHttp, type HttpMock, type RouteMap } from './http';
import { renderWithUser } from './render';
import { emptyList, list } from './factories/common';
import { serviceInHouseExecutor, serviceRequest, serviceRequestFile } from './factories/service';
import { objectDto } from './factories/waste';
import { RequestsTab } from '../src/pages/service/RequestsTab';

/**
 * Портал не обещает того, чего сервер не даст: бывший исполнитель (план
 * `docs/office-equipment-free-estimate-and-executor-scope-plan.md`, Р7 и Р11; §7, Т23; ответ В11
 * заказчика от 09.09.2026 — «смотреть и писать в чат», остальное закрыто).
 *
 * КТО ТАКОЙ «БЫВШИЙ» ДЛЯ ПОРТАЛА. Признака «был назначен» в карточке нет и не заводится: след снятия
 * живёт на сервере и расширяет ОБЛАСТЬ ЧТЕНИЯ — заявка приезжает в список, потому что человека с
 * неё сняли. Портал же видит ровно два факта: в действующем составе исполнителей его нет и автором
 * он не был. Этого и хватает: `canActOnServiceRequest` отвечает «нет» именно по ним.
 *
 * ДВА ВАРИАНТА ЗАЯВКИ, И ВТОРОЙ ВАЖНЕЕ.
 *
 * - **чужая площадка** (`inCustomerScope: false`) — правку и удаление держит ещё и страж стороны
 *   заказчика: сузился бы портал и без общего сомножителя;
 * - **своя площадка** (`inCustomerScope: true`) — страж заказчика отвечает `true` (площадка
 *   действительно его), и удержать «Редактировать», «Удалить» и подшивку способен ТОЛЬКО общий
 *   предикат действия. Мимо этого случая прошла редакция 4 плана, и ловит его один этот сценарий.
 *
 * ЯКОРЬ КАЖДОГО ОТРИЦАНИЯ — ТА ЖЕ УЧЁТКА С ВЫКЛЮЧЕННЫМ РУБИЛЬНИКОМ. Выключенный ключ означает
 * сегодняшнее поведение буквально, и кнопки на месте; включённый их снимает. Без этой пары
 * «кнопки нет» доказывалось бы учёткой, у которой её не бывает вовсе.
 *
 * ЧТО ОСТАЁТСЯ ОТКРЫТЫМ И ПРОВЕРЯЕТСЯ ПОЛОЖИТЕЛЬНО: карточка, документы на чтение и переписка.
 * Область чтения шире области действий ровно на след снятия, и смешать их нельзя ни в одну сторону —
 * пустое меню у такого субъекта означало бы отнятую переписку по заявке, которую он видит.
 */

/** Рубильник сужения области исполнителя: включённым он приезжает списком `features` сессии. */
const SCOPE_FLAG = 'service_request_executor_scope';

/**
 * Сисадмин с включённым рубильником — тот самый «исполнительский профиль» (Р3): ИТ-набор и набор
 * исполнителя, «Ведения» нет, роль не `admin`.
 */
const FORMER: AuthUser = serviceInHouseExecutor({ features: [SCOPE_FLAG] });

/** Он же с выключенным рубильником: сегодняшнее поведение, к которому и приравнивается выпуск A. */
const TODAY: AuthUser = serviceInHouseExecutor();

const MESSAGES = 'GET /service-requests/:id/messages';
const READ = 'POST /service-requests/:id/messages/read';

/**
 * Заявка, с которой его сняли.
 *
 * Статус «Новая» без исполнителей выбран намеренно: это единственное состояние, в котором заявка
 * ещё ПРАВИТСЯ (`isServiceRequestEditable`), — а «Редактировать» и «Удалить» и есть та пара кнопок,
 * которую на своей площадке держит только общий предикат. Возьми сценарий «В работе», обе кнопки
 * пропали бы по статусу, и проверка была бы зелёной вхолостую.
 *
 * Ни в исполнителях, ни в авторах его нет: сторона `it` в сводке обсуждения — это ИТ-набор, а не
 * авторство (`customer` там стоит ровно у автора).
 */
function removedFrom(inCustomerScope: boolean): ServiceRequestDto {
  return serviceRequest({
    status: 'new',
    executors: [],
    inCustomerScope,
    files: [serviceRequestFile('act')],
    chat: {
      canWrite: true,
      participantSides: ['it'],
      mailEnabled: false,
      total: 3,
      unreadMine: 1,
      unreadOthers: false,
      lastSeq: 3,
      readThroughSeq: 2,
    },
  });
}

function renderTab(user: AuthUser, request: ServiceRequestDto, over: RouteMap = {}): HttpMock {
  const http = mockHttp({
    'GET /service-requests': () => json(list([request])),
    // Кандидаты в исполнители: маршрут описан раньше `:id`, иначе шаблон с параметром перехватил
    // бы и его.
    'GET /service-requests/executor-candidates': () => json(emptyList()),
    'GET /service-requests/:id': () => json(request),
    'GET /service-requests/:id/history': () => json([]),
    'GET /objects': () => json(list([objectDto()])),
    'GET /departments': () => json(emptyList()),
    'GET /counterparties': () => json(emptyList()),
    'GET /office-equipment': () => json(emptyList()),
    'GET /office-equipment-types': () => json(emptyList()),
    ...over,
  });
  renderWithUser(<RequestsTab />, { user });
  return http;
}

/** Подписи пунктов меню строки списка: последнее непрятанное меню — оно и открыто. */
async function rowMenuLabels(): Promise<string[]> {
  fireEvent.click(await screen.findByRole('button', { name: 'Действия' }));
  const menu = await waitFor(() => {
    const found = [...document.querySelectorAll<HTMLElement>('.ant-dropdown')]
      .filter((el) => !el.classList.contains('ant-dropdown-hidden'))
      .map((el) => el.querySelector<HTMLElement>('.ant-dropdown-menu'))
      .filter((el): el is HTMLElement => !!el)
      .at(-1);
    if (!found) throw new Error('меню действий не открылось');
    return found;
  });
  return [...menu.querySelectorAll('.ant-dropdown-menu-title-content')].map(
    (el) => el.textContent ?? '',
  );
}

/** Кнопка строки по её доступному имени: быстрые входы подписаны `aria-label`, а не текстом. */
const rowButton = (label: string): HTMLElement | undefined =>
  [...document.querySelectorAll<HTMLElement>('button')].find(
    (el) => el.getAttribute('aria-label') === label,
  );

/** Открытая карточка заявки. `null` — законный ответ: сценарий проверяет и то, что она открылась. */
function cardWrap(): HTMLElement | null {
  return (
    [...document.querySelectorAll<HTMLElement>('.ant-modal-wrap')]
      .filter((el) => el.style.display !== 'none')
      .find((el) => el.querySelector('.ant-modal-title')?.textContent === 'Заявка СО-14') ?? null
  );
}

async function openCard(): Promise<HTMLElement> {
  fireEvent.click(await screen.findByText('СО-14'));
  await screen.findByText('Заявка СО-14');
  const wrap = cardWrap();
  if (!wrap) throw new Error('карточка заявки не открылась');
  return wrap;
}

/** Подписи кнопок подвала карточки: по ним и видно, что она предлагает сделать. */
const footerLabels = (card: HTMLElement): string[] =>
  [...card.querySelectorAll('.ant-modal-footer button')].map((el) => el.textContent ?? '');

async function openDocuments(card: HTMLElement): Promise<void> {
  const tab = [...card.querySelectorAll<HTMLElement>('.ant-tabs-tab')].find(
    (el) => el.textContent === 'Документы',
  );
  if (!tab) throw new Error('вкладки «Документы» в карточке нет');
  fireEvent.click(tab);
  await waitFor(() => expect(card.textContent).toContain('act.pdf'));
}

/** Подписи кнопок карточки — ими и различаются «читать» и «править». */
const cardButtons = (card: HTMLElement): string[] =>
  [...card.querySelectorAll('button')].map((el) => el.textContent ?? '');

/**
 * Оба варианта заявки одним перечнем: сценарий пишется один раз и прогоняется по обоим.
 *
 * Отдельными сценариями, а не циклом внутри одного: упавший обязан сказать, на какой из двух заявок
 * портал пообещал лишнее, — а лечится это в разных местах.
 */
const VARIANTS = [
  { name: 'чужая площадка', inCustomerScope: false },
  { name: 'СВОЯ площадка', inCustomerScope: true },
] as const;

describe('бывший исполнитель: запрещённых кнопок нет ни на одной заявке (Т23, Р11)', () => {
  for (const variant of VARIANTS) {
    it(`меню строки — одно обсуждение: ${variant.name}`, async () => {
      renderTab(FORMER, removedFrom(variant.inCustomerScope));
      await screen.findByText('СО-14');

      const labels = await rowMenuLabels();
      /*
       * Обсуждение — якорь и предмет разом: меню открылось (иначе «пунктов нет» было бы зелёным на
       * неоткрывшемся меню), и вход в переписку у снятого исполнителя остался. Пустым набор здесь
       * быть не должен: закрой мы и его, человек потерял бы единственную дверь к разговору по
       * заявке, которую видит.
       */
      expect(labels).toContain('Обсуждение');
      expect(labels).not.toContain('Отложить');
      expect(labels).not.toContain('Возобновить');
      expect(labels).not.toContain('Редактировать');
      expect(labels).not.toContain('Удалить');
      expect(labels).not.toContain('Отменить заявку');
    });

    it(`быстрых входов в строке нет: ${variant.name}`, async () => {
      renderTab(FORMER, removedFrom(variant.inCustomerScope));
      await screen.findByText('СО-14');

      // Назначение вышло из меню быстрой кнопкой (Э5 плана меню), и снимать её обязан тот же
      // предикат: иначе действие, вычеркнутое из меню, осталось бы доступным рядом с ним.
      expect(rowButton('Назначить исполнителей')).toBeUndefined();
      expect(rowButton('Изменить исполнителей')).toBeUndefined();
      /*
       * Тег статуса — тоже вход в ход заявки (ADR 0161): у того, кому ходы закрыты, он обязан стать
       * простой пометкой. Строка при этом на месте — статус читается, просто не нажимается.
       */
      expect(rowButton('Изменить статус: Новая')).toBeUndefined();
      // Подпись тега в списке несёт ещё и возраст ожидания («Новая · 5 дн.»), поэтому по началу
      // строки, а не по точному совпадению.
      expect(screen.getAllByText(/^Новая/).length).toBeGreaterThan(0);
    });

    it(`карточка открывается, а действий в подвале нет: ${variant.name}`, async () => {
      renderTab(FORMER, removedFrom(variant.inCustomerScope));
      const card = await openCard();

      // Заявка ЧИТАЕТСЯ целиком: область чтения шире области действий ровно на след снятия.
      expect(within(card).getAllByText('Kyocera M3145').length).toBeGreaterThan(0);
      // Обсуждение живёт кнопкой подвала со счётчиком — она и остаётся единственным действием.
      expect(footerLabels(card)).toContain('Обсуждение · 3');
      expect(footerLabels(card)).not.toContain('Действия');
      expect(footerLabels(card)).not.toContain('Редактировать');
      // Кнопки у поля «Исполнители» тоже нет: назначение — распоряжение заявкой, а не её чтение.
      expect(cardButtons(card)).not.toContain('Назначить');
      expect(cardButtons(card)).not.toContain('Изменить');
    });

    it(`документы читаются, но не подшиваются и не снимаются: ${variant.name}`, async () => {
      renderTab(FORMER, removedFrom(variant.inCustomerScope));
      const card = await openCard();
      await openDocuments(card);

      /*
       * Подшивка и снятие — такие же изменяющие ручки, как правка и переходы, и сервер закрывает их
       * тем же общим входом. Без общего сомножителя вкладка показала бы форму загрузки и «Удалить»
       * у каждой бумаги, а сервер ответил бы 403 на каждый файл.
       */
      expect(cardButtons(card)).not.toContain('Подшить документ');
      expect(cardButtons(card)).not.toContain('Удалить');
      // Сама бумага при этом видна и открывается: закрыта запись, а не чтение.
      expect(card.textContent).toContain('act.pdf');
    });

    it(`переписка открывается и читается: ${variant.name}`, async () => {
      renderTab(FORMER, removedFrom(variant.inCustomerScope), {
        [MESSAGES]: () =>
          json({
            items: [
              {
                id: 'm-1',
                seq: 3,
                authorId: 'user-77',
                authorName: 'Другов Д. Д.',
                origin: 'chat',
                body: 'аппарат увезли в сервис',
                createdAt: '2026-09-09T10:00:00.000Z',
                addressees: { sides: ['all'], users: [] },
              },
            ],
            hasMore: false,
            lastSeq: 3,
            readThroughSeq: 2,
          }),
        [READ]: () => json({ readThroughSeq: 3, lastSeq: 3 }),
      });
      await screen.findByText('СО-14');

      fireEvent.click(await screen.findByRole('button', { name: 'Действия' }));
      fireEvent.click(await screen.findByText('Обсуждение'));

      /*
       * Ответ В11 целиком: заявку снятый исполнитель видит и в переписке участвует. Проверяется
       * именно ЛЕНТА, а не наличие пункта: закройся окно отказом, пункт остался бы на месте и
       * сценарий выше был бы зелёным.
       */
      expect(await screen.findByText('аппарат увезли в сервис')).toBeDefined();
    });
  }
});

/**
 * Т23, вторая половина: тот же субъект с ВЫКЛЮЧЕННЫМ ключом.
 *
 * Это и есть доказательство, что кнопки снял рубильник, а не отсутствие прав у фикстуры. Здесь же
 * видно, зачем нужны два варианта заявки: на СВОЕЙ площадке страж стороны заказчика отвечает «да» —
 * правку и удаление он не удержит ни при включённом ключе, ни при выключенном, — и разница между
 * двумя прогонами держится ровно на общем предикате действия.
 */
describe('выключенный ключ — сегодняшнее поведение (Т23, якорь Р4)', () => {
  it('на своей площадке кнопки правки и удаления есть: их снимает именно рубильник', async () => {
    renderTab(TODAY, removedFrom(true));
    await screen.findByText('СО-14');

    const labels = await rowMenuLabels();
    expect(labels).toContain('Редактировать');
    expect(labels).toContain('Удалить');
    // И ходы заявки на месте: набор действий у такого субъекта сегодня непустой.
    expect(labels).toContain('Отложить');
    expect(rowButton('Назначить исполнителей')).toBeDefined();
  });

  it('на чужой площадке правки нет и сегодня: её держит страж стороны заказчика', async () => {
    /*
     * Ровно то, ради чего вариантов два. Здесь сужение обеспечивает СОСЕДНИЙ предикат
     * (`canChangeRequestAsCustomer`: своя область либо своё авторство), и общий сомножитель ничего
     * не добавляет. Прогони мы Т23 на одной этой заявке — дефект «портал обещает правку на своей
     * площадке» остался бы незамеченным.
     */
    renderTab(TODAY, removedFrom(false));
    await screen.findByText('СО-14');

    const labels = await rowMenuLabels();
    expect(labels).not.toContain('Редактировать');
    expect(labels).not.toContain('Удалить');
    // Якорь: остальные действия при выключенном ключе на месте — меню открылось и непусто.
    expect(labels).toContain('Отложить');
  });

  it('подшивка документов при выключенном ключе доступна — включённый её и снимает', async () => {
    renderTab(TODAY, removedFrom(false));
    const card = await openCard();
    await openDocuments(card);

    expect(cardButtons(card)).toContain('Подшить документ');
    expect(cardButtons(card)).toContain('Удалить');
  });
});
