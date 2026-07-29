import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';
import { Form, type FormInstance } from 'antd';
import { AutoSelect, type AutoSelectProps } from '../src/components/AutoSelect';

/**
 * Поведение проверяется в том виде, в каком оно живёт в приложении: поле внутри `Form.Item`,
 * значение — в хранилище формы. Отдельно — вариант с ручным `value`/`onChange`: так выпадающий
 * список используется в редакторе машин заявки.
 */

let form: FormInstance;

function Harness({
  select,
  initialValues,
}: {
  select: AutoSelectProps;
  initialValues?: Record<string, unknown>;
}) {
  const [instance] = Form.useForm();
  form = instance;
  return (
    <Form form={instance} layout="vertical" initialValues={initialValues}>
      <Form.Item name="field" label="Поле" rules={[{ required: true, message: 'Выберите' }]}>
        <AutoSelect {...select} />
      </Form.Item>
    </Form>
  );
}

const renderField = (select: AutoSelectProps, initialValues?: Record<string, unknown>) =>
  render(<Harness select={select} initialValues={initialValues} />);

/** Что показано в поле (не в хранилище формы) — подпись выбранного варианта. */
const shownLabel = (container: HTMLElement) =>
  container.querySelector('.ant-select-content')?.getAttribute('title') ?? null;

const value = () => form.getFieldValue('field') as unknown;

describe('единственный доступный вариант подставляется', () => {
  it('обязательное поле с одним вариантом заполняется само', () => {
    const { container } = renderField({
      options: [{ value: 'op-1', label: 'ООО «Ромашка»' }],
    });
    expect(value()).toBe('op-1');
    expect(shownLabel(container)).toBe('ООО «Ромашка»');
  });

  it('поле остаётся обычным: не заблокировано и открывает свой единственный пункт', () => {
    const { container } = renderField({ options: [{ value: 'a', label: 'А' }] });
    const input = container.querySelector('input[role="combobox"]');
    expect(container.querySelector('.ant-select-disabled')).toBeNull();
    expect(input).not.toBeNull();
    expect(input?.hasAttribute('disabled')).toBe(false);

    // Список открывается и показывает тот самый вариант — человек видит, из чего был выбор.
    fireEvent.mouseDown(container.querySelector('.ant-select-content')!);
    expect(document.querySelectorAll('.ant-select-item-option')).toHaveLength(1);
  });

  it('единственный доступный среди выключенных', () => {
    renderField({
      options: [
        { value: 'active', label: 'Активна', disabled: true },
        { value: 'inactive', label: 'Не активна' },
      ],
    });
    expect(value()).toBe('inactive');
  });

  it('единственный лист в сгруппированном списке', () => {
    renderField({
      options: [
        { label: 'Грузовая', options: [{ value: 'truck-1', label: 'Самосвал' }] },
        { label: 'Спецтехника', options: [] },
      ],
    });
    expect(value()).toBe('truck-1');
  });

  it('множественный режим получает массив из одного варианта', () => {
    renderField({ mode: 'multiple', options: [{ value: 'a', label: 'А' }] });
    expect(value()).toEqual(['a']);
  });

  it('вместе со значением отдаётся сама опция: побочная логика поля отрабатывает', () => {
    const onChange = vi.fn();
    renderField({ options: [{ value: 'a', label: 'А' }], onChange });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0]?.[0]).toBe('a');
    expect(onChange.mock.calls[0]?.[1]).toMatchObject({ value: 'a', label: 'А' });
  });
});

describe('подстановки не происходит', () => {
  it('вариантов больше одного', () => {
    renderField({
      options: [
        { value: 'a', label: 'А' },
        { value: 'b', label: 'Б' },
      ],
    });
    expect(value()).toBeUndefined();
  });

  it('вариантов нет вовсе', () => {
    renderField({ options: [] });
    expect(value()).toBeUndefined();
  });

  it('единственный вариант выключен', () => {
    renderField({ options: [{ value: 'a', label: 'А', disabled: true }] });
    expect(value()).toBeUndefined();
  });

  it('поле заблокировано: оно ждёт выбора в поле-родителе', () => {
    renderField({ disabled: true, options: [{ value: 'a', label: 'А' }] });
    expect(value()).toBeUndefined();
  });

  it('поведение выключено явно (фильтр, необязательное поле)', () => {
    renderField({ autoSelectSole: false, options: [{ value: 'a', label: 'А' }] });
    expect(value()).toBeUndefined();
  });

  it('значение уже выбрано — правка записи его не меняет', () => {
    renderField(
      {
        options: [
          { value: 'a', label: 'А' },
          { value: 'b', label: 'Б' },
        ],
      },
      { field: 'b' },
    );
    expect(value()).toBe('b');
  });

  it('в списке остался один вариант, но в поле — другое значение записи', () => {
    // Так выглядит предложение неактивного арендодателя: в выборе он один, а у записи свой.
    renderField({ options: [{ value: 'a', label: 'А' }] }, { field: 'legacy' });
    expect(value()).toBe('legacy');
  });
});

describe('загрузка списка', () => {
  it('пока список грузится — ждём, после загрузки подставляем', () => {
    const { rerender } = renderField({ loading: true, options: [] });
    expect(value()).toBeUndefined();

    rerender(<Harness select={{ loading: true, options: [{ value: 'a', label: 'А' }] }} />);
    expect(value()).toBeUndefined();

    rerender(<Harness select={{ loading: false, options: [{ value: 'a', label: 'А' }] }} />);
    expect(value()).toBe('a');
  });
});

describe('смена набора вариантов', () => {
  it('зависимый список: сброс поля и новый единственный вариант — подставляется', () => {
    const many = [
      { value: 'a', label: 'А' },
      { value: 'b', label: 'Б' },
    ];
    const { rerender } = renderField({ options: many });
    expect(value()).toBeUndefined();

    // Выбор в поле-родителе сузил список до одного варианта и обнулил поле.
    act(() => form.setFieldValue('field', undefined));
    rerender(<Harness select={{ options: [{ value: 'c', label: 'В' }] }} />);
    expect(value()).toBe('c');
  });

  it('очищаемое поле: очищенное значение не возвращается, пока список тот же', () => {
    const options = [{ value: 'a', label: 'А' }];
    const { rerender } = renderField({ allowClear: true, options });
    expect(value()).toBe('a');

    // Человек нажал крестик — поле должно остаться пустым.
    act(() => form.setFieldValue('field', undefined));
    rerender(<Harness select={{ allowClear: true, options }} />);
    expect(value()).toBeUndefined();

    // А сменился список — подставляем снова: это уже другой выбор.
    rerender(<Harness select={{ allowClear: true, options: [{ value: 'b', label: 'Б' }] }} />);
    expect(value()).toBe('b');
  });

  it('обязательное поле без крестика: сброс формы снова заполняет его', () => {
    // Повторное открытие окна создания начинается с resetFields — поле должно заполниться опять.
    const options = [{ value: 'a', label: 'А' }];
    const { rerender } = renderField({ options });
    expect(value()).toBe('a');

    act(() => form.resetFields());
    rerender(<Harness select={{ options }} />);
    expect(value()).toBe('a');
  });
});

describe('вне формы (ручные value/onChange)', () => {
  it('подставляет значение через переданный onChange', () => {
    const onChange = vi.fn();
    render(
      <AutoSelect
        value={undefined}
        onChange={onChange}
        options={[{ value: 'truck', label: 'Самосвал' }]}
      />,
    );
    expect(onChange).toHaveBeenCalledWith('truck', expect.objectContaining({ value: 'truck' }));
  });

  it('заполненное значение не трогает', () => {
    const onChange = vi.fn();
    render(
      <AutoSelect
        value="truck"
        onChange={onChange}
        options={[{ value: 'other', label: 'Иной' }]}
      />,
    );
    expect(onChange).not.toHaveBeenCalled();
  });
});
