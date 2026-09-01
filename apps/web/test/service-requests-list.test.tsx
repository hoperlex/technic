import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { AuthUser, ServiceRequestDto } from '@technic/contracts';
import { json, mockHttp, type HttpMock, type RouteMap } from './http';
import { renderWithUser } from './render';
import { emptyList, list } from './factories/common';
import {
  assignedServiceRequest,
  estimatePendingServiceRequest,
  heldServiceRequest,
  serviceCustomer,
  serviceExecutor,
  serviceInHouseExecutor,
  serviceOperator,
  serviceRequest,
  serviceRequestFile,
} from './factories/service';
import { objectDto, operator } from './factories/waste';
import { selectOption } from './antd';
import { RequestsTab } from '../src/pages/service/RequestsTab';

/**
 * Список заявок на обслуживание оргтехники (ADR 0085): ролевые наборы колонок, объединённый
 * столбец состояния и действия, построенные из коридора переходов.
 *
 * Проверяется именно связка «субъект → коридор → кнопка». Ошибка здесь тестом не падает: у
 * оператора появляется действие исполнителя (кнопка, ведущая в 403), а у исполнителя пропадает
 * его собственный шаг — и обнаруживают это люди, а не сборка. Субъекта два, потому что коридоров
 * три и различают их не роли: оператор оргтехники — надстройка над штабом (ADR 0086), сервис —
 * тип контрагента (ADR 0038).
 */

const OPERATOR: AuthUser = serviceOperator();
const EXECUTOR: AuthUser = serviceExecutor();
/** Свой сисадмин: ходы исполнителя ему открывает поимённая строка, а не право (Н5). */
const IN_HOUSE: AuthUser = serviceInHouseExecutor();
/** Заказчик: тот же штаб, но без надстройки — шага в цикле у него нет вовсе (Р102). */
const CUSTOMER: AuthUser = serviceCustomer();

function renderTab(user: AuthUser, items: ServiceRequestDto[], over: RouteMap = {}): HttpMock {
  const http = mockHttp({
    'GET /service-requests': () => json(list(items)),
    // Справочники фильтров: объекты и отделы видны обеим сторонам, перечень оргтехники — только
    // тому, у кого есть право справочника (сервису он закрыт, Р7).
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

/** Меню действий строки: на десктопе оно за кнопкой «Действия» в колонке действий. */
async function openRowActions(): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: 'Действия' }));
}

/** Подписи пунктов меню строки — по ним и видно, что заявке разрешено (Р110). */
async function rowActionLabels(): Promise<string[]> {
  await openRowActions();
  const menu = await waitFor(() => {
    const found = document.querySelector('.ant-dropdown-menu');
    if (!found) throw new Error('меню действий не открылось');
    return found;
  });
  return [...menu.querySelectorAll('.ant-dropdown-menu-title-content')].map(
    (el) => el.textContent ?? '',
  );
}

/**
 * Есть ли на экране такой текст. Именно «есть», а не «ровно один»: закреплённую шапку таблицы
 * antd рисует дважды — видимой строкой и скрытой мерной, — и точный поиск падал бы на любом
 * заголовке колонки, ничего не сообщая о самой колонке.
 */
const shown = (text: string) => screen.queryAllByText(text).length > 0;

/** Заголовки открытых окон: по ним и проверяется, куда привела подпись состояния (Р117). */
function openModalTitles(): string[] {
  return [...document.querySelectorAll<HTMLElement>('.ant-modal-wrap')]
    .filter((wrap) => wrap.style.display !== 'none')
    .map((wrap) => wrap.querySelector('.ant-modal-title')?.textContent ?? '');
}

/** Ссылка ли подпись состояния: `Typography.Link` рисует `<a>`, обычный текст — `<span>`. */
const statusLink = (text: string): HTMLElement | null =>
  screen.getByText(text).closest('a') as HTMLElement | null;

describe('список заявок на обслуживание: колонки по ролям', () => {
  it('оператор видит исполнителя, документы и один столбец состояния', async () => {
    renderTab(OPERATOR, [serviceRequest()]);
    expect(await screen.findByText('СО-14')).toBeDefined();
    // Колонка называет обоих исполнителей — компанию и своих сотрудников (Н5), поэтому она уже не
    // «Сервис».
    expect(shown('Исполнители')).toBe(true);
    expect(shown('Документы')).toBe(true);
    expect(shown('Статус')).toBe(true);
    /*
     * Три колонки про одно и то же сведены в одну (Р100): прежние «Ждёт» и «От вас требуется»
     * отвечали на тот же вопрос, что и статус, а читались как три разных факта. «Срок» ушёл вместе
     * с самим полем (Р115).
     */
    expect(shown('От вас требуется')).toBe(false);
    expect(shown('Срок')).toBe(false);
    /*
     * Колонка «Ждёт» на экране есть, но это уже НЕ прежняя «кого ждут»: она меряет возраст
     * ТЕКУЩЕГО ОЖИДАНИЯ (Р4), и подписана так именно потому, что «В статусе» после Р1 неправда —
     * назначение, предъявление объёма работ и согласование ожидание начинают заново, статуса не
     * трогая. Проверяется поэтому не заголовок, а содержимое: в клетке возраст, а не сторона.
     */
    expect(shown('Ждёт')).toBe(true);
    expect(shown('Ждёт оператора')).toBe(false);
    expect(shown('В статусе')).toBe(false);
  });

  it('исполнитель видит объект, контакт и свой следующий шаг подписью статуса', async () => {
    // «Назначенная» — это «Новая» с исполнителями (Р1, Р2): статуса `assigned` больше нет.
    renderTab(EXECUTOR, [assignedServiceRequest()]);
    expect(await screen.findByText('СО-14')).toBeDefined();
    expect(shown('Объект')).toBe(true);
    expect(shown('Контакт')).toBe(true);
    // Шаг живёт второй строкой столбца состояния, а не своей колонкой: подпись одна на все стороны
    // и лицо ей меняет только префикс (Р101).
    expect(shown('Вам: принять в работу')).toBe(true);
    // Сумма и документы — вопросы заказчика и оператора, исполнителю в списке они не нужны.
    expect(shown('Документы')).toBe(false);
  });
});

/**
 * Столбец состояния по строкам (§4 плана, Р100–Р102).
 *
 * Одна и та же заявка подписана трижды по-разному, и это главное в столбце: лицо меняет подпись,
 * а сам шаг остаётся тем, что задан статусом. Ошибка здесь молчалива — заметная строка «Вам: …» у
 * того, кто ждёт чужого хода, читается как требование к нему.
 */
describe('столбец состояния подписан лицом смотрящего', () => {
  // «Диагностики» больше нет (Н2): взявшаяся за работу заявка стоит в «В работе» — одно состояние
  // и у ремонта, и у расходников.
  const inWork = () => serviceRequest({ status: 'in_work' });

  it('исполнителю в «В работе» — его собственный шаг', async () => {
    renderTab(EXECUTOR, [inWork()]);
    await screen.findByText('СО-14');
    expect(shown('Вам: выполнить и закрыть работы')).toBe(true);
  });

  it('оператору та же заявка говорит, что ход не за ним', async () => {
    renderTab(OPERATOR, [inWork()]);
    await screen.findByText('СО-14');
    // «Ждёт исполнителя», а не «Ждёт сервис»: исполнителем теперь бывает и свой сотрудник (Н5).
    expect(shown('Ждёт исполнителя')).toBe(true);
    expect(shown('Вам: выполнить и закрыть работы')).toBe(false);
  });

  it('заказчику подпись всегда чужая: шага в цикле у него нет', async () => {
    // Ход за оператором, а не за сервисом: даже там, где решение принимает «своя» сторона
    // заказчика, `SERVICE_WAITING_ON` его не знает — строка остаётся серой (Р102).
    // Статус — нераспределённая «Новая»: прежняя «Согласована ИТ» мёртвая (0197), а заявок в
    // мёртвом статусе не бывает — очередь ответила бы «Ждёт оператора» по строке истории.
    renderTab(CUSTOMER, [serviceRequest()]);
    await screen.findByText('СО-14');
    expect(shown('Ждёт оператора')).toBe(true);
    expect(statusLink('Ждёт оператора')).toBeNull();
    expect(screen.queryByText(/^Вам: /)).toBeNull();
  });

  it('у принятой заявки подписи нет вовсе: ждать в ней нечего', async () => {
    renderTab(OPERATOR, [serviceRequest({ status: 'accepted' })]);
    await screen.findByText('СО-14');
    expect(screen.queryByText(/^Вам: /)).toBeNull();
    expect(shown('Закрыта')).toBe(false);
  });

  /**
   * Отложенная подписана одинаково всем: заморозку не ждёт никто (Р111), а «Отложена» без причины
   * сообщала бы факт, не отвечая, чего ждать и сколько (Р107). Три отдельных сценария, а не цикл
   * внутри одного: упавший расскажет, у какой именно стороны подпись разошлась.
   */
  const expectHeldLine = async (user: AuthUser) => {
    renderTab(user, [heldServiceRequest('diagnostics')]);
    await screen.findByText('СО-14');
    expect(shown('Отложена: ждём запчасть от поставщика')).toBe(true);
    // Ход не за смотрящим ни у кого: подпись заморозки — обычный текст (Р117).
    expect(statusLink('Отложена: ждём запчасть от поставщика')).toBeNull();
  };

  it('отложенная подписана причиной у оператора', async () => {
    await expectHeldLine(OPERATOR);
  });

  it('та же подпись у исполнителя', async () => {
    await expectHeldLine(EXECUTOR);
  });

  it('та же подпись у заказчика', async () => {
    await expectHeldLine(CUSTOMER);
  });
});

/**
 * Р117: подпись «Вам: …» ведёт туда же, куда одноимённый пункт меню.
 *
 * Проверяется не наличие ссылки, а то, что за ней открывается: действие берётся признаком
 * `primary` у пункта меню, а не второй картой «статус → окно», и разойтись с коридором оно не
 * может. Второй картой это и разошлось бы — строка звала бы к действию, которого в меню нет.
 */
describe('подпись состояния ведёт в действие (Р117)', () => {
  it('«Вам: назначить исполнителей» открывает окно назначения — то же, что и пункт меню', async () => {
    renderTab(OPERATOR, [serviceRequest()]);
    await screen.findByText('СО-14');
    // Тот же ход есть и в меню строки: подпись обещает ровно его.
    expect(await rowActionLabels()).toContain('Назначить исполнителей');
    fireEvent.keyDown(document.body, { key: 'Escape' });

    const link = statusLink('Вам: назначить исполнителей');
    expect(link).not.toBeNull();
    fireEvent.click(link!);

    // Ровно одно окно: клик по ссылке не всплывает до строки, иначе окно действия открылось бы
    // под карточкой заявки (Р117). Заголовок тот же, что и подпись пункта: исполнителей с волны В6
    // выбирают одним полем — и своих поимённо, и сервисную компанию строкой (Н5, Н6).
    await waitFor(() => expect(openModalTitles()).toEqual(['Назначить исполнителей']));
  });

  it('«Вам: нужен закрывающий документ» ведёт в окно приёмки, где бумагу и подшивают (Р120)', async () => {
    // Заявка сервисной компании: после Н8 бумага обязательна только ей, и подпись про документ
    // появляется ровно у такой заявки — у инхаус-ремонта её нет и быть не должно.
    renderTab(OPERATOR, [
      serviceRequest({ status: 'done', service: { id: 'cp-1', name: 'Сервис-Про' } }),
    ]);
    await screen.findByText('СО-14');

    const link = statusLink('Вам: нужен закрывающий документ');
    expect(link).not.toBeNull();
    fireEvent.click(link!);

    // Второго адреса у этого шага нет: подпись ведёт туда же, куда «Принять работу».
    await waitFor(() => expect(openModalTitles()).toEqual(['Принять работу СО-14']));
  });

  it('шаг без окна уходит на сервер сразу — как и одноимённый пункт меню', async () => {
    const http = renderTab(EXECUTOR, [assignedServiceRequest()], {
      'PATCH /service-requests/:id/start': () => json(serviceRequest({ status: 'in_work' })),
    });
    await screen.findByText('СО-14');

    fireEvent.click(statusLink('Вам: принять в работу')!);

    // «Принять в работу» — единственное действие без содержания: подтверждать нечего, и второе
    // поведение у той же дуги было бы расхождением подписи с меню (§8 плана).
    await waitFor(() => expect(http.countOf('PATCH /service-requests/:id/start')).toBe(1));
  });

  it('чужой ход подписан текстом, а не ссылкой', async () => {
    renderTab(OPERATOR, [serviceRequest({ status: 'in_work' })]);
    await screen.findByText('СО-14');
    // Ход за исполнителем: у оператора пункта меню для него нет — и звать некуда.
    expect(statusLink('Ждёт исполнителя')).toBeNull();
  });
});

/**
 * Ячейка документов (Р112, Н8): чем работа закрыта и чего не хватает.
 *
 * Планка одна на всё — хватает любого закрывающего документа, — поэтому перечня недостающих видов
 * у портала больше нет: три тега «нет: акт / нет: счёт / нет: талон» читались бы как «нужны все
 * три», хотя запирает переход отсутствие сразу всех.
 *
 * Спрашивается она только у того, кому бумага **положена** (`serviceRequestNeedsClosingDocument`):
 * платят за работу внешнего сервиса, и основание платежа — документ. У инхаус-ремонта его не
 * требует ни сервер, ни автозакрытие, и красный тег на такой заявке висел бы вечно, требуя
 * бумагу, которой неоткуда взяться.
 */
describe('ячейка документов', () => {
  it('подшитые виды показаны тегами, красного среди них нет', async () => {
    renderTab(OPERATOR, [
      serviceRequest({
        status: 'done',
        files: [serviceRequestFile('act'), serviceRequestFile('invoice')],
      }),
    ]);
    await screen.findByText('СО-14');

    expect(shown('Акт')).toBe(true);
    expect(shown('Счёт')).toBe(true);
    expect(shown('нет закрывающих')).toBe(false);
  });

  it('отсутствие всех трёх — один красный тег, а не три «нет: …»', async () => {
    // Заявка сервисной компании: только ей документ и обязателен (Н8).
    renderTab(OPERATOR, [
      serviceRequest({ status: 'done', files: [], service: { id: 'cp-1', name: 'КопиЛайт' } }),
    ]);
    await screen.findByText('СО-14');

    expect(screen.getAllByText('нет закрывающих')).toHaveLength(1);
    expect(screen.queryByText(/^нет: /)).toBeNull();
    expect(shown('Акт')).toBe(false);
    expect(shown('Счёт')).toBe(false);
    expect(shown('Гарантийный талон')).toBe(false);
  });

  it('своему сисадмину бумага не нужна: красного тега у инхаус-ремонта нет', async () => {
    // Тот же статус и те же пустые документы, но исполнитель свой — платить некому, и требовать
    // основание платежа не с кого. Сервер такую заявку закрывает и без бумаги, а автозакрытие
    // берёт её наравне с остальными.
    renderTab(OPERATOR, [serviceRequest({ status: 'done', files: [], service: null })]);
    await screen.findByText('СО-14');

    expect(shown('нет закрывающих')).toBe(false);
  });
});

/*
 * Три сценария про визу ИТ («на „Новой“ решения ИТ не предлагают», «на смете решение ИТ предлагают»
 * и «подписанную смету ИТ второй раз не визирует») удалены целиком вместе с самой визой (Р10):
 * ручки `PATCH /:id/it-approval` нет, фичи `it-approval` нет, `SERVICE_IT_TRANSITIONS` пуста, а
 * пункта «Решение ИТ по смете» портал не рисует ни в одном статусе. Проверять там нечего:
 * переписанные «на отсутствие пункта», они были бы зелёными при любой поломке — искали бы то, чего
 * нет в коде вовсе. Подпись под объёмом работ теперь одна, и её сторону держит
 * `canApproveServiceEstimate` — она и проверяется ниже.
 */
describe('действия ищутся предикатами, а не дугами (Р11)', () => {
  it('оператору «Новая» предлагает распределение — и ничего чужого', async () => {
    renderTab(OPERATOR, [serviceRequest()]);
    await openRowActions();
    expect(await screen.findByText('Назначить исполнителей')).toBeDefined();
    expect(screen.getByText('Отменить заявку')).toBeDefined();
    // Шаги исполнителя оператору недоступны ни через портал, ни через сервер: их открывает факт
    // назначения, а у нераспределённой заявки назначенных нет (Р6).
    expect(screen.queryByText('Принять в работу')).toBeNull();
  });

  it('назначение видно по составу исполнителей, а не по статусу: второе — уже переназначение', async () => {
    // Заявка та же «Новая», разница только в исполнителях — и она одна меняет подпись пункта
    // (`serviceIsFirstAssignment`, Р11). Прежде на этот же вопрос отвечал статус `assigned`.
    renderTab(OPERATOR, [assignedServiceRequest()]);
    const labels = await rowActionLabels();
    expect(labels).toContain('Изменить исполнителей');
    expect(labels).not.toContain('Назначить исполнителей');
  });

  it('висящее предъявление запирает переназначение, хотя статус тот же «В работе»', async () => {
    // Прежде запрет держал статус «Смета на согласовании» — пустая строка коридора. Статуса нет, и
    // запрет живёт в самом предикате (`canAssignServiceExecutors`): цифры предъявленного объёма
    // принадлежат прежнему исполнителю, и переданная заявка оставила бы новому чужой счёт.
    renderTab(OPERATOR, [
      estimatePendingServiceRequest({ service: { id: 'cp-1', name: 'КопиЛайт' } }),
    ]);
    const labels = await rowActionLabels();
    expect(labels).not.toContain('Изменить исполнителей');
    expect(labels).not.toContain('Назначить исполнителей');
  });

  it('согласование объёма работ предлагают, пока предъявление висит', async () => {
    // Основание — колонка `estimatePendingRevision`, а не статус (Р2, Р8): исходов у согласования
    // два, и оба стоят пунктами — «Согласовано» статуса не меняет, отказ уводит в «Отменена».
    renderTab(OPERATOR, [estimatePendingServiceRequest()]);
    const labels = await rowActionLabels();
    expect(labels).toContain('Согласовать объём работ');
    expect(labels).toContain('Не согласовать объём работ');
  });

  it('погашенное предъявление согласования не предлагает: отвечать не на что', async () => {
    // Та же заявка и тот же статус, разница ровно в `estimatePendingRevision`: `null` значит
    // «ответ получен либо предъявление отозвано». Пара с предыдущим сценарием и держит утверждение
    // «основание — колонка, а не статус».
    renderTab(OPERATOR, [estimatePendingServiceRequest({ estimatePendingRevision: null })]);
    const labels = await rowActionLabels();
    expect(labels).not.toContain('Согласовать объём работ');
    expect(labels).not.toContain('Не согласовать объём работ');
  });

  it('исполнителю назначенная заявка предлагает работу и отказ, но не распределение', async () => {
    renderTab(EXECUTOR, [assignedServiceRequest()]);
    await openRowActions();
    expect(await screen.findByText('Принять в работу')).toBeDefined();
    expect(screen.getByText('Отказаться от заявки')).toBeDefined();
    expect(screen.queryByText('Назначить исполнителей')).toBeNull();
    expect(screen.queryByText('Отменить заявку')).toBeNull();
  });

  /**
   * Р6: «Принять в работу» вышло из меню быстрой кнопкой прямо в строку списка — очередь
   * «назначено, но никто не взялся» жила ровно на том, что ради одного нажатия открывали меню.
   *
   * Проверяется не наличие кнопки, а её основание: рисуется она пунктом `start` набора действий,
   * и у того, кому пункт не положен, её нет вовсе. Спроси ячейка сама, кому «принять» разрешено,
   * это была бы вторая карта правил.
   */
  it('быстрая кнопка «Принять в работу» видна назначенному — и только ему', async () => {
    const http = renderTab(EXECUTOR, [assignedServiceRequest()], {
      'PATCH /service-requests/:id/start': () => json(serviceRequest({ status: 'in_work' })),
    });
    const button = await screen.findByRole('button', { name: 'Принять в работу' });

    fireEvent.click(button);
    await waitFor(() => expect(http.countOf('PATCH /service-requests/:id/start')).toBe(1));
  });

  it('оператору быстрой кнопки нет: ход не его, хотя заявка та же', async () => {
    renderTab(OPERATOR, [assignedServiceRequest()]);
    await screen.findByText('СО-14');
    expect(screen.queryByRole('button', { name: 'Принять в работу' })).toBeNull();
  });

  /*
   * Основание кнопки — назначение, а не право, и видно это на СВОЁМ сисадмине: `execute` у него
   * есть на любой заявке, а поимённой строки нет. У оператора контрагента-сервиса эта разница не
   * проверяема вовсе — портал считает его назначенным по типу контрагента
   * (`serviceExecutorAssignment`), потому что `counterpartyId` в `AuthUser` не приезжает, а
   * нераспределённую заявку сервис и не видит (`assertExecutorScope`).
   */
  it('своему сисадмину кнопка есть, когда он в исполнителях', async () => {
    renderTab(IN_HOUSE, [assignedServiceRequest()]);
    expect(await screen.findByRole('button', { name: 'Принять в работу' })).toBeDefined();
  });

  it('и пропадает, когда назначен не он: право `execute` осталось прежним', async () => {
    renderTab(IN_HOUSE, [
      assignedServiceRequest({
        executors: [
          { userId: 'user-other', name: 'Сервисов С. С.', assignedAt: '2026-08-05T10:00:00.000Z' },
        ],
      }),
    ]);
    await screen.findByText('СО-14');
    expect(screen.queryByRole('button', { name: 'Принять в работу' })).toBeNull();
  });
});

/**
 * Исполнители одним полем (Н5, Н6).
 *
 * Проверяется стык, который иначе виден только в сети: в списке лежат два вида строк — сотрудники
 * поимённо и сервисные компании, — а сервер принимает их **разными полями** одного тела. Спутай
 * портал слои, и компания уехала бы идентификатором учётки: 422 с чужим текстом вместо назначения.
 */
describe('назначение исполнителей', () => {
  it('сервисная компания уходит контрагентом, а поимённый список остаётся пустым', async () => {
    const http = renderTab(OPERATOR, [serviceRequest()], {
      'GET /counterparties': () =>
        json(list([operator({ id: 'cp-9', name: 'КопиЛайт', type: 'service' })])),
      'PUT /service-requests/:id/executors': () =>
        json({ request: assignedServiceRequest(), mail: 'queued' }),
    });
    await screen.findByText('СО-14');
    await openRowActions();
    fireEvent.click(await screen.findByText('Назначить исполнителей'));

    await selectOption('Исполнители', 'КопиЛайт');
    fireEvent.click(screen.getByRole('button', { name: 'Назначить' }));

    await waitFor(() => expect(http.countOf('PUT /service-requests/:id/executors')).toBe(1));
    const body = http.lastCall('PUT /service-requests/:id/executors')?.body as Record<
      string,
      unknown
    >;
    // Компания — контрагентом целиком (Н5): её сотрудников портал не перечисляет вовсе.
    expect(body.serviceCounterpartyId).toBe('cp-9');
    expect(body.userIds).toEqual([]);
    // Первое назначение причины не требует — её спрашивают, когда работу у кого-то отбирают.
    expect(body.reason).toBeUndefined();
  });
});

/**
 * Приём заявки и срочность (план модернизации, Р49, Р56, Р57).
 *
 * Проверяется то, что раньше зависело от роли смотрящего: объект видел только исполнитель, а
 * признака срочности не было вовсе. Оба ответа — про список, а не про сервер: сервер эти поля
 * отдаёт всем, и потерять их можно ровно здесь.
 */
describe('объект и срочность в списке', () => {
  it('объект виден и заказчику, и оператору — колонка перестала быть набором исполнителя', async () => {
    renderTab(OPERATOR, [serviceRequest()]);
    await screen.findByText('СО-14');
    expect(shown('Объект')).toBe(true);
    // Место внутри объекта — подписью под ним: по нему едет мастер.
    expect(shown('Корпус 3, каб. 214')).toBe(true);
  });

  it('срочная заявка помечена в списке, обычная — нет', async () => {
    renderTab(OPERATOR, [
      serviceRequest({ isUrgent: true, urgencyReason: 'Единственный принтер на площадке' }),
    ]);
    expect(await screen.findByText('СО-14')).toBeDefined();
    expect(shown('Срочная')).toBe(true);
  });

  it('оператор ставит и снимает срочность, исполнитель — не трогает вовсе', async () => {
    renderTab(OPERATOR, [assignedServiceRequest()]);
    await openRowActions();
    // Срочность — не переход: она доступна оператору и после назначения сервиса.
    expect(await screen.findByText('Отметить срочной')).toBeDefined();
  });

  it('исполнителю срочности не предлагают: признак заказывающей стороны', async () => {
    renderTab(EXECUTOR, [assignedServiceRequest()]);
    await openRowActions();
    await screen.findByText('Принять в работу');
    expect(screen.queryByText('Отметить срочной')).toBeNull();
    expect(screen.queryByText('Снять срочность')).toBeNull();
  });

  it('заказчику срочности не предлагают: у него право правки, но не право срочности', async () => {
    // Пункт спрашивал `serviceRequests.update` — право ПРАВКИ, которое у заявителя на своей «Новой»
    // есть, — а ручка закрыта отдельным `serviceRequests.urgency`, которого у него нет. Портал
    // предлагал действие, на которое сервер отвечает 403. Прежние случаи этого не ловили: они
    // проверяли оператора (право есть) и исполнителя (ему пункт закрыт другой веткой).
    renderTab(CUSTOMER, [serviceRequest()]);
    await openRowActions();
    expect(screen.queryByText('Отметить срочной')).toBeNull();
    expect(screen.queryByText('Снять срочность')).toBeNull();
  });

  it('у помеченной заявки действие называется снятием', async () => {
    renderTab(OPERATOR, [serviceRequest({ isUrgent: true, urgencyReason: 'встала бухгалтерия' })]);
    await openRowActions();
    expect(await screen.findByText('Снять срочность')).toBeDefined();
  });

  it('фильтр «Только срочные» уходит на сервер признаком', async () => {
    const http = renderTab(OPERATOR, [serviceRequest()]);
    await screen.findByText('СО-14');
    fireEvent.click(screen.getByLabelText('Только срочные'));
    await screen.findByText('СО-14');
    expect(http.lastCall('GET /service-requests')?.query.get('urgent')).toBe('true');
  });

  it('фильтра «Просроченные» в шите больше нет: он ушёл вместе с полем срока (Р115)', async () => {
    renderTab(OPERATOR, [serviceRequest()]);
    await screen.findByText('СО-14');
    expect(screen.queryByLabelText('Просроченные')).toBeNull();
    // Отбор по статусу при этом перечисляет коридор целиком — «Отложена» появилась в нём сама.
    expect(shown('Только срочные')).toBe(true);
  });
});

describe('очереди-пресеты', () => {
  /**
   * Пресет — переключатель над таблицей, а не одноимённый флажок в шите фильтров: у «Ожидаются
   * документы» есть и то и другое, и поиск по тексту брал бы то из них, что попадётся первым.
   */
  const openQueue = (label: string) => {
    const item = document.querySelector<HTMLElement>(`.ant-segmented-item-label[title="${label}"]`);
    if (!item) throw new Error(`пресета «${label}» над таблицей нет`);
    fireEvent.click(item);
  };

  it('«Требуют решения» спрашивает у сервера только ждущие меня заявки', async () => {
    const http = renderTab(OPERATOR, [serviceRequest()]);
    await screen.findByText('СО-14');
    openQueue('Требуют решения');
    await screen.findByText('СО-14');
    const last = http.lastCall('GET /service-requests');
    expect(last?.query.get('waitingOnMe')).toBe('true');
    // Порядок по умолчанию — возраст в статусе: список открывают вопросом «что стоит дольше всех».
    expect(last?.query.get('sortBy')).toBe('statusChangedAt');
    expect(last?.query.get('sortOrder')).toBe('asc');
  });

  it('«Ожидаются документы» спрашивает ровно то, что нельзя принять (Р114)', async () => {
    const http = renderTab(OPERATOR, [serviceRequest({ status: 'done' })]);
    await screen.findByText('СО-14');
    openQueue('Ожидаются документы');
    expect(http.lastCall('GET /service-requests')?.query.get('awaitingDocuments')).toBe('true');
    // Прежний признак «просрочена» на сервер больше не уходит ни при каком наборе фильтров.
    expect(http.lastCall('GET /service-requests')?.query.get('overdue')).toBeNull();
  });
});
