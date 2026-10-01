import { Form, InputNumber, Segmented, Space, Tag, Typography } from 'antd';
import {
  routeRequestCapacity,
  VEHICLE_OWNERSHIPS,
  vehicleOwnershipLabels,
  type VehicleOwnership,
} from '@technic/contracts';
import { formatMoney } from '@shared/lib';
import { AutoSelect, FormGrid } from '@shared/ui';
import { NEW_ROUTE } from '@features/vehicle-assignment';
import type { AssignmentFleetController } from '../model/useAssignmentFleet';
import type { AssignmentRouteCrewController } from '../model/useAssignmentRouteCrew';
import type { VehicleAssignmentForm } from '../model/types';

/** Render route-first planning and the complete, advisory-only fleet selector. */
export function AssignmentFleetFields({
  form,
  fleet,
  crew,
}: {
  form: VehicleAssignmentForm;
  fleet: AssignmentFleetController;
  crew: AssignmentRouteCrewController;
}) {
  return (
    <>
      {crew.routeModel.needsRoute && (
        <FormGrid.Full>
          <Typography.Title level={5} style={{ marginTop: 8 }}>
            Маршрут
          </Typography.Title>
          <Typography.Paragraph type="secondary" style={{ marginTop: -8 }}>
            Рейс на {crew.tripDate}. Путевой лист выписывается с маршрута, когда состав собран —
            {crew.prefillFormLabel ? ` ${crew.prefillFormLabel.toLowerCase()}` : ' по бланку рейса'}
            .
          </Typography.Paragraph>
          <Form.Item name="routeId" label="Рейс">
            <AutoSelect
              options={[
                ...crew.routeOptions.map((route) => ({
                  value: route.id,
                  label: [
                    route.displayNumber,
                    route.vehicleLabel,
                    route.driverName || 'водитель не назначен',
                    `${route.requests.length} из ${routeRequestCapacity(route.formCode)} заявок`,
                  ].join(' · '),
                })),
                { value: NEW_ROUTE, label: 'Новый маршрут' },
              ]}
              showSearch
              optionFilterProp="label"
              placeholder="Выберите рейс"
              onChange={crew.changeRoute}
            />
          </Form.Item>
        </FormGrid.Full>
      )}

      <FormGrid.Full>
        <Form.Item label="Техника">
          <Segmented<VehicleOwnership>
            block
            value={fleet.ownership}
            onChange={fleet.changeOwnership}
            options={VEHICLE_OWNERSHIPS.map((ownership) => ({
              value: ownership,
              label: `${vehicleOwnershipLabels[ownership]} · ${fleet.byOwnership[ownership].length}`,
              disabled: fleet.byOwnership[ownership].length === 0,
            }))}
          />
        </Form.Item>
      </FormGrid.Full>

      {fleet.isRental && (
        <Form.Item
          name="lessorId"
          label="Арендодатель"
          rules={[{ required: true, message: 'Выберите арендодателя' }]}
        >
          <AutoSelect
            options={fleet.lessorOptions}
            showSearch
            optionFilterProp="label"
            loading={fleet.isFetching}
            placeholder="Выберите арендодателя"
            onChange={() =>
              form.setFieldsValue({
                vehicleId: undefined,
                pricePerHour: null,
                pricePerShift: null,
                shiftHours: null,
              })
            }
          />
        </Form.Item>
      )}

      <Form.Item
        name="vehicleId"
        label="Конкретная техника"
        rules={[{ required: true, message: 'Выберите технику' }]}
        extra={
          crew.joined ? (
            <Typography.Text type="secondary">
              Машину задал рейс {crew.joined.displayNumber} — выберите «Новый маршрут», чтобы
              сменить её
            </Typography.Text>
          ) : fleet.substitution ? (
            <Typography.Text
              type={fleet.substitution.level === 'warning' ? 'warning' : 'secondary'}
            >
              {fleet.substitution.text}
              {crew.routeModel.formChange ? ` ${crew.routeModel.formChange}.` : ''}
            </Typography.Text>
          ) : fleet.vehicleOptions.length === 0 ? (
            fleet.emptyText
          ) : fleet.hiddenVehicles > 0 ? (
            <Typography.Text type="secondary">
              Заказанный вид техники показан целиком; машин других видов в списке не все — ещё{' '}
              {fleet.hiddenVehicles} в парке
            </Typography.Text>
          ) : undefined
        }
      >
        <AutoSelect
          options={fleet.vehicleOptions}
          showSearch
          optionFilterProp="label"
          loading={fleet.isFetching}
          disabled={crew.joining || (fleet.isRental && !fleet.lessorId)}
          placeholder={
            fleet.isRental && !fleet.lessorId ? 'Сначала выберите арендодателя' : 'Выберите ТС'
          }
          onChange={crew.changeVehicle}
        />
      </Form.Item>

      {fleet.selected && (
        <FormGrid.Full>
          <Space size={8} wrap style={{ marginBottom: 16 }}>
            <Tag
              color={
                fleet.substitution
                  ? fleet.substitution.level === 'warning'
                    ? 'orange'
                    : 'gold'
                  : 'blue'
              }
            >
              {fleet.selected.categoryName ?? fleet.selected.typeName}
            </Tag>
            {fleet.selected.registrationNumber && <Tag>{fleet.selected.registrationNumber}</Tag>}
            {fleet.selected.lessorName && <Tag color="purple">{fleet.selected.lessorName}</Tag>}
          </Space>
        </FormGrid.Full>
      )}

      <Form.Item
        name="pricePerHour"
        label="Стоимость за час, ₽"
        extra={
          fleet.listedRate?.pricePerHour != null
            ? `В справочнике: ${formatMoney(fleet.listedRate.pricePerHour)}`
            : undefined
        }
      >
        <InputNumber style={{ width: '100%' }} min={0} step={100} precision={2} />
      </Form.Item>
      <Form.Item
        name="pricePerShift"
        label="Стоимость за смену, ₽"
        extra={
          fleet.listedRate?.pricePerShift != null
            ? `В справочнике: ${formatMoney(fleet.listedRate.pricePerShift)}`
            : undefined
        }
      >
        <InputNumber style={{ width: '100%' }} min={0} step={1000} precision={2} />
      </Form.Item>
      <Form.Item name="shiftHours" label="Часов в смене">
        <InputNumber style={{ width: '100%' }} min={1} max={24} precision={0} />
      </Form.Item>
      <FormGrid.Full>
        {fleet.priceChanged && (
          <Typography.Text type="warning">
            Ставка отличается от справочника — в заявке сохранится договорная
          </Typography.Text>
        )}
        {!fleet.isRental && (
          <Typography.Text type="secondary">
            У собственной техники ставка необязательна: её указывают, если работу считают в деньгах
          </Typography.Text>
        )}
      </FormGrid.Full>
    </>
  );
}
