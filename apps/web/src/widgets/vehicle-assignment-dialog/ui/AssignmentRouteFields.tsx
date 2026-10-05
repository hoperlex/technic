import { Alert, Form, Input, Select, Typography } from 'antd';
import { communicationKindOptions } from '@technic/contracts';
import { TrailerFields } from '@features/vehicle-route-trailer';
import { AutoSelect, FormGrid } from '@shared/ui';
import type { AssignmentFleetController } from '../model/useAssignmentFleet';
import type { AssignmentRouteCrewController } from '../model/useAssignmentRouteCrew';

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
          {!crew.joining && (
            <FormGrid.Full>
              <Typography.Title level={5} style={{ marginTop: 16, marginBottom: 0 }}>
                Новый рейс
              </Typography.Title>
            </FormGrid.Full>
          )}

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
