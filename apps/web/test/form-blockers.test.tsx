import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { Form, Input, type FormInstance } from 'antd';
import { FormModal, useFormBlockers } from '../src/shared/ui';
import { renderWithUser } from './render';

/**
 * Единый вид отказа формы (ADR 0094). Проверяется не картинка, а то, ради чего механика заводилась:
 * причина стоит под своим полем, экран едет к первому блокеру, повторное нажатие с тем же блокером
 * снова заметно.
 *
 * Прокрутку в jsdom проверить нельзя: размеры там нулевые, и `scroll-into-view-if-needed` ничего
 * не двигает. Поэтому следим за обращением формы к `scrollToField` — за тем, куда портал просит
 * уехать, а не за тем, уехал ли экран.
 */

interface Values {
  reason?: string;
  amount?: string;
}

function Harness({
  onFinish,
  formRef,
}: {
  onFinish?: (v: Values) => void;
  formRef?: (form: FormInstance<Values>) => void;
}) {
  const [form] = Form.useForm<Values>();
  const blockers = useFormBlockers(form);
  formRef?.(form);

  return (
    <FormModal title="Форма" open onCancel={() => {}} onSubmit={() => form.submit()}>
      <Form
        form={form}
        layout="vertical"
        onFinish={(v: Values) => {
          // Проверка, правилами не выраженная, — та самая, что раньше показывала тост.
          if (blockers.raise({ amount: v.amount ? undefined : 'Укажите объём' })) return;
          onFinish?.(v);
        }}
        {...blockers.formProps}
      >
        <Form.Item
          name="reason"
          label="Причина"
          rules={[{ required: true, message: 'Укажите причину' }]}
        >
          <Input aria-label="Причина" />
        </Form.Item>
        <Form.Item name="amount" label="Объём">
          <Input aria-label="Объём" />
        </Form.Item>
      </Form>
    </FormModal>
  );
}

/** Класс-вариант вспышки, стоящий на форме: по его смене видно, что вспышка повторилась. */
function flashVariant(): string | null {
  const form = document.querySelector('form.form-blockers');
  if (!form) return null;
  return (
    [...form.classList].find((c) => c === 'form-blockers--a' || c === 'form-blockers--b') ?? null
  );
}

function fieldError(labelText: string): string | null {
  const label = [...document.querySelectorAll('label')].find(
    (el) => el.textContent?.trim() === labelText,
  );
  const item = label?.closest('.ant-form-item');
  return item?.querySelector('.ant-form-item-explain-error')?.textContent ?? null;
}

function submit(): void {
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));
}

describe('отказ формы', () => {
  it('правило показывает причину под своим полем и просит прокрутку к нему', async () => {
    const scroll = vi.fn();
    renderWithUser(
      <Harness formRef={(form) => vi.spyOn(form, 'scrollToField').mockImplementation(scroll)} />,
    );

    submit();

    await waitFor(() => expect(fieldError('Причина')).toBe('Укажите причину'));
    expect(scroll).toHaveBeenCalledWith(['reason'], expect.objectContaining({ block: 'center' }));
  });

  it('проверка из onFinish помечает поле, а не показывает тост', async () => {
    const onFinish = vi.fn();
    renderWithUser(<Harness onFinish={onFinish} />);

    fireEvent.change(screen.getByLabelText('Причина'), { target: { value: 'поломка' } });
    submit();

    await waitFor(() => expect(fieldError('Объём')).toBe('Укажите объём'));
    expect(onFinish).not.toHaveBeenCalled();
    // Тост — только для того, у чего нет своего поля.
    expect(document.querySelector('.ant-message')).toBeNull();
  });

  it('повторное нажатие с тем же блокером повторяет вспышку', async () => {
    renderWithUser(<Harness />);

    submit();
    await waitFor(() => expect(flashVariant()).toBe('form-blockers--a'));

    submit();
    await waitFor(() => expect(flashVariant()).toBe('form-blockers--b'));
  });

  it('поле без своего текста отказывает общей формулировкой, а не по-английски', async () => {
    function Bare() {
      const [form] = Form.useForm<Values>();
      const blockers = useFormBlockers(form);
      return (
        <FormModal title="Форма" open onCancel={() => {}} onSubmit={() => form.submit()}>
          <Form form={form} layout="vertical" {...blockers.formProps}>
            {/* Правило без `message` — таких в портале шесть: текст берётся из общего словаря. */}
            <Form.Item name="reason" label="Причина" rules={[{ required: true }]}>
              <Input aria-label="Причина" />
            </Form.Item>
            <Form.Item name="amount" label="Объём" rules={[{ type: 'number' }]}>
              <Input aria-label="Объём" />
            </Form.Item>
          </Form>
        </FormModal>
      );
    }

    renderWithUser(<Bare />);
    fireEvent.change(screen.getByLabelText('Объём'), { target: { value: 'двенадцать' } });
    submit();

    await waitFor(() => expect(fieldError('Причина')).toBe('Поле обязательно к заполнению'));
    expect(fieldError('Объём')).toBe('Поле заполняется только цифрами');
  });

  it('до первого отказа вспышки нет', () => {
    renderWithUser(<Harness />);
    expect(flashVariant()).toBeNull();
  });

  it('пометка, поставленная руками, снимается правкой поля', async () => {
    renderWithUser(<Harness />);

    fireEvent.change(screen.getByLabelText('Причина'), { target: { value: 'поломка' } });
    submit();
    await waitFor(() => expect(fieldError('Объём')).toBe('Укажите объём'));

    // У поля нет правил, и само оно пометку не снимет: это делает механика отказа.
    fireEvent.change(screen.getByLabelText('Объём'), { target: { value: '12' } });
    await waitFor(() => expect(fieldError('Объём')).toBeNull());
  });

  it('ошибка поля с сервера ложится на поле и просит прокрутку', async () => {
    const scroll = vi.fn();
    let api: ReturnType<typeof useFormBlockers> | null = null;

    function ApiHarness() {
      const [form] = Form.useForm<Values>();
      const blockers = useFormBlockers(form);
      api = blockers;
      vi.spyOn(form, 'scrollToField').mockImplementation(scroll);
      return (
        <Form form={form} layout="vertical" {...blockers.formProps}>
          <Form.Item name="amount" label="Объём">
            <Input aria-label="Объём" />
          </Form.Item>
        </Form>
      );
    }

    renderWithUser(<ApiHarness />);

    const applied = api!.fromApi({
      code: 'validation_error',
      status: 400,
      message: 'Ошибка валидации данных',
      fields: { amount: 'Объём больше вместимости', missingField: 'этого поля в форме нет' },
    });

    expect(applied).toBe(true);
    await waitFor(() => expect(fieldError('Объём')).toBe('Объём больше вместимости'));
    expect(scroll).toHaveBeenCalledWith('amount', expect.objectContaining({ block: 'center' }));
  });

  it('ответ без полей на форму не ложится — про него говорит тост', () => {
    let api: ReturnType<typeof useFormBlockers> | null = null;

    function ApiHarness() {
      const [form] = Form.useForm<Values>();
      api = useFormBlockers(form);
      return (
        <Form form={form} layout="vertical" {...api.formProps}>
          <Form.Item name="amount" label="Объём">
            <Input aria-label="Объём" />
          </Form.Item>
        </Form>
      );
    }

    renderWithUser(<ApiHarness />);

    expect(api!.fromApi({ code: 'conflict', status: 409, message: 'Заявку уже изменили' })).toBe(
      false,
    );
  });
});
