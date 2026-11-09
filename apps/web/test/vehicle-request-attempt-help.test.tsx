import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import { Form } from 'antd';
import { mockHttp } from './http';
import { renderWithUser } from './render';
import { authUser } from './factories/auth';
import { VehicleRequestEditorDialog } from '../src/widgets/vehicle-request-editor/ui/VehicleRequestEditorDialog';
import type { VehicleRequestEditorState } from '../src/widgets/vehicle-request-editor/model/useVehicleRequestEditorState';

/**
 * The words the create dialog says over a frozen attempt. «Сохранить» repeats the frozen data, not
 * the form, and a person who edits the form after a failed send must be told that before pressing
 * it — the old text promised only a reconciliation and hid exactly this.
 */

// The editor body is a lazy chunk of its own and has nothing to do with the notice above it.
vi.mock('../src/widgets/vehicle-request-editor/ui/VehicleRequestEditorBody', () => ({
  VehicleRequestEditorBody: () => null,
}));

const KEY = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function renderDialog(attempt: { key: string; protocol?: 'receipt-v1'; body: object }) {
  function Harness() {
    const [form] = Form.useForm();
    // Only what the dialog reads; the controller behind it is exercised by its own tests.
    const state = {
      open: true,
      record: null,
      copy: null,
      close: vi.fn(),
      form,
      reviewRequired: false,
      restoring: false,
      typesLoading: false,
      customer: { loading: false },
      operationId: KEY,
      confirmReview: vi.fn(),
      restoreDraft: vi.fn(),
      draft: {
        active: { createAttempt: attempt },
        pending: [],
        status: { available: true },
        persist: vi.fn(() => true),
        discardPending: vi.fn(),
      },
    } as unknown as VehicleRequestEditorState;
    return (
      <>
        <Form form={form} />
        <VehicleRequestEditorDialog
          confirmLoading={false}
          onFinish={vi.fn()}
          onReconcile={vi.fn()}
          onResetBackdated={vi.fn()}
          onResetLegacy={vi.fn()}
          reconciling={false}
          state={state}
        />
      </>
    );
  }
  mockHttp({});
  renderWithUser(<Harness />, { user: authUser() });
}

describe('подсказка над замороженной попыткой создания', () => {
  it('receipt-v1: правки формы в повтор не войдут, при отказе сервера портал сверит сам', async () => {
    renderDialog({ key: KEY, protocol: 'receipt-v1', body: {} });

    expect(
      await screen.findByText(
        `Исходные данные и файлы сохранены с кодом ${KEY}. Пока исход не сверен, «Сохранить» повторяет именно их — правки формы в повтор не войдут. Если сервер отклонит повтор, портал сам сверит попытку и, подтвердив, что заявка не создана, отпустит форму для исправлений.`,
      ),
    ).toBeDefined();
    expect(screen.getByText('Сверить исходную отправку')).toBeDefined();
  });

  it('попытка старой версии портала говорит прежнее', async () => {
    renderDialog({ key: KEY, body: {} });

    expect(
      await screen.findByText(
        `Попытка ${KEY} отправлена старой версией портала. Новая сверка для неё недоступна; сначала проверьте реестр, затем при необходимости начните новую попытку вручную.`,
      ),
    ).toBeDefined();
    expect(screen.queryByText('Сверить исходную отправку')).toBeNull();
  });
});
