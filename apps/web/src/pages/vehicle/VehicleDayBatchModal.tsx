import { useEffect, useMemo } from 'react';
import { Checkbox, Form, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import {
  assignmentTitle,
  type SpecialEquipmentRequestDto,
  type VehicleRequestDaysDto,
} from '@technic/contracts';
import { vehicleRequestKeys, vehicleRequestsApi } from '@entities/vehicle-request';
import { FormGrid, FormModal } from '@shared/ui';
import { formatDateOnly } from './shared';
import { DayBatchFields, type DayBatchFormValues } from './DayBatchFields';
import { useDayBatch } from './useDayBatch';

/**
 * «Распланировать период» — вторая дверь пачки «4-П на весь период» (ADR 0207 решение 4).
 *
 * Первая — галочка в окне принятия в работу, и ею закрывается обычный случай: заказ берут в работу
 * и сразу выписывают бумагу на весь срок. Эта — для того, что случается после: срок продлили,
 * несколько дней пропустили, часть листов аннулировали. Дверь на сервере у них одна, правила одни,
 * и отчёт один и тот же.
 *
 * Своим окном, а не блоком таблицы дней: у таблицы свой разговор — день за днём и машина у каждого
 * своя, — а здесь один вопрос на весь период. Машина в этом окне не спрашивается вовсе: пачка
 * берёт её из назначения заявки (решение 5), и об этом сказано прямо в шапке окна.
 */

interface Props {
  /**
   * Заказ, чей период планируют, и день среза; `null` — окно закрыто. День среза приходит от
   * таблицы дней, а не считается здесь: его считает сервер (`VehicleRequestDaysDto.onDate`), и
   * разойтись с ним окну нельзя — иначе оно не спросит причину там, где сервер её потребует.
   */
  target: { request: SpecialEquipmentRequestDto; onDate: string } | null;
  onClose: () => void;
  /** Новая таблица дней: её кэшем владеет вызывающий, как и у подённого окна. */
  onDone: (days: VehicleRequestDaysDto) => void;
}

export function VehicleDayBatchModal({ target, onClose, onDone }: Props) {
  const [form] = Form.useForm<DayBatchFormValues>();
  const request = target?.request ?? null;

  const batch = useDayBatch({
    onDays: (days) => {
      onDone(days);
      onClose();
    },
  });

  /**
   * Поля сбрасываются при смене заявки, а не при размонтировании: окно переиспользуется, и
   * оставшийся от соседнего заказа водитель читался бы как решение по этому. Листы предлагаются
   * выписать — за ними сюда и приходят; снять галочку можно, и тогда дни просто встанут в рейсы.
   *
   * Зависимость — идентификатор заявки, а не сам `target`: тот собирается вызывающим на каждый
   * его перерисовке, и сброс по объекту стирал бы уже выбранного водителя от любого чужого
   * ответа сервера.
   */
  const targetId = request?.id ?? null;
  useEffect(() => {
    if (!targetId) return;
    form.setFieldsValue({
      dayBatchIssue: true,
      dayBatchDriverId: undefined,
      dayBatchReason: undefined,
    });
  }, [targetId, form]);

  /**
   * Машинист заявки: умолчание поля водителя и та сторона, с которой сверяется выбор (решение 6).
   * Берётся из истории назначения — единственного места, где портал знает человека заявки
   * **идентификатором**: в листах ЭСМ-2 стоит только имя, а по имени в поле не подставишь.
   * Истории может не быть вовсе (заявку вели до её появления) — тогда подставлять некого, и поле
   * открывается пустым.
   */
  const { data: history } = useQuery({
    queryKey: vehicleRequestKeys.history(targetId ?? ''),
    queryFn: () => vehicleRequestsApi.assignmentHistory(targetId!),
    enabled: !!targetId,
  });
  const machinist = useMemo(() => {
    const onDate = target?.onDate ?? '';
    const current = (history?.changes ?? [])
      .filter((c) => c.dimension === 'driver' && !c.supersededKind && c.effectiveDate <= onDate)
      .sort((a, b) => b.effectiveDate.localeCompare(a.effectiveDate))[0]?.driver;
    if (current?.state !== 'set') return null;
    const person = history?.people.find((p) => p.personId === current.personId);
    return { personId: current.personId, name: person?.fullName ?? null };
  }, [history, target?.onDate]);

  const term = request
    ? { dateFrom: request.dateFrom, dateTo: request.dateTo }
    : { dateFrom: '', dateTo: null };

  return (
    <>
      <FormModal
        title={request ? `Распланировать период: заявка ${request.displayNumber}` : 'Период'}
        open={!!target}
        onCancel={onClose}
        onSubmit={() => form.submit()}
        confirmLoading={batch.applying}
        okText="Распланировать"
        // Длина срока кнопку больше не гасит (решение 11): срок длиннее порции проходится
        // несколькими нажатиями, и сколько дней уйдёт в это, сказано в теле окна.
        width={640}
      >
        <Form<DayBatchFormValues>
          form={form}
          layout="vertical"
          onFinish={(values) => request && batch.apply({ requestId: request.id, values })}
        >
          <FormGrid>
            <FormGrid.Full>
              <Typography.Paragraph type="secondary">
                {request
                  ? `${request.objectName}, ${formatDateOnly(request.dateFrom)} — ${
                      request.dateTo ? formatDateOnly(request.dateTo) : 'без даты окончания'
                    }. `
                  : ''}
                Пачка пройдёт срок подряд и заведёт рейс на каждый день
                {request?.assignment ? ` машины ${assignmentTitle(request.assignment)}` : ''};
                занятые и закрытые бумагой дни она пропустит и назовёт в отчёте.
              </Typography.Paragraph>
            </FormGrid.Full>

            {/* Рейсы без бумаги — законный ход: маршруты собирают заранее, а номер строгой
              отчётности расходуют тогда, когда бланк поедет с водителем. У галочки окна принятия
              в работу этого выбора нет: там бумага и есть цель. */}
            <FormGrid.Full>
              <Form.Item name="dayBatchIssue" valuePropName="checked" noStyle>
                <Checkbox>Выписать путевые листы по заведённым рейсам</Checkbox>
              </Form.Item>
            </FormGrid.Full>

            <DayBatchFields
              term={term}
              onDate={target?.onDate ?? ''}
              vehicleId={request?.assignment?.vehicleId}
              machinist={machinist}
              enabled={!!target}
              toggleLabel={null}
            />
          </FormGrid>
        </Form>
      </FormModal>
      {/* Отчёт живёт снаружи окна: к моменту его показа окно уже закрыто — пачка прошла, и
        возвращаться в форму не к чему. */}
      {batch.report}
    </>
  );
}
