import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type { ReportItemDto, VehicleReadingDto } from '@technic/contracts';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { ReadingBlock } from '../src/pages/driver/DriverReadingBlock';
import { OrphanBlock, type TransferTarget } from '../src/pages/driver/DriverOrphanBlock';
import type { DraftItem } from '../src/pages/driver/api';

/**
 * Читающий режим блока показаний (план docs/driver-readings-first-plan.md, Р10) и блок «Введено,
 * но не привязано к строке» с правилами переноса (Р14, Р14а).
 *
 * Оба компонента проверяются рендером напрямую, без страницы: страница решает, когда правка
 * закрыта и какие значения показать, — а здесь проверяется то, за что отвечают сами блоки.
 *
 * Два правила, ради которых набор и написан.
 *
 * 1. **Выключено всё, чем можно ввести** — число, комментарий, галочка подтверждения, «Прикрепить
 *    фото» и удаление файла. Проверяется не атрибут, а поведение: `disabled` в разметке — обещание
 *    браузеру, а событие `change` до обработчика доходит и помимо человека. Читающий режим обязан
 *    молчать сам, поэтому рядом стоит зеркальный тест обычного режима: без него «не вызвано»
 *    означало бы «компонент вообще не работает».
 * 2. **Ничто введённое не исчезает молча.** Несопоставленная запись показывается целиком и без
 *    кнопки отправки, а переносит её человек: целей ноль — кнопки нет вовсе; цель занята — сначала
 *    сравнение «сейчас / станет» и явная замена. Сам перенос блок не делает — он зовёт колбэк, и
 *    тесты смотрят ровно на его аргументы.
 */

// jsdom не реализует `scrollIntoView`, а поле ввода доводит до видимой части экрана по фокусу.
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};

const driver = authUser({
  id: 'user-driver',
  email: 'driver@example.test',
  role: 'driver',
  lastName: 'Водителев',
  firstName: 'Виктор',
  middleName: 'Иванович',
  fullName: 'Водителев Виктор Иванович',
});

const draft = (patch: Partial<DraftItem> = {}): DraftItem => ({
  odometerKm: '',
  engineHours: '',
  fuelFilledLiters: '',
  comment: '',
  files: [],
  confirmAnomaly: false,
  ...patch,
});

const photoFile = { id: 'file-1', filename: 'снимок.jpg', contentType: 'image/jpeg', size: 1024 };

/**
 * Показание с неподтверждённой аномалией и двумя уже привязанными файлами: без аномалии галочки
 * подтверждения в блоке нет вовсе, а привязанные файлы показываются числом — имён у них в DTO нет.
 */
const jumped: VehicleReadingDto = {
  id: 'reading-1',
  itemId: 'item-route',
  kind: 'values',
  odometerKm: 145320,
  engineHours: null,
  fuelFilledLiters: null,
  noDataReason: '',
  comment: '',
  source: 'driver',
  recordedAt: '2026-08-19T10:00:00.000Z',
  odometerAnomaly: {
    kind: 'implausible_jump',
    confirmed: false,
    previousValue: 140000,
    previousDate: '2026-08-10',
  },
  engineHoursAnomaly: null,
  odometerDelta: 5320,
  engineHoursDelta: null,
  fileIds: ['f-1', 'f-2'],
};

const routeItem: ReportItemDto = {
  id: 'item-route',
  sourceKind: 'route',
  sourceId: 'route-1',
  sourceLabel: 'Рейс Р-142',
  vehicleId: 'v-1',
  vehicleLabel: 'КамАЗ 65115 · А123ВС799',
  shiftOrder: 1,
  reading: jumped,
};

/**
 * Поле по его подписи. `getByLabelText` здесь не годится: подпись antd лежит в том же `label`, что
 * и суффикс поля («км») с подсказкой предыдущего значения, и точного совпадения не бывает.
 */
function field(label: string): HTMLInputElement | HTMLTextAreaElement {
  const wrapper = [...document.querySelectorAll('label')].find((el) =>
    el.textContent?.startsWith(label),
  );
  if (!wrapper) throw new Error(`поля «${label}» на экране нет`);
  const input = wrapper.querySelector('input, textarea');
  if (!input) throw new Error(`у поля «${label}» нет ввода`);
  return input as HTMLInputElement | HTMLTextAreaElement;
}

/** Выбор файла идёт скрытым `input[type=file]`, а не кнопкой: кнопка только открывает диалог. */
function filePicker(): HTMLInputElement {
  const input = document.querySelector('input[type="file"]');
  if (!input) throw new Error('поля выбора файла на экране нет');
  return input as HTMLInputElement;
}

const button = (name: string | RegExp): HTMLButtonElement =>
  screen.getByRole('button', { name }) as HTMLButtonElement;

/** Разбор выбранного файла в rc-upload асинхронный: «не вызвано» проверяется после микрозадач. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function renderBlock(readOnly: boolean) {
  const spies = { onChange: vi.fn(), onUpload: vi.fn(), onRemoveFile: vi.fn() };
  renderWithUser(
    <ReadingBlock
      item={routeItem}
      value={draft({ odometerKm: '145320', files: [photoFile] })}
      previous={null}
      errors={{}}
      uploading={false}
      readOnly={readOnly}
      onChange={spies.onChange}
      onUpload={spies.onUpload}
      onRemoveFile={spies.onRemoveFile}
    />,
    { user: driver },
  );
  return spies;
}

describe('Читающий режим блока показаний (Р10)', () => {
  it('не принимает ввода ни одним элементом, но показанное остаётся на экране', async () => {
    const spies = renderBlock(true);

    for (const [label, next] of [
      ['Одометр на конец смены', '145321'],
      ['Моточасы на конец смены', '12,5'],
      ['Заправлено за смену', '30'],
      ['Комментарий', 'дописал в закрытый день'],
    ] as const) {
      const input = field(label);
      expect(input.disabled).toBe(true);
      fireEvent.change(input, { target: { value: next } });
    }

    const confirm = screen.getByRole('checkbox') as HTMLInputElement;
    expect(confirm.disabled).toBe(true);
    fireEvent.click(confirm);

    expect(button(/Прикрепить фото/).disabled).toBe(true);
    const picker = filePicker();
    expect(picker.disabled).toBe(true);
    fireEvent.change(picker, {
      target: { files: [new File(['x'], 'новое.jpg', { type: 'image/jpeg' })] },
    });

    // Удаление снято отсутствием кнопки: выключенная кнопка «Удалить» обещала бы действие.
    expect(screen.queryByRole('button', { name: 'Удалить' })).toBeNull();

    await settle();
    expect(spies.onChange).not.toHaveBeenCalled();
    expect(spies.onUpload).not.toHaveBeenCalled();
    expect(spies.onRemoveFile).not.toHaveBeenCalled();

    // Введённое и приложенное при этом видно: режим закрывает ввод, а не показ.
    screen.getByDisplayValue('145320');
    screen.getByText('снимок.jpg');
    screen.getByText(/уже приложено: 2/);
  });

  it('в обычном режиме те же элементы ввод принимают', async () => {
    const spies = renderBlock(false);

    fireEvent.change(field('Одометр на конец смены'), { target: { value: '145321' } });
    expect(spies.onChange).toHaveBeenCalledWith({ odometerKm: '145321' });

    fireEvent.change(field('Комментарий'), { target: { value: 'мыл машину' } });
    expect(spies.onChange).toHaveBeenCalledWith({ comment: 'мыл машину' });

    fireEvent.click(screen.getByRole('checkbox'));
    expect(spies.onChange).toHaveBeenCalledWith({ confirmAnomaly: true });

    fireEvent.click(button('Удалить'));
    expect(spies.onRemoveFile).toHaveBeenCalledWith('file-1');

    fireEvent.change(filePicker(), {
      target: { files: [new File(['x'], 'новое.jpg', { type: 'image/jpeg' })] },
    });
    await waitFor(() => expect(spies.onUpload).toHaveBeenCalled());
  });
});

// ── Введено, но не привязано к строке ──

/** 19.08.2026, 14:32 по Москве: подпись блока показывает московское время, как и весь портал. */
const SAVED_AT = new Date('2026-08-19T11:32:00.000Z').getTime();

const orphan = draft({
  odometerKm: '145320',
  engineHours: '12.5',
  fuelFilledLiters: '30',
  comment: 'заправка по талону',
  files: [photoFile],
});

const routeTarget: TransferTarget = {
  key: 'route:route-1',
  label: 'Рейс Р-142 · КамАЗ 65115',
  occupied: null,
};
const esm2Target: TransferTarget = {
  key: 'esm2:wb-1',
  label: 'ЭСМ-2 № 000123 · Экскаватор JCB',
  occupied: null,
};

function renderOrphan(targets: TransferTarget[]) {
  const onTransfer = vi.fn();
  renderWithUser(
    <OrphanBlock
      item={orphan}
      savedAt={SAVED_AT}
      origin="строка ушла из задания"
      targets={targets}
      onTransfer={onTransfer}
    />,
    { user: driver },
  );
  return onTransfer;
}

describe('Блок «Введено, но не привязано к строке» (Р14, Р14а)', () => {
  it('показывает числа, комментарий и дату сохранения, а отправить их нечем', () => {
    renderOrphan([routeTarget]);

    screen.getByText('145320 км');
    screen.getByText('12.5 ч');
    screen.getByText('30 л');
    screen.getByText('заправка по талону');
    screen.getByText(/Сохранено 19\.08\.2026 14:32/);
    // Единственная кнопка блока — перенос: отправлять несопоставленную запись некуда, у неё нет
    // строки отчёта, и кнопки отправки у блока нет вовсе.
    expect(screen.getAllByRole('button').map((el) => el.textContent)).toEqual(['Перенести']);
  });

  it('целей нет — кнопки «Перенести» нет вовсе, а числа остаются на экране', () => {
    renderOrphan([]);

    expect(screen.queryByRole('button', { name: 'Перенести' })).toBeNull();
    screen.getByText('Перенести некуда');
    screen.getByText('145320 км');
  });

  it('единственная пустая цель принимает перенос сразу, без лишнего вопроса', () => {
    const onTransfer = renderOrphan([routeTarget]);

    fireEvent.click(button('Перенести'));

    expect(onTransfer).toHaveBeenCalledWith('route:route-1', 'empty');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('целей несколько — переносит ровно в выбранную', async () => {
    const onTransfer = renderOrphan([routeTarget, esm2Target]);

    fireEvent.click(button('Перенести'));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('radio', { name: /ЭСМ-2/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Перенести' }));

    expect(onTransfer).toHaveBeenCalledWith('esm2:wb-1', 'empty');
  });

  it('занятая цель — сначала сравнение «сейчас / станет», и заменяет человек', async () => {
    const occupied = draft({ odometerKm: '140000', comment: 'стоял в поле' });
    const onTransfer = renderOrphan([{ ...routeTarget, occupied }]);

    fireEvent.click(button('Перенести'));
    const dialog = await screen.findByRole('dialog');
    within(dialog).getByText('Сейчас');
    within(dialog).getByText('Станет');
    within(dialog).getByText('140000 км');
    within(dialog).getByText('стоял в поле');
    within(dialog).getByText('145320 км');

    // Отказ ничего не переносит: замена — отдельное решение человека, а не следствие показа.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Отмена' }));
    expect(onTransfer).not.toHaveBeenCalled();

    fireEvent.click(button('Перенести'));
    const again = await screen.findByRole('dialog');
    fireEvent.click(within(again).getByRole('button', { name: 'Заменить' }));
    expect(onTransfer).toHaveBeenCalledWith('route:route-1', 'replace');
  });
});
