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

/**
 * The upper part of the assignment form: what the request is and what it runs on now, the backdated
 * correction, the actual term, the ESM-2 machinist and the 4-P batch — in that reading order.
 */
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
      {/* What runs the request now — a line above the choice: a vehicle change starts with "change
          to what", and the answer to "from what" must stay in sight. Taking into work has no such
          line: there is nothing to change. */}
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

      {/* Backdated correction (ADR 0101, R8). First in the vehicle-change dialog because it changes
          the meaning of everything else: an ordinary change says "this vehicle drives from now on",
          a correction says "this vehicle was never here". Without `waybills.correct` there is no
          block at all: an action the handler answers with 403 must not be offered. */}
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
          {/* Forms of worked weeks, one by one (R11): a request may have forms of two vehicles in
              one week, and "all past ones" would burn the wrong number. Reconciliation reissues the
              current week itself — it is not listed. */}
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
                  // A week with two active forms of the request is not reissued by reconciliation
                  // (ADR 0100 decision 7): such a form is written off by number and reissued on
                  // demand, where the vehicle is named explicitly.
                  disabled:
                    (correction.sharedWeeks.get(weekStartKey(waybill.periodFrom!)) ?? 0) > 1,
                }))}
              />
            </Form.Item>
          </FormGrid.Full>
        </>
      )}

      {/* The actual term: filled with the ordered one, with what was ordered under the fields — an
          edit must be visible, not a silent substitution. Asked first because the route date drives
          the driver selection below. On a vehicle change the term is not asked — it was agreed when
          taking into work (ADR 0048), and the server does not accept `schedule` outside that. */}
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
          {/* Linear equipment (ADR 0100): instead of the week list and the delivery block — plain
              words about what this request will not have. Silence would be worse: a dispatcher used
              to seeing weeks and the relocation box here would read their absence as a portal bug,
              not as a different paper flow. */}
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

      {/* Machinist: weekly ESM-2 forms are issued to them, and without one the form is invalid. The
          list is the whole driver directory: this form has no SNILS or licence boxes, so there is
          nothing to filter by (ADR 0055).

          The field stands outside the actual-term branch because it is asked in both modes: the
          vehicle is changed together with the person (ADR 0048). Its place is the same in both
          cases — where it is looked for when taking into work; term, week list and delivery are
          about taking into work only. */}
      {crew.needsMachinist && (
        <Form.Item
          name="machinistId"
          label="Машинист"
          rules={crew.machinistRequired ? [{ required: true, message: 'Выберите машиниста' }] : []}
          extra={crew.machinistExtra}
        >
          {/* The portal never seats a person itself: even with one driver in the directory, the
              dispatcher decides. Row hints help to choose, they do not choose. For the same reason
              the previous machinist is not filled in on a vehicle change (ADR 0083): an empty field
              means "person unchanged", and clearing returns exactly that — so only there the field
              has a clear button. */}
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

      {/* The 4-P batch for the whole period (ADR 0207): checkbox, driver for the whole term and the
          reason for past days. Right under the machinist on purpose: the machinist is the batch
          driver's default, and the block names any divergence — both must be read together.

          No vehicle in the block: the batch takes it from the assignment (decision 5) built by this
          very dialog below. Days are counted by the ACTUAL term from the form, not the ordered one:
          the term is edited here, and paper goes to the dates sent to the server.

          Offered only for an own vehicle on an on-site order — a paper border, not a type border
          (R10 of the plan): a lessor issues the rental's waybill. Not on a vehicle change (the term
          runs, issued forms are not rewritten — days are collected by "Plan the period" in the
          card) and not on a "done" -> "confirmed" rollback (those days are lived already).
          Linearity is deliberately not part of it (ADR 0207 decision 1): a 4-P per day is asked for
          a machine standing a week on site too. */}
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
