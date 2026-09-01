import type { ReactNode } from 'react';
import { Form } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { mechRequesterKeyOf, parseCostTargetKey, type MechRequestDto } from '@technic/contracts';
import { departmentPlatformQuery } from '@entities/department';
import { objectOptionsQuery } from '@entities/object';
import { RequestCustomerSelect, useRequestCustomerOptions } from '@features/request-customer';
import { AutoSelect } from '@shared/ui';

/**
 * Заявитель и площадка формы (Р17, Р20) — два поля, а не одно, и это главная особенность модуля.
 *
 * У соседей заказчик один, и его пара колонок взаимоисключающа: заявку заводит либо объект, либо
 * отдел. Здесь **площадка есть у каждой заявки** — это место эксплуатации, ось области и ответ на
 * «куда везти», — а отдел лишь говорит, кто просит и на кого относятся расходы. Поэтому у заявки
 * площадки поле одно (место равно заявителю), а у заявки отдела появляется второе: техника едет на
 * стройку, а не в офис.
 *
 * Площадки отдела берутся из его карточки (ADR 0144), а не из справочника целиком: отдел выбирает
 * место **из закреплённых за ним**, чужая площадка — 403 сервера. Состав меняется, и потому
 * проверяет пару сервер; форма лишь не предлагает того, что заведомо отклонят.
 */
export interface MechRequesterFieldsApi {
  /** Ключ заказчика правимой записи (К7): им форма заполняет поле при открытии. */
  savedKey: string | null;
  /** Единственный доступный заявитель — форма подставляет его сама (заперто поле не подставляет). */
  soleKey: string | null;
  /** Выбран отдел: нужно второе поле «Площадка». */
  isDepartment: boolean;
  /** Пара колонок для тела запроса; `null` — заявитель вне состава поля, и отправлять нечего. */
  bodyOf: (
    customerKey: string | undefined,
    placeObjectId: string | undefined,
  ) => { objectId: string; departmentId?: string } | null;
  /** Готовая разметка обоих полей — состав и запертость они решают сами. */
  fields: ReactNode;
}

export function useMechRequesterFields({
  request,
  customerKey,
  disabled,
}: {
  /** `null` — заведение новой заявки. */
  request: MechRequestDto | null;
  /** Что сейчас выбрано в поле заявителя: от него зависит состав площадок. */
  customerKey: string | undefined;
  /** Правка закрыта состоянием записи (Р19): поля видны, но не меняются. */
  disabled: boolean;
}): MechRequesterFieldsApi {
  /*
   * Заказчик правимой записи держится в списке, даже выпав из состава поля (К7): площадку могли
   * снять с отдела уже после заведения, а обязательное поле не имеет права начинать правку
   * пустым — иначе правка комментария потребовала бы назвать заявителя заново.
   */
  const saved = request
    ? request.departmentId
      ? {
          target: { kind: 'department' as const, id: request.departmentId },
          label: `${request.departmentCode ?? ''} — ${request.departmentName ?? ''}`.trim(),
        }
      : {
          target: { kind: 'object' as const, id: request.objectId },
          label: `${request.objectCode} — ${request.objectName}`,
        }
    : null;

  const customer = useRequestCustomerOptions({
    objects: 'scope',
    departments: 'scope',
    saved,
  });

  const chosen = customerKey ? parseCostTargetKey(customerKey) : null;
  const isDepartment = chosen?.kind === 'department';

  // Справочник объектов и карта площадок отдела — один и тот же запрос списка отделов и списка
  // объектов, которыми живёт и подбор выше: лишнего похода на сервер здесь не возникает.
  const { data: objectOptions = [] } = useQuery({
    ...objectOptionsQuery(),
    enabled: isDepartment,
  });
  const { data: platforms, isFetching: platformsLoading } = useQuery({
    ...departmentPlatformQuery(),
    enabled: isDepartment,
  });
  const ownIds = isDepartment && chosen ? (platforms?.get(chosen.id) ?? []) : [];
  const placeOptions = objectOptions.filter((o) => ownIds.includes(o.value));

  const fields = (
    <>
      <Form.Item
        name="customer"
        label="Заявитель"
        rules={[{ required: true, message: 'Выберите заявителя' }]}
      >
        <RequestCustomerSelect
          options={customer.options}
          loading={customer.loading}
          disabled={disabled || customer.disabled}
        />
      </Form.Item>

      {/* Второе поле только у отдела: у заявки площадки место равно заявителю, и спрашивать его
          второй раз значило бы предлагать выбрать не тот объект, от чьего имени просят. */}
      {isDepartment && (
        <Form.Item
          name="placeObjectId"
          label="Площадка"
          extra={
            !platformsLoading && placeOptions.length === 0
              ? 'За этим отделом не закреплено ни одной площадки — обратитесь к администратору.'
              : 'Техника едет на стройку: выбирают из площадок, закреплённых за отделом.'
          }
          rules={[{ required: true, message: 'Выберите площадку' }]}
        >
          <AutoSelect
            showSearch
            optionFilterProp="label"
            placeholder="Куда везти технику"
            options={placeOptions}
            loading={platformsLoading}
            disabled={disabled}
          />
        </Form.Item>
      )}
    </>
  );

  return {
    // Ключ сохранённого заявителя считает контракт по той же паре колонок, что и подпись строки
    // списка: своей сборки формата `род:идентификатор` в портале нет.
    savedKey: request ? mechRequesterKeyOf(request) : null,
    soleKey: customer.soleCustomerKey,
    isDepartment,
    bodyOf: (key, placeObjectId) => {
      const pair = customer.customerPairOf(key);
      // Заявитель-отдел: место приходит вторым полем. Заявитель-площадка: место равно ему самому —
      // отдельного поля у него нет, и подставить сюда что-то другое неоткуда.
      if (pair.departmentId) {
        return placeObjectId ? { objectId: placeObjectId, departmentId: pair.departmentId } : null;
      }
      return pair.objectId ? { objectId: pair.objectId } : null;
    },
    fields,
  };
}
