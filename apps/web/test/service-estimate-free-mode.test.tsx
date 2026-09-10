import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { AuthUser, ServiceRequestDto, ServiceRequestItemDto } from '@technic/contracts';
import { json, mockHttp, type HttpMock, type RouteMap } from './http';
import { renderWithUser } from './render';
import { SERVICE_COUNTERPARTY, serviceExecutor, serviceRequest } from './factories/service';
import { EstimateEditorModal } from '../src/features/estimate-editor';

/**
 * Свободный ввод объёма работ и односторонняя конвертация режимов (план
 * `docs/office-equipment-free-estimate-and-executor-scope-plan.md`, Р1 и Р8; §7, Т2 и Т3; ответы В1
 * и В10 заказчика от 09.09.2026).
 *
 * ЧТО ЗДЕСЬ ДОКАЗЫВАЕТСЯ. Свободная запись — это РЕЖИМ ВВОДА, а не второй вид документа: на сервер
 * из него уходит обычная строка `kind = service`, `quantity = 1`, `unitPrice` = общая стоимость, и
 * признака формата в теле запроса нет вовсе. Проверяется именно тело `PUT /:id/estimate`: покажи
 * окно два поля, а отправь что-нибудь своё — итог, согласование, акт и реестр гарантий читали бы не
 * то, что человек видел на экране.
 *
 * ВТОРАЯ ПОЛОВИНА — ЗАМОК НА ОБРАТНОЙ ДОРОГЕ. Разворачивание свободной записи в графы не теряет
 * ничего и открыто всегда; склейка графов в одну запись теряет виды, количества, цены и гарантии, и
 * потому запрещена всюду, кроме единственной услуги количеством один без гарантии. Каждый из
 * четырёх запретов проверяется отдельным случаем: сложенные в один сценарий, они оставили бы
 * зелёным окно, которое запирает переключатель по какой-нибудь одной причине из четырёх.
 *
 * ТРЕТЬЯ ПОЛОВИНА — ЧЕРНОВИК И НОЛЬ (дефект Д1, найденный этой же волной тестов и починенный).
 * «Стоимость обязательна» держится только тогда, когда её нельзя обойти в два шага: описание,
 * сохранённое черновиком без цены, ложилось в базу нулём, а при следующем открытии ноль приезжал
 * готовым значением и предъявлялся молча. Отсюда три вопроса, которые сценарии ниже задают порознь:
 * что черновик отказывается уносить, что он по-прежнему уносить обязан (пустой объём работ —
 * законное состояние) и куда попадает ревизия, у которой ноль уже сохранён.
 *
 * ОКНО РЕНДЕРИТСЯ НАПРЯМУЮ, без списка и карточки: предмет проверки — состав, который уходит на
 * сервер, и путь до кнопки «Объём работ» к нему ничего не добавляет (тем же приёмом собран соседний
 * `service-estimate-decision.test.tsx`).
 */

/** Исполнитель: объём работ набирает он — окно и заведено ради стороны сервиса. */
const EXECUTOR: AuthUser = serviceExecutor();

/** Перечень из письма подрядчика (§1 плана): пять строк с количествами и одна сумма на всё. */
const LETTER =
  'Ремонт МФУ (RICOH MP C 2011, № 86228) ЖК ПРИМАВЕРА штаб, 1 шт;\n' +
  'Узел фотобарабана в сборе MP C2003SP, 2 шт;\n' +
  'Блок проявки в сборе чёрный, 1 шт';

/** Общая стоимость заказа из того же письма: цены по позициям в нём не разложены вовсе. */
const TOTAL = 70455;

function estimateItem(over: Partial<ServiceRequestItemDto> = {}): ServiceRequestItemDto {
  return {
    id: 'sri-1',
    kind: 'service',
    name: 'Замена узла подачи',
    quantity: 1,
    unitPrice: 1800,
    amount: 1800,
    performed: null,
    actualQuantity: null,
    actualAmount: null,
    warrantyMonths: null,
    warrantyUntil: null,
    warrantyUntilManual: false,
    ...over,
  };
}

/**
 * Заявка, у которой объём работ правится: «В работе», подрядчик назначен, предъявление не висит.
 *
 * Все три условия обязательны разом. Без подрядчика объёма работ у заявки не бывает вовсе (ADR
 * 0174), а непогашенное предъявление гасит и поля, и переключатель (Р9) — на такой фикстуре
 * сценарий про недоступный переключатель был бы зелёным по совершенно другой причине.
 */
function editableRequest(items: ServiceRequestItemDto[] = []): ServiceRequestDto {
  return serviceRequest({
    status: 'in_work',
    service: { ...SERVICE_COUNTERPARTY },
    estimatePendingRevision: null,
    items,
  });
}

function renderEditor(request: ServiceRequestDto, over: RouteMap = {}): HttpMock {
  const http = mockHttp(over);
  renderWithUser(<EstimateEditorModal request={request} onClose={() => {}} />, { user: EXECUTOR });
  return http;
}

/** Ответы обеих ручек цепочки «сохранить → предъявить»: тело сценариям неинтересно, версия — да. */
const savedAndSubmitted = (request: ServiceRequestDto): RouteMap => ({
  'PUT /service-requests/:id/estimate': () => json({ ...request, version: request.version + 1 }),
  'PATCH /service-requests/:id/estimate/submit': () =>
    json({ ...request, version: request.version + 2, estimatePendingRevision: 1 }),
});

/**
 * Пункт переключателя режима по его подписи.
 *
 * По разметке `Segmented`, а не по роли: выключенный пункт antd рисует `<label>` с радиокнопкой
 * внутри, и доступного имени у неё нет — искать его пришлось бы по группе целиком. Здесь же нужен
 * сам пункт, чтобы спросить его состояние.
 */
function modeOption(label: string): HTMLElement {
  const found = [...document.querySelectorAll<HTMLElement>('.ant-segmented-item')].find(
    (el) => el.textContent?.trim() === label,
  );
  if (!found) throw new Error(`пункта «${label}» в переключателе режима нет`);
  return found;
}

/** Доступен ли режим: спрашивается сама радиокнопка, а не класс-оформление. */
function modeEnabled(label: string): boolean {
  const input = modeOption(label).querySelector<HTMLInputElement>('input');
  if (!input) throw new Error(`у пункта «${label}» нет радиокнопки`);
  return !input.disabled;
}

const FREE = 'Одной строкой';
const ROWS = 'По графам';

const description = (): HTMLElement => screen.getByLabelText('Описание объёма работ');
const price = (): HTMLElement => screen.getByLabelText('Стоимость заказа');
const submitButton = (): HTMLElement =>
  screen.getByRole('button', { name: 'Предъявить на согласование' });
const draftButton = (): HTMLElement => screen.getByRole('button', { name: 'Сохранить черновик' });
const warrantyButton = (): HTMLElement =>
  screen.getByRole('button', { name: 'Гарантийный ремонт без оплаты' });

const estimateBody = (http: HttpMock): Record<string, unknown> =>
  http.lastCall('PUT /service-requests/:id/estimate')?.body as Record<string, unknown>;

/**
 * Что окно сказало ПО НАЖАТИЮ — тостом, а не строкой под кнопкой.
 *
 * Различать их обязательно: подсказка о пропуске висит в окне всё время, пока пропуск есть, и
 * найденная поиском по тексту она была бы зелёной даже там, где кнопку никто не нажимал. Тост же
 * появляется ровно от нажатия — он и есть доказательство, что окно отказало (либо, наоборот,
 * отправило).
 */
async function toastText(): Promise<string> {
  return await waitFor(() => {
    const notice = document.querySelector('.ant-message-notice-title')?.textContent;
    if (!notice) throw new Error('окно промолчало: тоста после нажатия нет');
    return notice;
  });
}

/**
 * Т2: что именно уходит из свободного режима.
 *
 * Главное здесь — не «форма работает», а СООТВЕТСТВИЕ ДВУХ ПОЛЕЙ И ОДНОЙ СТРОКИ: описание
 * становится наименованием, стоимость — ценой, количество портал подставляет сам. Второго
 * источника суммы не заводится, и проверка тела запроса — единственное место, где это видно.
 */
describe('свободный режим собирает одну строку услуги (Т2, Р1)', () => {
  it('описание уходит наименованием, стоимость — ценой, количество ставит портал', async () => {
    const request = editableRequest();
    const http = renderEditor(request, savedAndSubmitted(request));
    await screen.findByText('Как набрать:');

    // Окно открылось свободным режимом само: у сметы, которую ещё не начинали, терять нечего, а
    // начинают её как раз письмом подрядчика (`initialEstimateMode`).
    expect(screen.getByLabelText('Описание объёма работ')).toBeDefined();

    fireEvent.change(description(), { target: { value: LETTER } });
    fireEvent.change(price(), { target: { value: String(TOTAL) } });

    // Итог виден ДО нажатия: сумма и есть предмет согласования, и считается она по той же строке,
    // которая уйдёт на сервер, — расходиться им нечем.
    expect(screen.getByText('70 455,00 ₽')).toBeDefined();

    fireEvent.click(submitButton());
    await waitFor(() => expect(http.countOf('PUT /service-requests/:id/estimate')).toBe(1));

    /*
     * Строка ровно одна и ровно та: перечень целиком (с переводами строк) в наименовании, вид —
     * услуга, количество — единица, цена — вся сумма заказа. Гарантия пуста: свободная запись её
     * не обещает, а `null` и «0 месяцев» на сервере значат разное.
     */
    expect(estimateBody(http)).toEqual({
      items: [
        { kind: 'service', name: LETTER, quantity: 1, unitPrice: TOTAL, warrantyMonths: null },
      ],
      version: request.version,
    });
    // Предъявление уходит следом и той же цепочкой: сохранённое — то, что подписывают.
    await waitFor(() =>
      expect(http.countOf('PATCH /service-requests/:id/estimate/submit')).toBe(1),
    );
  });

  it('переводы строк письма сохраняются: перечень не склеивается в строку', async () => {
    const request = editableRequest();
    const http = renderEditor(request, savedAndSubmitted(request));
    await screen.findByText('Как набрать:');

    fireEvent.change(description(), { target: { value: LETTER } });
    fireEvent.change(price(), { target: { value: '1' } });
    fireEvent.click(submitButton());
    await waitFor(() => expect(http.countOf('PUT /service-requests/:id/estimate')).toBe(1));

    const items = estimateBody(http).items as { name: string }[];
    // Три строки письма — три строки наименования: перечень из письма читают глазами, и склеенный
    // в одну строку он теряет ровно то, ради чего свободный режим и заведён.
    expect(items[0]!.name.split('\n')).toHaveLength(3);
  });
});

/**
 * Т2, вторая половина: стоимость обязательна (ответ В10).
 *
 * «Пусто = 0» отменено: пустое поле означает «не оценено», и подставленный вместо него ноль записал
 * бы «бесплатно» под тем, чего никто не считал. Проверяется поэтому не текст отказа, а ТИШИНА В
 * СЕТИ — ни одного запроса: отказ, показанный после ухода состава, был бы бесполезен.
 */
describe('без стоимости свободный режим не отправляет ничего (Т2, В10)', () => {
  it('описание есть, стоимости нет — предъявление не уходит, и окно говорит почему', async () => {
    const request = editableRequest();
    const http = renderEditor(request, savedAndSubmitted(request));
    await screen.findByText('Как набрать:');

    fireEvent.change(description(), { target: { value: LETTER } });
    fireEvent.click(submitButton());

    // Пропуск назван словами — исключение ворот `check-form-blockers` выдано этому окну поимённо:
    // полей формы у него нет, помечать нечем, и список пропусков читается одной строкой.
    expect(await toastText()).toBe('Укажите стоимость заказа');
    expect(http.countOf('PUT /service-requests/:id/estimate')).toBe(0);
    expect(http.countOf('PATCH /service-requests/:id/estimate/submit')).toBe(0);
  });

  it('стоимость есть, описания нет — то же самое: спрашивается ровно то, что человек заполняет', async () => {
    const request = editableRequest();
    const http = renderEditor(request, savedAndSubmitted(request));
    await screen.findByText('Как набрать:');

    fireEvent.change(price(), { target: { value: String(TOTAL) } });
    fireEvent.click(submitButton());

    /*
     * Ни «количества больше нуля», ни «цены в каждой строке» — этих полей в свободном режиме на
     * экране нет вовсе, и требовать их значило бы отказывать по невидимому (находка Н6). Отказ
     * называет то, что видно: описание перечня.
     */
    expect(await toastText()).toBe('Опишите объём работ: что входит в заказ');
    expect(http.countOf('PUT /service-requests/:id/estimate')).toBe(0);
  });

  it('заполнено всё — отказа нет вовсе: сценарии выше падают на пропуске, а не на кнопке', async () => {
    const request = editableRequest();
    const http = renderEditor(request, savedAndSubmitted(request));
    await screen.findByText('Как набрать:');

    fireEvent.change(description(), { target: { value: LETTER } });
    fireEvent.change(price(), { target: { value: String(TOTAL) } });
    fireEvent.click(submitButton());

    await waitFor(() => expect(http.countOf('PUT /service-requests/:id/estimate')).toBe(1));
    // Единственный тост окна — об успехе, а не о пропуске: оба сценария выше падают на настоящем
    // отказе, а не на кнопке, которая не работает вовсе.
    expect(await toastText()).toBe('Объём работ предъявлен на согласование');
  });
});

/**
 * Т2, третья половина: у ЧЕРНОВИКА свой вопрос — «пустой законен, начатый без стоимости нет».
 *
 * Разбор тестовой волны (дефект Д1) показал дорогу в обход В10 длиной в два шага: описание без
 * стоимости уходило черновиком со строкой `unitPrice: 0` (`rowsToPayload` подставляет ноль), а при
 * следующем открытии ноль приезжал ГОТОВЫМ значением — не пропуском — и предъявлялся уже без
 * единого вопроса. Отказ поставлен на первом шаге, и проверяется здесь именно он: между «черновик
 * незакончен» и «черновик искажён» разница ровно в том, увидит ли человек свой пропуск при
 * следующем открытии.
 *
 * ЧЕРНОВИК ПРИ ЭТОМ ОСТАЛСЯ ЧЕРНОВИКОМ, и два сценария ниже сторожат именно это: пустую запись
 * сохранять по-прежнему можно, и очистить набранное до пустого состава — тоже. Починка, отобравшая
 * бы их, стоила бы дороже дефекта: «Сохранить черновик» в только что открытом окне отвечал бы
 * отказом на действие, которое до волны законно сохраняло пустой черновик.
 */
describe('черновик свободного режима: пустой законен, начатый без стоимости — нет (Д1)', () => {
  it('описание есть, стоимости нет — черновик не сохраняется, и в сети тишина', async () => {
    const request = editableRequest();
    const http = renderEditor(request, savedAndSubmitted(request));
    await screen.findByText('Как набрать:');

    fireEvent.change(description(), { target: { value: LETTER } });
    fireEvent.click(draftButton());

    /*
     * Тот же текст, что у предъявления, и это не лень: пропуск один и тот же, а разными словами
     * он читался бы как два разных правила. Тишина в сети здесь важнее текста — до починки именно
     * этот запрос и уносил ноль в базу.
     */
    expect(await toastText()).toBe('Укажите стоимость заказа');
    expect(http.countOf('PUT /service-requests/:id/estimate')).toBe(0);
    expect(http.countOf('PATCH /service-requests/:id/estimate/submit')).toBe(0);
  });

  it('нетронутая запись сохраняется черновиком: пустой объём работ — законное состояние', async () => {
    const request = editableRequest();
    const http = renderEditor(request, savedAndSubmitted(request));
    await screen.findByText('Как набрать:');

    fireEvent.click(draftButton());

    // Отказа нет — черновик прошёл: свободный режим держит свою строку всегда, и нетронутая она
    // означает «объём работ ещё не набирали», а не строку сметы (`rowsForSave` её отсеивает).
    expect(await toastText()).toBe('Объём работ сохранён');
    /*
     * Запроса при этом нет вовсе, и это НЕ отказ, а сверка состава (`rowsChanged`): пустое было
     * пустым и осталось, а лишний `PUT` поднял бы версию заявки и отобрал бы её у того, кто в этот
     * момент смотрит карточку. Что пустой состав действительно уходит, когда ему есть что
     * заменить, показывает следующий сценарий.
     */
    expect(http.countOf('PUT /service-requests/:id/estimate')).toBe(0);
  });

  it('набранное можно очистить до пустого состава — он и уходит на сервер', async () => {
    // Заявка со свободной записью на 5 000 ₽: очистка обоих полей — это «объём работ отменяется»,
    // и черновик обязан унести пустой состав, а не упереться в требование стоимости.
    const request = editableRequest([estimateItem({ unitPrice: 5000, amount: 5000 })]);
    const http = renderEditor(request, savedAndSubmitted(request));
    await screen.findByText('Как набрать:');

    fireEvent.change(description(), { target: { value: '' } });
    fireEvent.change(price(), { target: { value: '' } });
    fireEvent.click(draftButton());

    await waitFor(() => expect(http.countOf('PUT /service-requests/:id/estimate')).toBe(1));
    expect(estimateBody(http)).toEqual({ items: [], version: request.version });
  });
});

/**
 * Т2, В10 буквально: ноль в свободном режиме — не «бесплатно», а отказ.
 *
 * Ноль остаётся законным ровно там, где он законен сегодня, — у гарантийного ремонта со служебной
 * строкой, — и предъявляют его ОТДЕЛЬНОЙ кнопкой. Поэтому отказ и назван кнопкой: сказать «нельзя»
 * и не сказать «а как можно» значило бы отправить исполнителя искать выход там, где его нет.
 */
describe('ноль в свободном режиме не проходит ни одной дверью (В10)', () => {
  it('предъявить нельзя, и отказ называет гарантийную кнопку', async () => {
    const request = editableRequest();
    const http = renderEditor(request, savedAndSubmitted(request));
    await screen.findByText('Как набрать:');

    fireEvent.change(description(), { target: { value: LETTER } });
    fireEvent.change(price(), { target: { value: '0' } });
    fireEvent.click(submitButton());

    expect(await toastText()).toBe(
      'Стоимость заказа больше нуля: работы без оплаты предъявляют кнопкой «Гарантийный ремонт без оплаты»',
    );
    expect(http.countOf('PATCH /service-requests/:id/estimate/submit')).toBe(0);
    expect(http.countOf('PUT /service-requests/:id/estimate')).toBe(0);
  });

  it('и черновиком не сохраняется: иначе ноль вернулся бы следующим открытием', async () => {
    /*
     * Вторая дверь той же комнаты. Закрой мы только предъявление, ноль лёг бы в базу черновиком —
     * и при следующем открытии его уже никто не спросил бы: он приехал бы значением, а не пропуском.
     * Ровно так дефект Д1 и работал.
     */
    const request = editableRequest();
    const http = renderEditor(request, savedAndSubmitted(request));
    await screen.findByText('Как набрать:');

    fireEvent.change(description(), { target: { value: LETTER } });
    fireEvent.change(price(), { target: { value: '0' } });
    fireEvent.click(draftButton());

    expect(await toastText()).toContain('Стоимость заказа больше нуля');
    expect(http.countOf('PUT /service-requests/:id/estimate')).toBe(0);
  });
});

/**
 * Т2/Т3 на стыке: СОХРАНЁННЫЙ ноль в свободный режим больше не попадает.
 *
 * Вторая половина починки Д1, и без неё первая ничего не стоила бы: у ревизии, где ноль уже лежит
 * (заявки, заведённые до волны, и служебная строка гарантийного ремонта), окно открылось бы двумя
 * полями и тут же потребовало бы поправить стоимость — не дав ни увидеть, откуда ноль взялся, ни
 * убрать саму строку: кнопки удаления у свободного режима нет вовсе. По графам же цена стоит
 * колонкой у конкретной строки, и строка снимается.
 */
describe('сохранённый ноль открывается «По графам», а не двумя полями (Д1)', () => {
  it('режим угадан по составу: свободный недоступен, цена видна колонкой', async () => {
    renderEditor(editableRequest([estimateItem({ unitPrice: 0, amount: 0 })]));
    await screen.findByText('Как набрать:');

    expect(modeEnabled(FREE)).toBe(false);
    expect(screen.queryByLabelText('Описание объёма работ')).toBeNull();
    // Строка читается по графам — с наименованием и той самой ценой, о которой идёт спор.
    expect(screen.getByLabelText('Услуга: наименование')).toHaveProperty(
      'value',
      'Замена узла подачи',
    );
    expect(screen.getByLabelText('Цена за единицу')).toHaveProperty('value', '0');
  });

  it('по графам такую ревизию предъявить всё-таки можно — и это граница, а не недоделка', async () => {
    /*
     * ГРАНИЦА НАЗВАНА ВСЛУХ, чтобы починку не понесло дальше плана. Ответ В10 отменяет «пусто = 0»,
     * а не ноль как таковой: «ноль остаётся законным ровно там, где он законен сегодня». По графам
     * он законен — служебная строка гарантийного ремонта именно нулевая, — и правило ветки «по
     * графам» (`unitPrice >= 0`) волна не меняла. Запрети мы и здесь, гарантийная смета перестала бы
     * предъявляться вовсе.
     *
     * Свободный режим отличается тем, что показать ноль ему негде: полей два, и оба на вид
     * заполнены. Поэтому закрыта дорога В СВОБОДНЫЙ РЕЖИМ, а не сам ноль.
     */
    const request = editableRequest([estimateItem({ unitPrice: 0, amount: 0 })]);
    const http = renderEditor(request, savedAndSubmitted(request));
    await screen.findByText('Как набрать:');

    fireEvent.click(submitButton());

    await waitFor(() =>
      expect(http.countOf('PATCH /service-requests/:id/estimate/submit')).toBe(1),
    );
  });
});

/**
 * Гарантийный путь починкой не задет.
 *
 * Он и есть то единственное место, где «работы без оплаты» законны, и отказ свободного режима на
 * него прямо ссылается. Проверяется поэтому обе стороны ссылки: кнопка на месте, работает на пустом
 * составе и уходит СВОЕЙ ручкой, а не составом с нулём.
 */
describe('гарантийный ремонт без оплаты работает как прежде', () => {
  /** Гарантийное обращение: без него у окна нет ни режима, ни кнопки. */
  const warrantyRequest = (items: ServiceRequestItemDto[] = []): ServiceRequestDto =>
    serviceRequest({
      status: 'in_work',
      service: { ...SERVICE_COUNTERPARTY },
      estimatePendingRevision: null,
      warrantyClaim: {
        source: 'item',
        itemId: 'sri-0',
        itemName: 'Узел подачи',
        sourceRequestNum: 11,
      },
      items,
    });

  it('пустой состав + кнопка — предъявление уходит своей ручкой, без записи состава', async () => {
    const request = warrantyRequest();
    const http = renderEditor(request, savedAndSubmitted(request));
    await screen.findByText('Как набрать:');

    expect((warrantyButton() as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(warrantyButton());

    await waitFor(() =>
      expect(http.countOf('PATCH /service-requests/:id/estimate/submit')).toBe(1),
    );
    // Нулевую строку собирает СЕРВЕР (Р27): портал состава не пишет вовсе — иначе ноль ехал бы
    // ровно той дорогой, которую эта волна и закрыла.
    expect(http.lastCall('PATCH /service-requests/:id/estimate/submit')!.body).toEqual({
      warrantyRepair: true,
      comment: '',
      version: request.version,
    });
    expect(http.countOf('PUT /service-requests/:id/estimate')).toBe(0);
  });

  it('набранная запись кнопку гасит: гарантийный ремонт предъявляют без строк', async () => {
    // Якорь предыдущего сценария: кнопка спрашивает СОСТАВ, а не одну лишь пометку заявки, — и
    // спрашивает по строкам, которые уйдут, а не по тем, что лежат в состоянии окна.
    const request = warrantyRequest();
    renderEditor(request, savedAndSubmitted(request));
    await screen.findByText('Как набрать:');

    fireEvent.change(description(), { target: { value: LETTER } });

    await waitFor(() => expect((warrantyButton() as HTMLButtonElement).disabled).toBe(true));
  });
});

/**
 * Т3: обратная дорога закрыта всюду, где склейка что-нибудь потеряла бы (Р8).
 *
 * Четыре запрета — четыре сценария, и у каждого свой якорь: рядом с «пункт недоступен» стоит
 * «а «По графам» открыто». Без якоря сценарий остался бы зелёным на окне, которое не открылось
 * вовсе либо заперто висящим предъявлением, — то есть проверял бы собственную поломку.
 */
describe('«Одной строкой» недоступно, когда склейка теряет данные (Т3, Р8)', () => {
  it('строк больше одной: две записи в одну не сворачиваются ни при каком совпадении цен', async () => {
    renderEditor(editableRequest([estimateItem(), estimateItem({ id: 'sri-2' })]));
    await screen.findByText('Как набрать:');

    expect(modeEnabled(FREE)).toBe(false);
    // Дорога вперёд открыта всегда: разворачивание не теряет ничего, и это и есть односторонность.
    expect(modeEnabled(ROWS)).toBe(true);
  });

  it('у единственной строки заполнена гарантия: срок исчез бы молча', async () => {
    renderEditor(editableRequest([estimateItem({ warrantyMonths: 12 })]));
    await screen.findByText('Как набрать:');

    expect(modeEnabled(FREE)).toBe(false);
    expect(modeEnabled(ROWS)).toBe(true);
  });

  it('единственная строка — запчасть: вид у свободной записи всегда услуга', async () => {
    renderEditor(editableRequest([estimateItem({ kind: 'part' })]));
    await screen.findByText('Как набрать:');

    expect(modeEnabled(FREE)).toBe(false);
    expect(modeEnabled(ROWS)).toBe(true);
  });

  it('количество не единица: свободная запись держит ровно одну единицу', async () => {
    renderEditor(editableRequest([estimateItem({ quantity: 3, amount: 5400 })]));
    await screen.findByText('Как набрать:');

    expect(modeEnabled(FREE)).toBe(false);
    expect(modeEnabled(ROWS)).toBe(true);
  });

  it('одна услуга количеством один без гарантии — пункт доступен, и окно им и открылось', async () => {
    /*
     * Якорь всей четвёрки: тот же набор строк, отличающийся ровно тем, что склейке терять нечего.
     * Без него «пункт недоступен» доказывалось бы окном, в котором он недоступен всегда.
     */
    renderEditor(editableRequest([estimateItem()]));
    await screen.findByText('Как набрать:');

    expect(modeEnabled(FREE)).toBe(true);
    // И режим угадан по составу: смета, помещающаяся в два поля, ими и показана.
    expect(screen.getByLabelText('Описание объёма работ')).toBeDefined();
  });
});

/**
 * Т3, вторая половина: односторонность видна В ОДНОМ ОКНЕ, без перезагрузки.
 *
 * Отдельным сценарием, потому что доказывает он другое: не «фикстура такая», а «дорога закрылась от
 * действия человека». Ушёл в графы, добавил запчасть — назад уже нельзя, и это ровно то, что план
 * называет односторонней конвертацией.
 */
describe('конвертация односторонняя: из графов назад дороги нет (Т3, Р8)', () => {
  it('ушли из свободного режима, добавили запчасть — «Одной строкой» погасло', async () => {
    renderEditor(editableRequest());
    await screen.findByText('Как набрать:');

    // Свободный режим открыт и пуст: пункт доступен — терять нечего.
    expect(modeEnabled(FREE)).toBe(true);

    fireEvent.click(modeOption(ROWS));
    fireEvent.click(await screen.findByRole('button', { name: /Добавить запчасть/ }));

    // Появилась строка вида «Запчасть» — и обратная дорога закрылась: склейка потеряла бы вид.
    expect(screen.getByLabelText('Запчасть: наименование')).toBeDefined();
    await waitFor(() => expect(modeEnabled(FREE)).toBe(false));
  });

  it('пустая свободная запись при уходе в графы не превращается в строку сметы', async () => {
    /*
     * Оборотная сторона того же перехода: свободный режим держит свою строку всегда, и, не выбрось
     * её портал при уходе, человек, заглянувший в «Одной строкой» и вернувшийся, обнаружил бы в
     * «Услугах» пустую строку, которой не добавлял.
     */
    renderEditor(editableRequest());
    await screen.findByText('Как набрать:');

    fireEvent.click(modeOption(ROWS));

    expect(await screen.findByText('Работы не заведены')).toBeDefined();
    expect(screen.getByText('Деталей не требуется')).toBeDefined();
  });
});
