import { useEffect } from 'react';
import { RequestCustomerSelect, type RequestCustomerSelectProps } from './RequestCustomerSelect';
import type { ServiceRequestCustomer } from '../model/useServiceRequestCustomer';

/**
 * Прочие свойства поля идут в подбор как есть — в том числе `id`, которым `Form.Item` связывает
 * поле с подписью. Своими компонент распоряжается сам: состав, ход загрузки, запертость и
 * значение он считает, а не принимает.
 */
type SelectRest = Omit<
  RequestCustomerSelectProps,
  'options' | 'loading' | 'disabled' | 'value' | 'onChange'
>;

export interface ServiceRequestCustomerFieldProps extends SelectRest {
  /** Состав поля, площадка и запертость — ответ `useServiceRequestCustomer`. */
  customer: ServiceRequestCustomer;
  /**
   * Открыто ли окно формы. Закрытое держит значения прошлой правки, и пересобирать в нём нечего:
   * antd не размонтирует содержимое модалки между открытиями.
   */
  open: boolean;
  /** Приходит от `Form.Item`: поле — обычный контрол формы, значением владеет она. */
  value?: string;
  onChange?: (value: string | undefined) => void;
}

/**
 * Поле «Заказчик» заявки на обслуживание оргтехники (план `docs/department-requests-plan.md`,
 * Р11, Р11а, К10).
 *
 * Отдельно от `RequestCustomerSelect` — из-за площадки. В заказе ТС объект выбирают, и поле там
 * ничего о значении не решает; здесь площадка приходит снимком выбранной сейчас единицы, и на
 * смене техники ключ обязан пересобраться: заявка с прежним `object:A` уехала бы на объект, где
 * аппарата уже нет (К10). Правило про значение живёт у поля, а не у трёх форм по очереди.
 *
 * Пару колонок для тела запроса поле не собирает: тело собирает форма — тем же
 * `customerPairOf`, который отдаёт хук. Поле отвечает только за то, что человек видит и правит.
 */
export function ServiceRequestCustomerField({
  customer,
  open,
  value,
  onChange,
  ...props
}: ServiceRequestCustomerFieldProps) {
  /*
   * Площадка в поле — всегда та, где стоит выбранная **сейчас** единица (Р11а, К10): сменили
   * технику с площадки A на площадку B, прежний ключ выпал из состава поля — значение собирается
   * заново. Отдел сменой единицы не трогается: он про то, кто просит, а не про то, где стоит
   * аппарат, и из состава поля никуда не девается.
   *
   * Заодно закрыт К6: единственный вариант ставится здесь, потому что заблокированное поле
   * `AutoSelect` не заполняет намеренно (Р3а).
   */
  useEffect(() => {
    // Пока справочник едет, состава поля ещё нет, и «значения в нём не нашлось» означало бы лишь
    // это: подставленный формой отдел учётки был бы стёрт подсказкой поля.
    if (!open || customer.loading) return;
    const picked = customer.customerPairOf(value);
    if (picked.objectId || picked.departmentId) return;
    const next = customer.siteKey ?? customer.soleCustomerKey ?? undefined;
    // Повторная постановка того же — не событие: без этой проверки поле дёргало бы форму на каждой
    // перерисовке, ничего в ней не меняя.
    if (next === value) return;
    onChange?.(next);
  }, [open, customer, value, onChange]);

  return (
    <RequestCustomerSelect
      placeholder="Площадка или отдел"
      style={{ width: 260 }}
      {...props}
      options={customer.options}
      loading={customer.loading}
      disabled={customer.disabled}
      value={value}
      onChange={onChange}
    />
  );
}
