import { useState } from 'react';
import { Form } from 'antd';
import { useQuery } from '@tanstack/react-query';
import type { ServiceRequestDto } from '@technic/contracts';
import { objectOptionsQuery } from '@entities/object';
import { EquipmentNotFoundLink } from '@features/quick-create-equipment';
import { AutoSelect } from '@shared/ui';
import { ServiceRequestSubject } from './ServiceRequestSubject';
import { useAuth } from '../../auth/AuthContext';
import { useObjectScope } from '../../hooks/useObjectScope';

/** Опция справочника техники с реквизитами, которые форма показывает под полем (Р48). */
export interface EquipmentOption {
  value: string;
  label: string;
  name: string;
  serialNumber: string;
  inventoryNumber: string;
  objectLabel: string;
  location: string;
  warrantyUntil: string | null;
}

/**
 * Выбор единицы и её реквизиты в форме заявки (§9.3, Р40, Р48).
 *
 * Три вещи одним блоком, потому что отвечают они на один вопрос — «о каком аппарате речь»: само
 * поле, выход из тупика «техники нет в справочнике» и реквизиты, которые уйдут в заявку снимком.
 * Разложенные по форме порознь, они разъезжались бы: ссылка «Не нашли технику?» показывается ровно
 * там, где технику вообще выбирают, — при правке и в обращении по гарантии единица задана.
 */
export function ServiceRequestEquipmentField({
  request,
  claim,
  selected,
  options,
  loading,
  open,
}: {
  /** `null` — заведение: только тогда единицу и выбирают. */
  request: ServiceRequestDto | null;
  /** Обращение по гарантии: единица названа реестром и не правится. */
  claim: boolean;
  selected?: EquipmentOption;
  options: EquipmentOption[];
  loading: boolean;
  open: boolean;
}) {
  const { can } = useAuth();
  const form = Form.useFormInstance();
  const objectScope = useObjectScope();
  // Что набрали в поле техники: строка уходит контекстом в обращение к поддержке, когда единицы в
  // справочнике не оказалось. Держится и после того, как список закрылся, — искали именно это.
  const [search, setSearch] = useState('');
  const equipmentId = Form.useWatch('officeEquipmentId', form);
  const missing = !request && !claim && !equipmentId;

  /*
   * Площадка учётки — контекст обращения в поддержку. Спрашивается только у объектной роли с
   * единственным объектом: с несколькими портал не знает, на какой из них стоит ненайденная
   * техника, и называть первый попавшийся значило бы отправить поддержку не туда.
   */
  const { data: objectOptions = [] } = useQuery({
    ...objectOptionsQuery({ activeOnly: false }),
    enabled: open && missing && !!objectScope.soleObjectId,
  });
  const ownObjectName = objectOptions.find(
    (option) => option.value === objectScope.soleObjectId,
  )?.label;

  return (
    <>
      {/* Подпись человеческая (Р17): «Техника» называла раздел, а поле спрашивает про конкретный
          аппарат — тот, который сломался или которому нужен картридж. */}
      <Form.Item
        name="officeEquipmentId"
        label="Какой аппарат"
        rules={[{ required: true, message: 'Выберите единицу оргтехники' }]}
      >
        <AutoSelect
          showSearch
          optionFilterProp="label"
          loading={loading}
          options={options}
          // Технику не меняют ни при правке (это другая заявка), ни в обращении по гарантии:
          // источник гарантии относится к конкретной единице, и подмена сделала бы ссылку ложной.
          disabled={!!request || claim}
          placeholder="Модель, инвентарный или серийный номер"
          onSearch={setSearch}
          notFoundContent={
            can('officeEquipment.read')
              ? 'Ничего не нашлось — техники нет в справочнике'
              : 'Справочник недоступен'
          }
        />
      </Form.Item>

      {/* Ответ на «ничего не нашлось» — под самим полем: тупик разбирается, не выходя из заявки.
          Ответа два, и различает их право вести справочник, а не роль (Р40). */}
      {missing && (
        <EquipmentNotFoundLink
          canCreate={can('officeEquipment.write')}
          search={search}
          objectName={ownObjectName}
          // Заведённая единица становится значением поля — тем же, каким её выбрали бы из списка:
          // заявка продолжается с того же места, где встала.
          onCreated={(equipment) => form.setFieldValue('officeEquipmentId', equipment.id)}
        />
      )}

      {/* Реквизиты предмета (Р48, Р57): что именно уйдёт в заявку снимком. Источников два —
          справочник при заведении и сама заявка при правке. Там же, под строкой «Где стоит», живёт
          и чекбокс «аппарат стоит на другом объекте» (Р16): спорят именно с этой строкой. */}
      <ServiceRequestSubject request={request} selected={selected} />
    </>
  );
}
