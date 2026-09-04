import { useQuery } from '@tanstack/react-query';
import { SERVICE_REQUEST_STATUSES, serviceRequestStatusLabels } from '@technic/contracts';
import { serviceCompanyOptionsQuery } from '@entities/service-request';
import { officeEquipmentTypeOptionsQuery } from '@entities/office-equipment';
import { objectOptionsQuery } from '@entities/object';
import { departmentOptionsQuery } from '@entities/department';
import { type FilterDefinition } from '@shared/ui';
import { usePruneMissingFilters } from '@shared/lib';
import { useAuth } from '../../auth/AuthContext';

/**
 * Фильтры списка заявок на обслуживание — **одним описанием** на десктоп и телефон (§9.2).
 *
 * Обычно панель над таблицей собирается разметкой, а шит на телефоне — списком описаний, и две
 * копии расходятся при первой же правке: фильтр появляется на десктопе и не появляется в шите.
 * Здесь описание одно, а панель десктопа рисуется по нему же (`ServiceFilterBar`, соседний файл) —
 * забыть половину нельзя.
 *
 * Само рисование панели живёт отдельно (`ServiceFilterBar.tsx`): здесь принимаются РЕШЕНИЯ — какие
 * отборы у списка бывают, кому какой положен и что уходит в запрос, — а там их только показывают,
 * ничего не зная ни про права, ни про заявки. Разделение появилось, когда файл перерос порог длины,
 * и граница выбрана по этому шву, а не по числу строк.
 */

export interface ServiceListFilters {
  status?: string;
  objectId?: string;
  departmentId?: string;
  serviceCounterpartyId?: string;
  equipmentTypeId?: string;
  /** Признаки-очереди: сервер ждёт строку `'true'`, отсутствие значит «не спрашивали». */
  waitingOnMe?: string;
  mine?: string;
  awaitingDocuments?: string;
  warrantyClaim?: string;
  urgent?: string;
  /**
   * Расхождение по объекту (Р16): заявитель сказал, что аппарат стоит не там, где записано в его
   * карточке, и справочник до сих пор говорит своё. Отбор — конъюнкция ДВУХ признаков плюс «заявка
   * открыта», и считает её сервер: хранимая пометка `object_overridden` (факт заявления) и
   * вычисляемое расхождение (`equipment_object_id` заявки против объекта карточки).
   *
   * Одного признака мало ни в ту, ни в другую сторону. Хранимый сам не гаснет ничем — ИТ-служба
   * перенесёт единицу, а флаг у заявки останется навсегда, — и через месяц отбор перестал бы быть
   * очередью, став списком всего, что когда-либо поправляли. Вычисляемого мало, потому что технику
   * возят: у прошлогодних заявок снимок расходится с карточкой сплошь и рядом, и никто этого не
   * заявлял.
   */
  objectMismatch?: string;
  /**
   * Состояние предмета, которого ещё нет в справочнике (план кандидатов, §9): `'pending'` —
   * сообщение о технике ждёт проверки, `'rejected'` — проверка кончилась отказом. Не признак, а
   * ЗНАЧЕНИЕ ИЗ ДВУХ: состояние у кандидата одно, и пара чекбоксов допускала бы «и то, и другое» —
   * запрос, ответ на который пуст всегда, а читается пустая выдача как поломка списка.
   *
   * Строкой, как и соседи: отбор уходит в запрос как есть, а перечень значений стережёт сервер
   * (`candidateStatus` в `serviceRequestListQuerySchema`) — здесь его второй копии не заводится.
   */
  candidateStatus?: string;
  createdFrom?: string;
  createdTo?: string;
}

/**
 * Ключи отборов списка — те же, что поля `ServiceListFilters`, но перечнем: по ним хук списка
 * запоминает набор между сеансами (ADR 0139), строит «Сбросить» и решает, задан ли отбор вообще.
 * Тип сторожит совпадение — поле, добавленное в отбор и забытое здесь, перестанет запоминаться
 * молча, а не сломается.
 */
export const SERVICE_FILTER_FIELDS = [
  'status',
  'objectId',
  'departmentId',
  'serviceCounterpartyId',
  'equipmentTypeId',
  'waitingOnMe',
  'mine',
  'awaitingDocuments',
  'warrantyClaim',
  'urgent',
  'objectMismatch',
  'candidateStatus',
  'createdFrom',
  'createdTo',
] as const satisfies readonly (keyof ServiceListFilters)[];

/**
 * Отбор по статусу перечисляет коридор целиком, а не избранные значения: заведённая в контрактах
 * «Отложена» (Р103) появилась здесь сама, и следующий статус появится так же.
 */
const statusOptions = SERVICE_REQUEST_STATUSES.map((value) => ({
  value,
  label: serviceRequestStatusLabels[value],
}));

/** Признак включён — уходит строкой; выключен — не уходит вовсе, а не приходит `'false'`. */
const flag = (checked: boolean) => (checked ? 'true' : undefined);

/**
 * Две очереди по состоянию предмета (план кандидатов, §9). Подписи называют ЗАЯВКУ, а не кандидата
 * («предмет на проверке», а не «кандидат pending»): в списке заявок человек ищет заявки, и слово
 * «кандидат» здесь потребовало бы знания о таблице, которого у него нет.
 *
 * Перечень свой, а не `officeEquipmentCandidateStatusLabels` из контрактов, и это не дублирование:
 * тот словарь называет ИСХОД проверки для карточки кандидата (все четыре состояния, «Заведён в
 * справочник»), здесь же — два состояния, у которых есть незакрытая работа. Взяв словарь целиком,
 * отбор предложил бы два значения, отвечающих пустотой либо повторяющих отбор по карточке парка.
 */
const candidateStatusOptions = [
  { value: 'pending', label: 'Предмет на проверке' },
  { value: 'rejected', label: 'Предмет отклонён' },
];

/**
 * Очереди-пресеты над таблицей (§9.2): с них начинают работу оператор и сервис.
 *
 * Переехали сюда из самой страницы, потому что это не второй механизм, а те же три параметра
 * запроса (`waitingOnMe`, `urgent`, `awaitingDocuments`), что и отборы ниже, — и правило «кому
 * какой срез положен» у них общее. Порознь его пришлось бы держать в двух местах, и первым
 * признаком расхождения стал бы пресет, которого нет в шите фильтров, или наоборот.
 */
export function useServiceQueues(): { value: string; label: string }[] {
  const { can } = useAuth();
  return [
    { value: 'all', label: 'Все заявки' },
    { value: 'waiting', label: 'Требуют решения' },
    // Срочные — вход, а не фильтр: с них начинают день, и прятать их в шит значило бы прятать саму
    // работу (план модернизации, Р56).
    { value: 'urgent', label: 'Срочные' },
    // Та же дверь, что и у отбора ниже, и по той же причине (ADR 0160, решение 9): без субъектного
    // `serviceRequests.finance` сервер параметр молча игнорирует, и пресет был бы кнопкой, которая
    // переключается, ничего не меняя.
    ...(can('serviceRequests.finance')
      ? [{ value: 'documents', label: 'Ожидаются документы' }]
      : []),
  ];
}

export function useServiceRequestFilters({
  params,
  apply,
}: {
  params: ServiceListFilters;
  apply: (patch: ServiceListFilters) => void;
}): FilterDefinition[] {
  const { can } = useAuth();

  const { data: objectOptions = [], isSuccess: objectsReady } = useQuery(
    objectOptionsQuery({ activeOnly: false }),
  );
  const { data: departmentOptions = [], isSuccess: departmentsReady } =
    useQuery(departmentOptionsQuery());
  const {
    data: serviceOptions = [],
    isFetching: servicesLoading,
    isSuccess: servicesReady,
  } = useQuery(serviceCompanyOptionsQuery());
  // Перечень типов оргтехники закрыт правом справочника: сервису он недоступен вовсе (Р7), и
  // спрашивать его за него значило бы ловить 403 на каждом открытии списка.
  const { data: typeOptions = [], isSuccess: typesReady } = useQuery({
    ...officeEquipmentTypeOptionsQuery(),
    enabled: can('officeEquipment.read'),
  });

  /**
   * Восстановленный набор мог пережить сам предмет отбора: объект закрыли, отдел выключили,
   * подрядчика приостановили (ADR 0139). Такое значение уходит в запрос, но в поле показывается
   * сырым идентификатором — человек остаётся с пустым списком и без причины. Снимаем.
   *
   * Статус проверяется тем же порядком, хотя перечень его — из контрактов: снимок переживает
   * выпуск, а выбывшее из перечня значение сервер встретит отказом, и починить список изнутри
   * будет нечем.
   */
  usePruneMissingFilters(
    [
      { key: 'status', value: params.status, options: statusOptions, ready: true },
      // Перечень состояний предмета — константа портала, и «пережить свой предмет» ему нечем:
      // `ready: true`, потому что ждать загрузки нечего. Стоит здесь всё равно — чтобы снятое
      // значение (например, из запомненного набора прошлого выпуска) не ушло в запрос молча.
      {
        key: 'candidateStatus',
        value: params.candidateStatus,
        options: candidateStatusOptions,
        ready: true,
      },
      { key: 'objectId', value: params.objectId, options: objectOptions, ready: objectsReady },
      {
        key: 'departmentId',
        value: params.departmentId,
        options: departmentOptions,
        ready: departmentsReady,
      },
      {
        key: 'serviceCounterpartyId',
        value: params.serviceCounterpartyId,
        options: serviceOptions,
        ready: servicesReady,
      },
      {
        key: 'equipmentTypeId',
        value: params.equipmentTypeId,
        options: typeOptions,
        ready: typesReady,
      },
    ],
    (keys) => apply(Object.fromEntries(keys.map((key) => [key, undefined]))),
  );

  return [
    {
      kind: 'select',
      key: 'status',
      label: 'Статус',
      value: params.status,
      options: statusOptions,
      placeholder: 'Все статусы',
      onChange: (v) => apply({ status: v }),
    },
    {
      kind: 'toggle',
      key: 'waitingOnMe',
      label: 'Ждут меня',
      value: params.waitingOnMe === 'true',
      onChange: (v) => apply({ waitingOnMe: flag(v) }),
    },
    // Срочные стоят рядом с «Ждут меня»: это две очереди, с которых начинают день, и обе
    // отвечают на вопрос «за что браться сейчас», а не «что вообще есть».
    {
      kind: 'toggle',
      key: 'urgent',
      label: 'Только срочные',
      value: params.urgent === 'true',
      onChange: (v) => apply({ urgent: flag(v) }),
    },
    {
      kind: 'select',
      key: 'objectId',
      label: 'Объект',
      value: params.objectId,
      options: objectOptions,
      placeholder: 'Все объекты',
      onChange: (v) => apply({ objectId: v }),
    },
    {
      kind: 'select',
      key: 'departmentId',
      label: 'Отдел',
      value: params.departmentId,
      options: departmentOptions,
      placeholder: 'Все отделы',
      onChange: (v) => apply({ departmentId: v }),
    },
    {
      kind: 'select',
      key: 'serviceCounterpartyId',
      label: 'Сервис',
      value: params.serviceCounterpartyId,
      options: serviceOptions,
      loading: servicesLoading,
      placeholder: 'Все исполнители',
      onChange: (v) => apply({ serviceCounterpartyId: v }),
    },
    ...(can('officeEquipment.read')
      ? [
          {
            kind: 'select' as const,
            key: 'equipmentTypeId',
            label: 'Тип техники',
            value: params.equipmentTypeId,
            options: typeOptions,
            placeholder: 'Все типы',
            onChange: (v: string | undefined) => apply({ equipmentTypeId: v }),
          },
        ]
      : []),
    {
      kind: 'toggle',
      key: 'mine',
      label: 'Мои заявки',
      value: params.mine === 'true',
      onChange: (v) => apply({ mine: flag(v) }),
    },
    /*
     * Очередь долгов перед подрядчиком — рабочий инструмент того, кто заявку ведёт (ADR 0160,
     * решение 9). Сервер применяет параметр ТОЛЬКО при субъектном `serviceRequests.finance`, а
     * остальным молча игнорирует его — не отказом, чтобы разница «отказ / пустая выдача» сама не
     * стала оракулом «подшит ли счёт».
     *
     * Спрашивается ПРАВО субъекта, а не аудитория строки, и правилу «портал аудиторию не считает»
     * это не противоречит: у отбора нет строки, по которой её считать, — есть ровно тот же вопрос
     * к субъекту, который задаёт себе сервер, прежде чем применить параметр.
     */
    ...(can('serviceRequests.finance')
      ? [
          {
            kind: 'toggle' as const,
            key: 'awaitingDocuments',
            label: 'Ожидаются документы',
            value: params.awaitingDocuments === 'true',
            onChange: (v: boolean) => apply({ awaitingDocuments: flag(v) }),
          },
        ]
      : []),
    {
      kind: 'toggle',
      key: 'warrantyClaim',
      label: 'Только гарантийные',
      value: params.warrantyClaim === 'true',
      onChange: (v) => apply({ warrantyClaim: flag(v) }),
    },
    /*
     * Очередь ИТ-службы «разобрать расхождения» (Р16): по ней и переносят единицы в справочнике —
     * руками, разобравшись, а не по чекбоксу заявителя. Стоит рядом с прочими признаками-очередями,
     * потому что это такой же вход в работу, а не срез списка.
     */
    {
      kind: 'toggle',
      key: 'objectMismatch',
      label: 'Расхождение по объекту',
      value: params.objectMismatch === 'true',
      onChange: (v) => apply({ objectMismatch: flag(v) }),
    },
    /*
     * Отбор по состоянию предмета — рядом с «Расхождением по объекту» намеренно: обе строки про
     * ОДНО И ТО ЖЕ — про предмет заявки, разошедшийся со справочником, — и обе ведут к работе, а не
     * к срезу списка. «На проверке» разбирает тот, у кого `officeEquipment.review`, «отклонён» —
     * тот, кто заявку ведёт.
     *
     * ПРАВОМ НЕ ЗАКРЫТ, в отличие от «Ожидаются документы» и «Тип техники». Те два закрыты не из
     * осторожности: первый сервер молча игнорирует без `serviceRequests.finance` (кнопка была бы
     * переключателем, ничего не меняющим), второму нужен перечень типов, за который сервис получил
     * бы 403. Здесь нет ни того, ни другого — сервер применяет параметр всем, а значения перечня
     * зашиты в самом портале. И читатель у отбора есть на каждой стороне: заявитель им находит свои
     * заявки, по которым ещё нет ответа, — ту же плашку он видит и в карточке.
     */
    {
      kind: 'select',
      key: 'candidateStatus',
      label: 'Предмет заявки',
      value: params.candidateStatus,
      options: candidateStatusOptions,
      placeholder: 'Любой предмет',
      onChange: (v) => apply({ candidateStatus: v }),
    },
    {
      kind: 'dateRange',
      key: 'created',
      label: 'Период заведения',
      from: params.createdFrom,
      to: params.createdTo,
      onChange: (from, to) => apply({ createdFrom: from, createdTo: to }),
    },
  ];
}
