import { describe, expect, it } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { departmentKeys } from '@entities/department';
import { useDriverEditor } from '@features/driver-editor';
import { machinist } from './factories/vehicle';
import { json, mockHttp } from './http';
import { renderWithUser } from './render';
import { expectCarriersRefetched, primeCarriers } from './carrierRefresh';

function DriverActions() {
  const driver = machinist({ snils: '11223344595', email: '' });
  const editor = useDriverEditor({
    documentActions: {
      canWrite: false,
      canDelete: false,
      onReplace: () => undefined,
      onVerify: () => undefined,
      onRevoke: () => undefined,
      onDelete: () => undefined,
    },
  });
  return (
    <>
      <button onClick={() => editor.actions.edit(driver)}>Edit driver</button>
      {editor.node}
    </>
  );
}

describe('department head names carried from driver edits', () => {
  it('refreshes the department after a driver name is saved to the linked account', async () => {
    const http = mockHttp({
      'GET /drivers/license-categories': () => json([]),
      'PATCH /drivers/:id': () => json(machinist()),
    });
    const { queryClient } = renderWithUser(<DriverActions />);
    const carriers = [departmentKeys.list({})];
    primeCarriers(queryClient, carriers);

    fireEvent.click(screen.getByText('Edit driver'));
    fireEvent.change(await screen.findByLabelText('Фамилия'), { target: { value: 'Петров' } });
    fireEvent.click(screen.getByRole('button', { name: 'Сохранить' }));

    await waitFor(() => expect(http.countOf('PATCH /drivers/:id')).toBe(1));
    await expectCarriersRefetched(queryClient, carriers);
  });
});
