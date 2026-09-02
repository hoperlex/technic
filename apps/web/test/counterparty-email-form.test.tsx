import { useEffect } from 'react';
import { Form } from 'antd';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { EMAIL_FORMAT_MESSAGE } from '@technic/contracts';
import {
  CounterpartyFormFields,
  type CounterpartyFormValues,
} from '../src/pages/directories/CounterpartyFormFields';

/** Поле сохраняет общий ящик, поэтому проверка обязана сработать до общего тоста API. */
function FormHarness({ onFinish }: { onFinish: (value: CounterpartyFormValues) => void }) {
  const [form] = Form.useForm<CounterpartyFormValues>();
  useEffect(() => {
    form.setFieldsValue({
      type: 'service',
      name: 'Сервис оргтехники',
      inn: '7707083893',
      isActive: true,
    });
  }, [form]);

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
});
