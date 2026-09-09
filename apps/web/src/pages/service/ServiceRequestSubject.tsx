import { useEffect, useRef } from 'react';
import { Alert, Checkbox, Descriptions, Form, Space, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import type { ServiceRequestDto } from '@technic/contracts';
import { objectOptionsQuery } from '@entities/object';
import { WarrantyTag } from '@entities/office-equipment';
import { serviceRequestEquipmentName, serviceRequestPlaceLine } from '@entities/service-request';
import { AutoSelect } from '@shared/ui';
import { useAuth } from '../../auth/AuthContext';
import { useDepartmentScope } from '../../hooks/useDepartmentScope';
import { useObjectScope } from '../../hooks/useObjectScope';

/**
 * Выбранная единица глазами этого блока: реквизиты снимка и два ответа об области (Р2 плана
 * предмета заявки). Проекция селектора подходит под него целиком.
 */
interface SubjectEquipment {
  name: string;
  serialNumber: string;
  inventoryNumber: string;
  objectLabel: string;
  /** Отдел-владелец словами; пусто — карточка не размечена (Р1). */
  departmentName: string;
  location: string;
  warrantyUntil: string | null;
  /** Погашенная карточка приходит только дочиткой уже выбранного (Р3) и называется вслух. */
  isActive: boolean;
  /** Карточка целиком в области учётки. */
  inOwnScope: boolean;
  /** ОБЪЕКТ карточки в объектах учётки — им и различается «чужой отдел, своя площадка» (Р2). */
  objectInOwnScope: boolean;
}

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
  selected?: SubjectEquipment;
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
          {
            key: 'name',
            label: 'Аппарат',
            children: (
              <Space size={8} wrap>
                <span>{selected.name}</span>
                {/* Погашенная карточка попадает в поле только дочиткой уже выбранного (Р3) — из
                    реестра гарантий или из правки заявки, — и называется вслух: заявку по ней
                    сервер отбивает 422, и молчание стоило бы человеку заполненной формы. */}
                {!selected.isActive && (
                  <Typography.Text type="danger">выведен из эксплуатации</Typography.Text>
                )}
              </Space>
            ),
          },
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
      <ServiceRequestForeignScopeAlert selected={selected} />
      {/* Площадка заявки считается по объекту КАРТОЧКИ (`objectInOwnScope`), а не по карточке
          целиком: чужой отдел-владелец места аппарата не меняет (Р2, Р6). */}
      <ServiceRequestObjectOverride foreignSite={!selected.objectInOwnScope} />
    </>
  );
}

/**
 * АППАРАТ ЧИСЛИТСЯ НЕ ЗА ВАМИ (план предмета заявки, Р4–Р6) — предупреждение, и только оно.
 *
 * Заявку плашка не запрещает и ничего не требует: справочник по оргтехнике врёт чаще, чем человек,
 * стоящий рядом с аппаратом, — за этим поиск и открыли по всему парку. Отвергнуто на ревью
 * заказчика: запирать заведение до подтверждения ИТ-службой (заявку тогда не завести в тот день,
 * когда аппарат встал) и молча писать заявку на площадку карточки (автор отправил бы её и не
 * увидел — видимость объектной роли считается именно этой колонкой, Р4).
 *
 * НАЗЫВАЕТ РАСХОЖДЕНИЕ СЛОВАМИ, а не значком: «стоит не у вас» без имени площадки не отвечает на
 * единственный вопрос, ради которого плашку и читают, — «тот ли это аппарат». Названия объектов в
 * компании повторяются («Склад»), поэтому подпись идёт с кодом — той же строкой, что и «Где стоит»
 * над ней.
 *
 * РАЗВИЛКА ЧИТАЕТСЯ ТОЛЬКО ПО ДВУМ ПРИЗНАКАМ СЕРВЕРА (Р2), и своей оси у портала здесь нет:
 *
 *   * `objectInOwnScope: false` — аппарат стоит на чужой площадке; она и называется;
 *   * `inOwnScope: false` при СВОЕЙ площадке — единственная причина расхождения в отделе-владельце,
 *     и тогда называется он. Спроси портал роль сам, он завёл бы второе мнение об области — то, из-за
 *     которого признаков и сделали два.
 *
 * Когда чужие обе (роль отдела на чужой площадке), названа площадка: именно она решает, куда
 * запишется заявка, а дописать «и отдел» портал мог бы, лишь повторив у себя разбор области сервера.
 */
function ServiceRequestForeignScopeAlert({ selected }: { selected: SubjectEquipment }) {
  const foreignSite = !selected.objectInOwnScope;
  const foreignOwner = !selected.inOwnScope && selected.objectInOwnScope;
  if (!foreignSite && !foreignOwner) return null;

  const where = foreignSite
    ? `По справочнику он стоит на площадке «${selected.objectLabel}», а не на вашей.`
    : `По справочнику он закреплён за ${
        selected.departmentName ? `отделом «${selected.departmentName}»` : 'другим отделом'
      }, а не за вашим.`;
  return (
    <Alert
      type="warning"
      showIcon
      style={{ marginBottom: 12 }}
      title="Аппарат числится не за вами"
      description={`${where} Заявке это не мешает: она будет записана на вас — проверьте, тот ли это аппарат.`}
    />
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
 *
 * У АППАРАТА ВНЕ СВОЕЙ ОБЛАСТИ ПАРА НЕ ЗАЯВЛЯЕТСЯ, А СЛЕДУЕТ ИЗ ФОРМЫ (план предмета заявки, Р5,
 * Р6), и спрашивают её по-разному две оси:
 *
 *   * ОБЪЕКТНАЯ — не спрашивает здесь ничего. Своя площадка выбирается в поле «Для кого заявка» и
 *     одним решением становится и заказчиком, и объектом пары (Р5): второе поле про то же самое
 *     означало бы два ответа на один вопрос — и заявку, у которой заказчик и место разъехались;
 *   * ОТДЕЛЬСКАЯ — спрашивает площадку отдельно (Р6): заказчиком там уходит свой отдел, а место
 *     аппарата отделом не задаётся вовсе. Выбор ограничен площадками своих отделов
 *     (`departmentObjectIds`, ADR 0062) — тем же отбором, каким сервер отвечает 422 на чужую.
 *
 * Галочки в обоих случаях нет: расхождение здесь не заявляют — оно уже названо справочником, и
 * предлагать подтвердить его вручную значило бы спрашивать «точно ли аппарат там, где он стоит».
 * Площадок у отдела может не оказаться вовсе; тогда поля нет и пары нет — заявка запишется на
 * объект карточки и удержится в области своим отделом-заказчиком, а требовать невыполнимого от
 * человека с пустым списком портал не вправе.
 */
function ServiceRequestObjectOverride({
  /** Аппарат стоит вне площадок учётки (`objectInOwnScope: false`). */
  foreignSite,
}: {
  foreignSite: boolean;
}) {
  const form = Form.useFormInstance();
  const { user } = useAuth();
  const objectScope = useObjectScope();
  const departmentScope = useDepartmentScope();
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

  /*
   * Площадки своих отделов спрашиваются готовым списком учётки (ADR 0062, ADR 0144), а не
   * выводятся из её отделов: связь «отдел ↔ площадка» портал знает целиком, и второй способ её
   * посчитать разошёлся бы с серверным (`resolveEquipmentObject`) на первой же правке привязок.
   * Тот же список читает и площадка сообщения о технике (`ReportEquipmentModal`).
   */
  const departmentObjectIds = user?.departmentObjectIds ?? [];
  const askOwnSite =
    foreignSite && departmentScope.isDepartmentRole && !!departmentObjectIds.length;
  // Заявленное расхождение спрашивают только у аппарата СВОЕЙ площадки: у чужой оно уже факт.
  const claimed = !foreignSite;

  const { data: objectOptions = [], isFetching } = useQuery({
    ...objectOptionsQuery(),
    // Список нужен только раскрытому полю: у нетронутой галочки выбирать не из чего.
    enabled: (claimed && !!overridden) || askOwnSite,
  });
  const options = askOwnSite
    ? objectOptions.filter((option) => departmentObjectIds.includes(option.value))
    : // Только свои объекты: чужие объектной роли и выбирать незачем — сервер ответит 422.
      objectScope.limitObjectOptions(objectOptions);

  if (!claimed && !askOwnSite) return null;

  return (
    <>
      {claimed && (
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
      )}
      {(askOwnSite || (claimed && overridden)) && (
        <Form.Item
          name="objectId"
          label={askOwnSite ? 'На какой вашей площадке он стоит' : 'Где он на самом деле'}
          rules={[{ required: true, message: 'Выберите объект, на котором стоит аппарат' }]}
          extra={
            askOwnSite
              ? // Заявка записывается на выбранную площадку (Р4): на площадке карточки автор её не
                // увидел бы, а исполнять её некому — аппарат стоит не там.
                'Заявка запишется на эту площадку: по ней её найдут и исполнят.'
              : 'Справочник этим не правится: единицу перенесёт ИТ-служба, разобрав заявленные расхождения.'
          }
        >
          <AutoSelect
            showSearch
            optionFilterProp="label"
            loading={isFetching}
            options={options}
            placeholder="Код или название объекта"
          />
        </Form.Item>
      )}
    </>
  );
}
