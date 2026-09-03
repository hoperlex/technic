import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { AuthUser, OfficeEquipmentDto } from '@technic/contracts';
import { json, mockHttp, type HttpMock, type RouteMap } from './http';
import { renderWithUser } from './render';
import { emptyList, list } from './factories/common';
import { serviceOperator, serviceRequest } from './factories/service';
import { objectDto } from './factories/waste';
import { openSelectOptions, selectOption } from './antd';
import { ServiceRequestForm } from '../src/pages/service/ServiceRequestForm';

/**
 * «Аппарат стоит на другом объекте» (Р16, ответ В3) — пара, а не галочка.
 *
 * Проверяется ровно то, что ломается молча и разбирается потом руками ИТ-службы:
 *
 * 1. **пара уходит целиком** — `objectOverridden` вместе с `objectId`. Схема заведения половинок не
 *    принимает (422 и на пометку без объекта, и на объект без пометки), а нетронутая галочка не
 *    шлёт ни того ни другого: присланный сам по себе `objectId` сервер прочёл бы заявлением о
 *    расхождении, которого никто не делал;
 * 2. **смена аппарата уносит пару** — утверждение «стоит не там» относится к КОНКРЕТНОЙ единице.
 *    Выбрали A, заявили расхождение, назвали объект, сменили на B — и оставленная пара говорит про
 *    B то, чего никто не говорил. Сервер такое не отвергнет (он сверяет область заявителя, а не
 *    различие), и в очередь расхождений пришла бы ложная строка, которую разбирал бы живой человек;
 * 3. **список объектов ограничен областью заявителя** — `equipment_object_id` задаёт область
 *    видимости роли объекта, и свободный выбор означал бы, что заявку можно увести из своей области
 *    в чужую;
 * 4. **при правке пары нет вовсе** — заявленный факт историчен: справочник чекбоксом не правят, а
 *    переносит единицу ИТ-служба, разобрав отбор расхождений.
 */

const NORTH = objectDto();
const SOUTH = objectDto({ id: 'obj-2', code: 'ОБ-2', name: 'ЖК Южный' });
/** Чужая площадка: в области заявителя её нет, и в списке она появиться не должна. */
const FOREIGN = objectDto({ id: 'obj-9', code: 'ОБ-9', name: 'ЖК Западный' });

function unit(overrides: Partial<OfficeEquipmentDto> = {}): OfficeEquipmentDto {
  return {
    id: 'oe-1',
    type: { id: 'oet-1', name: 'МФУ', isActive: true },
    specs: [],
    name: 'Kyocera M3145',
    serialNumber: '',
    inventoryNumber: '0012345',
    object: { id: NORTH.id, code: NORTH.code, name: NORTH.name },
    department: null,
    location: 'Корпус 3, каб. 214',
    state: 'on_site',
    stateNote: '',
    purchasedOn: null,
    warrantyUntil: null,
    comment: '',
    isActive: true,
    createdAt: '2026-08-01T09:00:00.000Z',
    updatedAt: '2026-08-01T09:00:00.000Z',
    deletedAt: null,
    ...overrides,
  } as OfficeEquipmentDto;
}

/** Два аппарата: сценарий про сброс без второго не написать — менять было бы не на что. */
const KYOCERA = unit();
const BROTHER = unit({ id: 'oe-2', name: 'Brother HL-1110', inventoryNumber: '0012346' });

/**
 * Заявитель — оператор оргтехники двух площадок. Двух, а не одной: с единственным объектом список
 * сузился бы до одной строки сам собой, и утверждение «поле ограничено областью» осталось бы
 * неотличимым от «в справочнике один объект».
 */
const OPERATOR: AuthUser = serviceOperator({
  constructionObjectIds: [NORTH.id, SOUTH.id],
  phone: '9001234567',
});

function renderForm(
  over: RouteMap = {},
  request = null as null | Parameters<typeof serviceRequest>[0],
): HttpMock {
  const http = mockHttp({
    'GET /office-equipment': () => json(list([KYOCERA, BROTHER])),
    'GET /objects': () => json(list([NORTH, SOUTH, FOREIGN])),
    'GET /departments': () => json(emptyList()),
    'POST /service-requests': () => json({ request: serviceRequest(), mail: 'queued' }, 201),
    ...over,
  });
  renderWithUser(
    <ServiceRequestForm
      open
      request={request ? serviceRequest(request) : null}
      onClose={() => {}}
    />,
    { user: OPERATOR },
  );
  return http;
}

/**
 * Сама галочка. Ищется ожиданием, а не сразу: блок реквизитов появляется вслед за выбранной
 * единицей, а знает о ней `Form.useWatch` — то есть на такте позже самого клика по варианту.
 */
const overrideBox = async () =>
  (await screen.findByRole('checkbox', {
    name: 'Аппарат стоит на другом объекте',
  })) as HTMLInputElement;

/**
 * Заполнить обязательное и отправить. Полей два, и оба к предмету теста отношения не имеют: без
 * описания и без подразделения заявителя форма встанет на СВОИХ правилах, и проверка про пару
 * «пометка + объект» до отправки просто не дойдёт. Подразделение спрашивается потому, что площадок
 * у заявителя две (Н11), — а две они ради сценария про область поля объекта.
 */
async function submit(): Promise<void> {
  fireEvent.change(screen.getByLabelText('Описание'), {
    target: { value: 'Не захватывает бумагу' },
  });
  await selectOption('Откуда обращаетесь', /ЖК Северный/);
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
}

function bodyOf(http: HttpMock): Record<string, unknown> {
  return http.lastCall('POST /service-requests')?.body as Record<string, unknown>;
}

describe('чекбокс «аппарат стоит на другом объекте» (Р16)', () => {
  it('нетронутая галочка не шлёт ни пометки, ни объекта', async () => {
    const http = renderForm();
    await selectOption('Какой аппарат', /Kyocera/);
    expect((await overrideBox()).checked).toBe(false);
    // Поля объекта у нетронутой галочки нет вовсе: выбирать не из чего, пока не заявили расхождение.
    expect(screen.queryByLabelText('Где он на самом деле')).toBeNull();

    await submit();
    await waitFor(() => expect(http.countOf('POST /service-requests')).toBe(1));

    const body = bodyOf(http);
    // `false`, а не пропуск: умолчание заявки — объект из карточки техники, и сказать это надо
    // осознанно. А вот `objectId` не уходит вовсе — присланный сам по себе, он был бы заявлением.
    expect(body.objectOverridden).toBe(false);
    expect('objectId' in body).toBe(false);
  });

  it('заявленное расхождение уходит парой: пометка вместе с объектом', async () => {
    const http = renderForm();
    await selectOption('Какой аппарат', /Kyocera/);

    fireEvent.click(await overrideBox());
    await selectOption('Где он на самом деле', /ЖК Южный/);
    await submit();
    await waitFor(() => expect(http.countOf('POST /service-requests')).toBe(1));

    const body = bodyOf(http);
    expect(body.objectOverridden).toBe(true);
    expect(body.objectId).toBe(SOUTH.id);
  });

  it('список объектов ограничен областью заявителя: чужой площадки в нём нет', async () => {
    renderForm();
    await selectOption('Какой аппарат', /Kyocera/);
    fireEvent.click(await overrideBox());

    // Справочник отдал три площадки, поле показывает две: чужую сервер всё равно отбил бы 422, и
    // предлагать её значило бы звать увести заявку из своей области видимости.
    const options = (await openSelectOptions('Где он на самом деле')).map(
      (el) => el.textContent ?? '',
    );
    expect(options).toContain('ОБ-1 — ЖК Северный');
    expect(options).toContain('ОБ-2 — ЖК Южный');
    expect(options).not.toContain('ОБ-9 — ЖК Западный');
  });

  it('снятая галочка уносит и выбранный объект', async () => {
    const http = renderForm();
    await selectOption('Какой аппарат', /Kyocera/);

    fireEvent.click(await overrideBox());
    await selectOption('Где он на самом деле', /ЖК Южный/);
    // Сняли — поле ушло с экрана вместе со значением: половинками пару не принимают.
    fireEvent.click(await overrideBox());
    await waitFor(() => expect(screen.queryByLabelText('Где он на самом деле')).toBeNull());

    await submit();
    await waitFor(() => expect(http.countOf('POST /service-requests')).toBe(1));
    const body = bodyOf(http);
    expect(body.objectOverridden).toBe(false);
    expect('objectId' in body).toBe(false);
  });

  /**
   * Тот самый сценарий, ради которого правило живёт у самой пары, а не у формы: смена аппарата.
   *
   * Без сброса заявка ушла бы с чужим утверждением — «Brother стоит не на своём объекте», — и
   * сервер её принял бы: он сверяет область заявителя, а не различие. Разбирала бы её ИТ-служба
   * руками, в очереди расхождений.
   */
  it('смена аппарата уносит пару целиком: заявляли про другую единицу', async () => {
    const http = renderForm();
    await selectOption('Какой аппарат', /Kyocera/);
    fireEvent.click(await overrideBox());
    await selectOption('Где он на самом деле', /ЖК Южный/);
    await waitFor(async () => expect((await overrideBox()).checked).toBe(true));

    await selectOption('Какой аппарат', /Brother/);

    // Обе половины разом: галочка снята, поле объекта убрано. Снятая наполовину пара стоила бы
    // человеку 422 там, где он ничего не заявлял.
    await waitFor(async () => expect((await overrideBox()).checked).toBe(false));
    expect(screen.queryByLabelText('Где он на самом деле')).toBeNull();

    await submit();
    await waitFor(() => expect(http.countOf('POST /service-requests')).toBe(1));
    const body = bodyOf(http);
    expect(body.officeEquipmentId).toBe(BROTHER.id);
    expect(body.objectOverridden).toBe(false);
    expect('objectId' in body).toBe(false);
  });

  it('при правке пары нет вовсе, а заявленный факт показан строкой', async () => {
    renderForm({}, { objectOverridden: true, objectMismatch: true });
    // Правка объекта не меняет: факт историчен, а единицу переносит ИТ-служба в справочнике.
    expect(await screen.findByText('объект указал заявитель')).toBeDefined();
    expect(screen.queryByRole('checkbox', { name: 'Аппарат стоит на другом объекте' })).toBeNull();
  });
});
