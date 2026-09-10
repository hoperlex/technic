import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type {
  EarlyEndApprovalPreviewDto,
  SpecialEquipmentRequestDto,
  VehicleOwnership,
} from '@technic/contracts';
import { json, mockHttp, type HttpMock } from './http';
import { renderWithUser } from './render';
import { dateInput, typeDate } from './antd';
import { vehicleRequest } from './factories/vehicle';
import { VehicleEarlyEndModal } from '../src/pages/vehicle/VehicleEarlyEndModal';
import { VehicleEarlyEndApproveModal } from '../src/pages/vehicle/VehicleEarlyEndApproveModal';

/**
 * Окно досрочного завершения заказа спецтехники (ADR 0044, ADR 0178).
 *
 * Проверяется то, что окно **обещает человеку** до нажатия, а не его вёрстка. Обещаний три, и цена
 * у них разная: сколько дней освободится (по ним считают площадку и аренду), что произойдёт по
 * нажатию — виза или сразу срок, — и что случится с бланками строгой отчётности.
 *
 * ТРЕТЬЕ ОБЕЩАНИЕ ПЕРЕЕХАЛО НА СЕРВЕР (ADR 0178, Р19). Прежде окно считало его само: резало срок по
 * календарным неделям и писало «аннулируются листы за такие-то недели, выписываются заново». Тесты
 * здесь держали ту арифметику вровень со сверкой — и вместе с ней ушли. Неправдой она стала дважды:
 * у линейного заказа недель не существует вовсе (листы просят по одной), а сокращение с этой волны
 * лист не перевыписывает, а **правит**, сохраняя номер. Теперь окно показывает то, что посчитал
 * сервер обезличенным предпросмотром, и носит обратно его отпечаток — это и проверяется.
 *
 * «Сегодня» приходит в окно пропом (`onDate`, ADR 0036) — его считает сервер по Москве. Поэтому
 * подмены часов сценариям не нужно; сеть нужна ровно там, где ходят за предпросмотром.
 */

/** Понедельник 03.08.2026; неделя работ — 10–16.08, следующая — 17–23.08. */
const TODAY = '2026-08-12';

/** Назначение заказа: принадлежность машины решает, ведёт ли бумагу портал или арендодатель. */
function assignmentOf(ownership: VehicleOwnership) {
  return {
    vehicleId: 'v-1',
    ownership,
    vehicleKindId: 'vk-special',
    vehicleTypeId: 'vt-1',
    typeName: 'Автокраны',
    vehicleCategoryId: 'vc-1',
    categoryName: 'г/п 25 т',
    categorySpecs: { lift_capacity: 25 },
    modelName: 'КС-45717',
    registrationNumber: 'А111АА77',
    description: '',
    lessorId: null,
    lessorName: null,
    pricePerHour: null,
    pricePerShift: null,
    shiftHours: null,
    assignedBy: 'user-1',
    assignedByName: 'Петров П. П.',
    assignedAt: '2026-08-03T06:00:00.000Z',
  };
}

/**
 * Заказ, который сокращают: своя техника, в работе, срок 03–21.08 — три календарные недели, из
 * которых первая на день прогона уже отработана.
 */
function inWork(overrides: Partial<SpecialEquipmentRequestDto> = {}): SpecialEquipmentRequestDto {
  return vehicleRequest({
    status: 'confirmed',
    dateFrom: '2026-08-03',
    dateTo: '2026-08-21',
    assignment: assignmentOf('own'),
    version: 4,
    ...overrides,
  });
}

/**
 * Обезличенный ответ предпросмотра (Р26): числа и даты — ни номеров бланков, ни фамилий. Ровно то,
 * что сервер отдаёт визирующему, у которого прав на журнал листов нет вовсе.
 */
const PREVIEW: EarlyEndApprovalPreviewDto = {
  newDateTo: '2026-08-14',
  daysSaved: 7,
  paper: { trimmed: 1, cancelled: 2, trimmedTo: '2026-08-14' },
  linearDays: { detachable: [], frozen: [] },
  cancelGroups: [{ effectiveDate: '2026-08-17' }],
  operationRequirement: {
    kind: 'assignment_tail',
    reasonRequired: false,
    operationIdRequired: true,
  },
  asOf: TODAY,
  fingerprint: 'fp-early-end',
  cancelGroupsFingerprint: 'fp-groups',
};

function renderModal(
  request: SpecialEquipmentRequestDto,
  options: {
    approvesOwn?: boolean;
    onSubmit?: (v: unknown) => Promise<unknown> | undefined;
    onDate?: string;
    preview?: EarlyEndApprovalPreviewDto;
  } = {},
): HttpMock {
  const http = mockHttp({
    'POST /vehicle-requests/vr-1/early-end/preview': () => json(options.preview ?? PREVIEW),
  });
  renderWithUser(
    <VehicleEarlyEndModal
      request={request}
      onDate={options.onDate ?? TODAY}
      approvesOwn={options.approvesOwn ?? true}
      confirmLoading={false}
      onCancel={() => {}}
      onSubmit={options.onSubmit ?? (() => undefined)}
    />,
  );
  return http;
}

/** Причина обязательна — её заполняют почти в каждом сценарии, чтобы дойти до отправки. */
function fillReason(text = 'работы на фундаменте закончены'): void {
  const field = screen.getByPlaceholderText(/работы на фундаменте/);
  fireEvent.change(field, { target: { value: text } });
}

/** Причина отказа под своим полем (ADR 0094) — её рисует `Form.Item`, а не тост. */
function fieldError(labelText: string): string | null {
  const label = [...document.querySelectorAll('label')].find(
    (el) => el.textContent?.replace(/\s+/g, ' ').trim() === labelText,
  );
  const item = label?.closest('.ant-form-item');
  return item?.querySelector('.ant-form-item-explain-error')?.textContent ?? null;
}

/** Дойти до второго шага: заполнить форму и попросить у сервера последствия. */
async function showConsequences(): Promise<void> {
  fillReason('фундамент закончен');
  fireEvent.click(screen.getByText('Показать последствия'));
  await screen.findByText('Завершить досрочно');
}

describe('срок и то, что произойдёт по нажатию', () => {
  it('открывается сегодняшним днём и называет заказанный срок', async () => {
    renderModal(inWork());

    // Основание решения — заказанный срок целиком: сокращают именно его.
    expect(await screen.findByText('Заказано: 03.08.2026 – 21.08.2026')).toBeDefined();
    expect(screen.getByText('19 календарных дней')).toBeDefined();
    // Умолчание — сегодня: чаще всего им и заканчивают, «машина уезжает сегодня».
    expect(await screen.findByText('Освободится 9 дн. из заказанных')).toBeDefined();
    expect(dateInput('Последний день работ').value).toBe('12.08.2026');
  });

  it('сдвиг даты пересчитывает, сколько дней освободится', async () => {
    renderModal(inWork());
    await screen.findByText('Освободится 9 дн. из заказанных');

    typeDate('Последний день работ', '14.08.2026');

    // С 21-го до 14-го — семь дней (15…21), а не восемь: оставшийся последним день не в счёт.
    await waitFor(() => expect(screen.getByText('Освободится 7 дн. из заказанных')).toBeDefined());
  });

  /**
   * Границы окно берёт из контрактов (`earlyEndDateBounds`) — теми же их проверяет сервер, и
   * предлагать дату, которую он отклонит, портал не должен. Проверяется именно это: набранный день
   * вне границ формой не принимается, и за последствиями окно идёт с прежней датой, а не с
   * набранной.
   */
  it('дату вне срока заявки окно не принимает', async () => {
    const http = renderModal(inWork());
    await screen.findByText('Освободится 9 дн. из заказанных');

    // Ниже границы — вчера: задним числом период не переписывается.
    typeDate('Последний день работ', '11.08.2026');
    // Выше границы — нынешний конец срока: дата, равная ему, ничего не сокращает.
    typeDate('Последний день работ', '21.08.2026');
    fillReason();
    fireEvent.click(screen.getByText('Показать последствия'));

    await waitFor(() =>
      expect(http.countOf('POST /vehicle-requests/vr-1/early-end/preview')).toBe(1),
    );
    expect(http.lastCall('POST /vehicle-requests/vr-1/early-end/preview')?.body).toMatchObject({
      newDateTo: '2026-08-12',
    });
    expect(await screen.findByText('Освободится 9 дн. из заказанных')).toBeDefined();
  });

  it('без причины запрос не уходит: решает не тот, кто просит', async () => {
    const http = renderModal(inWork());
    await screen.findByText('Освободится 9 дн. из заказанных');

    fireEvent.click(screen.getByText('Показать последствия'));

    await waitFor(() => expect(fieldError('Причина')).toContain('Укажите причину'));
    expect(http.countOf('POST /vehicle-requests/vr-1/early-end/preview')).toBe(0);
  });

  it('кнопка называет то, что произойдёт: сразу или на визу', async () => {
    renderModal(inWork(), { approvesOwn: true });

    // У визирующего следующим шагом идёт разговор о последствиях, а не само сокращение.
    expect(await screen.findByText('Показать последствия')).toBeDefined();
    expect(screen.getByText(/Срок заявки изменится сразу — вы её и визируете/)).toBeDefined();
  });

  it('просящему не обещают завершения — только визу', async () => {
    renderModal(inWork(), { approvesOwn: false });

    expect(await screen.findByText('Отправить на визу')).toBeDefined();
    expect(screen.getByText(/Запрос уйдёт на визу руководителя строительства/)).toBeDefined();
  });
});

describe('что случится с бумагой — считает сервер', () => {
  /**
   * Главная проверка волны ADR 0178: обещание про бланки собрано **из ответа сервера**, а не из
   * календаря на клиенте. Числа в сцене намеренно такие, каких портальная арифметика недель дать не
   * могла бы: один сокращённый лист (номер жив), два аннулированных.
   */
  it('применяющая ветвь показывает числа предпросмотра и не называет недель срока', async () => {
    renderModal(inWork());
    await screen.findByText('Освободится 9 дн. из заказанных');
    typeDate('Последний день работ', '14.08.2026');

    await showConsequences();

    expect(screen.getByText(/1 лист будет сокращено по 14\.08\.2026/)).toBeDefined();
    expect(screen.getByText(/2 листа будет аннулировано/)).toBeDefined();
    // Гашение решений истории — датами вступления в силу, без машин и фамилий (Р26).
    expect(screen.getByText(/Гаснут решения от 17\.08\.2026/)).toBeDefined();
    // Никаких календарных недель: прежнее «аннулируются листы ЭСМ-2: 10.08–16.08» ушло вместе с
    // арифметикой, и вернуться незаметно оно не должно.
    expect(document.body.textContent).not.toContain('10.08.2026–16.08.2026');
  });

  it('подтверждение носит отпечаток предпросмотра и ключ операции', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderModal(inWork(), { onSubmit });
    await screen.findByText('Освободится 9 дн. из заказанных');
    typeDate('Последний день работ', '14.08.2026');
    await showConsequences();

    fireEvent.click(screen.getByText('Завершить досрочно'));

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const body = onSubmit.mock.calls[0]![0] as Record<string, unknown>;
    expect(body).toMatchObject({
      newDateTo: '2026-08-14',
      reason: 'фундамент закончен',
      // Версия — та, что была в окне: правка второго человека обязана получить конфликт.
      version: 4,
      previewFingerprint: 'fp-early-end',
      cancelGroupsFingerprint: 'fp-groups',
    });
    // Ключ операции — свой у каждого открытия окна, поэтому проверяется его наличие, а не значение.
    expect(typeof body.operationId).toBe('string');
  });

  /**
   * Ветвь, уходящая на визу, ничего не применяет: последствий у неё нет, сервер отвечает на такой
   * предпросмотр отказом по существу, а присланное подтверждение отвергает 422 (Р19, Р28). Значит,
   * окно обязано не ходить за предпросмотром и не носить ни отпечатка, ни ключа.
   */
  it('ждущий визы запрос уходит без предпросмотра и без подтверждений', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const http = renderModal(inWork(), { approvesOwn: false, onSubmit });
    await screen.findByText('Освободится 9 дн. из заказанных');

    typeDate('Последний день работ', '14.08.2026');
    fillReason('фундамент закончен');
    fireEvent.click(screen.getByText('Отправить на визу'));

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit).toHaveBeenCalledWith({
      newDateTo: '2026-08-14',
      reason: 'фундамент закончен',
      version: 4,
    });
    expect(http.countOf('POST /vehicle-requests/vr-1/early-end/preview')).toBe(0);
  });

  /**
   * Гасить нечего — отпечатка перечня нет, и слать его нельзя: лишнее подтверждение сервер
   * отвергает так же строго, как недостающее (Р28). Заодно проверяется, что при пустом плане окно
   * не выдумывает последствий.
   */
  it('пустой перечень гашений подтверждением не сопровождается', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderModal(inWork(), {
      onSubmit,
      preview: {
        ...PREVIEW,
        paper: { trimmed: 0, cancelled: 0, trimmedTo: null },
        cancelGroups: [],
        cancelGroupsFingerprint: null,
        operationRequirement: null,
      },
    });
    await screen.findByText('Освободится 9 дн. из заказанных');
    await showConsequences();

    expect(screen.getByText('Останутся как есть: сокращать и аннулировать нечего.')).toBeDefined();
    fireEvent.click(screen.getByText('Завершить досрочно'));

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0]![0]).not.toHaveProperty('cancelGroupsFingerprint');
  });

  /**
   * Линейный заказ (ADR 0100 §5) ведётся режимом `on_demand`: недельных листов портал ему не
   * заводит вовсе — их просят по одной неделе. Прежде окно писало ему отдельную оговорку, потому
   * что считать было нечем; теперь считает сервер, и ответ у линейного заказа такой же по форме —
   * числа. Проверяется, что своей ветки для линейного у окна не осталось.
   */
  it('линейный заказ показывает те же числа, а не особую оговорку', async () => {
    renderModal(inWork({ isLinear: true }), {
      preview: {
        ...PREVIEW,
        paper: { trimmed: 0, cancelled: 1, trimmedTo: null },
        linearDays: { detachable: ['2026-08-17', '2026-08-18'], frozen: ['2026-08-20'] },
      },
    });
    await screen.findByText('Освободится 9 дн. из заказанных');

    await showConsequences();

    expect(screen.getByText(/1 лист будет аннулировано/)).toBeDefined();
    expect(screen.getByText(/17\.08\.2026, 18\.08\.2026/)).toBeDefined();
    // День, по которому уже выписан лист, рейс не отдаст — и об этом сказано отдельно.
    expect(
      screen.getByText(/По ним уже выписан действующий путевой лист: 20\.08\.2026/),
    ).toBeDefined();
    expect(document.body.textContent).not.toContain('выписаны по требованию');
  });
});

describe('виза по чужому запросу', () => {
  /**
   * Виза применяет сокращение — двигает срок, гасит решения о технике и переписывает бумагу, — но
   * делает это спустя часы или дни после обращения и делает **другой человек**. Уходя прямо из
   * строки списка (как было до ADR 0178), она ставилась вслепую. Отсюда своё окно со своим
   * предпросмотром: предпросмотр заявителя здесь не годится и физически не подойдёт — имя двери
   * входит в отпечаток (Р19).
   */
  const pending = () =>
    inWork({
      earlyEnd: {
        status: 'pending',
        newDateTo: '2026-08-14',
        previousDateTo: '2026-08-21',
        reason: 'фундамент закончен',
        requestedBy: 'user-2',
        requestedByName: 'Прорабов П. П.',
        requestedAt: '2026-08-12T06:00:00.000Z',
        decidedBy: null,
        decidedByName: null,
        decidedAt: null,
        decisionComment: '',
      },
    });

  function renderApprove(onSubmit = vi.fn().mockResolvedValue(undefined)): HttpMock {
    const http = mockHttp({
      'POST /vehicle-requests/vr-1/early-end/decision/preview': () => json(PREVIEW),
    });
    renderWithUser(
      <VehicleEarlyEndApproveModal
        request={pending()}
        confirmLoading={false}
        onCancel={() => {}}
        onSubmit={onSubmit}
      />,
    );
    return http;
  }

  it('показывает, о чём просили, и последствия — своим предпросмотром', async () => {
    const http = renderApprove();

    // Основание решения: визирующий площадку в этот момент не видит и решает по написанному.
    expect(await screen.findByText('Просят закончить 14.08.2026 вместо 21.08.2026')).toBeDefined();
    expect(screen.getByText('Прорабов П. П.: фундамент закончен')).toBeDefined();
    // И цена визы — числами сервера: своей арифметики у окна нет.
    expect(screen.getByText(/1 лист будет сокращено по 14\.08\.2026/)).toBeDefined();
    expect(http.countOf('POST /vehicle-requests/vr-1/early-end/decision/preview')).toBe(1);
  });

  it('виза уносит свой отпечаток, ключ операции и версию заявки', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderApprove(onSubmit);
    await screen.findByText(/1 лист будет сокращено/);

    fireEvent.click(screen.getByText('Согласовать'));

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const body = onSubmit.mock.calls[0]![0] as Record<string, unknown>;
    expect(body).toMatchObject({
      approved: true,
      // Слово визирующего окно не спрашивает: причиной операции служит причина самого запроса.
      comment: '',
      previewFingerprint: 'fp-early-end',
      cancelGroupsFingerprint: 'fp-groups',
      version: 4,
    });
    expect(typeof body.operationId).toBe('string');
  });
});
