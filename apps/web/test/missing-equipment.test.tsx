import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type {
  AuthUser,
  CreateServiceRequestInput,
  OfficeEquipmentDto,
  OfficeEquipmentTypeDto,
  Permission,
} from '@technic/contracts';
import { selectOption } from './antd';
import { json, mockHttp, type RouteMap } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { emptyList, list } from './factories/common';
import { objectDto } from './factories/waste';
import { ServiceRequestForm } from '../src/pages/service/ServiceRequestForm';

/**
 * Тупик «нужной техники нет в справочнике» разбирается ТРЕМЯ ветвями (план
 * `docs/office-equipment-candidate-plan.md`, §9), и различает их не роль, а то, что человеку
 * разрешено сделать с этим тупиком.
 *
 * Ошибка в развилке ничем другим не ловится: перепутанное условие показало бы заявителю форму
 * заведения карточки (её сервер встретит 403 после одиннадцати заполненных полей), а проверяющему —
 * окно «Сообщить об аппарате», то есть предложило бы сообщить самому себе о технике, которую он же
 * и заводит.
 *
 * Второе, что закрепляется здесь, — ОКНО НИЧЕГО НЕ ОТПРАВЛЯЕТ САМО (Р2). Кандидат и заявка рождаются
 * одной транзакцией одного `POST /service-requests`; отдельный вход оставлял бы кандидатов-сирот
 * при каждом обрыве. Проверяется это счётчиком запросов, а не видом экрана: окно, закрывшееся после
 * отправки, выглядит точно так же, как окно, заполнившее форму.
 */

const TYPES: OfficeEquipmentTypeDto[] = [
  {
    id: 'oet-1',
    code: 'mfu',
    name: 'МФУ',
    sortOrder: 1,
    isActive: true,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  },
  {
    id: 'oet-2',
    code: 'printer',
    name: 'Принтер',
    sortOrder: 2,
    isActive: true,
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
  },
];

/** Карточка, которая якобы уже есть в парке: ею сервер отвечает на 409 дубля (Р10). */
function equipmentDto(): OfficeEquipmentDto {
  return {
    id: 'oe-1',
    type: { id: 'oet-1', name: 'МФУ', isActive: true },
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
}

/** Права заявителя: заводить заявки и читать справочник — их требует и сам `propose` (Р8). */
const REQUESTER: Permission[] = [
  'serviceRequests.create',
  'serviceRequests.read',
  'officeEquipment.read',
];

/** Ведёт справочник: тупик разбирается заведением карточки, как и до кандидатов. */
const OPERATOR: AuthUser = authUser({
  role: 'shtab',
  constructionObjectIds: ['obj-1'],
  addons: ['office_equipment_operator'],
});

/** Сообщает о технике: карточку завести не может, но его свидетельство проходит проверку. */
const PROPOSER: AuthUser = authUser({
  role: 'shtab',
  constructionObjectIds: ['obj-1'],
  permissions: [...REQUESTER, 'officeEquipment.propose'],
});

/** Ни того ни другого: до выпуска B прав не выдано никому, и это самая частая учётка. */
const PLAIN: AuthUser = authUser({
  role: 'shtab',
  constructionObjectIds: ['obj-1'],
  permissions: REQUESTER,
});

/** Заголовки `mockHttp` не журналирует, а ключ идемпотентности живёт именно заголовком (§8). */
interface SentRequest {
  path: string;
  method: string;
  headers: Record<string, string>;
}

function renderForm(user: AuthUser, over: RouteMap = {}) {
  const http = mockHttp({
    // Справочник пуст — это и есть разбираемый тупик: искомой техники в нём нет.
    'GET /office-equipment': () => json(emptyList()),
    'GET /office-equipment-types': () => json(list(TYPES)),
    'GET /objects': () => json(list([objectDto()])),
    'GET /departments': () => json(emptyList()),
    ...over,
  });
  const sent: SentRequest[] = [];
  const inner = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    sent.push({
      path: new URL(raw, window.location.origin).pathname,
      method: init?.method ?? 'GET',
      headers: { ...((init?.headers as Record<string, string> | undefined) ?? {}) },
    });
    return inner(input, init);
  }) as typeof globalThis.fetch;
  renderWithUser(<ServiceRequestForm open request={null} onClose={() => {}} />, { user });
  return { http, sent };
}

const fill = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

/** Заполнить окно «Сообщить об аппарате» и вернуть заявленное в форму заявки. */
async function reportEquipment() {
  fireEvent.click(await screen.findByText('Не нашли технику?'));
  await screen.findByText('Сообщить об аппарате');
  await selectOption('Что за аппарат', 'МФУ');
  fill('Модель с шильдика', 'Kyocera M3145');
  fill('Инвентарный номер', '0012345');
  fill('Место', 'каб. 214');
  fireEvent.click(screen.getByRole('button', { name: 'Отправить с заявкой' }));
  // Плашка — признак того, что черновик доехал до формы заявки: `form.submit()` окна асинхронен,
  // и без ожидания следующий шаг заполнял бы форму, в которой сообщения ещё нет.
  await screen.findByText(/^Аппарат на проверке: /);
}

/** Заявка заполняется до конца: без телефона и описания её не отправит ни форма, ни сервер. */
function fillRequest() {
  fill('Описание', 'Мнёт бумагу на каждой второй странице');
  fill('Телефон для связи', '+7 999 000-00-00');
}

describe('три ветви «Не нашли технику?»', () => {
  it('у того, кто ведёт справочник, открывается заведение карточки', async () => {
    renderForm(OPERATOR);
    fireEvent.click(await screen.findByText('Не нашли технику?'));

    expect(await screen.findByText('Новая единица оргтехники')).toBeDefined();
    // Ветка `write` идёт первой намеренно: у проверяющего есть оба права, и сообщать самому себе о
    // технике, которую он же и заводит, ему незачем.
    expect(screen.queryByText('Сообщить об аппарате')).toBeNull();
  });

  it('у заявителя с правом сообщать открывается окно кандидата', async () => {
    renderForm(PROPOSER);
    fireEvent.click(await screen.findByText('Не нашли технику?'));

    expect(await screen.findByText('Сообщить об аппарате')).toBeDefined();
    // Ни формы карточки парка, ни совета про поддержку: у человека есть свой выход из тупика.
    expect(screen.queryByText('Новая единица оргтехники')).toBeNull();
    expect(screen.queryByText('Карточки нет в справочнике')).toBeNull();
    // Фото просят, но не требуют (Р7, В4): снимок снимает половину работы проверяющего, а
    // запертая на вложении заявка означает несделанную заявку.
    expect(screen.getByText(/Приложите фото шильдика/)).toBeDefined();
  });

  it('без обоих прав остаётся сегодняшний текст обращения в техподдержку', async () => {
    renderForm(PLAIN);
    fireEvent.click(await screen.findByText('Не нашли технику?'));

    expect(await screen.findByText('Карточки нет в справочнике')).toBeDefined();
    expect(screen.queryByText('Сообщить об аппарате')).toBeNull();
  });
});

describe('окно кандидата заполняет форму, а не отправляет', () => {
  it('после «Отправить с заявкой» запросов нет, а под полем стоит плашка', async () => {
    const { http } = renderForm(PROPOSER);
    await reportEquipment();

    // ГЛАВНОЕ: сеть не тронута. Отдельной ручки у кандидата нет вовсе (Р2).
    expect(http.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    // Плашка называет аппарат словами и оставляет обе двери — поправить и убрать.
    expect(
      await screen.findByText('Аппарат на проверке: Kyocera M3145 · инв. 0012345'),
    ).toBeDefined();
    expect(screen.getByText(/МФУ · ОБ-1 — ЖК Северный · каб. 214/)).toBeDefined();
    expect(screen.getByRole('button', { name: 'Поправить' })).toBeDefined();
  });

  it('заявка уходит одним «Сохранить» — с кандидатом в теле и ключом идемпотентности', async () => {
    const created = { request: { id: 'sr-1', displayNumber: 'СО-1' }, mail: null };
    const { http, sent } = renderForm(PROPOSER, {
      'POST /service-requests': () => json(created, 201),
    });
    await reportEquipment();
    fillRequest();
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));

    await waitFor(() => expect(http.countOf('POST /service-requests')).toBe(1));
    const body = http.lastCall('POST /service-requests')?.body as CreateServiceRequestInput;
    expect(body.equipmentCandidate).toEqual({
      equipmentTypeId: 'oet-1',
      declaredModel: 'Kyocera M3145',
      serialNumber: '',
      inventoryNumber: '0012345',
      objectId: 'obj-1',
      location: 'каб. 214',
      comment: '',
    });
    /*
     * Единицы в теле НЕТ ВОВСЕ, и это не то же самое, что `null`: схема отличает «аппарата у заявки
     * нет» (законный ответ держателя `createWithoutEquipment`) от «предмет назван дважды» и на
     * второе отвечает отказом.
     */
    expect('officeEquipmentId' in body).toBe(false);
    // Объект верхнего уровня и пометка «не тот объект» ветке кандидата тоже запрещены: место
    // называет само сообщение.
    expect(body.objectId).toBeUndefined();
    expect(body.objectOverridden).toBe(false);
    // Ключ идемпотентности — заголовком и в формате UUID: тело заводит сразу две строки, и
    // потерянный успешный ответ стоил бы человеку второй пары.
    const post = sent.find((r) => r.method === 'POST' && r.path.endsWith('/service-requests'));
    expect(post?.headers['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/u);
  });
});

describe('409 «такой аппарат в справочнике уже есть»', () => {
  it('активный дубль своей области встаёт в поле, а сообщение снимается', async () => {
    const { http } = renderForm(PROPOSER, {
      'POST /service-requests': () => ({
        status: 409,
        body: {
          code: 'office_equipment_candidate_park_duplicate',
          message: 'Такой аппарат уже заведён карточкой',
          details: {
            kind: 'parkDuplicate',
            officeEquipmentId: 'oe-1',
            title: 'Kyocera M3145 · инв. 0012345',
          },
        },
      }),
      // Подставленная единица дочитывается по идентификатору: в выдаче поля её нет — поиск ничего
      // не находил, потому и сообщали.
      'GET /office-equipment/:id': () => json(equipmentDto()),
    });
    await reportEquipment();
    fillRequest();
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));

    await waitFor(() => expect(http.countOf('POST /service-requests')).toBe(1));
    // Портал продолжает заявку сам: сообщение о технике снято — иначе следующая отправка ушла бы
    // с двумя предметами сразу и получила бы уже отказ схемы.
    await waitFor(() =>
      expect(screen.queryByText('Аппарат на проверке: Kyocera M3145 · инв. 0012345')).toBeNull(),
    );
    // И объясняет словами, что произошло: человек искал этот аппарат и не нашёл.
    expect(await screen.findByText(/уже есть в справочнике/)).toBeDefined();
  });
});
