import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { Button, Form } from 'antd';
import { tripAmountSchema } from '@technic/contracts';
import { json, mockHttp } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { emptyList, list } from './factories/common';
import { freightRequest, freightTrip, vehicleFeed, vehicleSummary } from './factories/vehicle';
import { RequestTripFields } from '../src/widgets/vehicle-request-editor/ui/RequestTripFields';
import { VehicleRequestsTab } from '../src/pages/vehicle/VehicleRequestsTab';

/**
 * «Объём, м³» and «Масса, т» of a trip ask the contract's own rule (`tripAmountSchema`) on the
 * field. The route's body schema refuses 0 and a fourth decimal with a 400 before the handler
 * runs, and a create attempt freezes its body (ADR 0231): a form that lets such a value through
 * leaves the person with an attempt that can never be sent. The limits themselves are the
 * contract's (`request-trips-contracts.test.ts`); here only that the field asks and shows its
 * message, and that an empty field is still allowed — whether a quantity is required depends on
 * the ordered vehicle type and the server decides that.
 *
 * The expected messages are taken from the schema, not retyped: a test that repeated the text
 * would be a second copy of the rule the form is forbidden to hold.
 */

function messageOf(value: number): string {
  const parsed = tripAmountSchema.safeParse(value);
  if (parsed.success) throw new Error(`Значение ${value} схема принимает`);
  return parsed.error.issues[0]!.message;
}

const ZERO_MESSAGE = messageOf(0);
const DECIMALS_MESSAGE = messageOf(1.2345);

const FIELDS = [
  { name: 'volumeM3', label: 'Объём, м³' },
  { name: 'weightTons', label: 'Масса, т' },
] as const;

type Amount = (typeof FIELDS)[number];

/** The control of a quantity field of the open form. */
function amountInput(label: string): HTMLInputElement {
  const item = [...document.querySelectorAll('.ant-form-item')].find(
    (el) => el.querySelector('label')?.textContent === label,
  );
  const input = item?.querySelector('input');
  if (!input) throw new Error(`Поле «${label}» в форме не найдено`);
  return input;
}

/** The text under the field, or null while the field is clean. */
function amountError(label: string): string | null {
  const item = [...document.querySelectorAll('.ant-form-item')].find(
    (el) => el.querySelector('label')?.textContent === label,
  );
  return item?.querySelector('.ant-form-item-explain-error')?.textContent ?? null;
}

function type(label: string, value: string): void {
  const input = amountInput(label);
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value } });
  fireEvent.blur(input);
}

/**
 * The trip fields alone in a form. The rest of the trip (addresses, contacts) is required and would
 * stop any submit on its own, so a submit proves nothing about the quantity; the quantity is asked
 * through `validateFields` of its own two names, which is exactly the check the submit makes.
 */
function renderFields(onFinish: (values: unknown) => void) {
  let validate!: (name: Amount['name']) => Promise<unknown>;
  function Harness() {
    const [form] = Form.useForm();
    validate = (name) => form.validateFields([['trips', 0, name]]);
    return (
      <Form form={form} onFinish={onFinish}>
        <RequestTripFields
          index={0}
          saved={undefined}
          suggestObjectIds={[]}
          cargoRequired={false}
          detailed={false}
        />
        <Button htmlType="submit">Отправить</Button>
      </Form>
    );
  }
  mockHttp({});
  renderWithUser(<Harness />, { user: authUser() });
  return { validate: (name: Amount['name']) => validate(name) };
}

describe.each(FIELDS)('поле «$label»: правило количества', ({ name, label }) => {
  it.each([
    ['0', ZERO_MESSAGE],
    ['1.2345', DECIMALS_MESSAGE],
  ])('значение %s: сообщение контракта на самом поле, отправки нет', async (value, message) => {
    const onFinish = vi.fn();
    const form = renderFields(onFinish);

    type(label, value);

    await waitFor(() => expect(amountError(label)).toBe(message));
    await expect(form.validate(name)).rejects.toBeDefined();
    fireEvent.click(screen.getByText('Отправить'));
    await waitFor(() => expect(amountError(label)).toBe(message));
    expect(onFinish).not.toHaveBeenCalled();
  });

  it('пустое поле допустимо: нужно ли количество, решает сервер', async () => {
    const form = renderFields(vi.fn());

    type(label, '5');
    type(label, '');

    await expect(form.validate(name)).resolves.toBeDefined();
    expect(amountError(label)).toBeNull();
  });

  it('поле, которого не касались, не показывает ошибки и проходит проверку', async () => {
    const form = renderFields(vi.fn());

    await expect(form.validate(name)).resolves.toBeDefined();
    expect(amountError(label)).toBeNull();
  });

  it.each(['6', '20.5', '0.001', '123.456'])('значение %s проходит', async (value) => {
    const form = renderFields(vi.fn());

    type(label, value);

    await expect(form.validate(name)).resolves.toBeDefined();
    expect(amountError(label)).toBeNull();
  });

  it('ошибка уходит, когда значение исправлено', async () => {
    const form = renderFields(vi.fn());

    type(label, '0');
    await waitFor(() => expect(amountError(label)).toBe(ZERO_MESSAGE));
    type(label, '7');

    await waitFor(() => expect(amountError(label)).toBeNull());
    await expect(form.validate(name)).resolves.toBeDefined();
  });
});

describe('поля количества в форме правки заявки', () => {
  // A one-trip request of today's shape: the cargo is named, the addresses are old enough to be
  // kept as they are (no metadata), so the edit form is valid until the quantity is touched.
  const REQUEST = freightRequest({
    id: 'vr-amount',
    num: 61,
    displayNumber: 'ТС-61',
    vehicleCategoryId: null,
    vehicleCategoryName: null,
    vehicleCategorySpecs: null,
    trips: [
      freightTrip({
        id: 'vrt-61-1',
        displayNumber: 'ТС-61/1',
        cargoName: 'Арматура',
        volumeM3: 12,
        weightTons: null,
      }),
    ],
  });

  function renderTab() {
    const http = mockHttp({
      'GET /vehicle-requests/summary': () => json(vehicleSummary({ new: 1 })),
      'GET /vehicle-requests/feed': () => json(vehicleFeed([REQUEST])),
      'GET /objects': () => json(list([{ id: 'obj-1', code: 'ОБ-1', name: 'ЖК Северный' }])),
      'GET /departments': () => json(emptyList()),
      'GET /warehouses': () => json(emptyList()),
      'GET /vehicle-classifications': () => json(emptyList()),
      'GET /vehicles': () => json(emptyList()),
      'GET /vehicle-requests/:id/relocations': () => json([]),
      'PATCH /vehicle-requests/:id': ({ body }) => json({ ...REQUEST, ...(body as object) }),
    });
    renderWithUser(<VehicleRequestsTab />, { user: authUser() });
    return http;
  }

  async function openEdit(): Promise<void> {
    const row = (await screen.findByText('ТС-61')).closest('tr')!;
    fireEvent.click(row.querySelector('.anticon-edit')!.closest('button')!);
    await waitFor(() => expect(screen.getByText('Заявка ТС-61')).toBeDefined());
    // The trip fields appear once the form has the request type.
    await waitFor(() => expect(amountInput('Объём, м³')).toBeDefined());
  }

  function submit(): void {
    fireEvent.click(document.querySelector('.ant-modal-footer .ant-btn-primary')!);
  }

  it('ноль и четвёртый знак отказываются на поле, запрос правки не уходит', async () => {
    const http = renderTab();
    await openEdit();
    // The saved value arrives in the field, so the rule is asked about it too (and it passes).
    expect(Number(amountInput('Объём, м³').value)).toBe(12);
    expect(amountError('Объём, м³')).toBeNull();

    type('Объём, м³', '0');
    await waitFor(() => expect(amountError('Объём, м³')).toBe(ZERO_MESSAGE));
    type('Масса, т', '1.2345');
    await waitFor(() => expect(amountError('Масса, т')).toBe(DECIMALS_MESSAGE));

    submit();
    await waitFor(() => expect(amountError('Объём, м³')).toBe(ZERO_MESSAGE));
    expect(http.countOf('PATCH /vehicle-requests/:id')).toBe(0);
  });

  it('исправленное значение уходит правкой с тем числом, что набрано', async () => {
    const http = renderTab();
    await openEdit();

    type('Объём, м³', '0');
    await waitFor(() => expect(amountError('Объём, м³')).toBe(ZERO_MESSAGE));
    type('Объём, м³', '6');
    type('Масса, т', '20.5');
    await waitFor(() => expect(amountError('Объём, м³')).toBeNull());

    submit();
    await waitFor(() => expect(http.countOf('PATCH /vehicle-requests/:id')).toBe(1));
    const body = http.lastCall('PATCH /vehicle-requests/:id')!.body as {
      trips: { volumeM3: number | null; weightTons: number | null }[];
    };
    expect(body.trips[0]).toMatchObject({ volumeM3: 6, weightTons: 20.5 });
  });
});
