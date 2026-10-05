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

/**
 * Route-first planning and the fleet selector.
 *
 * The list is not narrowed by anything: neither the ordered category (ADR 0045), nor type (ADR
 * 0059), nor vehicle kind (ADR 0064). Ordered "Truck crane, 130 t" — the list has a 25 t truck
 * crane, a 200 t self-propelled crane and, lowest of all, a dump truck. Whether a neighbouring
 * position fits is the dispatcher's call: they know the fleet and what was agreed with the
 * customer, while the directory is filled unevenly, and a ban by it would hide the machine that
 * actually does the work. The mismatch is named — as a list group ("Larger than ordered", "Another
 * vehicle kind"), a mark in the row and a warning under the field — but the choice is not taken
 * away.
 */
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
      {/* Step 1: which route the request goes with. Asked before the vehicle because that is how
          the day is planned: a vehicle of this type already has a route, the request is appended as
          a task row, and the route defines the vehicle (ADR 0052). "New route" restores the old
          order: the vehicle is chosen and a route is created for it.

          Routes are shown for the form's date: the delivery is edited right here, and a route
          prints the task of one day — a hint for a neighbouring day would offer routes the request
          cannot join. */}
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

      {/* Step 2: whose vehicle. The number of units is in the label itself: an empty branch is
          visible before entering it. Not a form field: ownership is not part of the assignment — it
          belongs to the vehicle, and here it only narrows the list. */}
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

      {/* Step 3 (rental only): from whom. */}
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

      {/* Step 4: the concrete unit. A mismatch with the ordered position is a warning under the
          field (ADR 0045, ADR 0059, ADR 0064): it does not cancel the assignment, but it does not
          pass unnoticed either. A selected route locks the field: the route defines the vehicle
          (ADR 0052). A truncated fleet is named here too: field search runs over loaded rows, and a
          vehicle that did not fit the page would look absent. */}
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
            {/* The selected vehicle's classifier position: the colour changes when it diverges from
                the order — the tag and the warning say the same thing in two ways. */}
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

      {/* Rates: filled from the directory, but these are inputs — the price of a request is agreed
          separately from the price list. */}
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
