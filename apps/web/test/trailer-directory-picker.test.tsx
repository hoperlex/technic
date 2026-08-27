import { describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { Form } from 'antd';
import type { VehicleTrailerDto } from '@technic/contracts';
import { json, mockHttp } from './http';
import { renderWithUser } from './render';
import { list } from './factories/common';
import { FormGrid } from '../src/shared/ui';
import { TrailerFields } from '../src/pages/vehicle/TrailerFields';

const trailer = (over: Partial<VehicleTrailerDto>): VehicleTrailerDto =>
  ({
    id: 'tr-1',
    kind: 'semi_trailer',
    model: 'ШМИТЦ SPR-24',
    registrationNumber: 'ВХ933277',
    vin: '',
    passportNumber: '',
    manufacturedYear: null,
    color: '',
    maxMassKg: null,
    curbMassKg: null,
    ownerOrganizationId: null,
    ownerOrganizationName: null,
    status: 'active',
    note: '',
    sourceName: '',
    hitchedVehicle: null,
    hitchPosition: null,
    createdAt: '2026-08-01T06:00:00.000Z',
    updatedAt: '2026-08-01T06:00:00.000Z',
    deletedAt: null,
    ...over,
  }) as VehicleTrailerDto;

const onFinish = vi.fn();

function Harness({
  hitched,
}: {
  hitched?: {
    id: string;
    position: 1 | 2;
    model: string;
    registrationNumber: string;
    status: 'active' | 'maintenance';
  }[];
}) {
  const [form] = Form.useForm();
  const withTrailer = Form.useWatch('withTrailer', form) ?? false;
  return (
    <Form form={form} initialValues={{ withTrailer: true }} onFinish={onFinish}>
      <FormGrid>
        <TrailerFields
          withTrailer={withTrailer || true}
          checkboxLabel="Рейс с прицепом"
          checkboxFullWidth
          modelPlaceholder="СЗАП-8551"
          regNumberPlaceholder="АВ1234 77"
          secondPlaceholder="Если прицепов два"
          hitched={hitched}
          vehicleId="v-1"
          vehicleTypeId="vt-1"
        />
      </FormGrid>
      <button type="submit">Сохранить</button>
    </Form>
  );
}

describe('smoke', () => {
  it('чекбокс включает список, выбор кладёт графы, предупреждение о чужой машине', async () => {
    mockHttp({
      'GET /vehicle-types': () => json(list([])),
      'GET /vehicle-trailers': () =>
        json(
          list([
            trailer({}),
            trailer({
              id: 'tr-2',
              model: 'МАЗ-8926',
              registrationNumber: 'АВ123477',
              status: 'maintenance',
              hitchedVehicle: { id: 'v-9', registrationNumber: 'О403ВХ777', modelName: 'КАМАЗ' },
              hitchPosition: 1,
            }),
            trailer({
              id: 'tr-3',
              model: 'СПИСАННЫЙ',
              registrationNumber: 'СС111177',
              status: 'retired',
            }),
          ]),
        ),
    });
    renderWithUser(<Harness />);

    // Ручной режим: два поля первой пары.
    expect(await screen.findByLabelText('Прицеп 1: марка')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Прицеп 1: марка'), {
      target: { value: 'РУЧНАЯ МАРКА' },
    });

    const boxes = screen.getAllByRole('checkbox', { name: 'Из справочника' });
    expect(boxes).toHaveLength(2);
    fireEvent.click(boxes[0]!);

    // Режим справочника: список вместо полей, набранное показано отдельной строкой.
    expect(await screen.findByLabelText('Прицеп 1')).toBeTruthy();
    expect(screen.getByText('РУЧНАЯ МАРКА')).toBeTruthy();

    fireEvent.mouseDown(screen.getByLabelText('Прицеп 1'));
    await waitFor(() =>
      expect(screen.getAllByText('ШМИТЦ SPR-24 ВХ933277').length).toBeGreaterThan(0),
    );
    // Списанного в списке нет.
    expect(screen.queryByText('СПИСАННЫЙ СС111177')).toBeNull();
    // Обслуживание помечено.
    expect(screen.getByText('Обслуживание')).toBeTruthy();

    fireEvent.click(screen.getAllByText('МАЗ-8926 АВ123477')[0]!);
    await waitFor(() =>
      expect(
        screen.getByText(
          'Прицеп закреплён за другой машиной — О403ВХ777. Рейс это не запрещает: закрепление не меняется.',
        ),
      ).toBeTruthy(),
    );

    // Главное: выбранное доезжает до отправки, хотя поля спрятаны.
    fireEvent.click(screen.getByText('Сохранить'));
    await waitFor(() => expect(onFinish).toHaveBeenCalled());
    expect(onFinish.mock.calls[0]![0]).toMatchObject({
      trailer1Model: 'МАЗ-8926',
      trailer1RegNumber: 'АВ123477',
    });

    // Возврат в ручной: графы заполнены выбором.
    fireEvent.click(screen.getAllByRole('checkbox', { name: 'Из справочника' })[0]!);
    await waitFor(() =>
      expect((screen.getByLabelText('Прицеп 1: марка') as HTMLInputElement).value).toBe('МАЗ-8926'),
    );
    expect((screen.getByLabelText('Прицеп 1: госномер') as HTMLInputElement).value).toBe(
      'АВ123477',
    );
  });

  it('подстановка закрепления включает режим справочника', async () => {
    mockHttp({
      'GET /vehicle-types': () => json(list([])),
      'GET /vehicle-trailers': () => json(list([trailer({})])),
    });
    renderWithUser(
      <Harness
        hitched={[
          {
            id: 'tr-1',
            position: 1,
            model: 'ШМИТЦ SPR-24',
            registrationNumber: 'ВХ933277',
            status: 'active',
          },
        ]}
      />,
    );
    expect(await screen.findByLabelText('Прицеп 1')).toBeTruthy();
    // Второй слот остался ручным.
    expect(screen.getByLabelText('Прицеп 2: марка')).toBeTruthy();
    // Подпись про закрепление на месте.
    expect(screen.getByText(/В графах — прицеп, закреплённый за машиной/)).toBeTruthy();
  });
});

describe('второй слот', () => {
  it('не предлагает прицеп, уже стоящий в первом', async () => {
    mockHttp({
      'GET /vehicle-types': () => json(list([])),
      'GET /vehicle-trailers': () =>
        json(
          list([
            trailer({}),
            trailer({ id: 'tr-2', model: 'МАЗ-8926', registrationNumber: 'АВ123477' }),
          ]),
        ),
    });
    renderWithUser(<Harness />);
    fireEvent.change(await screen.findByLabelText('Прицеп 1: госномер'), {
      target: { value: 'вх 933277' },
    });
    fireEvent.click(screen.getAllByRole('checkbox', { name: 'Из справочника' })[1]!);
    fireEvent.mouseDown(await screen.findByLabelText('Прицеп 2'));
    await waitFor(() => expect(screen.getAllByText('МАЗ-8926 АВ123477').length).toBeGreaterThan(0));
    expect(screen.queryByText('ШМИТЦ SPR-24 ВХ933277')).toBeNull();
  });
});
