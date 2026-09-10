import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type {
  AuthUser,
  RequestHistoryEntryDto,
  RequestHistoryKind,
  ServiceRequestDto,
} from '@technic/contracts';
import { json, mockHttp, type HttpMock } from './http';
import { renderWithUser } from './render';
import { emptyList, list } from './factories/common';
import { assignedServiceRequest, serviceOperator } from './factories/service';
import { operator } from './factories/waste';
import { AssignServiceModal } from '../src/features/assign-service/ui/AssignServiceModal';
import { ServiceRequestViewModal } from '../src/pages/service/ServiceRequestViewModal';

/**
 * Причина замены исполнителя необязательна, а в истории у неё прочерк (план
 * `docs/office-equipment-free-estimate-and-executor-scope-plan.md`, Р6; §7, Т14; просьба заказчика
 * от 09.09.2026 дословно: «убрать звёздочку с причины замены — сделать необязательным, в истории
 * ставить прочерк»).
 *
 * ДВА ПРЕДМЕТА, И ОНИ РАЗНЫЕ. Первый — ЧТО УХОДИТ на сервер: причина и комментарий разведены по
 * своим полям тела, и подмена `reason ?? comment` отменена. Проверяются все четыре сочетания —
 * только причина, только комментарий, оба, ни одного, — потому что расходятся они попарно: пока
 * поля складывались в одно, «только комментарий» выглядел как заполненная причина, а «оба» терял
 * комментарий вовсе (Н11). Одним сценарием на «пустую причину» этого не увидеть.
 *
 * Второй — ЧТО ЧИТАЕТСЯ в ленте: у события «Сервис заменён» без причины стоит прочерк, и только у
 * него. Молчащая строка читалась бы как потерянный текст — «а что тут было написано?» — и разбор
 * замены начинался бы с недоверия к самой истории; прочерк отвечает прямо: причину не называли.
 *
 * ПОЧЕМУ ПРОВЕРЯЕТСЯ ТЕЛО, А НЕ «ФОРМА ОТПРАВИЛАСЬ». Обязательность держал `required` формы, и
 * снять его мало: сервер по-прежнему различает пустую причину и отсутствующее поле, а история
 * пишется по `body.reason`. Тело запроса — единственное место, где видно, что именно портал сказал.
 */

/** Тот, кто распределяет заявки: право `serviceRequests.assign` есть у «Ведения». */
const OPERATOR: AuthUser = serviceOperator();

/** Заявка с назначенным составом: у первого назначения поля причины нет вовсе — менять нечего. */
const ASSIGNED: ServiceRequestDto = assignedServiceRequest();

const REASON = 'Сисадмин в отпуске до конца месяца';
const COMMENT = 'Ключ от серверной у дежурного на первом этаже';

function renderAssign(): HttpMock {
  const http = mockHttp({
    // Кандидаты в поимённые исполнители: маршрут описан раньше `:id`, иначе шаблон с параметром
    // перехватил бы и его.
    'GET /service-requests/executor-candidates': () => json(emptyList()),
    'GET /counterparties': () =>
      json(list([operator({ id: 'cp-1', name: 'КопиЛайт', type: 'service' })])),
    // Ответ ручки несёт исход письма: `queued` — обычный, и тост об отсутствии адресатов не
    // появляется. Сценариям он неинтересен, но без него окно сообщило бы о поломке почты.
    'PUT /service-requests/:id/executors': () => json({ ...ASSIGNED, mail: 'queued' }),
  });
  renderWithUser(<AssignServiceModal request={ASSIGNED} onClose={() => {}} />, { user: OPERATOR });
  return http;
}

const field = (label: string): HTMLElement => screen.getByLabelText(label);

/** Сохранить состав: у переназначения кнопка подписана «Сохранить», у первого — «Назначить». */
const save = () => fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));

async function executorsBody(http: HttpMock): Promise<Record<string, unknown>> {
  await waitFor(() => expect(http.countOf('PUT /service-requests/:id/executors')).toBe(1));
  return http.lastCall('PUT /service-requests/:id/executors')?.body as Record<string, unknown>;
}

/**
 * Т14, первая половина: четыре сочетания двух полей.
 *
 * Состав исполнителей окно подставляет само (он и есть то, что правят), поэтому сценарии трогают
 * ровно два поля — и различаются ровно ими.
 */
describe('переназначение: причина и комментарий — разные поля (Т14, Р6)', () => {
  it('звёздочки у причины нет: поле помечено словом «Необязательно»', async () => {
    renderAssign();
    await screen.findByLabelText('Причина замены');

    /*
     * Обязательность у antd — не подпись, а класс на метке (`ant-form-item-required`): именно он
     * рисует звёздочку и именно он остался бы, сними мы одно лишь `required` с правил. Проверяется
     * поэтому он, а не наличие символа в тексте.
     */
    const label = [...document.querySelectorAll('label')].find(
      (el) => el.textContent?.trim() === 'Причина замены',
    );
    expect(label?.classList.contains('ant-form-item-required')).toBe(false);
    // И сказано это словами, а не одним лишь отсутствием звёздочки: «Необязательно» стоит подписью
    // под полем — иначе о необязательности узнавали бы, только рискнув отправить пустым.
    expect(screen.getByText(/^Необязательно\./)).toBeDefined();
  });

  it('ни причины, ни комментария — переназначение всё равно уходит', async () => {
    const http = renderAssign();
    await screen.findByLabelText('Причина замены');

    save();

    const body = await executorsBody(http);
    /*
     * Причины в теле НЕТ ВОВСЕ (`undefined` не переживает сериализацию), а не пустая строка: сервер
     * различает «не назвали» и «назвали пустым», и второе он же и отверг бы схемой. Комментарий
     * приходит пустой строкой — поле необязательное, но объявленное.
     */
    expect(body.reason).toBeUndefined();
    expect(body.comment).toBe('');
    // Состав при этом ушёл настоящий: сценарий доказывает проход без причины, а не пустой запрос.
    expect(body.userIds).toEqual(['user-9']);
    expect(body.serviceCounterpartyId).toBe('cp-1');
  });

  it('только причина — уходит она одна', async () => {
    const http = renderAssign();
    await screen.findByLabelText('Причина замены');

    fireEvent.change(field('Причина замены'), { target: { value: REASON } });
    save();

    const body = await executorsBody(http);
    expect(body.reason).toBe(REASON);
    expect(body.comment).toBe('');
  });

  it('только комментарий — причиной он НЕ становится', async () => {
    const http = renderAssign();
    await screen.findByLabelText('Причина замены');

    fireEvent.change(field('Комментарий исполнителю'), { target: { value: COMMENT } });
    save();

    const body = await executorsBody(http);
    /*
     * Тот самый разъезд, ради которого поля и разведены (Р6, Н11). Прежде в историю уходило
     * `reason ?? comment`, и записка новому исполнителю — «ключ у дежурного» — вставала в ленту
     * ОБЪЯСНЕНИЕМ ЗАМЕНЫ. Теперь причина остаётся неназванной, а комментарий уезжает своим полем.
     */
    expect(body.reason).toBeUndefined();
    expect(body.comment).toBe(COMMENT);
  });

  it('оба — уходят оба, и комментарий не теряется под заполненной причиной', async () => {
    const http = renderAssign();
    await screen.findByLabelText('Причина замены');

    fireEvent.change(field('Причина замены'), { target: { value: REASON } });
    fireEvent.change(field('Комментарий исполнителю'), { target: { value: COMMENT } });
    save();

    const body = await executorsBody(http);
    // Вторая половина Н11: под заполненной причиной комментарий прежде не уходил никуда вовсе.
    expect(body.reason).toBe(REASON);
    expect(body.comment).toBe(COMMENT);
  });

  it('предупреждение о снятом исполнителе осталось: оно про последствие, а не про причину', async () => {
    /*
     * Необязательность сняла ВОПРОС «почему», но не ПРЕДУПРЕЖДЕНИЕ «что будет». Убери мы их
     * заодно, окно потеряло бы единственное место, где о потере объёма работ сказано до нажатия.
     */
    renderAssign();

    expect(await screen.findByText('У снятого исполнителя заявку заберут')).toBeDefined();
  });
});

// ── Прочерк в ленте ────────────────────────────────────────────────────────

function historyEntry(
  kind: RequestHistoryKind,
  comment: string,
  over: Partial<RequestHistoryEntryDto> = {},
): RequestHistoryEntryDto {
  return {
    id: `h-${kind}-${comment ? 'said' : 'silent'}`,
    kind,
    at: '2026-09-09T09:00:00.000Z',
    actorId: 'user-1',
    actorName: 'Ведениев В. В.',
    fromStatus: null,
    toStatus: null,
    comment,
    changes: [],
    ...over,
  };
}

function renderCard(history: RequestHistoryEntryDto[]): void {
  mockHttp({
    'GET /service-requests/:id': () => json(ASSIGNED),
    'GET /service-requests/:id/history': () => json(history),
  });
  renderWithUser(<ServiceRequestViewModal request={ASSIGNED} onClose={() => {}} />, {
    user: OPERATOR,
  });
}

async function openHistory(): Promise<void> {
  fireEvent.click(await screen.findByRole('tab', { name: 'История' }));
}

/**
 * Что лента говорит о событии с таким тегом.
 *
 * Ищется СТРОКА события, а не текст по всей таблице: прочерком в этой же таблице подписан
 * неизвестный автор (`actorName ?? '—'`), и поиск по документу нашёл бы его вместо причины. Берётся
 * средняя колонка — та, в которой лента и рассказывает, что произошло.
 */
async function saidAbout(tag: string): Promise<string> {
  return await waitFor(() => {
    const row = [...document.querySelectorAll<HTMLElement>('tbody tr')].find((el) =>
      el.querySelector('.ant-tag')?.textContent?.includes(tag),
    );
    if (!row) throw new Error(`события «${tag}» в ленте нет`);
    return row.querySelectorAll('td')[1]?.textContent ?? '';
  });
}

/**
 * Т14, вторая половина: прочерк стоит у замены — и только у неё.
 *
 * Отрицательный случай здесь обязателен: прочерк, поставленный всем видам событий, превратил бы
 * ленту в частокол, в котором значащий прочерк замены потерялся бы первым. Поэтому рядом с
 * «замена без причины показывает „—“» стоит «а переход без комментария молчит».
 */
describe('история: пустая причина замены показывается прочерком (Т14, В8)', () => {
  it('«Сервис заменён» без причины — прочерк, а не пустая строка', async () => {
    renderCard([historyEntry('serviceReassigned', '')]);
    await openHistory();

    expect(await saidAbout('Сервис заменён')).toBe('—');
  });

  it('причина названа — в ленте она, а не прочерк', async () => {
    renderCard([historyEntry('serviceReassigned', REASON)]);
    await openHistory();

    expect(await saidAbout('Сервис заменён')).toBe(REASON);
  });

  it('у остальных видов события пустой комментарий остаётся молчанием', async () => {
    /*
     * Якорь всего сценария: то же самое отсутствие текста у соседнего события. У него пустой
     * комментарий означает «сказать нечего», и прочерка там быть не должно — строка называет само
     * событие. Прочерк, поставленный всем видам, потерялся бы среди себе подобных ровно там, где
     * он значащий.
     */
    renderCard([
      historyEntry('serviceReassigned', ''),
      historyEntry('estimateSubmitted', '', { id: 'h-submitted' }),
    ]);
    await openHistory();

    expect(await saidAbout('Объём работ предъявлен')).toBe('Объём работ предъявлен');
    // И прочерк у замены при этом на месте: сценарий различает виды, а не гасит их все разом.
    expect(await saidAbout('Сервис заменён')).toBe('—');
  });
});
