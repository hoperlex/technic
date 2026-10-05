import { useEffect } from 'react';
import { Alert, Checkbox, Form, Input, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { driverKeys, driversApi } from '@entities/driver';
import { AutoSelect, FormGrid } from '@shared/ui';
import {
  dayBatchModel,
  driverOption,
  type DayBatchFormValues,
  type DayBatchMachinist,
  type DayBatchTerm,
} from '@features/vehicle-assignment';
import { formatDateOnly } from '@shared/lib';

/**
 * Поля пачки «4-П на весь период» (ADR 0207): кто поедет весь срок и чем объясняются прошедшие
 * дни.
 *
 * Отдельным файлом от обоих окон, которые его показывают, по той же границе, что `TrailerFields`
 * отделён от формы рейса: окна разные — одно принимает заявку в работу, второе добирает
 * пропущенные дни уже работающего заказа, — а вопрос у них один и тот же, и разойтись ему нельзя.
 * Разъедься эти два блока хоть подписью поля, и диспетчер прочёл бы про одно действие две разные
 * истории в соседних окнах.
 *
 * **Машины здесь нет, и это решение, а не пропуск** (ADR 0207 решение 5). Пачка берёт её из
 * назначения заявки: свободный выбор развёл бы бумагу по двум машинам так, что этого не показали
 * бы ни гараж, ни срез «На объекте», ни ЭСМ-2. Нужна другая единица на отдельный день — её ставят
 * подённой дверью, где расхождение с назначением помечается прямо в таблице.
 *
 * Водитель, наоборот, спрашивается и обязателен: без человека лист не выписывается вовсе. Один на
 * весь период — это названная уступка [ADR 0083](../../../../../docs/adr/0083-no-autofill-dates-and-drivers.md):
 * спрашивать человека по одному на пятьдесят дней значит не иметь пачки. Подмена на субботу
 * остаётся законной и делается подённой дверью.
 */

/**
 * Кто может сесть за эту машину — тем же ключом и тем же отбором, что у подённого окна и у окна
 * принятия в работу: один и тот же список не должен ездить к серверу дважды и тем более
 * отвечать по-разному.
 */
const driversKey = (vehicleId: string | undefined, date: string) =>
  driverKeys.available({ vehicleId, on: date, withTrailer: false });

/**
 * Поля формы, которые собирает блок. Имена общие у обоих окон намеренно: тело пачки собирает одна
 * функция (`dayBatchBody`), и второе имя того же поля разошлось бы с ней молча — форма отправляла
 * бы выбранного водителя в никуда.
 */
interface Props {
  /**
   * Срок, по которому пойдёт пачка, — в том виде, в каком он уедет на сервер. У окна принятия в
   * работу это **фактический** срок из формы, а не заказанный: его правят тут же, и считать дни
   * по заказанному значило бы обещать бумагу не на те числа.
   */
  term: DayBatchTerm;
  /**
   * День среза: им решается, есть ли в сроке прошедшие дни, а значит — спрашивать ли причину
   * (ADR 0101 п. 4). У таблицы дней его считает сервер (`onDate`), у окна принятия в работу взять
   * его неоткуда — там день заявки ещё не существует, и портал считает срез по московскому
   * календарю сам. Последнее слово всё равно за `backdateGuard`: сервер спросит причину сам, если
   * портал промахнулся мимо полуночи.
   */
  onDate: string;
  /** Машина листов: по ней отбираются водители — ровно так же, как в подённом окне. */
  vehicleId: string | undefined;
  /**
   * Машинист заявки: умолчание поля (ADR 0207 решение 6) и та сторона, с которой сверяется выбор.
   * `null` — портал его не знает: подставлять некого, и расхождение называть не с чем.
   */
  machinist: DayBatchMachinist | null;
  /** Спрашивается ли блок сейчас: в окне принятия в работу — по галочке, в окне пачки — всегда. */
  enabled: boolean;
  /**
   * Галочка, которой блок включается; `null` — окно и есть пачка (кнопка «Распланировать
   * период»), и включать нечего. Подпись приходит снаружи: в окне принятия в работу галочка
   * говорит про весь период сразу, а в окне пачки речь только о бумаге.
   */
  toggleLabel: string | null;
}

export function DayBatchFields({
  term,
  onDate,
  vehicleId,
  machinist,
  enabled,
  toggleLabel,
}: Props) {
  const form = Form.useFormInstance<DayBatchFormValues>();
  const driverId = Form.useWatch('dayBatchDriverId', form);

  /**
   * Водители — тем же запросом и тем же отбором, что у подённого окна: день заказа печатается
   * обычным 4-П, и графы удостоверения с СНИЛСом в нём те же. Дата отбора — первый день срока:
   * годность документов считается на один день, а человек в пачке один; истёкшее внутри периода
   * удостоверение покажет уже сам лист, и переспрашивать по дню здесь нечем.
   */
  const { data: selection, isFetching } = useQuery({
    queryKey: driversKey(vehicleId, term.dateFrom),
    queryFn: () =>
      driversApi.available({ vehicleId: vehicleId!, on: term.dateFrom, withTrailer: false }),
    enabled: enabled && !!vehicleId && !!term.dateFrom,
  });
  const options = (selection?.drivers ?? []).map(driverOption);

  /**
   * Называет ли этот список машиниста заявки по имени. Списки-то разные: машинистов берут из
   * справочника целиком (в бланке ЭСМ-2 нет граф под удостоверение), а водителей дня — отбором под
   * машину на первый день срока, и человек, чья специализация водителя в этот день не действовала
   * либо чья карточка снята, в него не попадает вовсе.
   */
  const model = dayBatchModel({
    term,
    onDate,
    machinist,
    driverOptions: options,
    driverSelectionReady: !!selection,
    driverId,
  });

  // ADR 0207 explicitly allows one autofill here: the request machinist is the batch driver only
  // when the date-specific selection still contains that person. A manual choice always wins.
  useEffect(() => {
    if (!enabled || !model.defaultDriverId) return;
    if (form.getFieldValue('dayBatchDriverId')) return;
    form.setFieldsValue({ dayBatchDriverId: model.defaultDriverId });
  }, [enabled, model.defaultDriverId, form]);

  return (
    <>
      {toggleLabel ? (
        <FormGrid.Full>
          <Form.Item name="dayBatchEnabled" valuePropName="checked" noStyle>
            <Checkbox>{toggleLabel}</Checkbox>
          </Form.Item>
          <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
            {/* Хвост про пропуски один на оба случая: пропускает пачка одинаково и когда срок
              влез в порцию целиком, и когда идёт частями. */}
            {model.portionHint ??
              `Каждый день срока (${model.days.length} дн.) встанет в рейс назначенной машины, и по рейсу выпишется путевой лист.`}{' '}
            Дни, которые уже заняты своим рейсом или закрыты бумагой, пачка пропустит и назовёт в
            отчёте.
          </Typography.Paragraph>
        </FormGrid.Full>
      ) : (
        // У окна самой пачки галочки нет, а порцию назвать всё равно надо: без этого диспетчер
        // узнал бы о недобранном хвосте срока только из отчёта.
        model.portionHint && (
          <FormGrid.Full>
            <Alert type="info" showIcon title={model.portionHint} />
          </FormGrid.Full>
        )
      )}

      {enabled && (
        <>
          <FormGrid.Full>
            <Form.Item
              name="dayBatchDriverId"
              label="Водитель на весь период"
              rules={[{ required: true, message: 'Выберите водителя — без него лист не выписать' }]}
              extra={
                vehicleId
                  ? 'Один человек на все дни срока: пачка выписывает бумаги, а не ведёт график смен. Подмену на отдельный день ставят в таблице «Дни работ».'
                  : 'Сначала выберите технику: годность документов считается под машину'
              }
            >
              <AutoSelect
                autoSelectSole={false}
                options={options}
                showSearch
                optionFilterProp="label"
                loading={isFetching}
                disabled={!vehicleId}
                placeholder="Кто поедет весь срок"
                notFoundContent="Подходящих водителей на этот день нет"
              />
            </Form.Item>
          </FormGrid.Full>

          {model.machinistNote && (
            <FormGrid.Full>
              <Alert type="info" showIcon title={model.machinistNote} />
            </FormGrid.Full>
          )}

          {/* Past days go as one corrections-journal operation (ADR 0207 §9), so the reason is one:
            it explains the decision to paper the past period, not each day separately. The same
            reason is printed on every such waybill. */}
          {model.pastDays.length > 0 && (
            <FormGrid.Full>
              <Form.Item
                name="dayBatchReason"
                label="Причина заднего числа"
                // Required by the server (`backdateGuard` answers 422), so required here too: the
                // form must not send a body that is bound to be refused. `whitespace` matters
                // because `useDayBatch` trims the reason and drops it when empty — a reason of
                // spaces would pass a bare `required` and reach the server as no reason at all.
                rules={[{ required: true, whitespace: true, message: 'Укажите причину' }]}
                extra={`В сроке ${model.pastDays.length} дн. до ${formatDateOnly(onDate)}: они пройдут одной операцией журнала коррекций — с вашим именем и этой причиной в каждом листе`}
              >
                <Input.TextArea
                  rows={2}
                  maxLength={2000}
                  showCount
                  placeholder="Например: техника отработала период, документы оформляем по факту"
                />
              </Form.Item>
            </FormGrid.Full>
          )}
        </>
      )}
    </>
  );
}
