import { useEffect, useRef } from 'react';
import { Checkbox, Descriptions, Form, Space, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import type { ServiceRequestDto } from '@technic/contracts';
import { objectOptionsQuery } from '@entities/object';
import { WarrantyTag } from '@entities/office-equipment';
import { serviceRequestEquipmentName, serviceRequestPlaceLine } from '@entities/service-request';
import { AutoSelect } from '@shared/ui';
import { useObjectScope } from '../../hooks/useObjectScope';

/**
 * Реквизиты предмета заявки в форме (план модернизации, Р48, Р57; подписи — Р17): аппарат, номера,
 * где он стоит и место внутри объекта.
 *
 * Показываются, а не подразумеваются: до этого блока заказчик отправлял заявку, видя одну строку
 * выпадающего списка, — а в саму заявку уходили снимком именно эти поля, и опознаёт по ним аппарат
 * сервис, который приедет.
 *
 * Источников два, и они разные по существу. При заведении реквизиты берутся из **справочника**
 * (единицу ещё выбирают, и показать надо то, что уйдёт в снимок). При правке — из самой **заявки**:
 * карточку могли переименовать и перевезти, а решение принимали по тому, что было тогда.
 */
export function ServiceRequestSubject({
  request,
  selected,
}: {
  /** Правка существующей заявки: реквизиты берутся из её снимка. */
  request: ServiceRequestDto | null;
  /** Выбранная в справочнике единица; у правки её нет — поле выключено. */
  selected?: {
    name: string;
    serialNumber: string;
    inventoryNumber: string;
    objectLabel: string;
    location: string;
    warrantyUntil: string | null;
  };
}) {
  const dash = <Typography.Text type="secondary">—</Typography.Text>;

  if (request) {
    const place = serviceRequestPlaceLine(request);
    return (
      <Descriptions
        size="small"
        column={1}
        style={{ marginBottom: 16 }}
        labelStyle={{ width: 140 }}
        items={[
          // «Без аппарата» словами (Р8): у правимой заявки предмета может не быть вовсе, и пустое
          // поле в форме прочиталось бы как «реквизиты не подтянулись».
          { key: 'name', label: 'Аппарат', children: serviceRequestEquipmentName(request) },
          // Номеров и места без аппарата не существует — строки не пустеют, а не рисуются: строка
          // «инв. № — · сер. № —» утверждала бы, что у аппарата их не заполнили.
          ...(request.equipment
            ? [
                {
                  key: 'numbers',
                  label: 'Номера',
                  children: `инв. № ${request.equipment.inventoryNumber || '—'} · сер. № ${
                    request.equipment.serialNumber || '—'
                  }`,
                },
              ]
            : []),
          ...(place
            ? [
                {
                  key: 'object',
                  label: 'Где стоит',
                  children: (
                    <Space size={8} wrap>
                      <span>{place}</span>
                      {/* Пометка «не тот объект» историчная и правке не подлежит (Р16): это факт
                          заявления, а не состояние. Строкой, а не чекбоксом: правка заявки объекта
                          не меняет — единицу переносит ИТ-служба в справочнике, разобрав отбор
                          расхождений. У заявки без аппарата пары не бывает вовсе (Р7), и живёт она
                          поэтому внутри строки площадки. */}
                      {request.objectOverridden && (
                        <Typography.Text type="secondary">объект указал заявитель</Typography.Text>
                      )}
                    </Space>
                  ),
                },
              ]
            : []),
        ]}
      />
    );
  }

  if (!selected) return null;

  return (
    <>
      <Descriptions
        size="small"
        column={1}
        style={{ marginBottom: 8 }}
        labelStyle={{ width: 140 }}
        items={[
          { key: 'name', label: 'Аппарат', children: selected.name },
          {
            key: 'numbers',
            label: 'Номера',
            children: (
              <Space size={12} wrap>
                <span>инв. № {selected.inventoryNumber || dash}</span>
                <span>сер. № {selected.serialNumber || dash}</span>
              </Space>
            ),
          },
          {
            key: 'object',
            label: 'Где стоит',
            children: (
              <Space size={8} wrap>
                <span>{selected.objectLabel}</span>
                {selected.location && (
                  <Typography.Text type="secondary">{selected.location}</Typography.Text>
                )}
              </Space>
            ),
          },
          {
            key: 'warranty',
            label: 'Гарантия',
            children: <WarrantyTag until={selected.warrantyUntil} />,
          },
        ]}
      />
      <ServiceRequestObjectOverride />
    </>
  );
}

/**
 * «Аппарат стоит на другом объекте» (Р16, ответ В3) — под реквизитом «Где стоит», потому что он и
 * есть предмет спора: карточка говорит одно, человек видит другое.
 *
 * Чекбокс правит **заявку и пометку**, а не справочник. Перенос единицы — решение ИТ-службы после
 * проверки, а карточку правит всякий заявитель: опечатка в заявке возила бы аппараты по объектам, и
 * через месяц справочник перестал бы отвечать, где что стоит. Заявленное расхождение ИТ-служба
 * разбирает отбором и переносит единицу руками.
 *
 * **Список объектов ограничен областью заявителя, и это не удобство поля, а его единственное
 * безопасное устройство.** `equipment_object_id` задаёт область видимости роли объекта: свободный
 * выбор означал бы, что заявку можно отправить в чужую область — и увести из своей. Тот же отбор
 * считает сервер по привязкам автора и отвечает 422 на чужой объект; портал показывает то же самое,
 * но портал не защита.
 *
 * **Смена аппарата уносит пару целиком.** Утверждение «стоит не там» относится к КОНКРЕТНОЙ
 * единице: выбрали аппарат A, отметили расхождение, назвали объект — а потом сменили аппарат на B,
 * — и оставленная пара заявляет про B то, чего никто не говорил. Сервер такое не отвергнет (он
 * проверяет область заявителя, а не различие), и в очередь расхождений ИТ-службы пришла бы ложная
 * строка, которую разбирал бы живой человек. Правило живёт у самой пары, ровно как правило площадки
 * живёт у поля заказчика (К10), а не у формы, которая их только расставляет.
 */
function ServiceRequestObjectOverride() {
  const form = Form.useFormInstance();
  const objectScope = useObjectScope();
  const overridden = Form.useWatch('objectOverridden', form);
  const equipmentId = Form.useWatch('officeEquipmentId', form);

  /*
   * Сброс — на СМЕНЕ единицы, а не на каждом проходе: первый выбор пару не трогает (она и так
   * пуста), а безусловный сброс дёргал бы форму на каждой перерисовке, ничего в ней не меняя.
   * Прежнее значение держится ссылкой — полем формы оно было бы вторым источником правды.
   */
  const previous = useRef(equipmentId);
  useEffect(() => {
    if (previous.current === equipmentId) return;
    previous.current = equipmentId;
    // Обе половины разом: пометка без объекта и объект без пометки схему заведения не проходят, и
    // снять одну значило бы завести отказ 422 там, где человек ничего не заявлял.
    form.setFieldsValue({ objectOverridden: false, objectId: undefined });
  }, [equipmentId, form]);

  const { data: objectOptions = [], isFetching } = useQuery({
    ...objectOptionsQuery(),
    // Список нужен только раскрытому полю: у нетронутой галочки выбирать не из чего.
    enabled: !!overridden,
  });

  return (
    <>
      <Form.Item name="objectOverridden" valuePropName="checked" style={{ marginBottom: 8 }}>
        <Checkbox
          // Снятая галочка уносит и выбор: пара «объект + пометка» уходит на сервер целиком, и
          // схема заведения не принимает её половинками — объект без пометки и пометка без объекта
          // одинаково отвергаются (422).
          onChange={(e) => {
            if (!e.target.checked) form.setFieldValue('objectId', undefined);
          }}
        >
          Аппарат стоит на другом объекте
        </Checkbox>
      </Form.Item>
      {overridden && (
        <Form.Item
          name="objectId"
          label="Где он на самом деле"
          rules={[{ required: true, message: 'Выберите объект, на котором стоит аппарат' }]}
          extra="Справочник этим не правится: единицу перенесёт ИТ-служба, разобрав заявленные расхождения."
        >
          <AutoSelect
            showSearch
            optionFilterProp="label"
            loading={isFetching}
            // Только свои объекты: чужие объектной роли и выбирать незачем — сервер ответит 422.
            options={objectScope.limitObjectOptions(objectOptions)}
            placeholder="Код или название объекта"
          />
        </Form.Item>
      )}
    </>
  );
}
