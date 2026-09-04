import { Button, Space, Tooltip, Typography, type TableColumnsType } from 'antd';
import { EyeOutlined, MoreOutlined } from '@ant-design/icons';
import {
  actsAsServiceExecutor,
  can,
  participantSidesOf,
  type AuthUser,
  type ServiceChatFacts,
  type ServiceExecutorAssignment,
  type ServiceRequestDto,
} from '@technic/contracts';
import {
  serviceRequestEquipmentName,
  serviceRequestPlaceLine,
  serviceStatusLine,
  statusAgeLabel,
  UrgentTag,
} from '@entities/service-request';
import { ServiceChatMark } from '@features/service-chat';
import {
  ActionMenuButton,
  actionsColumn,
  type CardConfig,
  ExpandableCell,
  textColumn,
} from '@shared/ui';
import { cardListMenuItems, rowMenuItems } from './serviceMenuPlacement';
import { ServiceStatusCell, ServiceStatusLineCell } from './ServiceStatusCell';
import type { ServiceMenuItem } from './serviceStatusChoices';
import {
  amountLabel,
  DocumentsCell,
  EquipmentCell,
  PlaceCell,
  showsAmount,
  StartWorkButton,
  AssignButton,
} from './serviceRequestCells';
import { PhoneLink } from '../../components/PhoneField';

/**
 * Список заявок на обслуживание: ядро колонок одно, а вопросы у ролей разные (§9.2).
 *
 * Заказчик спрашивает «что с моим принтером»: неисправность и во сколько это встало. Оператор —
 * «что требует решения»: кто исполнитель, на какую сумму и подшиты ли бумаги. Сервис — «что мне
 * делать»: где стоит техника и кому звонить. Показать всем всё нельзя: колонок набирается полтора
 * десятка, и список перестаёт читаться на любом экране.
 *
 * Вопрос «кто тянет и что требуется от меня» набора не имеет вовсе: на него отвечает общий столбец
 * состояния (Р100) — он в ядре и подписан для каждой стороны по-своему. Набор выбирается
 * **правами**, а не именем роли: оператор оргтехники — это надстройка над штабом или отделом
 * (ADR 0086), а сервис — тип контрагента (ADR 0038), и списком ролей их не описать.
 */

export interface ServiceGridView {
  customer: boolean;
  operator: boolean;
  service: boolean;
}

/**
 * Признаки заявки, ни один из которых не спрашивали.
 *
 * Колонки выбираются на ВСЮ таблицу, а стороны в контрактах делятся надвое: `operator` и `it`
 * считаются по САМОМУ СУБЪЕКТУ (код выданного набора — бизнес-профиль модуля), а `customer` и
 * `service` — по СТРОКЕ (авторство, область заказчика, назначение). Пустые признаки и оставляют в
 * ответе ровно первую половину — ту, которая на всю таблицу одна.
 *
 * Приём не выдуман здесь: им же сервер раскладывает стороны в SQL (`probeFacts` в
 * `services/service-request-chat.ts`), спрашивая контракты «а без заявки?». Другого способа задать
 * этот вопрос нет, а задать его надо — иначе набор колонок пришлось бы выводить своей формулой.
 *
 * Авторство при этом на клиенте не выводится и выводиться не может: `createdBy` в DTO нет
 * намеренно, а понадобься набору колонок сторона заказчика по строке — её берут готовой из
 * серверного `chat.participantSides`. Набору она не нужна: «показать ли колонки заказчика»
 * отвечает ПРАВО заводить заявки, а не участие в конкретной переписке.
 *
 * `userId` здесь пустой: он сравнивается только с поимённым адресатом реплики (`audienceMatches`),
 * а участие в сторонах от него не зависит.
 */
function subjectOnlyChatFacts(user: AuthUser | null): ServiceChatFacts {
  return {
    userId: user?.id ?? '',
    isAuthor: false,
    inCustomerScope: false,
    actsForAssignedService: false,
    isNamedExecutor: false,
  };
}

/**
 * «Если заявка отдана его компании — он на ней исполнитель?» Тем же вопросом список и смотрят:
 * заявку, отданную не ему, подрядчик не видит, и набор колонок у него от строки не зависит.
 *
 * Поимённая строка в пробнике пуста намеренно: сотрудник с `serviceRequests.execute` становится
 * исполнителем НА КОНКРЕТНОЙ заявке, а не вообще, — и колонки подрядчика (объект, контакт) ему
 * положены не больше, чем прежде. Признаки конкретной строки собирает `serviceExecutorAssignment`,
 * и он же отвечает за меню действий.
 */
const ASSIGNED_TO_MY_COUNTERPARTY: ServiceExecutorAssignment = {
  actsForAssignedCounterparty: true,
  isNamedExecutor: false,
};

/**
 * Чьими глазами смотрят на список. Наблюдателю и администратору показывается всё: первый заведён
 * ради сквозной картины по компании, у второго есть оба коридора сразу — он разбирает чужие
 * ошибки, и половина ответа ему не годится.
 *
 * СТОРОНЫ СПРАШИВАЮТСЯ У КОНТРАКТОВ, А НЕ РАЗБИРАЮТСЯ ЗДЕСЬ (Р8). Прежде набор считался своей
 * формулой из трёх прав — `actsForCounterparty` плюс `assign` плюс `create`, — и это было третье
 * представление сторон рядом с `participantSidesOf` и `actsAsServiceExecutor`: расходиться с ними
 * оно могло только молча, набором колонок, который никто не проверяет глазами. Так уже и вышло бы:
 * сторону «Ведения» перевели на код набора (план профилей, Р9), а здешняя копия осталась бы на
 * правах и показывала бы колонки решающего тому, кому профиля не выдавали.
 *
 * Взаимоисключение сторон тоже ушло из формулы: `!executor &&` перед каждой строкой повторял то,
 * что контракты знают сами — сторона `operator` прямо исключает оператора подрядчика, а прав
 * заводить заявки у него нет вовсе.
 *
 * Ответ по всем существующим субъектам прежний: у держателей профиля код и права ходят вместе
 * (пометка роли — производная от кода), у подрядчика профиля нет, у наблюдателя нет ни того ни
 * другого. Разойтись новое правило со старым может лишь на собранном руками наборе, где права
 * «Ведения» выданы без его кода, — и там правильный ответ даёт код, а не сумма прав.
 */
export function serviceGridView(user: AuthUser | null): ServiceGridView {
  const executor = actsAsServiceExecutor(user, ASSIGNED_TO_MY_COUNTERPARTY);
  // Обе стороны ведения модуля дают один набор колонок: «Ведение» (`operator`) распределяет и
  // принимает, ИТ-служба (`it`) решает «чинить или менять», и список оба читают одним вопросом —
  // «что требует решения». Стороны спрашиваются целиком, а не одна из них: они опознаются кодами
  // разных наборов (план профилей, Р9), и ИТ-служба под `operator` не подходит — прежняя формула
  // включала её случайно, правом `assign`, общим у двух должностей.
  const sides = participantSidesOf(user, subjectOnlyChatFacts(user));
  const operator = sides.includes('operator') || sides.includes('it');
  // Заказчик — это право заводить заявки, а не сторона переписки: колонки «Описание» и «Сумма»
  // отвечают на «что с моим принтером», и спрашивать за них участие в конкретной заявке нечем.
  const customer = can(user, 'serviceRequests.create');
  // «Всё» — две разные причины с одинаковым ответом: сторон не нашлось вовсе (наблюдатель со
  // сквозным чтением) либо сторон сразу две (администратор: ведёт модуль и пишет объём работ).
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
   * Чью очередь считать своей. Учётка целиком, а не прежний признак `isMine`: подпись состояния и
   * её лицо считаются одной функцией (`serviceStatusLine`, Р101), и второй вход для того же факта
   * рано или поздно разошёлся бы с текстом — заметная строка «Ждёт оператора» у того, кого и ждут.
   */
  user: AuthUser | null;
  actions: (request: ServiceRequestDto) => ServiceMenuItem[];
  /**
   * Строки текущей страницы — набору колонок, а не только таблице (ADR 0160, Р11): показывать ли
   * столбец «Сумма», решается по выдаче ЦЕЛИКОМ. Аудитория — свойство строки, и у держателя
   * `serviceRequests.execute` без субъектного `.finance` в одной выдаче законно лежат обе:
   * назначенная заявка полная, соседняя заявка его же области — редуцированная (`showsAmount`).
   */
  requests: readonly ServiceRequestDto[];
  /**
   * Заявка, по которой идёт действие без окна (ADR 0161): её тег ждёт ответа и нажатий не
   * принимает. Признак по строке, а не общий флаг набора: тот погасил бы теги соседних заявок.
   */
  pendingId?: string | null;
  onOpen: (request: ServiceRequestDto) => void;
  /**
   * Открыть обсуждение прямо из строки (ADR 0141): метка непрочитанного у номера ведёт в него, а
   * не в карточку. Окно при этом принадлежит набору окон СТРАНИЦЫ, а не карточки: карточка здесь
   * не открыта, и вкладывать переписку некуда.
   */
  onChat: (request: ServiceRequestDto) => void;
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
            {/* Непрочитанное обсуждение — там же и по той же причине: колонки с текстом реплик в
                списке нет вовсе (решение опроса), и метка у номера — единственное место, где
                видно, что по заявке написали. */}
            <ServiceChatMark request={r} onOpen={opts.onChat} />
          </Space>
          {/* Строкой ниже, а не следом за номером: `Space` и текст оба строчные, и без блока
              подпись приклеивается к номеру вплотную — «СО-10завёл Иванов». */}
          <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block' }}>
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
      // Сам тег — вход в ход заявки (ADR 0161): переходы отбираются из набора действий строки, и
      // второй карты правил у портала не появляется. Разметка ячейки живёт своим модулем.
      render: (_v: unknown, r: ServiceRequestDto) => (
        <ServiceStatusLineCell
          request={r}
          items={opts.actions(r)}
          pending={opts.pendingId === r.id}
          user={opts.user}
        />
      ),
    },
    // Поиск живёт лупой этого столбца: сервер ищет и по модели, и по обоим номерам, и по номеру
    // самой заявки («СО-14») — то есть ровно по тому, чем заявку и опознают.
    textColumn<ServiceRequestDto>({
      key: 'equipment',
      title: 'Техника',
      dataIndex: 'equipment',
      width: 260,
      // Гарантия приезжает внутри самой строки (Ф3), и ячейке больше нечего передавать: срок лежит
      // в блоке предмета, а у заявки без аппарата блока нет вовсе — спрашивать не у чего.
      render: (_v, r) => <EquipmentCell request={r} />,
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
      // Ячейка отдельным модулем: у заявки без аппарата верхнюю строку занимает отдел-заказчик, и
      // объяснение этому длиннее самой разметки (Р8).
      render: (_v: unknown, r: ServiceRequestDto) => <PlaceCell request={r} />,
    },
    ...(view.customer
      ? [
          {
            key: 'description',
            // Заголовок общий на оба вида и равен подписи поля в форме (Р2): заказчик просит
            // единообразия, кинд-зависимость Р17 ADR 0145 отменена вместе с «Что случилось».
            title: 'Описание',
            dataIndex: 'description',
            width: 240,
            render: (_v: unknown, r: ServiceRequestDto) => (
              // Описание длинное и читают его не всегда: свёрнутая ячейка не растит строку списка.
              <ExpandableCell>{r.description}</ExpandableCell>
            ),
          },
        ]
      : []),
    ...(view.operator
      ? [
          {
            key: 'service',
            // Колонка называет обоих исполнителей: с волны В6 их два слоя — сервисная компания
            // целиком и свои сотрудники поимённо (Н5). Прежнее «Сервис» показывало половину, и у
            // заявки, которую чинит свой сисадмин, столбец читался как «никто не назначен».
            title: 'Исполнители',
            dataIndex: 'service',
            width: 220,
            // Сортировка осталась по контрагенту — среди полей сортировки контракта поимённых нет,
            // и сортируемый заголовок обещал бы порядок, на который сервер ответит 400.
            sorter: true,
            render: (_v: unknown, r: ServiceRequestDto) => {
              const named = r.executors.map((e) => e.name);
              if (!r.service && named.length === 0) {
                return <Typography.Text type="secondary">не назначены</Typography.Text>;
              }
              return (
                <>
                  {r.service?.name}
                  {r.service && named.length > 0 && <br />}
                  {named.length > 0 && (
                    <Typography.Text type={r.service ? 'secondary' : undefined}>
                      {named.join(', ')}
                    </Typography.Text>
                  )}
                </>
              );
            },
          },
        ]
      : []),
    ...((view.customer || view.operator) && showsAmount(opts.requests)
      ? [
          {
            key: 'amount',
            title: 'Сумма',
            dataIndex: 'estimatedTotalAmount',
            width: 140,
            align: 'right' as const,
            render: (_v: unknown, r: ServiceRequestDto) => {
              // Редуцированная строка молчит целиком, а не рисует прочерк: пустая ячейка ничего не
              // утверждает, а «—» утверждало бы, что сметы у заявки нет (ADR 0160, Р11).
              const label = amountLabel(r);
              if (!label) return null;
              return (
                <div style={{ lineHeight: 1.35 }}>
                  <div>{label.value}</div>
                  {label.hint && (
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {label.hint}
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
      // Не «В статусе» (Р4): меряется возраст ТЕКУЩЕГО ОЖИДАНИЯ — назначение, предъявление объёма
      // работ и согласование статуса не меняют, а ожидание начинают заново. Так же подписан тег.
      title: 'Ждёт',
      dataIndex: 'statusChangedAt',
      width: 120,
      sorter: true,
      render: (_v: unknown, r: ServiceRequestDto) => statusAgeLabel(r.statusChangedAt),
    },
    actionsColumn<ServiceRequestDto>((r) => {
      const all = opts.actions(r);
      const items = rowMenuItems(all);
      return (
        <Space size={4}>
          {/* «Принять в работу» и назначение — быстрыми кнопками (Р6, ADR 0162): пункты берутся
              готовыми, доступность считает набор действий. */}
          <StartWorkButton item={all.find((item) => item.key === 'start')} />
          <AssignButton item={all.find((item) => item.key === 'assign')} />
          <Tooltip title="Открыть карточку">
            <Button
              size="small"
              icon={<EyeOutlined />}
              aria-label="Открыть карточку"
              onClick={() => opts.onOpen(r)}
            />
          </Tooltip>
          {items.length > 0 && (
            // Действий бывает четыре и больше — иконками они заняли бы полстроки. Триггер общий с
            // карточкой: он же собирает пункты и возвращает фокус после закрытия (ADR 0162).
            <ActionMenuButton
              items={items}
              size="small"
              icon={<MoreOutlined />}
              ariaLabel="Действия"
            />
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
        {/* Метка обсуждения и на телефоне у номера: тап по ней открывает переписку, тап по
            карточке — саму заявку. Второго места для непрочитанного здесь нет — колонок нет. */}
        <ServiceChatMark request={r} onOpen={opts.onChat} />
        {r.isUrgent && <UrgentTag reason="" />}
        {/* Тап по тегу открывает шит переходов, тап по карточке — саму заявку (ADR 0161). */}
        <ServiceStatusCell request={r} items={opts.actions(r)} pending={opts.pendingId === r.id} />
      </Space>
    ),
    primary: (r) =>
      [
        serviceRequestEquipmentName(r),
        r.equipment?.inventoryNumber && `инв. ${r.equipment.inventoryNumber}`,
      ]
        .filter(Boolean)
        .join(' · '),
    lines: [
      // Подсказок на телефоне нет, поэтому причина срочности выносится строкой — иначе красная
      // метка сообщала бы «срочно», не отвечая «почему».
      (r) => (r.isUrgent ? `Срочно: ${r.urgencyReason}` : null),
      // Площадки у заявки «от отдела» нет вовсе: строка пропускается целиком — пустые карточка не
      // рисует, — а прочерк на телефоне читался бы как недогруженная запись (Р8).
      (r) => serviceRequestPlaceLine(r),
      (r) => r.description,
      (r) => (r.service ? `Сервис: ${r.service.name}` : 'Сервис не назначен'),
      // Денежная строка карточки решается по аудитории САМОЙ СТРОКИ, а не по набору страницы
      // (ADR 0160, Р11): у карточек столбцов нет, ровнять здесь нечего — редуцированная заявка
      // просто не показывает строки, как не показывает её заявка без сметы.
      (r) => {
        const label = amountLabel(r);
        return !label || label.value === '—' ? null : `${label.value} ${label.hint}`;
      },
      // «Ждёт», а не «в статусе» (Р4): возраст меряет ожидание, а не статус.
      (r) => `Ждёт: ${statusAgeLabel(r.statusChangedAt)}`,
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
      ...cardListMenuItems(opts.actions(r)),
    ],
  };
}
