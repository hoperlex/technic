import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import type { AuthUser, ServiceEstimateFormat, ServiceRequestDto } from '@technic/contracts';
import { serviceClosingDocumentHint } from '@entities/service-request';
import { json, mockHttp, type HttpMock } from './http';
import { renderWithUser } from './render';
import { emptyList, list } from './factories/common';
import {
  SERVICE_COUNTERPARTY,
  serviceOperator,
  serviceRequest,
  serviceRequestFile,
} from './factories/service';
import { objectDto } from './factories/waste';
import { RequestsTab } from '../src/pages/service/RequestsTab';
import { ServiceAcceptModal } from '../src/features/service-accept/ui/ServiceAcceptModal';

/**
 * Планка закрывающего документа читает ФОРМАТ ДЕЙСТВУЮЩЕЙ РЕВИЗИИ (Р5 плана
 * `docs/office-equipment-on-site-and-invoice-estimate-plan.md`, Э3): у построчной, гарантийной и
 * безревизионной заявки заявку закрывает любой из трёх видов, у документной — только акт, потому
 * что счёт у неё и есть объём работ, которым заявку ОТКРЫЛИ.
 *
 * ПРОВЕРЯЕТСЯ ПРОВОДКА, А НЕ ПРЕДИКАТ. Сам предикат живёт в контрактах и там же проверен по клеткам;
 * сломаться на портале может ровно одно — формат не дойдёт до читателя. Дорога у него длинная
 * (ответ сервера → строка списка → ячейка документов и подпись состояния → окно приёмки), а поле
 * карточки НЕОБЯЗАТЕЛЬНОЕ: забытое, оно читается как «ревизии нет» и молча возвращает планку
 * наследия — то есть «счёт закрывает» у заявки, которой как раз не хватает акта. Ошибка такого рода
 * не ломает ни сборку, ни существующие сценарии: она просто тихо отпускает из очереди не ту заявку.
 *
 * ДОКУМЕНТНОЙ ПОДАЧИ СЕГОДНЯ НЕ БЫВАЕТ — ручка предъявления отвечает 422 на `mode='document'` до
 * Э4, — поэтому все случаи с `estimateFormat: 'document'` описывают состояние БУДУЩЕГО выпуска и
 * едут вперёд кода, который его создаёт (§7 плана, выпуск читателей). Остальные три случая
 * (формата нет, `items`, `warranty`) — это сегодняшнее поведение, и они здесь не для симметрии:
 * планка наследия не должна была сдвинуться ни на одном из них, а доказать это можно только
 * спросив.
 */

const OPERATOR: AuthUser = serviceOperator();

/**
 * Работы предъявлены подрядчиком — состояние, в котором планка и спрашивается (Р112, Н8): до
 * «Решена» закрывающих бумаг не бывает по определению, а у инхаус-ремонта их не требует никто.
 */
function presented(
  format: ServiceEstimateFormat | null | undefined,
  files: ServiceRequestDto['files'],
): ServiceRequestDto {
  return serviceRequest({
    status: 'done',
    service: { ...SERVICE_COUNTERPARTY },
    // `undefined` описывает ответ приложения, которое о волне не знает, — поле в JSON не приходит
    // вовсе; `null` — «ревизии нет». Для планки это один и тот же случай, и оба здесь проверяются.
    ...(format === undefined ? {} : { estimateFormat: format }),
    files,
  });
}

function renderTab(items: ServiceRequestDto[]): HttpMock {
  const http = mockHttp({
    'GET /service-requests': () => json(list(items)),
    // Статический путь описан раньше шаблона с параметром — иначе `:id` перехватил бы и его.
    'GET /service-requests/executor-candidates': () => json(emptyList()),
    'GET /service-requests/:id': ({ params }) =>
      json(items.find((r) => r.id === params.id) ?? items[0]!),
    'GET /service-requests/:id/history': () => json([]),
    'GET /objects': () => json(list([objectDto()])),
    'GET /departments': () => json(emptyList()),
    'GET /counterparties': () => json(emptyList()),
    'GET /office-equipment': () => json(emptyList()),
    'GET /office-equipment-types': () => json(emptyList()),
  });
  renderWithUser(<RequestsTab />, { user: OPERATOR });
  return http;
}

/** Есть ли текст на экране: шапку таблицы antd рисует дважды, поэтому «есть», а не «ровно один». */
const shown = (text: string) => screen.queryAllByText(text).length > 0;

/** Красный тег ячейки документов — портальная половина очереди «Ожидаются документы». */
const awaiting = () => shown('нет закрывающих');

/**
 * Подпись состояния той же строки. Проверяется вместе с тегом, а не вместо него: ячейка и столбец
 * состояния спрашивают один предикат двумя разными дорогами — ячейке карточка приходит целиком, а
 * подписи `serviceStatusLine` отдаёт её по перечню полей (`Pick`), из которого необязательный
 * формат и выпадает молча. Разойдись они, человек читал бы в одной строке «нет закрывающих» и
 * приглашение закрыть работы.
 */
const callsForDocument = () => shown('Вам: нужен закрывающий документ');

describe('очередь «Ожидаются документы» у документной ревизии (Р5)', () => {
  it('счёт документную заявку НЕ закрывает: она остаётся в очереди', async () => {
    renderTab([presented('document', [serviceRequestFile('invoice')])]);
    await screen.findByText('СО-14');

    expect(awaiting()).toBe(true);
    expect(callsForDocument()).toBe(true);
    /*
     * Зелёного «Счёт» рядом с красным тегом нет, и это не придирка к виду: зелёный тег означает
     * «вот чем закрыто», и пара «Счёт» + «нет закрывающих» в одной ячейке читалась бы как поломка
     * списка. Сам счёт при этом из заявки не исчез — он виден на вкладке документов, где показаны
     * все виды.
     */
    expect(shown('Счёт')).toBe(false);
  });

  it('акт её отпускает — он закрывает при любом формате', async () => {
    renderTab([presented('document', [serviceRequestFile('act')])]);
    await screen.findByText('СО-14');

    expect(awaiting()).toBe(false);
    expect(callsForDocument()).toBe(false);
    expect(shown('Акт')).toBe(true);
  });

  it('гарантийный талон документную заявку тоже не закрывает (ответ В10: только акт)', async () => {
    renderTab([presented('document', [serviceRequestFile('warranty_card')])]);
    await screen.findByText('СО-14');

    expect(awaiting()).toBe(true);
    expect(shown('Гарантийный талон')).toBe(false);
  });
});

describe('планка наследия не сдвинулась ни на одном формате (Р5)', () => {
  it.each([
    ['поля в ответе нет вовсе', undefined],
    ['ревизии нет', null],
    ['построчная подача', 'items'],
    ['гарантийная подача', 'warranty'],
  ] as const)('%s: счёт закрывает, как и закрывал', async (_name, format) => {
    renderTab([presented(format, [serviceRequestFile('invoice')])]);
    await screen.findByText('СО-14');

    expect(awaiting()).toBe(false);
    expect(callsForDocument()).toBe(false);
    expect(shown('Счёт')).toBe(true);
  });

  it('без единой бумаги очередь держит заявку при любом формате', async () => {
    renderTab([presented('items', [])]);
    await screen.findByText('СО-14');

    expect(awaiting()).toBe(true);
    expect(callsForDocument()).toBe(true);
  });
});

describe('роль файла — вторая половина правила (Р5)', () => {
  it('счёт-основание объёма работ заявку не закрывает, даже у построчной ревизии', async () => {
    /*
     * Состояние Э4: роль `estimate_basis` ставит только подшивка из команды предъявления, и снять
     * такой файл нельзя никогда. Спрашивается оно здесь затем, что портал обязан передавать в
     * предикат ФАЙЛ, а не его вид: передай он один `kind`, основание автоподписи посчиталось бы
     * закрывающим документом той же заявки — она закрылась бы тем, чем её открыли.
     */
    renderTab([presented('items', [serviceRequestFile('invoice', { purpose: 'estimate_basis' })])]);
    await screen.findByText('СО-14');

    expect(awaiting()).toBe(true);
    expect(shown('Счёт')).toBe(false);
  });
});

describe('окно приёмки считает нехватку бумаги тем же правилом (Р112)', () => {
  /*
   * Текстов теперь два, и это половина того же правила (Р5): перечень видов в подсказке считается
   * по формату действующей ревизии. Прежний единственный текст звал подшить счёт и у документной
   * заявки — то есть предлагал закрыть её тем самым документом, которым её открыли.
   */
  const LEGACY_HINT = serviceClosingDocumentHint(null);
  const DOCUMENT_HINT = serviceClosingDocumentHint('document');

  function renderAccept(request: ServiceRequestDto): void {
    mockHttp({});
    renderWithUser(<ServiceAcceptModal request={request} mode="accept" onClose={() => {}} />, {
      user: OPERATOR,
    });
  }

  it('у документной заявки со счётом предупреждение остаётся — и называет один акт', async () => {
    renderAccept(presented('document', [serviceRequestFile('invoice')]));

    expect(await screen.findByText(DOCUMENT_HINT)).toBeDefined();
    // Перечня из трёх видов у неё нет: подшив по нему счёт, человек остался бы в той же очереди.
    expect(screen.queryByText(LEGACY_HINT)).toBeNull();
    // Приёмку планка не запирает с Н8: окно говорит о нехватке, но закрыть заявку рукой даёт —
    // иначе заявка-наследие без бумаги осталась бы без единого выхода.
    expect((screen.getByRole('button', { name: 'Принять' }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it('у неё же с актом предупреждения нет', async () => {
    renderAccept(presented('document', [serviceRequestFile('act')]));

    await screen.findByText(/Предъявлено/);
    expect(screen.queryByText(DOCUMENT_HINT)).toBeNull();
  });

  it('у построчной заявки счёта по-прежнему довольно', async () => {
    renderAccept(presented('items', [serviceRequestFile('invoice')]));

    await screen.findByText(/Предъявлено/);
    expect(screen.queryByText(LEGACY_HINT)).toBeNull();
  });
});
