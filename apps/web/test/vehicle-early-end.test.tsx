import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import type { SpecialEquipmentRequestDto, VehicleOwnership } from '@technic/contracts';
import { renderWithUser } from './render';
import { dateInput, typeDate } from './antd';
import { vehicleRequest } from './factories/vehicle';
import { VehicleEarlyEndModal } from '../src/pages/vehicle/VehicleEarlyEndModal';

/**
 * Окно досрочного завершения заказа спецтехники (ADR 0044).
 *
 * Проверяется то, что окно **обещает человеку** до нажатия, а не его вёрстка. Обещаний три, и цена
 * у них разная: сколько дней освободится (по ним считают площадку и аренду), что произойдёт по
 * нажатию — виза или сразу срок, — и сколько бланков строгой отчётности при этом сгорит. Последнее
 * окно считает **само** (`esm2Periods`), и до появления серверного предпросмотра у этой двери
 * тесты здесь — единственное, что держит обещание вровень со сверкой (`docs/assignment-periods-plan.md`,
 * Ю10; метка `ЭСМ2-РАЗРЕЗ` стоит в самом окне).
 *
 * «Сегодня» приходит в окно пропом (`onDate`, ADR 0036) — его считает сервер по Москве. Поэтому ни
 * подмены часов, ни сети сценариям не нужно: окно — чистая форма на пропах.
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

function renderModal(
  request: SpecialEquipmentRequestDto,
  options: { approvesOwn?: boolean; onSubmit?: (v: unknown) => void; onDate?: string } = {},
) {
  renderWithUser(
    <VehicleEarlyEndModal
      request={request}
      onDate={options.onDate ?? TODAY}
      approvesOwn={options.approvesOwn ?? true}
      confirmLoading={false}
      onCancel={() => {}}
      onSubmit={options.onSubmit ?? (() => {})}
    />,
  );
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

/** Что обещано про бланки: `null` — окно про листы молчит вовсе. */
function waybillsNote(): string | null {
  const found = [...document.querySelectorAll('.ant-typography')].find((el) =>
    el.textContent?.includes('ЭСМ-2'),
  );
  return found?.textContent ?? null;
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
   * вне границ формой не принимается, обещание дней не меняется, и на сервер уходит прежняя дата,
   * а не набранная.
   */
  it('дату вне срока заявки окно не принимает', async () => {
    const onSubmit = vi.fn();
    renderModal(inWork(), { onSubmit });
    await screen.findByText('Освободится 9 дн. из заказанных');

    // Ниже границы — вчера: задним числом период не переписывается.
    typeDate('Последний день работ', '11.08.2026');
    // Выше границы — нынешний конец срока: дата, равная ему, ничего не сокращает.
    typeDate('Последний день работ', '21.08.2026');
    fillReason();
    fireEvent.click(screen.getByText('Завершить досрочно'));

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({ newDateTo: '2026-08-12' });
    expect(await screen.findByText('Освободится 9 дн. из заказанных')).toBeDefined();
  });

  it('без причины запрос не уходит: решает не тот, кто просит', async () => {
    const onSubmit = vi.fn();
    renderModal(inWork(), { onSubmit });
    await screen.findByText('Освободится 9 дн. из заказанных');

    fireEvent.click(screen.getByText('Завершить досрочно'));

    await waitFor(() => expect(fieldError('Причина')).toContain('Укажите причину'));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('уходит выбранным днём, причиной и версией заявки', async () => {
    const onSubmit = vi.fn();
    renderModal(inWork(), { onSubmit });
    await screen.findByText('Освободится 9 дн. из заказанных');

    typeDate('Последний день работ', '14.08.2026');
    fillReason('фундамент закончен');
    fireEvent.click(screen.getByText('Завершить досрочно'));

    // Версия — та, что была в окне: правка второго человека обязана получить конфликт.
    await waitFor(() =>
      expect(onSubmit).toHaveBeenCalledWith({
        newDateTo: '2026-08-14',
        reason: 'фундамент закончен',
        version: 4,
      }),
    );
  });

  it('кнопка называет то, что произойдёт: сразу или на визу', async () => {
    renderModal(inWork(), { approvesOwn: true });

    expect(await screen.findByText('Завершить досрочно')).toBeDefined();
    expect(screen.getByText('Срок заявки изменится сразу — вы её и визируете.')).toBeDefined();
  });

  it('просящему не обещают завершения — только визу', async () => {
    renderModal(inWork(), { approvesOwn: false });

    expect(await screen.findByText('Отправить на визу')).toBeDefined();
    expect(
      screen.getByText(
        'Запрос уйдёт на визу руководителя строительства; до визы срок заявки прежний.',
      ),
    ).toBeDefined();
  });
});

describe('сколько бланков ЭСМ-2 сгорит', () => {
  it('срок обрублен посреди недели: она перевыписывается, следующие сгорают', async () => {
    renderModal(inWork());
    await screen.findByText('Освободится 9 дн. из заказанных');

    typeDate('Последний день работ', '14.08.2026');

    // Неделя нового последнего дня аннулируется и выписывается заново — по 14-е включительно;
    // неделя за ней сгорает целиком.
    await waitFor(() =>
      expect(waybillsNote()).toBe(
        'Аннулируются листы ЭСМ-2: 10.08.2026–16.08.2026, 17.08.2026–21.08.2026;' +
          ' выписываются заново: 10.08.2026–14.08.2026',
      ),
    );
  });

  it('прошедшие недели в обещание не идут: их листы отработаны', async () => {
    renderModal(inWork());
    await screen.findByText('Освободится 9 дн. из заказанных');

    typeDate('Последний день работ', '14.08.2026');

    // Первая неделя срока — 03–09.08 — кончилась до дня среза, и сверка её не тронет.
    await waitFor(() => expect(waybillsNote()).not.toBeNull());
    expect(waybillsNote()).not.toContain('03.08.2026');
  });

  it('срок обрублен на границе недели: перевыписывать нечего', async () => {
    renderModal(inWork());
    await screen.findByText('Освободится 9 дн. из заказанных');

    // 16.08 — воскресенье: лист этой недели остаётся ровно таким, каким был выписан.
    typeDate('Последний день работ', '16.08.2026');

    await waitFor(() =>
      expect(waybillsNote()).toBe('Аннулируются листы ЭСМ-2: 17.08.2026–21.08.2026'),
    );
  });

  it('срок начался посреди недели — с того дня и считается первый лист', async () => {
    // Заказ 05–21.08, день среза — его первый день: не отработано ещё ничего.
    renderModal(inWork({ dateFrom: '2026-08-05' }), { onDate: '2026-08-05' });
    await screen.findByText('Заказано: 05.08.2026 – 21.08.2026');

    typeDate('Последний день работ', '07.08.2026');

    // Первая неделя листа начинается днём начала срока, а не понедельником.
    await waitFor(() =>
      expect(waybillsNote()).toBe(
        'Аннулируются листы ЭСМ-2: 05.08.2026–09.08.2026, 10.08.2026–16.08.2026,' +
          ' 17.08.2026–21.08.2026; выписываются заново: 05.08.2026–07.08.2026',
      ),
    );
  });

  it('арендная техника: бумагу ведёт арендодатель, и обещать нечего', async () => {
    renderModal(inWork({ assignment: assignmentOf('rental') }));
    await screen.findByText('Освободится 9 дн. из заказанных');

    typeDate('Последний день работ', '14.08.2026');

    await waitFor(() => expect(dateInput('Последний день работ').value).toBe('14.08.2026'));
    expect(waybillsNote()).toBeNull();
  });

  /**
   * Линейный заказ (ADR 0100 §5) ведётся режимом `on_demand`: недельных листов портал ему не
   * заводит вовсе — их просят по одной неделе, — и сверка сокращения смотрит не на срок, а на уже
   * выписанное (`esm2RequestedPeriods`). Назвать здесь недели срока значило бы пообещать сожжение
   * бланков, которых никогда не было.
   */
  it('линейный заказ: недель срока не обещают — их никто не выписывал', async () => {
    renderModal(inWork({ isLinear: true }));
    await screen.findByText('Освободится 9 дн. из заказанных');

    typeDate('Последний день работ', '14.08.2026');

    await waitFor(() => expect(waybillsNote()).toContain('выписаны по требованию'));
    // Ни одной календарной недели срока: в обещании нет чисел вовсе.
    expect(waybillsNote()).not.toContain('10.08.2026');
    expect(waybillsNote()).not.toContain('17.08.2026');
  });
});
