import { describe, expect, it } from 'vitest';
import { act, fireEvent, screen } from '@testing-library/react';
import { Button, Form, Input } from 'antd';
import { StaleRecordNotice, useFormRecordSession } from '../src/shared/ui';
import { renderWithProps } from './propsDriver';

/**
 * The form-session rule of stage 5 (plan §4.5, decision R6-a) on a bare form: the forms of wave 1
 * rely on these guarantees, and here they are pinned without any screen around them.
 *
 * - the form is filled per window session `[open, id, loaded]`, not per record object;
 * - the save carries the version taken at fill time;
 * - a newer record over an untouched form refills it silently and moves the snapshot;
 * - over a changed form only the notice appears; "Reload" is the only way the input is dropped;
 * - an own mutation moves the snapshot at once and refills untouched fields when its record comes.
 */

interface Note {
  id: string;
  version: number;
  title: string;
  body: string;
}

const NOTE: Note = { id: 'n-1', version: 3, title: 'Счёт', body: 'Оплатить до пятницы' };

const mount = (initial: Parameters<typeof Harness>[0]) => renderWithProps(Harness, initial);

function Harness({
  open,
  record,
  versioned = true,
  placeholder = false,
  onAccept,
}: {
  open: boolean;
  record: Note | undefined;
  versioned?: boolean;
  placeholder?: boolean;
  onAccept?: (accept: (version: number) => void) => void;
}) {
  const [form] = Form.useForm<{ title: string; body: string }>();
  const session = useFormRecordSession(form, {
    open,
    id: record?.id ?? null,
    data: record,
    isPlaceholderData: placeholder,
    version: versioned ? (note: Note) => note.version : undefined,
    values: (note: Note) => ({ title: note.title, body: note.body }),
  });
  return (
    <div data-version={session.version ?? ''} data-testid="harness">
      <StaleRecordNotice session={session} />
      <Form form={form}>
        <Form.Item name="title" label="Заголовок">
          <Input />
        </Form.Item>
        <Form.Item name="body" label="Текст">
          <Input />
        </Form.Item>
      </Form>
      <Button onClick={() => onAccept?.(session.accept)}>своя мутация</Button>
    </div>
  );
}

const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
const shownVersion = () => screen.getByTestId('harness').getAttribute('data-version');
const type = (label: string, value: string) =>
  fireEvent.change(field(label), { target: { value } });

describe('fill per window session', () => {
  it('a record loaded before opening fills the form when the window opens', () => {
    const view = mount({ open: false, record: NOTE });
    expect(field('Заголовок').value).toBe('');

    view.update({ open: true, placeholder: false });
    expect(field('Заголовок').value).toBe('Счёт');
    expect(shownVersion()).toBe('3');
  });

  it('reopening the same record fills it anew: the previous session input does not survive', () => {
    const view = mount({ open: true, record: NOTE });
    type('Заголовок', 'Черновик');

    view.update({ open: false });
    view.update({ open: true, placeholder: false });
    expect(field('Заголовок').value).toBe('Счёт');
  });

  it('placeholder data is not the record and does not start a session', () => {
    const view = mount({ open: true, record: NOTE, placeholder: true });
    expect(field('Заголовок').value).toBe('');

    view.update({ open: true, placeholder: false });
    expect(field('Заголовок').value).toBe('Счёт');
  });
});

describe('a newer record over the open form', () => {
  it('an untouched form is refilled silently and the snapshot follows', () => {
    const view = mount({ open: true, record: NOTE });

    view.update({ record: { ...NOTE, version: 4, title: 'Счёт № 2' } });
    expect(field('Заголовок').value).toBe('Счёт № 2');
    expect(shownVersion()).toBe('4');
    expect(screen.queryByText('Запись изменена другим пользователем')).toBeNull();
  });

  it('a changed form keeps the input and the snapshot and shows the notice', () => {
    const view = mount({ open: true, record: NOTE });
    type('Текст', 'Оплатить сегодня');

    view.update({ record: { ...NOTE, version: 4, title: 'Счёт № 2' } });
    expect(field('Текст').value).toBe('Оплатить сегодня');
    // Even the field the person did not touch stays as it was: the form is one answer, and half of
    // it from a version the person has not seen would be a third version nobody wrote.
    expect(field('Заголовок').value).toBe('Счёт');
    expect(shownVersion()).toBe('3');
    expect(screen.getByText('Запись изменена другим пользователем')).toBeDefined();
  });

  it('«Перечитать» drops the input by consent, fills the fresh record and moves the snapshot', () => {
    const view = mount({ open: true, record: NOTE });
    type('Текст', 'Оплатить сегодня');
    view.update({ record: { ...NOTE, version: 4, title: 'Счёт № 2' } });

    fireEvent.click(screen.getByText('Перечитать'));
    expect(field('Заголовок').value).toBe('Счёт № 2');
    expect(field('Текст').value).toBe('Оплатить до пятницы');
    expect(shownVersion()).toBe('4');
    expect(screen.queryByText('Запись изменена другим пользователем')).toBeNull();
  });

  it('the same version reread as a new object changes nothing', () => {
    const view = mount({ open: true, record: NOTE });
    type('Текст', 'Оплатить сегодня');

    view.update({ record: { ...NOTE } });
    expect(field('Текст').value).toBe('Оплатить сегодня');
    expect(screen.queryByText('Запись изменена другим пользователем')).toBeNull();
  });

  it('a form without a version is filled once per session and never follows the record', () => {
    const view = mount({ open: true, record: NOTE, versioned: false });

    view.update({ record: { ...NOTE, version: 4, title: 'Счёт № 2' } });
    expect(field('Заголовок').value).toBe('Счёт');
    expect(screen.queryByText('Запись изменена другим пользователем')).toBeNull();
  });
});

describe('own mutation of the window', () => {
  it('moves the snapshot at once and refills only untouched fields when its record arrives', () => {
    let accept: ((version: number) => void) | null = null;
    const capture = (fn: (version: number) => void) => (accept = fn);
    const view = mount({ open: true, record: NOTE, onAccept: capture });
    type('Текст', 'Оплатить сегодня');

    fireEvent.click(screen.getByText('своя мутация'));
    act(() => accept!(5));
    // The next save already carries our own version: 409 for our own change would be absurd.
    expect(shownVersion()).toBe('5');

    view.update({ record: { ...NOTE, version: 5, title: 'Счёт № 5', body: 'с сервера' } });
    expect(field('Заголовок').value).toBe('Счёт № 5');
    expect(field('Текст').value).toBe('Оплатить сегодня');
    expect(screen.queryByText('Запись изменена другим пользователем')).toBeNull();
  });

  it('a foreign version after the own one is a foreign change again', () => {
    let accept: ((version: number) => void) | null = null;
    const capture = (fn: (version: number) => void) => (accept = fn);
    const view = mount({ open: true, record: NOTE, onAccept: capture });
    fireEvent.click(screen.getByText('своя мутация'));
    act(() => accept!(5));
    view.update({ record: { ...NOTE, version: 5 } });
    type('Текст', 'Оплатить сегодня');

    view.update({ record: { ...NOTE, version: 6 } });
    expect(screen.getByText('Запись изменена другим пользователем')).toBeDefined();
    expect(shownVersion()).toBe('5');
  });
});
