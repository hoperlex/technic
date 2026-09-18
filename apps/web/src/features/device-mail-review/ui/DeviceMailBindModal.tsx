import { useEffect, useState } from 'react';
import { Alert, Descriptions, Form, Input, Select } from 'antd';
import { useQuery } from '@tanstack/react-query';
import {
  DEVICE_IDENTITY_KINDS,
  deviceIdentityLabels,
  isIdentifyingKind,
  type DeviceIdentityKind,
  type DeviceMailQueueItemDto,
} from '@technic/contracts';
import { deviceMailApi, deviceMailKeys } from '@entities/device-mail';
import { officeEquipmentOptionsQuery } from '@entities/office-equipment';
import { AutoSelect, FormModal } from '@shared/ui';
import { useDeviceMailBind } from '../model/actions';

/**
 * «Привязать к аппарату» — окно подтверждённой привязки (план
 * `docs/office-equipment-mail-telemetry-plan.md`, Р20, §6).
 *
 * ЧЕЛОВЕК ВИДИТ ПОДСКАЗКИ ОПОЗНАНИЯ ИЗ СНИМКА, а не сырьё письма: серийник, инвентарный, имя
 * устройства, сетевое имя, IP и модель — всё, чем аппарат назвал себя сам. Сырьё вычищается через
 * тридцать дней, а снимок остаётся: очередь, читающая подсказки из тела письма, через месяц
 * осталась бы без единой (Р20).
 *
 * IP ПОКАЗЫВАЕТСЯ, НО КЛЮЧОМ НЕ БЫВАЕТ. Его нет в `DEVICE_IDENTITY_KINDS` вовсе, и это решение §6:
 * после DHCP по старому адресу стоит другой принтер. Здесь он подсказка глазам — «этот тот самый,
 * что в 214-м», — и ничего больше.
 *
 * ЧИСЛО ЗАТРОНУТЫХ ПИСЕМ ПОКАЗЫВАЕТСЯ ДО ПОДТВЕРЖДЕНИЯ, И СЧИТАЕТ ЕГО СЕРВЕР тем же отбором, что и
 * применение (Р20 требует этого буквально). Разделение «пачкой или одной строкой» спрашивается у
 * контракта (`isIdentifyingKind`): своя копия правила на экране разошлась бы со слоем применения
 * молча — и разошлась бы в том самом действии, цена ошибки которого «чужая наработка в живой
 * карточке, и заметить это некому».
 */

/**
 * Что подставить под этот род ключа.
 *
 * ДВА ИСТОЧНИКА, И ОБА ОБЯЗАТЕЛЬНЫ. Серийник, инвентарный, имя устройства и сетевое имя приходят из
 * СНИМКА разбора (`identity`): их вычитал профиль из тела письма. Адреса отправителя и получателя
 * снимок не несёт и нести не может — их знает конверт, а не разбор, — и приезжают они своими полями
 * строки очереди (`fromAddress`, `envelopeTo`).
 *
 * `envelopeTo` здесь не для полноты перечисления: плюс-адресация (`mfp+214@…`, Р10) — законный и
 * самый надёжный ключ, и без подстановки человек набирал бы этот адрес руками, не видя его нигде.
 * Ровно этого поля в DTO сначала не было, и находка ревью была именно про это.
 */
function hintFor(item: DeviceMailQueueItemDto, kind: DeviceIdentityKind): string {
  switch (kind) {
    case 'serial':
      return item.identity.serial ?? '';
    case 'inventory':
      return item.identity.inventory ?? '';
    case 'deviceName':
      return item.identity.deviceName ?? '';
    case 'host':
      return item.identity.host ?? '';
    case 'fromAddress':
      return item.fromAddress;
    case 'envelopeTo':
      return item.envelopeTo;
    default:
      return '';
  }
}

/**
 * Каким ключом привязывать ПО УМОЛЧАНИЮ — первым, который письмо назвало, в порядке Р9: серийный,
 * инвентарный, имя устройства. Ни одного нет — адрес отправителя: он есть всегда, но применится
 * только к этой строке, и об этом окно говорит вслух.
 */
function defaultKind(item: DeviceMailQueueItemDto): DeviceIdentityKind {
  const ordered: DeviceIdentityKind[] = ['serial', 'inventory', 'deviceName'];
  return ordered.find((kind) => hintFor(item, kind) !== '') ?? 'fromAddress';
}

const kindOptions = DEVICE_IDENTITY_KINDS.map((value) => ({
  value,
  label: deviceIdentityLabels[value],
}));

interface Values {
  kind: DeviceIdentityKind;
  value: string;
  equipmentId: string;
  note?: string;
}

export function DeviceMailBindModal({
  item,
  onClose,
}: {
  /** `null` — окно закрыто: строку очереди ещё не выбрали. */
  item: DeviceMailQueueItemDto | null;
  onClose: () => void;
}) {
  const [form] = Form.useForm<Values>();
  const [search, setSearch] = useState('');
  const kind = Form.useWatch('kind', form);
  const value = Form.useWatch('value', form);

  // Поля заполняются при КАЖДОМ открытии, а не один раз на монтаже: окно живёт на экране очереди и
  // открывается разными строками, а форма antd держит прежние значения до явного сброса.
  useEffect(() => {
    if (!item) return;
    const initial = defaultKind(item);
    form.setFieldsValue({
      kind: initial,
      value: hintFor(item, initial),
      equipmentId: undefined,
      note: '',
    });
  }, [item, form]);

  const bind = useDeviceMailBind(item?.id ?? null, onClose);

  const { data: options = [], isFetching: loadingOptions } = useQuery({
    ...officeEquipmentOptionsQuery(search),
    enabled: item !== null,
  });

  const trimmed = (value ?? '').trim();
  /*
   * Число спрашивается у сервера на КАЖДОЕ изменение ключа и значения — и это дешевле, чем кажется:
   * ключ кэша содержит и то, и другое, поэтому возврат к прежней паре ответа не стоит. Считать его
   * на клиенте нечем: пачка ищется по нормализованной подсказке внутри снимков всех накопленных
   * писем, а у экрана на руках одна страница очереди.
   */
  const { data: targets } = useQuery({
    queryKey: deviceMailKeys.bindTargets(item?.id ?? '', kind ?? '', trimmed),
    queryFn: () => deviceMailApi.bindTargets(item!.id, { kind: kind!, value: trimmed }),
    enabled: item !== null && Boolean(kind) && trimmed !== '',
  });

  const batch = kind ? isIdentifyingKind(kind) : false;

  return (
    <FormModal
      title="Привязать письмо к аппарату"
      open={item !== null}
      onCancel={onClose}
      onSubmit={() => form.submit()}
      confirmLoading={bind.isPending}
      okText="Привязать"
      width={560}
    >
      {item ? (
        <>
          <Descriptions size="small" column={1} style={{ marginBottom: 12 }}>
            <Descriptions.Item label="Тема">{item.subject || '—'}</Descriptions.Item>
            <Descriptions.Item label="От кого">{item.fromAddress || '—'}</Descriptions.Item>
            {/* Адрес получателя — не декорация конверта: это ключ плюс-адресации (Р10), и выбрать
                его родом, не видя значения, было бы предложением набрать адрес по памяти. */}
            <Descriptions.Item label={deviceIdentityLabels.envelopeTo}>
              {item.envelopeTo || '—'}
            </Descriptions.Item>
            {item.identity.serial ? (
              <Descriptions.Item label={deviceIdentityLabels.serial}>
                {item.identity.serial}
              </Descriptions.Item>
            ) : null}
            {item.identity.inventory ? (
              <Descriptions.Item label={deviceIdentityLabels.inventory}>
                {item.identity.inventory}
              </Descriptions.Item>
            ) : null}
            {item.identity.deviceName ? (
              <Descriptions.Item label={deviceIdentityLabels.deviceName}>
                {item.identity.deviceName}
              </Descriptions.Item>
            ) : null}
            {item.identity.host ? (
              <Descriptions.Item label={deviceIdentityLabels.host}>
                {item.identity.host}
              </Descriptions.Item>
            ) : null}
            {/* IP — подсказка глазам и только: ключом он не бывает ни при каких условиях (§6). */}
            {item.identity.ip ? (
              <Descriptions.Item label="IP (не ключ)">{item.identity.ip}</Descriptions.Item>
            ) : null}
            {item.identity.model ? (
              <Descriptions.Item label="Модель из письма">{item.identity.model}</Descriptions.Item>
            ) : null}
          </Descriptions>

          <Form<Values>
            form={form}
            layout="vertical"
            onFinish={(v) =>
              bind.mutate({
                equipmentId: v.equipmentId,
                kind: v.kind,
                value: v.value.trim(),
                note: v.note?.trim() ?? '',
              })
            }
          >
            <Form.Item
              name="kind"
              label="Чем связываем"
              rules={[{ required: true, message: 'Выберите ключ' }]}
            >
              <Select
                options={kindOptions}
                onChange={(next: DeviceIdentityKind) =>
                  form.setFieldValue('value', hintFor(item, next))
                }
              />
            </Form.Item>
            <Form.Item
              name="value"
              label="Значение ключа"
              rules={[{ required: true, message: 'Укажите значение ключа' }]}
              extra="Сравнение идёт той же формой, что у номеров карточки: пробелы по краям срезаются, регистр не важен"
            >
              <Input maxLength={200} />
            </Form.Item>
            <Form.Item
              name="equipmentId"
              label="Какая карточка"
              rules={[{ required: true, message: 'Выберите карточку аппарата' }]}
            >
              <AutoSelect
                showSearch
                /* Своего фильтра нет: сервер ищет по номерам, месту и модели, а клиентский фильтр
                   видит одну подпись — и молча резал бы найденное. */
                filterOption={false}
                options={options}
                loading={loadingOptions}
                onSearch={setSearch}
                placeholder="Модель, инвентарный или серийный номер"
              />
            </Form.Item>
            <Form.Item name="note" label="Примечание">
              <Input.TextArea rows={2} maxLength={500} />
            </Form.Item>
          </Form>

          {targets ? (
            <Alert
              type={batch ? 'warning' : 'info'}
              showIcon
              title={`${BIND_TARGETS_PREFIX}${targets.messages}`}
              description={
                batch
                  ? 'Ключ опознающий: привязка применит все накопленные письма с этим значением, каждое — своим разбором. Следующие письма аппарата свяжутся сами.'
                  : 'Ключ не опознающий: применится только это письмо. Один служебный адрес отправителя стоит у всего парка, и пачка по нему приписала бы одной карточке чужую наработку.'
              }
            />
          ) : null}
        </>
      ) : null}
    </FormModal>
  );
}

/**
 * «Будет затронуто писем: N» — обещание, которое проверяется тестом дословно. Строкой здесь, а не
 * литералом в разметке: Р20 требует показать число ДО подтверждения, и проверка этого требования
 * не должна держаться на пересказе формулировки.
 */
export const BIND_TARGETS_PREFIX = 'Будет затронуто писем: ';
