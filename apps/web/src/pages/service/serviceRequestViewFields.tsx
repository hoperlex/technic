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
  serviceRequestEquipmentName,
  serviceRequestObjectLabel,
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
  // Площадка заявки; `null` — её нет вовсе, и от этого зависит и подпись строки, и её состав (Р8).
  const objectLabel = serviceRequestObjectLabel(request);

  return [
    {
      key: 'status',
      label: 'Статус',
      children: (
        <Space size={8} wrap>
          <ServiceStatusTag status={request.status} />
          {/* Вид заявки (Н1) — рядом со статусом, а не отдельной строкой: он не реквизит, а ответ
              на «о чём эта заявка вообще», и читается вместе с состоянием. Обслуживание (бывший
              «Ремонт», Р1) не подписывается: оно умолчание модуля, и тег у каждой второй заявки
              перестал бы что-либо означать. */}
          {request.kind === 'consumable' && (
            <Tag color="cyan">{serviceRequestKindLabels.consumable}</Tag>
          )}
          {/* Второй исход согласования (Р8, В21): заявку закрыли не потому, что починили, а потому
              что чинить нецелесообразно. Пометка стоит рядом со статусом, а не в истории: по ней
              собирают список «что пора менять», и в отменённых заявках её ищут глазами.
              Ставит её теперь человек галочкой при отказе, а не снятая виза ИТ (Р10). */}
          {request.replacementRecommended && (
            <Tooltip title="При отказе по объёму работ отмечено: ремонт нецелесообразен, аппарат под замену">
              <Tag color="volcano">Рекомендована замена</Tag>
            </Tooltip>
          )}
          {statusLine &&
            (statusLine.mine ? (
              <span>{statusLine.text}</span>
            ) : (
              <Typography.Text type="secondary">{statusLine.text}</Typography.Text>
            ))}
          {/* Не «в статусе»: возраст обнуляется от смены того, кого ждут, а не статуса (Р4) —
              предъявленный объём работ и переданная другому исполнителю заявка статуса не меняют, а
              ожидание начинают заново. Подпись обязана называть то, что показано, — и та же
              формулировка стоит подсказкой у тега состояния. */}
          <Typography.Text type="secondary">
            ждёт {statusAgeLabel(request.statusChangedAt)}
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
    /*
     * Решение при отказе по объёму работ (Р12) — САМО ПО СЕБЕ, полем заявки рядом с пометкой
     * замены, а не «под причиной». Причины отмены в карточке нет вовсе: она уходит комментарием
     * перехода и живёт на вкладке «История», где её и читают, — а `serviceRequestViewFields` видит
     * одну заявку. Тянуть её сюда отдельным запросом за последним отменяющим переходом значило бы
     * вторую дорогу к тому, что уже показано вкладкой рядом.
     *
     * Строки нет, когда решения нет: непустым оно бывает только у отменённой заявки (`CHECK` в БД),
     * и прочерк у всех остальных читался бы как «поле забыли заполнить».
     */
    ...(request.rejectionResolution
      ? [
          {
            key: 'rejectionResolution',
            label: 'Решение',
            full: true,
            children: request.rejectionResolution,
          },
        ]
      : []),
    {
      key: 'equipment',
      label: 'Какой аппарат',
      full: true,
      children: (
        <Space orientation="vertical" size={2}>
          {/* «Без аппарата» словами (Р8): предмета у заявки может не быть вовсе, и это законное
              состояние — прочерк на его месте читался бы как незаполненное поле. Реквизитов у
              такой заявки нет ни одного: ни номеров, ни типа, ни гарантии — вторая строка и теги
              ниже не пустеют, а не рисуются. */}
          <span>{serviceRequestEquipmentName(request)}</span>
          {request.equipment && (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {[
                request.equipment.typeName,
                request.equipment.inventoryNumber && `инв. ${request.equipment.inventoryNumber}`,
                request.equipment.serialNumber && `SN ${request.equipment.serialNumber}`,
              ]
                .filter(Boolean)
                .join(' · ')}
            </Typography.Text>
          )}
          {/* Два разных признака (§9.2): состояние гарантии самой техники и пометка о том,
              что заявку завели по гарантии. Первое известно только тому, кому виден
              справочник, второе — всем. У заявки без аппарата обоих нет вовсе: гарантия единицы
              не «неизвестна», а не существует, и обращение по гарантии заводится выбором аппарата
              (Р7 закрывает эту дверь на сервере). */}
          {request.equipment && equipmentWarrantyUntil !== undefined && (
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
      /*
       * Подпись зависит от того, есть ли чему стоять. У заявки без аппарата площадки может не быть
       * вовсе (заявка «от отдела», Р8), и «Где стоит» в ней было бы неправдой: стоять нечему.
       * Заказчик при этом есть всегда и ровно один — площадка либо отдел (`CHECK` предмета, Р7), —
       * поэтому строка не исчезает, а сужается до вопроса «для кого».
       */
      label: objectLabel ? 'Где стоит и для кого' : 'Для кого',
      full: true,
      children: (
        <Space size={8} wrap>
          {objectLabel && <span>{objectLabel}</span>}
          {/* «Не тот объект» (Р16): объект в этой заявке назвал человек, а не подставила карточка
              техники. Пометка историчная и неизменная — это факт заявления, а не расхождение:
              расхождение вычисляется соединением с карточкой на сервере и гаснет само, когда
              ИТ-служба перенесёт единицу. Поэтому подпись говорит про заявление, а не про то, что
              аппарат «стоит не там»: к моменту чтения его могли уже перенести.
              У заявки без аппарата этой пары не бывает: спорить с карточкой техники, которой нет,
              не о чем — дверь закрыта на сервере (Р7). */}
          {request.objectOverridden && (
            <Tooltip title="Заявитель указал, что аппарат стоит на другом объекте: справочник этим не правится — единицу переносит ИТ-служба, разобрав отбор расхождений">
              <Tag color="gold">Объект указан заявителем</Tag>
            </Tooltip>
          )}
          {/* Место внутри объекта — снимок на момент заведения (Р57): по нему сервис и едет,
              а карточка единицы к моменту ремонта могла уже переехать. */}
          {request.equipment?.location && (
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
      // Подпись общая на оба вида и от `request.kind` больше не зависит (Р2, просьба 7). Прежнее
      // решение Р17 ADR 0145 разводило её по виду («что случилось» у ремонта, «что нужно» у
      // расходников), потому что старая «Неисправность» врала на заявках про картриджи; заказчик
      // выбрал другой выход из той же проблемы — нейтральное «Описание», одинаковое везде.
      label: 'Описание',
      full: true,
      children: request.description,
    },
    {
      key: 'responsible',
      label: 'Кто обращается',
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
            label: 'Откуда обращаются',
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
    /*
     * «Комментарий» заявителя остался, а «Примечание исполнителя» ушло (ADR 0141): первое — часть
     * постановки задачи, его пишут до того, как заявка кому-либо адресована; второе было
     * перезаписываемым полем на всю заявку, и его заменила лента обсуждения, где видно, кто, когда
     * и кому сказал. Двух мест для одного текста у карточки больше нет.
     */
    {
      key: 'comment',
      label: 'Что ещё важно знать',
      full: true,
      children: request.comment || '—',
    },
  ];
}
