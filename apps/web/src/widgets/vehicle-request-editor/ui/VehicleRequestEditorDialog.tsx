import { Alert, DatePicker, Form, Input } from 'antd';
import { REQUEST_CUSTOMER_LOCKED_MESSAGE } from '@technic/contracts';
import { PhoneInput } from '@entities/user-account';
import { ResponsibleFields, TimeInput, optionalWorkTimeRule } from '@entities/request';
import { RequestCustomerSelect } from '@features/request-customer';
import { copyNotice, type FormValues } from '@features/vehicle-request-editor';
import { useIsMobile } from '@shared/lib';
import { AutoSelect, FormGrid, FormModal } from '@shared/ui';
import type { VehicleRequestEditorState } from '../model/useVehicleRequestEditorState';
import { FileEditor, VehicleClassificationSelect } from './editorFields';
import { RequestRelocationsField } from './RequestRelocationsField';
import { RequestTripsBlock } from './RequestTripsBlock';
import { VehicleBackdateFields } from './VehicleBackdateFields';

interface Props {
  confirmLoading: boolean;
  onFinish: (values: FormValues) => void;
  state: VehicleRequestEditorState;
}

export function VehicleRequestEditorDialog({ confirmLoading, onFinish, state }: Props) {
  const isMobile = useIsMobile();
  return (
    <FormModal
      title={
        state.record
          ? `Заявка ${state.record.displayNumber}`
          : state.copy
            ? `Новая заявка на автотехнику — по образцу ${state.copy.source.displayNumber}`
            : 'Новая заявка на автотехнику'
      }
      open={state.open}
      onCancel={() => state.setOpen(false)}
      onSubmit={() => state.form.submit()}
      confirmLoading={confirmLoading}
      width={880}
    >
      {state.copy && !state.record && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          description={copyNotice(state.copy.source, state.copy.minDate, state.copy.today)}
        />
      )}
      <Form form={state.form} layout="vertical" onFinish={onFinish}>
        <FormGrid>
          <Form.Item
            name="customerKey"
            label="Объект/отдел"
            extra={state.customerLocked ? REQUEST_CUSTOMER_LOCKED_MESSAGE : undefined}
            rules={[{ required: true, message: 'Выберите объект или отдел' }]}
          >
            <RequestCustomerSelect
              options={state.customer.options}
              loading={state.customer.loading}
              disabled={state.customerLocked || state.customer.disabled}
            />
          </Form.Item>
          <Form.Item
            name="requestType"
            label="Тип заявки"
            tooltip="Заказ техники на объект — техника любого вида; грузоперевозка — только грузовая"
            extra={
              state.record ? (state.retypeBlocker ?? 'Смена типа переоформит заявку') : undefined
            }
            rules={[{ required: true, message: 'Выберите тип заявки' }]}
          >
            <AutoSelect
              options={state.formRequestTypeOptions}
              placeholder="Выберите тип заявки"
              disabled={
                (!!state.record && !state.canRetype) || state.requestTypeOptions.length === 1
              }
              onChange={state.handleRequestTypeChange}
            />
          </Form.Item>
          <FormGrid.Full>
            <VehicleClassificationSelect
              groups={state.typeGroups}
              loading={state.typesLoading}
              disabled={!state.requestType}
              placeholder={
                state.requestType ? 'Выберите тип или категорию' : 'Сначала выберите тип заявки'
              }
            />
          </FormGrid.Full>

          {state.isSpecial && (
            <>
              <Form.Item
                name="dateFrom"
                label="Дата начала"
                tooltip={state.leadTimeHint}
                rules={[{ required: true, message: 'Укажите дату начала' }]}
              >
                <DatePicker
                  format="DD.MM.YYYY"
                  style={{ width: '100%' }}
                  inputReadOnly={isMobile}
                  disabledDate={state.minDateRule}
                />
              </Form.Item>
              <Form.Item
                name="dateTo"
                label="Дата окончания"
                extra={
                  state.dateToLocked
                    ? 'Срок работающей техники сокращают досрочным завершением — с визой'
                    : state.periodHint
                }
              >
                <DatePicker
                  format="DD.MM.YYYY"
                  style={{ width: '100%' }}
                  inputReadOnly={isMobile}
                  disabledDate={
                    state.dateToLocked ? state.isBeforeCurrentDateTo : state.minDateRule
                  }
                />
              </Form.Item>
              {state.backdated && state.effectiveDateKey && (
                <FormGrid.Full>
                  <VehicleBackdateFields
                    record={state.record}
                    next={state.formCalendar}
                    effectiveDate={state.effectiveDateKey}
                  />
                </FormGrid.Full>
              )}
              <FormGrid.Full>
                <ResponsibleFields
                  nameField="responsibleName"
                  phoneField="responsiblePhone"
                  nameLabel="Ответственный на объекте"
                  phoneLabel="Контактный телефон"
                  phoneInput={PhoneInput}
                />
              </FormGrid.Full>
              {state.relocationsEditable && state.record && (
                <FormGrid.Full>
                  <Form.Item label="Перегон техники (4-П)">
                    <RequestRelocationsField request={state.record} />
                  </Form.Item>
                </FormGrid.Full>
              )}
            </>
          )}

          {state.isFreight && (
            <>
              <Form.Item
                name="scheduledDate"
                label="Дата подачи"
                tooltip={state.leadTimeHint}
                rules={[{ required: true, message: 'Укажите дату' }]}
              >
                <DatePicker
                  format="DD.MM.YYYY"
                  style={{ width: '100%' }}
                  inputReadOnly={isMobile}
                  disabledDate={state.minDateRule}
                />
              </Form.Item>
              <Form.Item
                name="scheduledTime"
                label="Время (МСК)"
                tooltip="Необязательно. Рабочее окно — с 07:00 до 21:00"
                rules={[optionalWorkTimeRule]}
              >
                <TimeInput />
              </Form.Item>
              {state.backdated && state.effectiveDateKey && (
                <FormGrid.Full>
                  <VehicleBackdateFields
                    record={state.record}
                    next={state.formCalendar}
                    effectiveDate={state.effectiveDateKey}
                  />
                </FormGrid.Full>
              )}
              <RequestTripsBlock
                savedTrips={state.recordTrips}
                expanded={state.tripsExpanded}
                onExpand={() => state.setTripsExpanded(true)}
                suggestObjectIds={state.suggestObjectIds}
                cargoRequired={state.cargoRequired}
              />
            </>
          )}

          <FormGrid.Full>
            <Form.Item name="comment" label={state.commentHint?.label ?? 'Комментарий'}>
              <Input.TextArea
                rows={3}
                maxLength={2000}
                placeholder={state.commentHint?.placeholder}
              />
            </Form.Item>
            <Form.Item label="Файлы">
              <FileEditor editor={state.editor} />
            </Form.Item>
          </FormGrid.Full>
        </FormGrid>
      </Form>
    </FormModal>
  );
}
