import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { AuthUser, DeviceMailSampleDto, DeviceParseRuleDto } from '@technic/contracts';
import { apiError, json, mockHttp, type HttpMock, type RouteMap } from './http';
import { renderWithUser } from './render';
import { selectOption } from './antd';
import { authUser } from './factories/auth';
import {
  DeviceRulesBoard,
  RULES_EMPTY_TEXT,
  SAMPLES_EMPTY_TEXT,
  SAMPLES_FAILED_TEXT,
  SAMPLES_LIMIT_HINT,
} from '../src/features/device-mail-rules';

/**
 * ПРАВИЛА РАЗБОРА (план `docs/office-equipment-mail-identity-ui-plan.md`, §6.2) против замороженных
 * DTO.
 *
 * Проверяется то, ради чего экран написан именно так:
 *
 *   1. ПУСТОЙ СПИСОК — НОРМА, и подпись это говорит: правило заводят под формат, который портал не
 *      понял, и до первого такого письма правил не бывает;
 *   2. УДАЛЕНИЕ ПОКАЗЫВАЕТСЯ ТОЛЬКО ТАМ, ГДЕ ОНО ЗАКОННО (`canDelete` с сервера): по правилу, при
 *      жизни которого разбирали письма, кнопка обещала бы то, чем сервер ответит отказом;
 *   3. ПРОВЕРКА НА ПИСЬМЕ НИЧЕГО НЕ СОХРАНЯЕТ и показывает, ЧТО ИМЕННО вынулось: ради этого она и
 *      стоит в форме — ошибку в правиле метрики иначе заметить некому;
 *   4. ОТКАЗ ПО ВЫРАЖЕНИЮ ДОЕЗЖАЕТ СЛОВАМИ: опасное выражение правит человек, и «ошибка» вместо
 *      причины оставила бы его без единственной подсказки;
 *   5. УСЛОВИЕ ПО МОДЕЛИ ДОЕЗЖАЕТ ДО СЕРВЕРА И ВИДНО В СПИСКЕ: сравнивает модели сервер, портал
 *      лишь передаёт строку, — но потерянное по дороге поле молча расширило бы правило на весь
 *      парк (ADR 0204);
 *   6. ПИСЬМО ДЛЯ ПРОВЕРКИ БЕРЁТСЯ ИЗ СПИСКА, а пустой список объясняет себя словами: набирать
 *      идентификатор письма руками человеку неоткуда, а письмо без сохранённого сырья отвечало бы
 *      отказом, который читается как ошибка правила;
 *   7. УПАВШИЙ СПИСОК НЕ ВЫДАЁТ СЕБЯ ЗА ПУСТОЙ: «писем нет» о неудавшемся запросе — это ложь,
 *      после которой человек идёт искать причину в приёмнике, а не нажимает «Повторить»;
 *   8. НЕ ПОДОШЕДШЕЕ УСЛОВИЕ НЕ НАЗЫВАЕТСЯ «НИЧЕГО НЕ НАШЛОСЬ»: выражение в этом случае не
 *      запускалось вовсе, и человек правил бы единственное, что работало.
 *
 * ОКНО ВЫБИРАЕТСЯ ЯВНО (`inModal`): доска держит форму дважды — заведение и правку, — а закрытое
 * окно antd из разметки не убирает, и поиск по всему документу берёт поле закрытого окна.
 */

const REVIEWER: AuthUser = authUser({
  role: 'manager',
  grantPermissions: ['officeEquipment.read', 'officeEquipment.telemetry'],
});

function rule(over: Partial<DeviceParseRuleDto> = {}): DeviceParseRuleDto {
  return {
    id: 'rule-1',
    target: 'identity',
    keyKind: 'serial',
    metricCode: null,
    component: null,
    valueForm: null,
    matchKind: 'label',
    expression: 'machine id',
    scope: 'any',
    whenProfile: null,
    whenFrom: '',
    whenSubject: '',
    whenModel: '',
    sortOrder: 100,
    isEnabled: true,
    updatedAt: '2026-09-18T06:00:00.000Z',
    updatedByName: 'Иванов И. И.',
    canDelete: true,
    ...over,
  };
}

/** Письмо-образец: то немногое, что нужно, чтобы отличить одно письмо от другого глазами. */
function sample(over: Partial<DeviceMailSampleDto> = {}): DeviceMailSampleDto {
  return {
    id: '11111111-1111-1111-1111-111111111111',
    receivedAt: '2026-09-18T06:00:00.000Z',
    subject: 'Counter report',
    fromAddress: 'mfp@company.ru',
    status: 'unmatched',
    ...over,
  };
}

/** Запросы внутри одного окна: у второго экземпляра формы поля называются так же. */
function inModal(title: string) {
  const heading = [...document.querySelectorAll('.ant-modal-title')].find(
    (el) => el.textContent === title,
  );
  if (!heading) throw new Error(`окна «${title}» на экране нет`);
  return within(heading.closest('.ant-modal') as HTMLElement);
}

/** Само окно — для `selectOption`, которому нужна область поиска подписи. */
function modalEl(title: string): HTMLElement {
  const heading = [...document.querySelectorAll('.ant-modal-title')].find(
    (el) => el.textContent === title,
  );
  if (!heading) throw new Error(`окна «${title}» на экране нет`);
  return heading.closest('.ant-modal') as HTMLElement;
}

/**
 * Нажать «Проверить», дождавшись, пока кнопка отопрётся.
 *
 * Ждать приходится по делу: выбранное письмо форма отдаёт через `Form.useWatch`, а он приносит
 * новое значение следующим проходом отрисовки. Нажатие сразу после выбора пришлось бы на ещё
 * запертую кнопку и не сделало бы ничего — молча, без единого падения.
 */
async function clickCheck(title = 'Новое правило разбора'): Promise<void> {
  const button = inModal(title).getByRole('button', { name: 'Проверить' }) as HTMLButtonElement;
  await waitFor(() => expect(button.disabled).toBe(false));
  fireEvent.click(button);
}

function renderBoard(over: RouteMap = {}): HttpMock {
  const http = mockHttp({
    'GET /device-mail/rules': () => json({ items: [rule()] }),
    'GET /device-mail/rules/samples': () => json({ items: [sample()] }),
    ...over,
  });
  renderWithUser(<DeviceRulesBoard />, { user: REVIEWER });
  return http;
}

describe('правила разбора', () => {
  it('показывает, что правило достаёт и чем ищет', async () => {
    renderBoard();
    expect(await screen.findByText('Серийный номер')).toBeDefined();
    expect(screen.getByText('machine id')).toBeDefined();
    expect(screen.getByText(/Метка перед значением/)).toBeDefined();
    expect(screen.getByText('к любому письму')).toBeDefined();
    expect(screen.getByText('Применяется')).toBeDefined();
  });

  it('пустой список объясняет, что это норма', async () => {
    renderBoard({ 'GET /device-mail/rules': () => json({ items: [] }) });
    expect(await screen.findByText(RULES_EMPTY_TEXT)).toBeDefined();
  });

  it('удаление предлагается только там, где сервер его разрешил', async () => {
    renderBoard({ 'GET /device-mail/rules': () => json({ items: [rule({ canDelete: false })] }) });
    expect(await screen.findByRole('button', { name: 'Изменить' })).toBeDefined();
    expect(screen.queryByRole('button', { name: 'Удалить' })).toBeNull();
  });

  it('проверка на письме ничего не сохраняет и называет найденное', async () => {
    const http = renderBoard({
      'POST /device-mail/rules/preview': () =>
        json({
          applies: true,
          found: true,
          rawValue: 'W512P900123',
          value: 'W512P900123',
          unitLabel: '',
          resolution: { status: 'matched', equipmentId: 'eq-1', equipmentTitle: 'Ricoh · инв. 3282' },
          note: 'С этим ключом письмо опознаёт аппарат: Ricoh · инв. 3282',
        }),
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Новое правило' }));
    fireEvent.change(await screen.findByPlaceholderText('Например: machine id'), {
      target: { value: 'serial number' },
    });
    await selectOption('Письмо для проверки', /Counter report/);
    await clickCheck();

    expect(await screen.findByText(/Нашлось: W512P900123/)).toBeDefined();
    expect(screen.getByText(/опознаёт аппарат/)).toBeDefined();
    // Проверка не пишет: ни создания, ни правки не ушло.
    expect(http.countOf('POST /device-mail/rules')).toBe(0);
    expect(http.lastCall('POST /device-mail/rules/preview')?.body).toMatchObject({
      messageId: '11111111-1111-1111-1111-111111111111',
      rule: { target: 'identity', keyKind: 'serial', expression: 'serial number' },
    });
  });

  it('письмо для проверки выбирается из списка, и уезжает id выбранного', async () => {
    const http = renderBoard({
      'GET /device-mail/rules/samples': () =>
        json({
          items: [
            sample(),
            sample({
              id: '22222222-2222-2222-2222-222222222222',
              subject: '',
              fromAddress: '',
              receivedAt: '2026-09-19T06:00:00.000Z',
            }),
          ],
        }),
      'POST /device-mail/rules/preview': () =>
        json({
          applies: true,
          found: false,
          rawValue: '',
          value: '',
          unitLabel: '',
          resolution: { status: 'unmatched', equipmentId: null, equipmentTitle: '' },
          note: 'В этом письме метка не встретилась',
        }),
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Новое правило' }));
    fireEvent.change(await screen.findByPlaceholderText('Например: machine id'), {
      target: { value: 'machine id' },
    });
    // Письмо без темы и без отправителя обязано остаться различимым: иначе выбирать его человеку
    // не из чего, а именно такие письма и не разобрались.
    await selectOption('Письмо для проверки', /без темы · отправитель не указан/);
    await clickCheck();

    expect(await screen.findByText(/Ничего не нашлось/)).toBeDefined();
    expect(http.lastCall('POST /device-mail/rules/preview')?.body).toMatchObject({
      messageId: '22222222-2222-2222-2222-222222222222',
    });
  });

  it('когда образцов нет, причина названа словами', async () => {
    renderBoard({ 'GET /device-mail/rules/samples': () => json({ items: [] }) });

    fireEvent.click(await screen.findByRole('button', { name: 'Новое правило' }));
    expect(await screen.findByText(SAMPLES_EMPTY_TEXT)).toBeDefined();
    // «Проверить» при этом не обещает того, чего нельзя сделать.
    expect(screen.getByRole('button', { name: 'Проверить' })).toHaveProperty('disabled', true);
  });

  it('условие по модели уходит на сервер и видно в списке', async () => {
    const http = renderBoard({
      'GET /device-mail/rules': () => json({ items: [rule({ whenModel: 'MP C2011' })] }),
      'POST /device-mail/rules': () => json(rule({ whenModel: 'MP C2011' })),
    });

    expect(await screen.findByText(/модель «MP C2011»/)).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: 'Новое правило' }));
    fireEvent.change(await screen.findByPlaceholderText('Например: machine id'), {
      target: { value: 'serial number' },
    });
    fireEvent.change(screen.getByPlaceholderText('Часть названия модели'), {
      target: { value: 'MP C2011' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));

    await waitFor(() =>
      expect(http.lastCall('POST /device-mail/rules')?.body).toMatchObject({
        target: 'identity',
        expression: 'serial number',
        whenModel: 'MP C2011',
      }),
    );
  });

  it('упавший список писем назван отказом, а не пустотой, и повторяется на месте', async () => {
    let attempts = 0;
    renderBoard({
      'GET /device-mail/rules/samples': () => {
        attempts += 1;
        return attempts === 1
          ? apiError(503, { code: 'service_unavailable', message: 'база не отвечает' })
          : json({ items: [sample()] });
      },
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Новое правило' }));
    const add = inModal('Новое правило разбора');
    expect(await add.findByText(SAMPLES_FAILED_TEXT)).toBeDefined();
    // Отказ — это НЕ «писем нет»: перепутав их, человек пошёл бы искать причину в приёмнике.
    expect(screen.queryByText(SAMPLES_EMPTY_TEXT)).toBeNull();

    // Вторая попытка делается на месте, а не закрытием и открытием окна.
    fireEvent.click(add.getByRole('button', { name: 'Повторить' }));
    expect(await add.findByText(SAMPLES_LIMIT_HINT)).toBeDefined();
    await selectOption('Письмо для проверки', /Counter report/, modalEl('Новое правило разбора'));
  });

  it('не подошедшее условие не выдаёт себя за ненайденное значение', async () => {
    renderBoard({
      'POST /device-mail/rules/preview': () =>
        json({
          applies: false,
          found: false,
          rawValue: '',
          value: '',
          unitLabel: '',
          resolution: { status: 'unmatched', equipmentId: null, equipmentTitle: '' },
          note:
            'Правило писано для модели MP C2011, а у письма модель IM C3000 ' +
            '(из карточки аппарата)',
        }),
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Новое правило' }));
    const add = inModal('Новое правило разбора');
    fireEvent.change(await add.findByPlaceholderText('Например: machine id'), {
      target: { value: 'machine id' },
    });
    await selectOption('Письмо для проверки', /Counter report/, modalEl('Новое правило разбора'));
    await clickCheck();

    expect(await add.findByText('Правило к этому письму не применяется')).toBeDefined();
    expect(add.getByText(/из карточки аппарата/)).toBeDefined();
    // «Ничего не нашлось» здесь было бы ложью: выражение не запускалось вовсе.
    expect(screen.queryByText('Ничего не нашлось')).toBeNull();

    // Правка правила гасит ответ: он получен по ДРУГОМУ выражению и подтверждал бы не то.
    fireEvent.change(add.getByPlaceholderText('Например: machine id'), {
      target: { value: 'serial number' },
    });
    await waitFor(() =>
      expect(screen.queryByText('Правило к этому письму не применяется')).toBeNull(),
    );
  });

  it('письмо проверки не уезжает в тело сохранения правила', async () => {
    const http = renderBoard({ 'POST /device-mail/rules': () => json(rule()) });

    fireEvent.click(await screen.findByRole('button', { name: 'Новое правило' }));
    const add = inModal('Новое правило разбора');
    fireEvent.change(await add.findByPlaceholderText('Например: machine id'), {
      target: { value: 'serial number' },
    });
    await selectOption('Письмо для проверки', /Counter report/, modalEl('Новое правило разбора'));
    fireEvent.click(add.getByRole('button', { name: 'Сохранить' }));

    // Набор ключей сверяется ЦЕЛИКОМ: `toMatchObject` лишнего поля не заметит, а схема правила на
    // сервере `.strict()` — уехавший черновик проверки отказал бы всему сохранению.
    await waitFor(() => expect(http.countOf('POST /device-mail/rules')).toBe(1));
    const body = http.lastCall('POST /device-mail/rules')?.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(
      [
        'expression',
        'isEnabled',
        'keyKind',
        'matchKind',
        'scope',
        'sortOrder',
        'target',
        'whenFrom',
        'whenModel',
        'whenProfile',
        'whenSubject',
      ].sort(),
    );
  });

  it('правка подставляет условие по модели и возвращает его серверу', async () => {
    const http = renderBoard({
      'GET /device-mail/rules': () => json({ items: [rule({ whenModel: 'MP C2011' })] }),
      'PATCH /device-mail/rules/:id': () => json(rule({ whenModel: 'MP C2011SP' })),
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Изменить' }));
    const edit = inModal('Правило разбора');
    const model = (await edit.findByPlaceholderText(
      'Часть названия модели',
    )) as HTMLInputElement;
    // Не подставленное поле молча сняло бы условие с чужого правила на первой же правке.
    await waitFor(() => expect(model.value).toBe('MP C2011'));

    fireEvent.change(model, { target: { value: 'MP C2011SP' } });
    fireEvent.click(edit.getByRole('button', { name: 'Сохранить' }));

    await waitFor(() =>
      expect(http.lastCall('PATCH /device-mail/rules/rule-1')?.body).toMatchObject({
        whenModel: 'MP C2011SP',
      }),
    );

    // Правка чужого правила не протекает в окно заведения — форм две, и они не общие.
    fireEvent.click(screen.getByRole('button', { name: 'Новое правило' }));
    const add = inModal('Новое правило разбора');
    await waitFor(() =>
      expect((add.getByPlaceholderText('Часть названия модели') as HTMLInputElement).value).toBe(
        '',
      ),
    );
  });

  it('отказ по опасному выражению доезжает словами', async () => {
    renderBoard({
      'POST /device-mail/rules': () =>
        apiError(422, {
          code: 'unprocessable_entity',
          message: 'повтор навешен на группу, которая сама повторяется, — такое выражение вешает разбор',
        }),
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Новое правило' }));
    fireEvent.change(await screen.findByPlaceholderText('Например: machine id'), {
      target: { value: '(a+)+$' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));

    await waitFor(() => expect(screen.getByText(/вешает разбор/)).toBeDefined());
  });
});
