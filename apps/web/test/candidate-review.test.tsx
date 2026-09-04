import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { CANDIDATE_PENDING_ACCEPT_REFUSAL } from '@technic/contracts';
import type {
  AuthUser,
  ConfirmOfficeEquipmentCandidateInput,
  MergeOfficeEquipmentCandidateInput,
  OfficeEquipmentCandidateDto,
  OfficeEquipmentDto,
  OfficeEquipmentModelDto,
  OfficeEquipmentTypeDto,
  Permission,
  RejectOfficeEquipmentCandidateInput,
} from '@technic/contracts';
import { selectOption } from './antd';
import { json, mockHttp, type HttpMock, type RouteMap } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { emptyList, list } from './factories/common';
import { objectDto } from './factories/waste';
import { serviceRequest } from './factories/service';
import { EquipmentTab } from '../src/pages/service/EquipmentTab';
import { ServiceRequestSubjectName } from '../src/pages/service/ServiceRequestSubjectName';
import { serviceAcceptLock } from '../src/pages/service/serviceStatusChoices';

/**
 * Очередь проверки сообщений о технике и три решения проверяющего (план
 * `docs/office-equipment-candidate-plan.md`, Р12–Р15, §9).
 *
 * Проверяется здесь то, что на экране не видно и в ручном прогоне не ловится: подтверждение — это
 * ЗАВЕДЕНИЕ КАРТОЧКИ ПО СООБЩЕНИЮ, а не «согласен» (в теле уходит полная форма парка, Р13); отказ
 * без причины не отправляется вовсе, а причина объявлена читаемой заявителем (Р15); каждая дверь
 * несёт `expectedVersion`, и устаревшая форма получает 409 со свежим состоянием, а не перетирает
 * решение коллеги (Р11).
 *
 * Отдельно закреплена инвалидация: решение рождает запись в парке (Р13), и не погаси портал ключи
 * парка, моделей и расходников, счётчик «В парке» показывал бы вчерашнее число до перезагрузки.
 */

const TYPE: OfficeEquipmentTypeDto = {
  id: 'oet-1',
  code: 'mfu',
  name: 'МФУ',
  sortOrder: 1,
  isActive: true,
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
};

/**
 * Моделей две намеренно: с единственным вариантом `AutoSelect` заполнил бы поле сам, и проверка
 * «в теле подтверждения уехала выбранная модель» прошла бы независимо от того, выбирал её кто-то
 * или нет.
 */
const MODELS: OfficeEquipmentModelDto[] = [
  {
    id: 'oem-1',
    type: { id: TYPE.id, name: TYPE.name, isActive: true },
    specs: [],
    name: 'Kyocera M3145',
    manufacturer: '',
    isActive: true,
    comment: '',
    isUsed: false,
    equipmentCount: 0,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  },
  {
    id: 'oem-2',
    type: { id: TYPE.id, name: TYPE.name, isActive: true },
    specs: [],
    name: 'Canon i-SENSYS',
    manufacturer: '',
    isActive: true,
    comment: '',
    isUsed: false,
    equipmentCount: 0,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  },
];

function candidateDto(
  over: Partial<OfficeEquipmentCandidateDto> = {},
): OfficeEquipmentCandidateDto {
  return {
    id: 'oec-1',
    status: 'pending',
    contentVersion: 3,
    equipmentType: { id: TYPE.id, name: TYPE.name, isActive: true },
    declaredModel: 'Kyocera M3145',
    serialNumber: '',
    inventoryNumber: '0012345',
    object: { id: 'obj-1', code: 'ОБ-1', name: 'ЖК Северный' },
    location: 'каб. 214',
    comment: 'стоит у бухгалтерии, наклейки нет',
    author: { id: 'user-9', name: 'Иванов Иван', departmentName: 'Бухгалтерия' },
    createdAt: '2026-09-01T09:00:00.000Z',
    updatedByName: null,
    updatedAt: '2026-09-01T09:00:00.000Z',
    decidedByName: null,
    decidedAt: null,
    decisionReason: '',
    resultEquipment: null,
    request: { id: 'sr-1', num: 14, displayNumber: 'СО-14', status: 'new' },
    ...over,
  };
}

/** Подпись сообщения в очереди — та же, что показывает и заявка: по ней строку и открывают. */
const TITLE = 'Kyocera M3145 · инв. 0012345';

/** Проверяющий: `review` требует `officeEquipment.write` — на нём и держится весь замок (Р8). */
const REVIEWER_RIGHTS: Permission[] = [
  'officeEquipment.read',
  'officeEquipment.write',
  'officeEquipment.review',
  'serviceRequests.read',
];

const REVIEWER: AuthUser = authUser({
  id: 'user-review',
  role: 'shtab',
  constructionObjectIds: ['obj-1'],
  permissions: REVIEWER_RIGHTS,
});

/** Тот же человек без права проверки: подвкладки он не видит вовсе. */
const KEEPER: AuthUser = authUser({
  id: 'user-keeper',
  role: 'shtab',
  constructionObjectIds: ['obj-1'],
  permissions: REVIEWER_RIGHTS.filter((p) => p !== 'officeEquipment.review'),
});

function renderTab(user: AuthUser, over: RouteMap = {}): HttpMock {
  const http = mockHttp({
    'GET /office-equipment': () => json(emptyList<OfficeEquipmentDto>()),
    'GET /office-equipment-types': () => json(list([TYPE])),
    'GET /office-equipment-types/:id/specs': () => json([]),
    'GET /office-equipment-models': () => json(list(MODELS)),
    'GET /objects': () => json(list([objectDto()])),
    'GET /departments': () => json(emptyList()),
    'GET /office-equipment-candidates': () => json(list([candidateDto()])),
    'GET /office-equipment-candidates/:id': () => json(candidateDto()),
    ...over,
  });
  renderWithUser(<EquipmentTab />, { user });
  return http;
}

/** Перейти в очередь и открыть единственную строку — так же, как это делает человек. */
async function openReview() {
  fireEvent.click(await screen.findByText(/На проверке/));
  fireEvent.click(await screen.findByText(TITLE));
  await screen.findByText('Проверка сообщения о технике');
  // Окно перечитывает кандидата своим запросом (Р12): до ответа тело пусто, и проверять в нём
  // нечего — комментарий заявителя и есть признак того, что срез доехал.
  await screen.findAllByText('стоит у бухгалтерии, наклейки нет');
}

describe('подвкладка «На проверке»', () => {
  it('видна проверяющему, считает очередь и спрашивает ожидающих старыми сверху', async () => {
    const http = renderTab(REVIEWER);

    // Счётчик стоит в самой подписи: срока проверки у модуля нет вовсе (В3), и число —
    // единственное, чем очередь заявляет о себе тому, кто зашёл смотреть парк.
    expect(await screen.findByText('На проверке (1)')).toBeDefined();
    const query = http.lastCall('GET /office-equipment-candidates')!.query;
    expect(query.get('status')).toBe('pending');
    // Старые сверху — иначе очередь работала бы как стек, и строка, до которой не дошли руки в
    // первый день, не дождалась бы проверки никогда.
    expect(query.get('sortOrder')).toBe('asc');
  });

  it('без права проверки подвкладки нет, и очередь не спрашивается вовсе', async () => {
    const http = renderTab(KEEPER);
    await waitFor(() => expect(http.countOf('GET /office-equipment')).toBe(1));

    expect(screen.queryByText(/На проверке/)).toBeNull();
    expect(http.countOf('GET /office-equipment-candidates')).toBe(0);
  });
});

describe('окно проверки', () => {
  it('показывает сообщённое, ссылку на заявку и три двери решения', async () => {
    renderTab(REVIEWER);
    await openReview();

    // «Что сообщил заявитель» — с автором: его видит только проверяющий (Р9).
    expect(screen.getByText('Иванов Иван · Бухгалтерия')).toBeDefined();
    expect(screen.getAllByText('стоит у бухгалтерии, наклейки нет').length).toBeGreaterThan(0);
    // Ссылка на заявку обязательна: решение про технику принимают, глядя на то, зачем о ней
    // сообщили, — и видя, не отменили ли заявку, пока сообщение стояло в очереди (Р16).
    expect(screen.getByRole('link', { name: 'СО-14' })).toBeDefined();

    expect(screen.getByRole('button', { name: 'Завести карточку' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Это уже заведённый аппарат' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'Отклонить' })).toBeDefined();
    // Правка реквизитов — тут же и только до решения (Р12).
    expect(screen.getByText('Поправить сообщённое')).toBeDefined();
  });

  it('«Завести карточку» шлёт полную форму парка с версией и гасит парк, модели и расходники', async () => {
    const http = renderTab(REVIEWER, {
      'POST /office-equipment-candidates/:id/confirm': () =>
        json(
          candidateDto({
            status: 'confirmed',
            contentVersion: 4,
            resultEquipment: { id: 'oe-9', title: TITLE },
          }),
        ),
    });
    await openReview();

    // Форма предзаполнена заявленным, а модель выбирает проверяющий: у заявителя она текстом с
    // шильдика, и превратить строку в ссылку справочника может только тот, кто ведёт справочник.
    await selectOption('Модель', 'Kyocera M3145');
    fireEvent.click(screen.getByRole('button', { name: 'Завести карточку' }));

    await waitFor(() =>
      expect(http.countOf('POST /office-equipment-candidates/:id/confirm')).toBe(1),
    );
    const body = http.lastCall('POST /office-equipment-candidates/:id/confirm')
      ?.body as ConfirmOfficeEquipmentCandidateInput;
    expect(body.expectedVersion).toBe(3);
    // Это ЗАВЕДЕНИЕ КАРТОЧКИ, а не «согласен»: в теле полная форма парка, а заявленное перенесено
    // в неё один в один — пределы длин у полей кандидата те же, обрезать при переносе нечего.
    expect(body.equipment.equipmentTypeId).toBe('oet-1');
    expect(body.equipment.modelId).toBe('oem-1');
    expect(body.equipment.inventoryNumber).toBe('0012345');
    expect(body.equipment.objectId).toBe('obj-1');
    expect(body.equipment.location).toBe('каб. 214');

    // Решение рождает запись в парке — значит устаревают и парк, и очередь: без гашения счётчик
    // «В парке» у модели показывал бы вчерашнее число (Н6).
    await waitFor(() => expect(http.countOf('GET /office-equipment')).toBeGreaterThan(1));
    await waitFor(() =>
      expect(http.countOf('GET /office-equipment-candidates')).toBeGreaterThan(1),
    );
  });

  it('устаревшая версия получает 409 и перечитывает состояние, а не перетирает чужое решение', async () => {
    const http = renderTab(REVIEWER, {
      'POST /office-equipment-candidates/:id/confirm': () => ({
        status: 409,
        body: { code: 'version_conflict', message: 'Решение уже принято' },
      }),
    });
    await openReview();
    const before = http.countOf('GET /office-equipment-candidates/:id');

    await selectOption('Модель', 'Kyocera M3145');
    fireEvent.click(screen.getByRole('button', { name: 'Завести карточку' }));

    expect(await screen.findByText(/Решение уже приняли или форма устарела/)).toBeDefined();
    // Карточка перечитывается обязательно: окно, оставшееся с прежней версией, отправило бы её
    // ещё раз и получило бы тот же отказ.
    await waitFor(() =>
      expect(http.countOf('GET /office-equipment-candidates/:id')).toBeGreaterThan(before),
    );
  });
});

describe('отказ и объединение', () => {
  it('причина обязательна и объявлена читаемой заявителем', async () => {
    const http = renderTab(REVIEWER, {
      'POST /office-equipment-candidates/:id/reject': () =>
        json(
          candidateDto({ status: 'rejected', contentVersion: 4, decisionReason: 'В 214 пусто' }),
        ),
    });
    await openReview();
    fireEvent.click(screen.getByRole('button', { name: 'Отклонить' }));

    await screen.findByText('Отклонить сообщение');
    // Подсказка стоит там, где подбирают слова, а не после того, как их прочитал автор (Р15).
    expect(screen.getByText(/Эту строку прочитает заявитель/)).toBeDefined();

    // Пустой отказ не уходит вовсе: «отклонено без объяснения» человек прочитает как «передумали».
    fireEvent.click(screen.getAllByRole('button', { name: 'Отклонить' })[1]!);
    expect(await screen.findByText('Укажите причину отказа')).toBeDefined();
    expect(http.countOf('POST /office-equipment-candidates/:id/reject')).toBe(0);

    fireEvent.change(screen.getByLabelText('Почему аппарат не заводим'), {
      target: { value: 'В 214 пусто' },
    });
    fireEvent.click(screen.getAllByRole('button', { name: 'Отклонить' })[1]!);

    await waitFor(() =>
      expect(http.countOf('POST /office-equipment-candidates/:id/reject')).toBe(1),
    );
    const body = http.lastCall('POST /office-equipment-candidates/:id/reject')
      ?.body as RejectOfficeEquipmentCandidateInput;
    expect(body).toEqual({ reason: 'В 214 пусто', expectedVersion: 3 });
  });

  it('«Это уже заведённый аппарат» отдаёт выбранную карточку и версию', async () => {
    const unit: OfficeEquipmentDto = {
      id: 'oe-1',
      type: { id: TYPE.id, name: TYPE.name, isActive: true },
      specs: [],
      name: 'Kyocera M3145',
      serialNumber: 'SN-7770001',
      inventoryNumber: '0012345',
      object: { id: 'obj-1', code: 'ОБ-1', name: 'ЖК Северный' },
      department: null,
      location: 'каб. 214',
      state: 'on_site',
      stateNote: '',
      purchasedOn: null,
      warrantyUntil: null,
      comment: '',
      isActive: true,
      createdAt: '2026-08-01T09:00:00.000Z',
      updatedAt: '2026-08-01T09:00:00.000Z',
      deletedAt: null,
    };
    const http = renderTab(REVIEWER, {
      'GET /office-equipment': () => json(list([unit])),
      'POST /office-equipment-candidates/:id/merge': () =>
        json(
          candidateDto({
            status: 'duplicate',
            contentVersion: 4,
            resultEquipment: { id: unit.id, title: TITLE },
          }),
        ),
    });
    await openReview();
    fireEvent.click(screen.getByRole('button', { name: 'Это уже заведённый аппарат' }));

    await screen.findByText('Аппарат уже есть в справочнике');
    await selectOption('Какая карточка', TITLE);
    fireEvent.click(screen.getByRole('button', { name: 'Объединить' }));

    await waitFor(() =>
      expect(http.countOf('POST /office-equipment-candidates/:id/merge')).toBe(1),
    );
    const body = http.lastCall('POST /office-equipment-candidates/:id/merge')
      ?.body as MergeOfficeEquipmentCandidateInput;
    expect(body).toEqual({ officeEquipmentId: 'oe-1', expectedVersion: 3 });
  });
});

/**
 * ОБРАТНАЯ СТОРОНА ОЧЕРЕДИ: та же проверка глазами ЗАЯВКИ (план кандидатов, Р5, Р15, Р16, §9).
 *
 * Раздел заведён вместе с полем `equipmentCandidate` в `ServiceRequestDto` и стережёт ровно то, что
 * до его появления не стерёг никто. Плашка состояния и замок приёмки написаны были раньше сервера и
 * читали поле, которого в ответе не было: на экране это выглядело как заявка БЕЗ ПРЕДМЕТА и с
 * обычной, ничем не запертой приёмкой — то есть не ломалось, а молча показывало неправду. Утверждения
 * ниже привязаны к настоящему полю контракта, и вернись оно в «портал читает пустоту», покраснеют
 * оба.
 *
 * Проверяются подписи, а не факт вызова функции: человек читает состояние словами, и «на проверке»
 * без названного аппарата или «отклонён» без причины — это тот же тёмный экран, только заполненный.
 */
describe('состояние предмета в самой заявке', () => {
  const pending = serviceRequest({
    // Карточки парка у такой заявки нет по построению (Р5): предмет называет само сообщение.
    equipment: null,
    equipmentCandidate: {
      id: 'oec-1',
      status: 'pending',
      declaredModel: 'Kyocera M3145',
      serialNumber: '',
      inventoryNumber: '0012345',
      decisionReason: '',
    },
  });

  it('плашка называет предмет сообщением, пока карточки парка нет', () => {
    renderWithUser(<ServiceRequestSubjectName request={pending} />);
    // Подпись предмета — то же, что в очереди проверки и в письме: модель плюс названный номер.
    expect(screen.getAllByText(/Kyocera M3145 · инв\. 0012345/).length).toBeGreaterThan(0);
    expect(screen.getByText(/На проверке/)).toBeDefined();
  });

  it('заявителю плашка та же: реквизиты и решение — не деньги заявки', () => {
    // Аудитория `requester` — тот объём, в котором сервер собирает ответ автору (ADR 0160). Блок
    // кандидата проекция не режет (`SERVICE_REQUEST_FIELD_AUDIENCE`), и сценарий закрепляет это со
    // стороны портала: автор сообщения — главный читатель плашки, а не терпимый.
    renderWithUser(<ServiceRequestSubjectName request={{ ...pending, audience: 'requester' }} />);
    expect(screen.getByText(/На проверке/)).toBeDefined();
  });

  it('отказ печатает причину дословно — за ней автор и приходит', () => {
    const rejected = serviceRequest({
      equipment: null,
      audience: 'requester',
      equipmentCandidate: {
        id: 'oec-1',
        status: 'rejected',
        declaredModel: 'Kyocera M3145',
        serialNumber: '',
        inventoryNumber: '0012345',
        decisionReason: 'В кабинете 214 стоит другой аппарат',
      },
    });
    renderWithUser(<ServiceRequestSubjectName request={rejected} />);
    expect(screen.getByText('Предмет отклонён: В кабинете 214 стоит другой аппарат')).toBeDefined();
  });

  it('обычная заявка плашки не рисует вовсе', () => {
    // Отрицательный контроль: без него все три утверждения выше зеленели бы и на компоненте,
    // который рисует плашку всегда.
    renderWithUser(<ServiceRequestSubjectName request={serviceRequest()} />);
    expect(screen.queryByText(/На проверке/)).toBeNull();
    expect(screen.queryByText(/Предмет отклонён/)).toBeNull();
  });

  it('приёмка заперта, пока решения нет, и словами сервера (Р16)', () => {
    // Текст — контрактная константа, а не строка теста: разойдись меню с ответом сервера, человек
    // прочитал бы два разных отказа и решил, что это две поломки.
    expect(serviceAcceptLock(pending)).toEqual({
      primary: false,
      disabled: true,
      disabledReason: CANDIDATE_PENDING_ACCEPT_REFUSAL,
    });
    // После ЛЮБОГО решения замок снят — включая отказ: иначе заявка навсегда застряла бы в
    // «Решена» из-за справочника (Р16).
    const decided = serviceRequest({
      equipmentCandidate: { ...pending.equipmentCandidate!, status: 'rejected' },
    });
    expect(serviceAcceptLock(decided).disabled).toBe(false);
    expect(serviceAcceptLock(serviceRequest()).disabled).toBe(false);
  });
});
