import { Alert, Checkbox, DatePicker, Form, Input, Typography } from 'antd';
import {
  WAYBILL_CORRECTION_CONFIRM,
  assignmentRateLabel,
  assignmentTitle,
  formatMoscowDateTime,
  requestCustomerName,
  weekStartKey,
  type VehicleRequestDto,
} from '@technic/contracts';
import { TimeInput, optionalWorkTimeRule } from '@entities/request';
import { formatDateOnly, useIsMobile } from '@shared/lib';
import { AutoSelect, FormGrid } from '@shared/ui';
import type { AssignmentCorrectionController } from '../model/useAssignmentCorrection';
import type { AssignmentFleetController } from '../model/useAssignmentFleet';
import type { AssignmentRouteCrewController } from '../model/useAssignmentRouteCrew';
import type { VehicleAssignmentForm } from '../model/types';
import { DayBatchFields } from './DayBatchFields';

export function AssignmentScheduleFields({
  request,
  reassign,
  form,
  fleet,
  correction,
  crew,
  canBatchDays,
  dayBatchEnabled,
  today,
}: {
  request: VehicleRequestDto;
  reassign: boolean;
  form: VehicleAssignmentForm;
  fleet: AssignmentFleetController;
  correction: AssignmentCorrectionController;
  crew: AssignmentRouteCrewController;
  canBatchDays: boolean;
  dayBatchEnabled: boolean;
  today: string;
}) {
  const isMobile = useIsMobile();
  const dateFrom = Form.useWatch('dateFrom', form);
  const dateTo = Form.useWatch('dateTo', form);
  const machinistId = Form.useWatch('machinistId', form);

  return (
    <>
      <FormGrid.Full>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 16 }}>
          {requestCustomerName(request)} · заказано «{fleet.orderedLabel}»
        </Typography.Paragraph>
      </FormGrid.Full>
      {reassign && request.assignment && (
        <FormGrid.Full>
          <Typography.Paragraph style={{ marginBottom: 16 }}>
            Сейчас назначена: {assignmentTitle(request.assignment)}
            {assignmentRateLabel(request.assignment)
              ? ` · ${assignmentRateLabel(request.assignment)}`
              : ''}
          </Typography.Paragraph>
        </FormGrid.Full>
      )}

      {correction.canCorrect && (
        <FormGrid.Full>
          <Form.Item name="correctionEnabled" valuePropName="checked" noStyle>
            <Checkbox>Исправить задним числом: работала другая машина</Checkbox>
          </Form.Item>
        </FormGrid.Full>
      )}
      {correction.correctionEnabled && (
        <>
          <FormGrid.Full>
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 16 }}
              title="Правка прошедших дней"
              description={
                <>
                  Подписи объекта под днями работы будут сняты — часы останутся, подтвердить их
                  придётся заново. {WAYBILL_CORRECTION_CONFIRM}
                </>
              }
            />
          </FormGrid.Full>
          <FormGrid.Full>
            <Form.Item
              name="correctionReason"
              label="Причина коррекции"
              extra="Останется в журнале коррекций и в самих листах — и в списанном, и в выписанном взамен"
            >
              <Input.TextArea rows={2} maxLength={2000} placeholder="Что произошло на самом деле" />
            </Form.Item>
          </FormGrid.Full>
          <FormGrid.Full>
            <Form.Item
              name="unlockWaybillIds"
              label="Листы ЭСМ-2 к перевыписке"
              extra={
                correction.correctableSheets.length > 0
                  ? 'Отмеченные номера будут аннулированы, взамен выпишутся новые — следующими по серии'
                  : 'Отработанных недель с действующим листом у заявки нет: переписывать нечего'
              }
            >
              <Checkbox.Group
                style={{ display: 'flex', flexDirection: 'column', gap: 4 }}
                options={correction.correctableSheets.map((waybill) => ({
                  value: waybill.id,
                  label: `№ ${waybill.number} · ${formatDateOnly(waybill.periodFrom!)} – ${formatDateOnly(waybill.periodTo!)}`,
                  disabled:
                    (correction.sharedWeeks.get(weekStartKey(waybill.periodFrom!)) ?? 0) > 1,
                }))}
              />
            </Form.Item>
          </FormGrid.Full>
        </>
      )}

      {!reassign && request.requestType === 'special_equipment' && (
        <>
          <Form.Item
            name="dateFrom"
            label="Фактическая дата начала"
            rules={[{ required: true, message: 'Укажите дату начала' }]}
            extra={`Заказано: ${formatDateOnly(request.dateFrom)}`}
          >
            <DatePicker format="DD.MM.YYYY" style={{ width: '100%' }} inputReadOnly={isMobile} />
          </Form.Item>
          <Form.Item
            name="dateTo"
            label="Фактическая дата окончания"
            extra={
              request.dateTo ? `Заказано: ${formatDateOnly(request.dateTo)}` : 'Заказан один день'
            }
          >
            <DatePicker format="DD.MM.YYYY" style={{ width: '100%' }} inputReadOnly={isMobile} />
          </Form.Item>
          {crew.needsMachinist && crew.isLinear && (
            <FormGrid.Full>
              <Alert
                type="info"
                showIcon
                title="Линейная техника: ЭСМ-2 выписывается по требованию"
                description="Недельные листы портал сам не выписывает — их выписывают из карточки заявки, по неделе за раз. Работа каждого дня печатается своим 4-П. Перегона у такой техники нет: вечером она возвращается на базу."
              />
            </FormGrid.Full>
          )}
        </>
      )}
      {!reassign && request.requestType === 'freight_transport' && (
        <>
          <Form.Item
            name="scheduledDate"
            label="Фактическая дата подачи"
            rules={[{ required: true, message: 'Укажите дату подачи' }]}
            extra={`Заказано: ${formatMoscowDateTime(new Date(request.scheduledAt), request.scheduledTimeUnspecified)}`}
          >
            <DatePicker format="DD.MM.YYYY" style={{ width: '100%' }} inputReadOnly={isMobile} />
          </Form.Item>
          <Form.Item
            name="scheduledTime"
            label="Фактическое время (МСК)"
            tooltip="Необязательно. Рабочее окно — с 07:00 до 21:00"
            rules={[optionalWorkTimeRule]}
          >
            <TimeInput />
          </Form.Item>
        </>
      )}

      {crew.needsMachinist && (
        <Form.Item
          name="machinistId"
          label="Машинист"
          rules={crew.machinistRequired ? [{ required: true, message: 'Выберите машиниста' }] : []}
          extra={crew.machinistExtra}
        >
          <AutoSelect
            autoSelectSole={false}
            options={crew.machinistOptions}
            loading={crew.machinistsLoading}
            allowClear={reassign}
            placeholder={reassign ? 'Оставить прежнего' : 'Кто сядет за технику'}
            notFoundContent="В справочнике нет действующих водителей"
          />
        </Form.Item>
      )}

      {canBatchDays && (
        <DayBatchFields
          term={{
            dateFrom: dateFrom ? dateFrom.format('YYYY-MM-DD') : '',
            dateTo: dateTo ? dateTo.format('YYYY-MM-DD') : null,
          }}
          onDate={today}
          vehicleId={fleet.vehicleId}
          machinist={{
            personId: machinistId,
            name: crew.machinistItems.find((driver) => driver.id === machinistId)?.fullName ?? null,
          }}
          enabled={dayBatchEnabled}
          toggleLabel="Выписать 4-П на весь период"
        />
      )}
    </>
  );
}
