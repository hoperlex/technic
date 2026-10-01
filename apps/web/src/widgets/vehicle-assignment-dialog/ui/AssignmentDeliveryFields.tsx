import { Alert, Checkbox, DatePicker, Form, Typography } from 'antd';
import { formatWeeklyRequestNumber } from '@technic/contracts';
import { AddressField } from '@features/address-input';
import { useIsMobile } from '@shared/lib';
import { AutoSelect, FormGrid } from '@shared/ui';
import type { AssignmentDeliveryController } from '../model/useAssignmentDelivery';
import type { AssignmentFleetController } from '../model/useAssignmentFleet';
import type { AssignmentRouteCrewController } from '../model/useAssignmentRouteCrew';

export function AssignmentDeliveryFields({
  delivery,
  fleet,
  crew,
}: {
  delivery: AssignmentDeliveryController;
  fleet: AssignmentFleetController;
  crew: AssignmentRouteCrewController;
}) {
  const isMobile = useIsMobile();
  if (!delivery.canOffer || !fleet.selected) return null;

  return (
    <>
      <FormGrid.Full>
        <Typography.Title level={5} style={{ marginTop: 16, marginBottom: 0 }}>
          Доставка на объект
        </Typography.Title>
        <Form.Item name="deliveryEnabled" valuePropName="checked" noStyle>
          <Checkbox onChange={(event) => delivery.toggle(event.target.checked)}>
            Техника едет своим ходом — выписать путевой лист 4-П
          </Checkbox>
        </Form.Item>
        {delivery.weekly && (
          <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
            Доставку запросила недельная заявка{' '}
            {formatWeeklyRequestNumber(delivery.weekly.weeklyRequestNum)} — поля подставлены ею и
            правятся здесь же.
          </Typography.Paragraph>
        )}
        <Typography.Paragraph type="secondary" style={{ marginTop: 8 }}>
          Перегон станет отдельным рейсом; лист по нему выписывают в карточке маршрута. Если технику
          везут тралом, оставьте выключенным.
        </Typography.Paragraph>
      </FormGrid.Full>

      {delivery.wants && (
        <>
          <Form.Item
            name="deliveryDate"
            label="Дата перегона"
            rules={[{ required: true, message: 'Укажите дату перегона' }]}
          >
            <DatePicker format="DD.MM.YYYY" style={{ width: '100%' }} inputReadOnly={isMobile} />
          </Form.Item>
          <Form.Item
            name="deliveryDriverId"
            label="Водитель перегона"
            rules={[{ required: true, message: 'Выберите водителя' }]}
            extra={
              !delivery.date
                ? 'Сначала укажите дату: годность удостоверения считается на день перегона'
                : crew.driverOptions.length === 0 && !crew.driversLoading
                  ? 'В справочнике нет действующих водителей'
                  : undefined
            }
          >
            <AutoSelect
              autoSelectSole={false}
              options={crew.driverOptions}
              showSearch
              optionFilterProp="label"
              loading={crew.driversLoading}
              disabled={!delivery.date}
              placeholder={delivery.date ? 'Выберите водителя' : 'Сначала укажите дату перегона'}
            />
          </Form.Item>
          {crew.deliveryDriverGaps && (
            <FormGrid.Full>
              <Alert
                type="warning"
                showIcon
                title="Документы водителя перегона неполные"
                description={crew.deliveryDriverGaps}
              />
            </FormGrid.Full>
          )}
          <AddressField
            name="deliveryFrom"
            label="Откуда"
            required
            requiredMessage="Укажите, откуда идёт техника"
            directory
            suggestObjectIds={delivery.suggestObjectIds}
            placeholder="База, ул. Автомобильная, 3"
          />
          <AddressField
            name="deliveryTo"
            label="Куда"
            required
            requiredMessage="Укажите, куда идёт техника"
            directory
            suggestObjectIds={delivery.suggestObjectIds}
            placeholder="Объект, адрес площадки"
          />
        </>
      )}
    </>
  );
}
