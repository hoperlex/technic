import { Button, Dropdown, Space, Tooltip, Typography, type TableColumnsType } from 'antd';
import { EyeOutlined, MoreOutlined } from '@ant-design/icons';
import {
  actsForCounterparty,
  can,
  type AuthUser,
  type ServiceRequestDto,
} from '@technic/contracts';
import {
  ServiceStatusTag,
  serviceStatusLine,
  statusAgeLabel,
  UrgentTag,
} from '@entities/service-request';
import { actionsColumn, type ActionSheetItem, type CardConfig, ExpandableCell } from '@shared/ui';
import { DocumentsCell, EquipmentCell } from './serviceRequestCells';
import { textColumn } from '@shared/ui';
import { PhoneLink } from '../../components/PhoneField';
import { formatMoney } from '../../utils/format';

/**
 * Список заявок на обслуживание: ядро колонок одно, а вопросы у ролей разные (§9.2).
 *
 * Заказчик спрашивает «что с моим принтером»: неисправность и во сколько это встало. Оператор —
 * «что требует решения»: кто исполнитель, на какую сумму и подшиты ли бумаги. Сервис — «что мне
 * делать»: где стоит техника и кому звонить. Показать всем всё нельзя: колонок набирается полтора
 * десятка, и список перестаёт читаться на любом экране.
 *
 * Вопрос «кто тянет и что требуется от меня» набора не имеет вовсе: на него отвечает общий столбец
 * состояния (Р100) — он в ядре и подписан для каждой стороны по-своему.
 *
 * Набор выбирается **правами**, а не именем роли: оператор оргтехники — это надстройка над штабом
 * или отделом (ADR 0086), а сервис — тип контрагента (ADR 0038), и списком ролей их не описать.
 */

export interface ServiceGridView {
  customer: boolean;
  operator: boolean;
  service: boolean;
}

/**
 * Чьими глазами смотрят на список. Наблюдателю и администратору показывается всё: первый заведён
 * ради сквозной картины по компании, у второго есть оба коридора сразу — он разбирает чужие
 * ошибки, и половина ответа ему не годится.
 */
export function serviceGridView(user: AuthUser | null): ServiceGridView {
  const executor = actsForCounterparty(user, 'service');
  const operator = !executor && can(user, 'serviceRequests.assign');
  const customer = !executor && can(user, 'serviceRequests.create');
  const everything =
    (!executor && !operator && !customer) || (operator && can(user, 'serviceRequests.estimate'));
  return {
    customer: customer || everything,
    operator: operator || everything,
    service: executor || everything,
  };
}

export interface ServiceGridOptions {
  view: ServiceGridView;
  /**
   * Гарантия самой техники по её идентификатору. Приходит извне: в заявке лежит снимок реквизитов
   * единицы без срока, а справочник виден не всякому — сервису он закрыт вовсе (Р7).
   */
  warrantyOf: (equipmentId: string) => string | null | undefined;
  /**
   * Чью очередь считать своей. Учётка целиком, а не прежний признак `isMine`: подпись состояния и
   * её лицо считаются одной функцией (`serviceStatusLine`, Р101), и второй вход для того же факта
   * рано или поздно разошёлся бы с текстом — заметная строка «Ждёт оператора» у того, кого и ждут.
   */
  user: AuthUser | null;
  /**
   * Главный шаг статуса — то самое действие, к которому зовёт подпись «Вам: …» (Р117). Строит его
   * коридор переходов (признак `primary` у пункта меню), а не вторая карта «статус → окно»: та
   * разошлась бы с коридором на первом же новом статусе. Вернуло `null` либо не передано вовсе —
   * подпись остаётся текстом: пункта в меню нет, и звать некуда.
   */
  primaryAction?: (request: ServiceRequestDto) => (() => void) | null;
  actions: (request: ServiceRequestDto) => ActionSheetItem[];
  onOpen: (request: ServiceRequestDto) => void;
}

/** Итог заявки: пока работы не закрыты — согласованная смета, после — то, что по акту. */
function amountLabel(request: ServiceRequestDto): { value: string; hint: string } {
  if (request.completion?.totalAmount != null) {
    return { value: formatMoney(request.completion.totalAmount), hint: 'по акту' };
  }
  if (request.estimatedTotalAmount != null) {
    return { value: formatMoney(request.estimatedTotalAmount), hint: 'по смете' };
  }
  return { value: '—', hint: '' };
}

export function serviceRequestColumns(
  opts: ServiceGridOptions,
): TableColumnsType<ServiceRequestDto> {
  const { view } = opts;
  return [
    {
      key: 'num',
      title: '№',
      dataIndex: 'displayNumber',
      width: 130,
      sorter: true,
      render: (_v: unknown, r: ServiceRequestDto) => (
        <div style={{ lineHeight: 1.35 }}>
          <Space size={4} wrap>
            <span>{r.displayNumber}</span>
            {/* Срочность — у номера, а не в отдельной колонке: список читают слева направо, и
                признак, ради которого заявку берут вне очереди, обязан попасться первым. */}
            {r.isUrgent && <UrgentTag reason={r.urgencyReason} />}
          </Space>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            завёл {r.createdByName}
          </Typography.Text>
        </div>
      ),
    },
    // Один столбец на все три вопроса — «где заявка», «кто тянет», «что требуется от меня»
    // (Р100). Прежние соседние «Ждёт» и «От вас требуется» говорили об одном и том же, а
    // читались как три разных факта.
    {
      key: 'status',
      title: 'Статус',
      dataIndex: 'status',
      width: 230,
      sorter: true,
      render: (_v: unknown, r: ServiceRequestDto) => {
        const line = serviceStatusLine(r, opts.user);
        const act = line?.mine ? (opts.primaryAction?.(r) ?? null) : null;
        return (
          <div style={{ lineHeight: 1.35 }}>
            <ServiceStatusTag status={r.status} statusChangedAt={r.statusChangedAt} />
            {line && (
              <div style={{ fontSize: 12 }}>
                {act ? (
                  <Typography.Link
                    // Мишень — сам текст, а не ячейка (Р117): строку списка задевают мышью чаще,
                    // чем нажимают, а клик по ней открывает карточку — всплыви он, окно действия
                    // открылось бы под карточкой.
                    onClick={(e) => {
                      e.stopPropagation();
                      act();
                    }}
                  >
                    {line.text}
                  </Typography.Link>
                ) : line.mine ? (
                  line.text
                ) : (
                  <Typography.Text type="secondary">{line.text}</Typography.Text>
                )}
              </div>
            )}
          </div>
        );
      },
    },
    // Поиск живёт лупой этого столбца: сервер ищет и по модели, и по обоим номерам, и по номеру
    // самой заявки («СО-14») — то есть ровно по тому, чем заявку и опознают.
    textColumn<ServiceRequestDto>({
      key: 'equipment',
      title: 'Техника',
      dataIndex: 'equipment',
      width: 260,
      render: (_v, r) => (
        <EquipmentCell request={r} warrantyUntil={opts.warrantyOf(r.equipment.id)} />
      ),
    }),
    // Объект — колонка ядра, а не набора сервиса (Р57). До этого её видел только исполнитель, и
    // заказчик с оператором отвечали на вопрос «где стоит аппарат», открывая карточку: у отдела
    // заявки бывают на разных площадках, а у оператора — на всех сразу.
    {
      key: 'object',
      title: 'Объект',
      dataIndex: 'object',
      width: 200,
      sorter: true,
      render: (_v: unknown, r: ServiceRequestDto) => (
        <div style={{ lineHeight: 1.35 }}>
          <div>
            {r.object.code} — {r.object.name}
          </div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {[r.equipment.location, r.customerDepartment?.name].filter(Boolean).join(' · ')}
          </Typography.Text>
        </div>
      ),
    },
    ...(view.customer
      ? [
          {
            key: 'description',
            title: 'Неисправность',
            dataIndex: 'description',
            width: 240,
            render: (_v: unknown, r: ServiceRequestDto) => (
              // Описание неисправности длинное и читают его не всегда: свёрнутая ячейка не
              // растит строку списка под самую многословную заявку.
              <ExpandableCell>{r.description}</ExpandableCell>
            ),
          },
        ]
      : []),
    ...(view.operator
      ? [
          {
            key: 'service',
            title: 'Сервис',
            dataIndex: 'service',
            width: 190,
            sorter: true,
            render: (_v: unknown, r: ServiceRequestDto) =>
              r.service?.name ?? <Typography.Text type="secondary">не назначен</Typography.Text>,
          },
        ]
      : []),
    ...(view.customer || view.operator
      ? [
          {
            key: 'amount',
            title: 'Сумма',
            dataIndex: 'estimatedTotalAmount',
            width: 140,
            align: 'right' as const,
            render: (_v: unknown, r: ServiceRequestDto) => {
              const { value, hint } = amountLabel(r);
              return (
                <div style={{ lineHeight: 1.35 }}>
                  <div>{value}</div>
                  {hint && (
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {hint}
                    </Typography.Text>
                  )}
                </div>
              );
            },
          },
        ]
      : []),
    ...(view.operator
      ? [
          {
            key: 'documents',
            title: 'Документы',
            dataIndex: 'files',
            width: 170,
            render: (_v: unknown, r: ServiceRequestDto) => <DocumentsCell request={r} />,
          },
        ]
      : []),
    ...(view.service
      ? [
          {
            key: 'contact',
            title: 'Контакт',
            dataIndex: 'responsibleName',
            width: 180,
            render: (_v: unknown, r: ServiceRequestDto) => (
              <div style={{ lineHeight: 1.35 }}>
                <div>{r.responsibleName || '—'}</div>
                {/* Номер ссылкой `tel:`: по контакту в списке именно звонят (ADR 0066). */}
                {r.responsiblePhone && <PhoneLink phone={r.responsiblePhone} />}
              </div>
            ),
          },
        ]
      : []),
    {
      key: 'statusChangedAt',
      title: 'В статусе',
      dataIndex: 'statusChangedAt',
      width: 120,
      sorter: true,
      render: (_v: unknown, r: ServiceRequestDto) => statusAgeLabel(r.statusChangedAt),
    },
    actionsColumn<ServiceRequestDto>((r) => {
      const items = opts.actions(r);
      return (
        <Space size={4}>
          <Tooltip title="Открыть карточку">
            <Button
              size="small"
              icon={<EyeOutlined />}
              aria-label="Открыть карточку"
              onClick={() => opts.onOpen(r)}
            />
          </Tooltip>
          {items.length > 0 && (
            // Действий у заявки бывает четыре и больше (назначить, согласовать, принять,
            // отменить) — иконками они заняли бы полстроки, поэтому уходят в меню.
            <Dropdown
              trigger={['click']}
              menu={{
                items: items.map((item) => ({
                  key: item.key,
                  label: item.label,
                  danger: item.danger,
                  disabled: item.disabled,
                })),
                onClick: ({ key }) => items.find((item) => item.key === key)?.onClick(),
              }}
            >
              <Button size="small" icon={<MoreOutlined />} aria-label="Действия" />
            </Dropdown>
          )}
        </Space>
      );
    }, 110),
  ];
}

/** Карточка заявки на телефоне (§9.7): номер и статус в шапке, дальше — техника и суть. */
export function serviceRequestCard(opts: ServiceGridOptions): CardConfig<ServiceRequestDto> {
  return {
    title: (r) => r.displayNumber,
    badge: (r) => (
      <Space size={4}>
        {r.isUrgent && <UrgentTag reason="" />}
        <ServiceStatusTag status={r.status} />
      </Space>
    ),
    primary: (r) =>
      [r.equipment.name, r.equipment.inventoryNumber && `инв. ${r.equipment.inventoryNumber}`]
        .filter(Boolean)
        .join(' · '),
    lines: [
      // Подсказок на телефоне нет, поэтому причина срочности выносится строкой — иначе красная
      // метка сообщала бы «срочно», не отвечая «почему».
      (r) => (r.isUrgent ? `Срочно: ${r.urgencyReason}` : null),
      (r) =>
        [`${r.object.code} — ${r.object.name}`, r.equipment.location].filter(Boolean).join(' · '),
      (r) => r.description,
      (r) => (r.service ? `Сервис: ${r.service.name}` : 'Сервис не назначен'),
      (r) => {
        const { value, hint } = amountLabel(r);
        return value === '—' ? null : `${value} ${hint}`;
      },
      (r) => `В статусе: ${statusAgeLabel(r.statusChangedAt)}`,
      // Подсказок на телефоне нет, поэтому состояние выносится строкой — той же, что во второй
      // строке столбца на десктопе. Текстом, а не ссылкой (Р117): тап по карточке открывает
      // карточку, и второй смысл у того же жеста спорил бы с первым — действия здесь в шите.
      (r) => serviceStatusLine(r, opts.user)?.text ?? null,
    ],
    onOpen: opts.onOpen,
    actions: (r) => [
      {
        key: 'open',
        label: 'Открыть карточку',
        icon: <EyeOutlined />,
        onClick: () => opts.onOpen(r),
      },
      ...opts.actions(r),
    ],
  };
}
