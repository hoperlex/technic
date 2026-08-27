import { Button, Space, Tag, Tooltip, Typography } from 'antd';
import { UserSwitchOutlined } from '@ant-design/icons';
import {
  type AccessSubject,
  serviceRequestKindLabels,
  type ServiceRequestDto,
  serviceRequestStatusLabels,
  warrantyClaimSourceLabels,
} from '@technic/contracts';
import {
  ServiceStatusTag,
  serviceStatusLine,
  statusAgeLabel,
  UrgentTag,
} from '@entities/service-request';
import { WarrantyTag } from '@entities/office-equipment';
import type { ViewField } from '@shared/ui';
import { ResponsibleValue } from '../../components/ResponsibleFields';
import { formatDateTime } from '../../utils/format';

/**
 * Поля карточки заявки на обслуживание (§9.4) — вкладка «Заявка».
 *
 * Отдельным модулем от самого окна: окно отвечает за вкладки, действия и запросы, а здесь лежит
 * ответ на «что с заявкой» — двенадцать полей, каждое со своим правилом показа. Вместе они
 * перерастали ограничение длины файла, и разделены по этой границе: состав полей меняется от
 * каждой правки модели, устройство окна — почти никогда.
 */
export function serviceRequestViewFields({
  request,
  user,
  equipmentWarrantyUntil,
  onAssign,
}: {
  request: ServiceRequestDto;
  /** Смотрящий: от него зависит только лицо подписи состояния — «Вам: …» либо «Ждёт …». */
  user: AccessSubject | null | undefined;
  /**
   * Гарантия самой единицы. Приходит извне и бывает не задана вовсе: в заявке лежит снимок
   * реквизитов без срока, а справочник виден не всякому — сервису он закрыт (Р7).
   */
  equipmentWarrantyUntil?: string | null;
  /**
   * Открыть окно исполнителей (ADR 0140). Не задан — состав правит кто-то другой либо не тот
   * статус: право и коридор здесь не считаются вовсе, обработчик приходит готовым пунктом
   * действий. Спроси поле само, кому назначать можно, — и это была бы вторая карта прав, которая
   * разошлась бы с коридором переходов на первом же изменении цикла.
   */
  onAssign?: (() => void) | null;
}): ViewField[] {
  // Подпись — та же, что во второй строке столбца (Р100); у отложенной её разбирает строка ниже.
  const statusLine = request.status !== 'on_hold' ? serviceStatusLine(request, user) : null;

  return [
    {
      key: 'status',
      label: 'Статус',
      children: (
        <Space size={8} wrap>
          <ServiceStatusTag status={request.status} />
          {/* Вид заявки (Н1) — рядом со статусом, а не отдельной строкой: он не реквизит, а ответ
              на «о чём эта заявка вообще», и читается вместе с состоянием. Ремонт не подписывается:
              он умолчание модуля, и тег у каждой второй заявки перестал бы что-либо означать. */}
          {request.kind === 'consumable' && (
            <Tag color="cyan">{serviceRequestKindLabels.consumable}</Tag>
          )}
          {/* Второй исход визы ИТ (Н3, В21): заявку закрыли не потому, что починили, а потому что
              чинить нецелесообразно. Пометка стоит рядом со статусом, а не в истории: по ней
              собирают список «что пора менять», и в отменённых заявках её ищут глазами. */}
          {request.replacementRecommended && (
            <Tooltip title="Решение ИТ по смете: ремонт нецелесообразен, аппарат под замену">
              <Tag color="volcano">Рекомендована замена</Tag>
            </Tooltip>
          )}
          {statusLine &&
            (statusLine.mine ? (
              <span>{statusLine.text}</span>
            ) : (
              <Typography.Text type="secondary">{statusLine.text}</Typography.Text>
            ))}
          <Typography.Text type="secondary">
            в статусе {statusAgeLabel(request.statusChangedAt)}
          </Typography.Text>
        </Space>
      ),
      full: true,
    },
    // Заморозка объясняется строкой, а не одной подписью в шапке: причина отвечает на «чего
    // ждём» (Р107), а статус возврата — на «куда заявка пойдёт дальше» (Р104: дуга одна, и
    // выбора пути у заморозки нет).
    ...(request.status === 'on_hold'
      ? [
          {
            key: 'hold',
            label: 'Отложена',
            full: true,
            children: [
              request.holdReason || '—',
              request.heldFromStatus &&
                `вернётся в «${serviceRequestStatusLabels[request.heldFromStatus]}»`,
            ]
              .filter(Boolean)
              .join(' · '),
          },
        ]
      : []),
    {
      key: 'equipment',
      label: 'Техника',
      full: true,
      children: (
        <Space direction="vertical" size={2}>
          <span>{request.equipment.name}</span>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {[
              request.equipment.typeName,
              request.equipment.inventoryNumber && `инв. ${request.equipment.inventoryNumber}`,
              request.equipment.serialNumber && `SN ${request.equipment.serialNumber}`,
            ]
              .filter(Boolean)
              .join(' · ')}
          </Typography.Text>
          {/* Два разных признака (§9.2): состояние гарантии самой техники и пометка о том,
              что заявку завели по гарантии. Первое известно только тому, кому виден
              справочник, второе — всем. */}
          {equipmentWarrantyUntil !== undefined && (
            <Space size={8} wrap>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                гарантия на технику:
              </Typography.Text>
              <WarrantyTag until={equipmentWarrantyUntil} />
            </Space>
          )}
          {request.warrantyClaim && (
            <Tooltip
              title={
                request.warrantyClaim.sourceRequestNum
                  ? `Источник: заявка СО-${request.warrantyClaim.sourceRequestNum}`
                  : 'Гарантия поставщика на саму единицу'
              }
            >
              <Tag color="purple">
                {warrantyClaimSourceLabels[request.warrantyClaim.source]}
                {request.warrantyClaim.itemName ? `: ${request.warrantyClaim.itemName}` : ''}
              </Tag>
            </Tooltip>
          )}
        </Space>
      ),
    },
    {
      key: 'customer',
      label: 'Объект и заказчик',
      full: true,
      children: (
        <Space size={8} wrap>
          <span>
            {request.object.code} — {request.object.name}
          </span>
          {/* Место внутри объекта — снимок на момент заведения (Р57): по нему сервис и едет,
              а карточка единицы к моменту ремонта могла уже переехать. */}
          {request.equipment.location && (
            <Typography.Text type="secondary">{request.equipment.location}</Typography.Text>
          )}
          {request.customerDepartment && <Tag>{request.customerDepartment.name}</Tag>}
          {/* Отдел-владелец техники: по нему считается область, и он бывает не тем же, что
              отдел-заказчик — соседний отдел чинит «чужой» принтер чаще, чем кажется. */}
          {request.equipmentDepartment &&
            request.equipmentDepartment.id !== request.customerDepartment?.id && (
              <Typography.Text type="secondary">
                владелец: {request.equipmentDepartment.name}
              </Typography.Text>
            )}
        </Space>
      ),
    },
    {
      key: 'description',
      label: 'Неисправность',
      full: true,
      children: request.description,
    },
    {
      key: 'responsible',
      label: 'Заявитель',
      children: (
        <ResponsibleValue name={request.responsibleName} phone={request.responsiblePhone} />
      ),
    },
    /*
     * Откуда заявка (Н11) — рядом с заявителем, второй колонкой той же строки.
     *
     * Значение — снимок подразделения **учётки, заведшей заявку**: отдел, а если отдела у неё
     * нет — площадка. Не отдел-заказчик выше: тот выбирают («чужой» принтер соседнего отдела), а
     * здесь записано, где числится сам подавший. И не контакт слева: `responsibleName` — тот,
     * кому звонить, и он бывает вовсе не из того же отдела.
     *
     * Строки нет вовсе, когда привязок у учётки не было (администратор портала) либо заявку
     * завели до выпуска 1: прочерк читался бы как «поле не заполнили», хотя заполнять его нечем.
     */
    ...(request.requesterPlace
      ? [
          {
            key: 'requesterPlace',
            label: 'Подразделение',
            children: (
              <Space size={8} wrap>
                <span>{request.requesterPlace.name}</span>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {request.requesterPlace.kind === 'department' ? 'отдел' : 'площадка'}
                </Typography.Text>
              </Space>
            ),
          },
        ]
      : []),
    // Срочность показывается строкой, а не одной меткой в заголовке: решение принимают по
    // причине, а не по красному цвету, и в карточке для неё есть место (Р56).
    ...(request.isUrgent
      ? [
          {
            key: 'urgency',
            label: 'Срочность',
            full: true,
            children: (
              <Space size={8} wrap>
                <UrgentTag reason="" />
                <span>{request.urgencyReason}</span>
              </Space>
            ),
          },
        ]
      : []),
    {
      key: 'executors',
      label: 'Исполнители',
      full: true,
      /* Состав и ручка к нему — в одной строке (ADR 0140): исполнителей меняют, глядя на то, кто
         ведёт заявку, а прежде за этим шли в меню «Действия» внизу карточки — то есть отводили
         глаза от самого ответа. Глагол кнопки берётся от видимого состава, а не от статуса: рядом
         с пустым полем «Изменить» звало бы менять то, чего нет. Кому кнопка положена, здесь не
         решается вовсе — её просто нет, когда обработчик не передан. */
      children: (
        <Space size={8} wrap>
          {request.executors.length === 0 && !request.service ? (
            'не назначены'
          ) : (
            /* Два слоя рядом (Н5): свои — поимённо, сервисная компания — строкой. Разными тегами,
               потому что и спрашивают с них по-разному: с человека — лично, с компании — как с
               подрядчика, чьих инженеров портал не знает. */
            <>
              {request.executors.map((person) => (
                <Tag key={person.userId}>{person.name}</Tag>
              ))}
              {request.service && (
                <Tooltip title="Сервисная компания назначена целиком: кто из инженеров поедет, решает она">
                  <Tag color="blue">{request.service.name}</Tag>
                </Tooltip>
              )}
            </>
          )}
          {onAssign && (
            <Button
              type="link"
              size="small"
              icon={<UserSwitchOutlined />}
              style={{ padding: 0 }}
              onClick={onAssign}
            >
              {request.executors.length === 0 && !request.service ? 'Назначить' : 'Изменить'}
            </Button>
          )}
        </Space>
      ),
    },
    {
      key: 'acceptance',
      label: 'Приёмка',
      children: !request.acceptedAt ? (
        '—'
      ) : request.acceptanceSource === 'auto' ? (
        /* Закрыл портал, а не человек (Н7): у автоматической приёмки автора нет и быть не должно,
           и «—» на месте имени читалось бы как потерянную запись. Пустой источник у принятой
           заявки — это `human`: так её оставил старый код в окне выката. */
        <Space size={8} wrap>
          <Tooltip title="Портал закрыл заявку сам: сутки после предъявления работ прошли без возражений">
            <Tag color="geekblue">Закрыта автоматически</Tag>
          </Tooltip>
          <span>{formatDateTime(request.acceptedAt)}</span>
        </Space>
      ) : (
        `${request.acceptedByName || '—'} · ${formatDateTime(request.acceptedAt)}`
      ),
    },
    {
      key: 'author',
      label: 'Автор',
      children: `${request.createdByName} · ${formatDateTime(request.createdAt)}`,
    },
    { key: 'comment', label: 'Комментарий', full: true, children: request.comment || '—' },
    // Примечание исполнителя (приём ADR 0053): его строка в заявке, заявку она не редактирует.
    ...(request.serviceComment
      ? [
          {
            key: 'serviceComment',
            label: 'Примечание исполнителя',
            full: true,
            children: request.serviceComment,
          },
        ]
      : []),
  ];
}
