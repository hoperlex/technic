import { lazy, useEffect, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen } from '@testing-library/react';
import { DeferredContent } from '@shared/ui';
import { VehicleAssignModal } from '@widgets/vehicle-assignment-dialog';
import { renderWithUser } from './render';
import { json, mockHttp } from './http';
import { list } from './factories/common';
import { vehicleRequest } from './factories/vehicle';

describe('отложенное первое открытие', () => {
  it('не загружает закрытое тело, но сохраняет его состояние и закрытые props после открытия', async () => {
    const mounted = vi.fn();
    const unmounted = vi.fn();
    function Body({ active }: { active: boolean }) {
      const [count, setCount] = useState(0);
      useEffect(() => {
        mounted();
        return unmounted;
      }, []);
      return (
        <button onClick={() => setCount(count + 1)}>
          {active ? 'Открыт' : 'Закрыт'} {count}
        </button>
      );
    }
    const load = vi.fn(async () => ({ default: Body }));
    const LazyBody = lazy(load);
    function Probe({ active }: { active: boolean }) {
      return (
        <DeferredContent active={active} fallback={<p>Загрузка</p>}>
          <LazyBody active={active} />
        </DeferredContent>
      );
    }
    const rendered = renderWithUser(<Probe active={false} />);
    expect(load).not.toHaveBeenCalled();
    rendered.rerender(<Probe active />);
    fireEvent.click(await screen.findByText('Открыт 0'));
    rendered.rerender(<Probe active={false} />);
    expect(screen.getByText('Закрыт 1')).toBeDefined();
    expect(unmounted).not.toHaveBeenCalled();
    rendered.rerender(<Probe active />);
    expect(screen.getByText('Открыт 1')).toBeDefined();
    expect(load).toHaveBeenCalledTimes(1);
    expect(mounted).toHaveBeenCalledTimes(1);
  });

  it('отменённое холодное назначение не воскресает и не спрашивает парк', async () => {
    const http = mockHttp({ 'GET /vehicles': () => json(list([])) });
    function Probe() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>Назначить</button>
          <VehicleAssignModal
            request={open ? vehicleRequest() : null}
            confirmLoading={false}
            onCancel={() => setOpen(false)}
            onSubmit={() => undefined}
          />
        </>
      );
    }
    renderWithUser(<Probe />);
    fireEvent.click(screen.getByText('Назначить'));
    expect(screen.getByRole('dialog')).toBeDefined();
    expect(
      (screen.getByRole('button', { name: 'Взять в работу' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Отмена' }));
    await act(() => vi.dynamicImportSettled());
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(http.countOf('GET /vehicles')).toBe(0);
  });
});
