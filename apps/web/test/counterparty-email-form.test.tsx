import { useEffect } from 'react';
import { Form } from 'antd';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { EMAIL_FORMAT_MESSAGE } from '@technic/contracts';
import {
  CounterpartyFormFields,
  type CounterpartyFormValues,
  counterpartyCreatePayload,
  counterpartyUpdatePayload,
} from '../src/pages/directories/CounterpartyFormFields';

/** Поле сохраняет общий ящик, поэтому проверка обязана сработать до общего тоста API. */
function FormHarness({
  onFinish,
  type = 'service',
  email,
}: {
  onFinish: (value: CounterpartyFormValues) => void;
  /** Тип решает, показано ли поле: у прочих оно скрыто, но значение из карточки сохраняет. */
  type?: CounterpartyFormValues['type'];
  /** Готовое значение — так в карточку приезжает адрес, заведённый когда-то и не тронутый с тех пор. */
  email?: string;
}) {
  const [form] = Form.useForm<CounterpartyFormValues>();
  useEffect(() => {
    form.setFieldsValue({
      type,
      name: 'Сервис оргтехники',
      inn: '7707083893',
      isActive: true,
      ...(email === undefined ? {} : { email }),
    });
  }, [form, type, email]);

  return (
    <>
      <CounterpartyFormFields form={form} objectOptions={[]} onFinish={onFinish} />
      <button type="button" onClick={() => form.submit()}>
        Сохранить
      </button>
    </>
  );
}

describe('общий email сервисной компании', () => {
  it('помечает неверный адрес в форме и не отправляет его', async () => {
    const onFinish = vi.fn();
    render(<FormHarness onFinish={onFinish} />);

    const input = await screen.findByLabelText('Email для заявок');
    fireEvent.change(input, { target: { value: 'не адрес' } });
    fireEvent.blur(input);
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));

    expect(await screen.findByText(EMAIL_FORMAT_MESSAGE)).toBeTruthy();
    expect(onFinish).not.toHaveBeenCalled();
  });

  it('нормализует скопированный адрес до отправки', async () => {
    const onFinish = vi.fn();
    render(<FormHarness onFinish={onFinish} />);

    const input = await screen.findByLabelText('Email для заявок');
    fireEvent.change(input, { target: { value: ' service@ example.ru ' } });
    fireEvent.blur(input);
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));

    await waitFor(() => expect(onFinish).toHaveBeenCalledTimes(1));
    expect(onFinish.mock.calls[0]![0].email).toBe('service@example.ru');
  });

  /**
   * Поле скрыто у прочих типов, а `hidden` у `Form.Item` — это стиль, а не снятие с учёта: правило
   * без оговорки проверяло бы и невидимое поле. Цена ошибки не «лишняя проверка», а запертая
   * карточка: сообщение отрисовалось бы внутри скрытого поля, и человек нажимал бы «Сохранить»
   * впустую, не видя причины. Кривой адрес взяться может только из старых данных — форма и API
   * пишут проверенный, — но именно такие значения и запирают формы.
   */
  it('скрытое поле не запирает сохранение карточки другого типа', async () => {
    const onFinish = vi.fn();
    render(<FormHarness onFinish={onFinish} type="supplier" email="кривой адрес" />);

    fireEvent.click(await screen.findByRole('button', { name: 'Сохранить' }));

    await waitFor(() => expect(onFinish).toHaveBeenCalledTimes(1));
    // Значение уезжает как было: смена типа не стирает ящик организации (ADR 0153).
    expect(onFinish.mock.calls[0]![0].email).toBe('кривой адрес');
    expect(screen.queryByText(EMAIL_FORMAT_MESSAGE)).toBeNull();
  });

  /**
   * Форма пропустила непроверенное значение — значит его не должно быть и в запросе. Иначе тихий
   * отказ формы просто менялся бы на серверный: 400 на поле, которого человек не видит.
   *
   * Проверяется поэтому не вызов `onFinish`, а **тело запроса**: между ними и живёт ошибка.
   */
  it('правка карточки другого типа не отправляет скрытый адрес', () => {
    const values: CounterpartyFormValues = {
      type: 'supplier',
      name: 'Поставщик',
      inn: '7707083893',
      email: 'кривой адрес',
      isActive: true,
    };
    // Правка: поля нет вовсе — сервер прочтёт это как «не трогать заведённый ящик».
    expect('email' in counterpartyUpdatePayload(values)).toBe(false);
    // Сервисной компании — отправляется, иначе адрес нельзя было бы ни завести, ни очистить.
    expect(counterpartyUpdatePayload({ ...values, type: 'service', email: '' })).toMatchObject({
      email: '',
    });
    // Заведение требует полного тела, и беречь там нечего: карточки ещё нет.
    expect(counterpartyCreatePayload(values).email).toBe('кривой адрес');
  });
});
