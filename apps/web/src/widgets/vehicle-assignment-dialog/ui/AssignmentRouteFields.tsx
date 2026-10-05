import { Alert, Form, Input, Select, Typography } from 'antd';
import { communicationKindOptions } from '@technic/contracts';
import { TrailerFields } from '@features/vehicle-route-trailer';
import { AutoSelect, FormGrid } from '@shared/ui';
import type { AssignmentFleetController } from '../model/useAssignmentFleet';
import type { AssignmentRouteCrewController } from '../model/useAssignmentRouteCrew';

/**
 * The lower part of the form: why no route is kept, or the route's driver and departure details. /
 */
export function AssignmentRouteFields({
  targetId,
  fleet,
  crew,
}: {
  targetId: string;
  fleet: AssignmentFleetController;
  crew: AssignmentRouteCrewController;
}) {
  return (
    <>
      {/* Why no route is kept: a rental is run by its lessor, a type may have no form. Shown as
          text — a vanished "Route" block would read as a bug. An on-site order has neither block
          nor text: there is no route in that process, nothing to explain (ADR 0041). */}
      {fleet.selected && !crew.routeModel.needsRoute && crew.routeModel.reason && (
        <FormGrid.Full>
          <Alert
            type="info"
            showIcon
            style={{ marginTop: 16 }}
            title="Маршрут не ведётся"
            description={crew.routeModel.reason}
          />
        </FormGrid.Full>
      )}

      {crew.routeModel.needsRoute && (
        <>
          {crew.joining && (
            <FormGrid.Full>
              <Typography.Text type="secondary">
                Заявка встанет строкой задания в рейс {crew.joined?.displayNumber}: реквизиты выезда
                там уже свои, и правят их в карточке маршрута.
              </Typography.Text>
            </FormGrid.Full>
          )}
          {/* A new route asks what an existing one need not: how the form's header fields are
              filled. The heading is here, not up at the route choice: up there one decides where
              the request goes, here the route itself is created. */}
          {!crew.joining && (
            <FormGrid.Full>
              <Typography.Title level={5} style={{ marginTop: 16, marginBottom: 0 }}>
                Новый рейс
              </Typography.Title>
            </FormGrid.Full>
          )}

          {/* The driver is a question of both branches (ADR 0048), with different obligation: a
              new route cannot get a waybill without one, for an existing route an empty field means
              "the same person drives". One field for both, not two: the form has one box, and a
              second field would drift from the first in list, marks and warnings below. */}
          <Form.Item
            name="driverPersonId"
            label="Водитель"
            rules={crew.joining ? [] : [{ required: true, message: 'Выберите водителя' }]}
            extra={
              crew.joining
                ? crew.joinedDriverExtra
                : crew.driverOptions.length === 0 && !crew.driversLoading
                  ? 'В справочнике нет действующих водителей: заведите карточку или откройте специализацию «водитель» у существующей.'
                  : undefined
            }
          >
            {/* The driver is never filled in — not as the only one in the directory, not as
                yesterday's driver of this vehicle, not as the existing route's current driver (ADR
                0083). The dispatcher seats the person, and a filled-in surname reads as a decision
                taken: it gets skimmed, and goes into the form for real. The list still hints —
                suitable first, with category and document marks (ADR 0055, ADR 0064).

                Clear button only for an existing route: there clearing returns the meaningful
                "do not touch the driver"; a new route has nothing to return to, it is required. */}
            <AutoSelect
              autoSelectSole={false}
              options={crew.driverOptions}
              showSearch
              allowClear={crew.joining}
              optionFilterProp="label"
              loading={crew.driversLoading}
              placeholder={crew.joining ? 'Оставить водителя рейса' : 'Выберите водителя'}
            />
          </Form.Item>

          {/* The route is shared: one task for all, one driver — a change affects every request in
              it, not only this one. It is read before the click and under the same field: the route
              list shows "3 of 7 requests", but not whose. */}
          {crew.joining && crew.joinedRouteNote && (
            <FormGrid.Full>
              <Alert
                type={crew.joinedRouteNote.type}
                showIcon
                title={crew.joinedRouteNote.message}
                description={crew.joinedRouteNote.description}
              />
            </FormGrid.Full>
          )}
          {/* Two warnings, not one: an empty form box and a foreign category are different things —
              the first is checked against the driver directory, the second against the document in
              hand. Neither forbids anything (ADR 0055, ADR 0064). For an existing route's driver
              they say the same: the route's form and its boxes are the same. */}
          {crew.driverGaps && (
            <FormGrid.Full>
              <Alert
                type="warning"
                showIcon
                title="Документы водителя внесены не полностью"
                description={crew.driverGaps}
              />
            </FormGrid.Full>
          )}
          {crew.driverCategoryMismatch && (
            <FormGrid.Full>
              <Alert
                type="warning"
                showIcon
                title="Категория прав не совпадает с требованием машины"
                description={crew.driverCategoryMismatch}
              />
            </FormGrid.Full>
          )}

          {/* Departure details are properties of the route: an existing one has its own, and asking
              them here would silently rewrite someone else's route. The driver is deliberately
              exempt (ADR 0048): a person takes the wheel, not a header box is filled, and they are
              changed with the same move as the vehicle. A trailer raises the required driver
              category, so the list above is rebuilt when it is toggled.

              The trailer block stands OUTSIDE the `joining` condition: it decides itself whether to
              render by `asks` (§14, R20). Inside, it would unmount together with the answer, while
              the route locks the vehicle to its own. */}
          <TrailerFields
            key={targetId}
            withTrailer={crew.withTrailer}
            checkboxLabel="Рейс с прицепом"
            modelPlaceholder="МАЗ-8926"
            regNumberPlaceholder="8062 ЕН 77"
            secondPlaceholder="Если прицепов два"
            hitched={crew.suggestion?.hitched}
            vehicleId={fleet.vehicleId}
            vehicleTypeId={fleet.selected?.vehicleTypeId}
            asks={!crew.joining}
          />
          {!crew.joining && (
            <>
              <Form.Item name="garageNumber" label="Гаражный номер">
                <Input placeholder="00000389" />
              </Form.Item>
              {/* A list, not a string: the value is printed in a box of the 4-P and form No. 3, and
                  one word written three ways makes a stack of waybills unreconcilable. No clear
                  button and no "not chosen" item — the UI requirement was mandatory, and the box no
                  longer leaves the dialog empty. A value inherited from a previous route outside
                  the set stays as its own item (`communicationKindOptions`). */}
              <Form.Item
                name="communicationKind"
                label="Вид сообщения"
                rules={[{ required: true, message: 'Выберите вид сообщения' }]}
              >
                <Select options={communicationKindOptions(crew.communicationKind)} />
              </Form.Item>
              <Form.Item name="transportationKind" label="Вид перевозки">
                <Input placeholder="коммерческая" />
              </Form.Item>
            </>
          )}
        </>
      )}
    </>
  );
}
