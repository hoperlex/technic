import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { AuthUser, ServiceRequestDto, ServiceRequestItemDto } from '@technic/contracts';
import { json, mockHttp, type HttpMock, type RouteMap } from './http';
import { renderWithUser } from './render';
import {
  SERVICE_COUNTERPARTY,
  serviceExecutor,
  serviceOperator,
  serviceRequest,
  serviceRequestFile,
} from './factories/service';
import {
  serviceActionRow,
  serviceExecutorAssignment,
} from '../src/pages/service/serviceRequestRow';
import { EstimateEditorModal } from '../src/features/estimate-editor';

/**
 * ПОДАЧА ОБЪЁМА РАБОТ СЧЁТОМ И ОСВОБОЖДЕНИЕ ОТ ПОДПИСИ — портальная половина плана
 * `docs/office-equipment-on-site-and-invoice-estimate-plan.md` (Р1, Р2, Р3, Р10; §6, раздел
 * «Портал»).
 *
 * ЧТО ЗДЕСЬ ДОКАЗЫВАЕТСЯ, И ПОЧЕМУ ИМЕННО ЭТО.
 *
 * 1. **Поля ИСЧЕЗАЮТ, а не гаснут** (Р10). Проверяется отсутствием узла в разметке, а не атрибутом
 *    `disabled`, и разница тут не стилистическая: у окна уже есть настоящий погашенный режим —
 *    замок висящего предъявления, — и означает он совсем другое («сначала отзовите предъявление»).
 *    Два состояния, выглядящих одинаково, отправили бы человека искать несуществующую кнопку.
 * 2. **Набранное не теряется.** Галочка открыта, пока набранное помещается в одну запись; строк
 *    больше — заперта, и снятие галочки возвращает состав целиком. Без этого «спрятать» означало
 *    бы «унести молча».
 * 3. **Два рубильника действуют ПО-РАЗНОМУ, и это главное, что здесь стережётся** (§7, реестр
 *    ключей). `service_estimate_document_mode` гасит КОМАНДУ: до включения ручка отвечает на
 *    документное тело 422, поэтому выключенный ключ убирает способ подачи целиком — кнопка, ведущая
 *    в 422, хуже отсутствующей. `service_estimate_exemption` гасит ИСХОД: заявление проходит и при
 *    выключенном, ложится в след как «наблюдение», а подпись собирается обычным путём. Спрячь
 *    портал чекбокс — режим наблюдения не существовал бы вовсе: служба не увидела бы ни одного
 *    заявления и ни одной суммы до самого включения ключа. Один и тот же сценарий «ключ выключен»
 *    обязан давать РАЗНЫЕ ответы на два способа, и оба ответа проверяются порознь.
 * 4. **Чекбокс освобождения рисуется ровно тому, кому его разрешает предикат контрактов**
 *    (`canDeclareExemption`, Р3): нарисованный шире, он обещал бы денежное решение, за которым
 *    стоит 403. Рубильник в это условие не входит — он входит в ТЕКСТ рядом с чекбоксом.
 *
 * ТЕЛО ЗАПРОСА — ГЛАВНАЯ ПРОВЕРКА СУИТЫ. Формат предъявления задан внешним дискриминатором (Р2), и
 * расхождение экрана с телом здесь стоит дороже обычного: документная ревизия не несёт ни строк, ни
 * суммы, а заявление об освобождении — денежное решение, исход которого считает сервер.
 *
 * ОКНО РЕНДЕРИТСЯ НАПРЯМУЮ, как и в соседнем `service-estimate-free-mode.test.tsx`: путь до кнопки
 * «Объём работ» к предмету проверки ничего не добавляет.
 */

/** Оба рубильника волны: выключенные, они и есть умолчание сессии (`hasFeature` fail-closed). */
const DOCUMENT_FLAG = 'service_estimate_document_mode' as const;
const EXEMPTION_FLAG = 'service_estimate_exemption' as const;

/** Исполнитель подрядчика: заявление об освобождении делает только он (ответ В1 заказчика). */
const EXECUTOR = serviceExecutor({ features: [DOCUMENT_FLAG, EXEMPTION_FLAG] });

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
 * Заявка, по которой объём работ предъявляют: «В работе», подрядчик назначен, предъявление не
 * висит. Все три условия спрашивает и `canDeclareExemption` — на другой фикстуре чекбокса не было
 * бы по причине, о которой сценарий не говорит.
 */
function editableRequest(items: ServiceRequestItemDto[] = []): ServiceRequestDto {
  return serviceRequest({
    status: 'in_work',
    service: { ...SERVICE_COUNTERPARTY },
    estimatePendingRevision: null,
    items,
  });
}

/** Ответ хранилища на загрузку счёта: сессия → PUT в хранилище → подтверждение (`filesApi`). */
const UPLOAD_ROUTES: RouteMap = {
  'POST /files/upload-session': () =>
    json({
      fileId: 'file-invoice',
      uploadUrl: 'https://storage.test/put/file-invoice',
      objectKey: 'service/file-invoice.pdf',
      expiresIn: 900,
    }),
  'POST /files/:id/complete': () =>
    json({
      id: 'file-invoice',
      filename: 'Счёт № 412.pdf',
      contentType: 'application/pdf',
      size: 2048,
      status: 'ready',
      createdAt: '2026-09-14T10:00:00.000Z',
    }),
};

function renderEditor(
  request: ServiceRequestDto,
  {
    user = EXECUTOR,
    routes = {},
    intent,
  }: {
    user?: AuthUser;
    routes?: RouteMap;
    intent?: 'estimate' | 'breakdown' | 'document' | 'work_done';
  } = {},
): HttpMock {
  const http = mockHttp({
    ...UPLOAD_ROUTES,
    'PUT /service-requests/:id/estimate': () => json({ ...request, version: request.version + 1 }),
    'PATCH /service-requests/:id/estimate/submit': () =>
      json({ ...request, version: request.version + 2, estimatePendingRevision: 1 }),
    ...routes,
  });
  /*
   * Перевод карточки для предикатов приходит окну ГОТОВЫМ — тем же самым, каким его делают разделы
   * портала (`serviceActionRow`, `serviceExecutorAssignment`). Собери сценарий свой — он проверял
   * бы согласие окна с фикстурой, а не с правилом, по которому сервер отвечает 403.
   */
  renderWithUser(
    <EstimateEditorModal
      request={request}
      intent={intent}
      actionRow={serviceActionRow(request)}
      assignment={serviceExecutorAssignment(request, user)}
      onClose={() => {}}
    />,
    { user },
  );
  return http;
}

const documentBox = (): HTMLInputElement =>
  screen.getByRole('checkbox', { name: 'Подать прикреплением счёта' }) as HTMLInputElement;
const exemptionBox = (): HTMLInputElement =>
  screen.getByRole('checkbox', { name: 'Согласование не требуется' }) as HTMLInputElement;
const submitButton = (): HTMLButtonElement =>
  screen.getByRole('button', { name: 'Предъявить на согласование' }) as HTMLButtonElement;

/** Приложить счёт так же, как это делает человек: файл кладётся в скрытый ввод `Upload`. */
function attachInvoice(name = 'Счёт № 412.pdf'): void {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  const file = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], name, {
    type: 'application/pdf',
  });
  fireEvent.change(input, { target: { files: [file] } });
}

const submitBody = (http: HttpMock): Record<string, unknown> =>
  http.lastCall('PATCH /service-requests/:id/estimate/submit')?.body as Record<string, unknown>;

/**
 * §7, шаги 3 и 4: способ включается рубильником, и рубильников ДВА.
 *
 * РУБИЛЬНИКИ РАЗНЫЕ ПО ПРИРОДЕ, И ОТСЮДА ВСЁ ОСТАЛЬНОЕ. Ключ способа подачи гасит КОМАНДУ: ручка
 * предъявления отвечает на документное тело отказом 422 до самого включения, и нарисованная кнопка в
 * такую дверь — обещание, за которым пусто. Ключ освобождения гасит ИСХОД: заявление проходит при
 * любом его состоянии, пишется следом и видно службе, а выключенный ключ означает лишь, что подпись
 * соберут обычным порядком. Спрячь портал чекбокс — и режима наблюдения не стало бы вовсе, то есть
 * включать освобождение пришлось бы вслепую.
 */
describe('рубильник команды убирает способ целиком, рубильник исхода — нет (§7)', () => {
  it('без документного ключа подачи счётом нет вовсе: ручка отвечает на такое тело 422', async () => {
    renderEditor(editableRequest(), { user: serviceExecutor({ features: [EXEMPTION_FLAG] }) });
    await screen.findByText('Как набрать:');

    expect(screen.queryByText('Подать прикреплением счёта')).toBeNull();
  });

  it('включён только документный: счёт подать можно, а заявление уходит в наблюдение', async () => {
    /*
     * Два рубильника, а не один, — это решение выката, а не удобство: подача документом полезна и
     * с обычным согласованием, и включать её вместе с обходом подписи незачем. Проверяется именно
     * порознь: один флаг на два способа прошёл бы этот сценарий незамеченным.
     */
    renderEditor(editableRequest(), { user: serviceExecutor({ features: [DOCUMENT_FLAG] }) });
    await screen.findByText('Как набрать:');

    expect(documentBox().disabled).toBe(false);
    // Чекбокс на месте и при выключенном ключе освобождения — весь режим наблюдения в этом.
    expect(exemptionBox().disabled).toBe(false);
  });

  /**
   * РЕЖИМ НАБЛЮДЕНИЯ ЦЕЛИКОМ (§7, шаг 4): ключ гасит ИСХОД, а не команду.
   *
   * Спрячь портал чекбокс при выключенном ключе — заявлений не появилось бы ни одного, и служба,
   * ради которой наблюдение и заведено, не узнала бы до самого включения ни их числа, ни сумм. А
   * поставленная галочка обязана сказать правду о последствии: заявление запишут, подпись всё равно
   * соберут. Молчание здесь дороже всего — исполнитель ушёл бы с экрана уверенным, что заявка
   * принята.
   */
  describe('выключенный ключ освобождения оставляет чекбокс и меняет текст', () => {
    it('чекбокс виден тому, кому разрешает предикат, — и без рубильника', async () => {
      renderEditor(editableRequest(), { user: serviceExecutor({ features: [DOCUMENT_FLAG] }) });
      await screen.findByText('Как набрать:');

      expect(exemptionBox().disabled).toBe(false);
    });

    it('текст предупреждает: заявление запишут, но подпись соберут', async () => {
      renderEditor(editableRequest(), { user: serviceExecutor({ features: [DOCUMENT_FLAG] }) });
      await screen.findByText('Как набрать:');

      expect(screen.getByText(/заявление будет записано и видно службе/)).toBeDefined();
      expect(screen.getByText(/подпись «Ведения» под этой суммой всё равно соберут/)).toBeDefined();
      /*
       * Обещания снятой подписи в этом состоянии нет — а оно и есть цена ошибки: прежний текст
       * («собирать не будут») стоял бы здесь ложью о денежном решении.
       */
      expect(screen.queryByText(/собирать не будут/)).toBeNull();
    });

    it('включённый ключ говорит обратное: подпись под этой суммой собирать не будут', async () => {
      renderEditor(editableRequest());
      await screen.findByText('Как набрать:');

      expect(screen.getByText(/собирать не будут/)).toBeDefined();
      expect(screen.queryByText(/заявление будет записано и видно службе/)).toBeNull();
    });

    it('заявление уезжает в теле и без рубильника: исход считает сервер, а не портал', async () => {
      /*
       * Главная проверка режима наблюдения: не показ, а КОМАНДА. Спрячь портал заявление из тела
       * при выключенном ключе — сервер не записал бы ни одной строки, и наблюдать было бы нечего;
       * исход (`applied` / `observed`) считает он сам, по своей строке `feature_flags`.
       */
      const request = editableRequest();
      const http = renderEditor(request, {
        user: serviceExecutor({ features: [DOCUMENT_FLAG] }),
      });
      await screen.findByText('Как набрать:');
      fireEvent.change(screen.getByLabelText('Описание объёма работ'), {
        target: { value: 'Замена ролика захвата на месте' },
      });
      fireEvent.change(screen.getByLabelText('Стоимость заказа'), { target: { value: '1200' } });
      fireEvent.click(exemptionBox());
      fireEvent.click(submitButton());

      await waitFor(() =>
        expect(http.countOf('PATCH /service-requests/:id/estimate/submit')).toBe(1),
      );
      // Версия поднялась сохранением состава: построчное предъявление идёт цепочкой «сохранить →
      // предъявить», и со старой версией второй шаг получил бы 409 на ровном месте.
      expect(submitBody(http)).toEqual({
        mode: 'items',
        exemption: {},
        comment: '',
        version: request.version + 1,
      });
    });
  });
});

/**
 * Р10 буквально: поля УХОДЯТ С ЭКРАНА.
 *
 * Каждый из трёх узлов проверяется отсутствием: переключатель режимов, поле стоимости и таблица
 * граф. Спроси сценарий атрибут `disabled`, он остался бы зелёным ровно в том состоянии, которое
 * план и запрещает, — окно, погашенное по двум разным причинам одинаково.
 */
describe('подача счётом убирает поля с экрана, а не гасит их (Р10)', () => {
  it('переключатель, поле стоимости и итог исчезают из разметки', async () => {
    renderEditor(editableRequest());
    await screen.findByText('Как набрать:');
    expect(screen.getByLabelText('Стоимость заказа')).toBeDefined();

    fireEvent.click(documentBox());

    expect(screen.queryByText('Как набрать:')).toBeNull();
    expect(screen.queryByLabelText('Стоимость заказа')).toBeNull();
    expect(screen.queryByLabelText('Описание объёма работ')).toBeNull();
    /*
     * Итога нет вовсе, и это не забытая строка разметки: строк у документной ревизии ноль, а
     * посчитанный по ним «0,00 ₽» читался бы как цена работ — та самая ошибка, которую §8 плана
     * велит вывести отовсюду, где сумма ещё неизвестна.
     */
    expect(screen.queryByText('Итого по объёму работ:')).toBeNull();
  });

  it('таблица граф исчезает вместе с ними', async () => {
    renderEditor(editableRequest([estimateItem()]));
    await screen.findByText('Как набрать:');
    // Заявка открылась свободной записью (состав в неё помещается) — в графы переходим руками,
    // иначе сценарий проверял бы отсутствие того, чего и не было на экране.
    fireEvent.click(screen.getByText('По графам'));
    expect(screen.getByLabelText('Цена за единицу')).toBeDefined();

    fireEvent.click(documentBox());

    expect(screen.queryByLabelText('Цена за единицу')).toBeNull();
    expect(screen.queryByLabelText('Услуга: наименование')).toBeNull();
    // Остаётся ровно то, что перечисляет Р10: загрузка и комментарий.
    expect(screen.getByRole('button', { name: /Приложить счёт/ })).toBeDefined();
    expect(screen.getByPlaceholderText(/Комментарий к объёму работ/)).toBeDefined();
  });

  it('снятие галочки возвращает и поля, и набранное', async () => {
    renderEditor(editableRequest());
    await screen.findByText('Как набрать:');
    fireEvent.change(screen.getByLabelText('Описание объёма работ'), {
      target: { value: 'Ремонт МФУ по письму подрядчика' },
    });
    fireEvent.change(screen.getByLabelText('Стоимость заказа'), { target: { value: '70455' } });

    fireEvent.click(documentBox());
    fireEvent.click(documentBox());

    /*
     * Набранное дождалось возвращения целиком — ради этого поля и прячут, а не очищают. Потеряй
     * окно состав на галочке, человек, заглянувший «а как это выглядит», лишился бы письма
     * подрядчика, которое переносил вручную.
     */
    expect(screen.getByLabelText('Описание объёма работ')).toHaveProperty(
      'value',
      'Ремонт МФУ по письму подрядчика',
    );
    expect(screen.getByLabelText('Стоимость заказа')).toHaveProperty('value', '70455');
  });
});

/**
 * Вторая половина правила «набранное не теряется»: галочка ЗАПЕРТА, пока прятать есть что.
 *
 * Счёт подают вместо состава — у документной ревизии строк нет вовсе, — и спрятать под галочкой
 * набранную смету значило бы унести её молча. Поэтому запрет, а не предупреждение, и поэтому же
 * причина названа словами: погашенная галочка без объяснения читается как поломка окна.
 */
describe('галочка заперта, когда набранное в подачу не помещается (Р10)', () => {
  it('две строки — галочка недоступна, и окно называет выход', async () => {
    renderEditor(
      editableRequest([
        estimateItem(),
        estimateItem({ id: 'sri-2', name: 'Чистка тракта', unitPrice: 900, amount: 900 }),
      ]),
    );
    await screen.findByText('Как набрать:');

    expect(documentBox().disabled).toBe(true);
    // Подсказка висит на обёртке: выключенный ввод событий мыши не отдаёт, и повешенная на сам
    // чекбокс она не показалась бы вовсе.
    fireEvent.mouseOver(screen.getByText('Подать прикреплением счёта'));
    await waitFor(() => expect(document.body.textContent).toContain('уберите лишние строки'));
  });

  it('одна помещающаяся строка — галочка открыта: запирает не наличие состава, а его размер', async () => {
    renderEditor(editableRequest([estimateItem()]));
    await screen.findByText('Как набрать:');

    expect(documentBox().disabled).toBe(false);
  });
});

/**
 * Предъявление счётом: чем оно заперто и что уезжает на сервер.
 *
 * Пустой список приложенного запирает КНОПКУ, а не отвечает тостом по нажатию, — в отличие от
 * пропусков состава: дозаполнять здесь нечего, список виден рядом, и такое тело не собирается даже
 * схемой (`fileIds` минимум один).
 */
describe('предъявление счётом: без документа нельзя, с документом — своё тело (Р2)', () => {
  it('без единого файла кнопка заперта, и причина названа строкой', async () => {
    renderEditor(editableRequest());
    await screen.findByText('Как набрать:');
    fireEvent.click(documentBox());

    expect(submitButton().disabled).toBe(true);
    expect(
      screen.getByText('Приложите счёт или скриншот: документная подача без файла невозможна'),
    ).toBeDefined();
  });

  it('приложенный счёт отпирает кнопку, а тело уходит документным форматом', async () => {
    const request = editableRequest();
    const http = renderEditor(request);
    await screen.findByText('Как набрать:');
    fireEvent.click(documentBox());

    attachInvoice();
    // Имя файла видно человеку до нажатия: по идентификатору свой счёт от чужого не отличить.
    await screen.findByText('Счёт № 412.pdf');
    expect(submitButton().disabled).toBe(false);

    fireEvent.click(submitButton());
    await waitFor(() =>
      expect(http.countOf('PATCH /service-requests/:id/estimate/submit')).toBe(1),
    );

    /*
     * Ни строк, ни суммы: документная ревизия их не несёт вовсе (ответ В5 — «придёт от разбора
     * документа»), и подставленный ноль читался бы как «работы бесплатны».
     */
    expect(submitBody(http)).toEqual({
      mode: 'document',
      fileIds: ['file-invoice'],
      comment: '',
      version: request.version,
    });
    /*
     * Состав перед этим НЕ сохраняется: спрятанные строки в документную ревизию не переносятся, а
     * сохранённые сейчас легли бы черновиком, которого человек на экране не видит.
     */
    expect(http.countOf('PUT /service-requests/:id/estimate')).toBe(0);
  });
});

describe('действие «Работы выполнены» завершает денежный шаг и ведёт к акту', () => {
  it('подаёт счёт с автосогласованием и сразу открывает подшивку акта', async () => {
    const request = editableRequest();
    const submitted = serviceRequest({
      ...request,
      version: request.version + 1,
      estimateRevision: 1,
      estimateFormat: 'document',
      estimatePendingRevision: null,
      estimateSubmittedAt: '2026-09-24T10:00:00.000Z',
      approval: {
        revision: 1,
        by: null,
        byName: '',
        at: '2026-09-24T10:00:00.000Z',
        source: 'auto',
      },
      files: [serviceRequestFile('invoice', { purpose: 'estimate_basis' })],
    });
    const withAct = serviceRequest({
      ...submitted,
      version: submitted.version + 1,
      files: [...submitted.files, serviceRequestFile('act')],
    });
    const http = renderEditor(request, {
      intent: 'work_done',
      routes: {
        'PATCH /service-requests/:id/estimate/submit': () => json(submitted),
        'POST /service-requests/:id/files': () => json(withAct),
      },
    });

    expect(screen.queryByText('Как набрать:')).toBeNull();
    expect(screen.getByRole('button', { name: /Приложить счёт или скриншот/ })).toBeDefined();
    expect(screen.queryByText('Согласование не требуется')).toBeNull();

    attachInvoice('screen.png');
    await screen.findByText('Счёт № 412.pdf');
    fireEvent.click(screen.getByRole('button', { name: 'Работы выполнены' }));

    await screen.findByText('Документ принят, согласование выполнено автоматически.');
    expect(submitBody(http)).toEqual({
      mode: 'document',
      fileIds: ['file-invoice'],
      exemption: {},
      comment: '',
      version: request.version,
    });
    expect(screen.getByRole('button', { name: /Подшить документ/ })).toBeDefined();

    const act = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], 'Акт.pdf', {
      type: 'application/pdf',
    });
    fireEvent.change(document.querySelector('input[type="file"]') as HTMLInputElement, {
      target: { files: [act] },
    });

    await waitFor(() => expect(http.countOf('POST /service-requests/:id/files')).toBe(1));
    expect(http.lastCall('POST /service-requests/:id/files')?.body).toEqual({
      fileIds: ['file-invoice'],
      kind: 'act',
    });
    expect(await screen.findByText(/Акт подшит/)).toBeDefined();
  });
});

/**
 * Освобождение от подписи: кому его показывают и что уезжает в теле (Р1, Р3).
 *
 * Показ считает предикат контрактов и только он: право заявить освобождение есть у оператора
 * контрагента-сервиса по ЭТОЙ заявке, и ни у кого больше — ни у «Ведения», которое подпись ставит,
 * ни у своего исполнителя, за работу которого не платят.
 */
describe('чекбокс освобождения показывается ровно тому, кому дано (Р3)', () => {
  it('оператору сервиса при включённом рубильнике — виден', async () => {
    renderEditor(editableRequest());
    await screen.findByText('Как набрать:');

    expect(exemptionBox().disabled).toBe(false);
    // «По условиям договора» окно не обещает: политики в системе нет (ответ В12), и обещание,
    // которого она не проверяет, было бы ложью.
    expect(document.body.textContent).not.toContain('по условиям договора');
  });

  it('«Ведению» — не виден: предикат отказал, и второго мнения портал не заводит', async () => {
    const operator = serviceOperator({ features: [DOCUMENT_FLAG, EXEMPTION_FLAG] });
    renderEditor(editableRequest(), { user: operator });
    await screen.findByText('Как набрать:');

    expect(screen.queryByText('Согласование не требуется')).toBeNull();
  });

  it('перевода карточки не передали — чекбокса нет: fail-closed, а не «показать на всякий»', async () => {
    mockHttp(UPLOAD_ROUTES);
    renderWithUser(<EstimateEditorModal request={editableRequest()} onClose={() => {}} />, {
      user: EXECUTOR,
    });
    await screen.findByText('Как набрать:');

    expect(screen.queryByText('Согласование не требуется')).toBeNull();
  });

  it('построчное предъявление с освобождением: законное сочетание и главный сценарий разбора', async () => {
    const request = editableRequest();
    const http = renderEditor(request);
    await screen.findByText('Как набрать:');
    fireEvent.change(screen.getByLabelText('Описание объёма работ'), {
      target: { value: 'Замена ролика захвата на месте' },
    });
    fireEvent.change(screen.getByLabelText('Стоимость заказа'), { target: { value: '1200' } });

    fireEvent.click(exemptionBox());
    fireEvent.change(screen.getByLabelText('Пояснение к освобождению от подписи'), {
      target: { value: 'Мелкий ремонт сделан при диагностике' },
    });
    fireEvent.click(submitButton());

    await waitFor(() =>
      expect(http.countOf('PATCH /service-requests/:id/estimate/submit')).toBe(1),
    );
    /*
     * «Строки плюс освобождение» — это и есть п. 1 разбора (Р2, ответ заказчика 11.09.2026):
     * мелкий ремонт на месте вписывают строками и сразу помечают «согласование не требуется».
     * В теле едет ЗАЯВЛЕНИЕ — одно пояснение; исход (`applied` / `observed`) считает сервер
     * рубильником, и приди он полем отсюда, автоподпись под денежным решением ставил бы браузер.
     */
    expect(submitBody(http)).toEqual({
      mode: 'items',
      exemption: { note: 'Мелкий ремонт сделан при диагностике' },
      comment: '',
      version: request.version + 1,
    });
  });

  it('счёт и освобождение вместе: оба пункта разбора одной командой', async () => {
    const request = editableRequest();
    const http = renderEditor(request);
    await screen.findByText('Как набрать:');
    fireEvent.click(documentBox());
    attachInvoice();
    await screen.findByText('Счёт № 412.pdf');

    fireEvent.click(exemptionBox());
    fireEvent.click(submitButton());

    await waitFor(() =>
      expect(http.countOf('PATCH /service-requests/:id/estimate/submit')).toBe(1),
    );
    /*
     * Пояснение необязательно, и пустым оно НЕ уезжает: пустая строка в поле «почему» читалась бы
     * как сказанное, а не как несказанное. Само же заявление в теле есть — иначе сервер записал
     * бы обычное предъявление, а денежное решение осталось бы без следа.
     */
    expect(submitBody(http)).toEqual({
      mode: 'document',
      fileIds: ['file-invoice'],
      exemption: {},
      comment: '',
      version: request.version,
    });
  });
});
