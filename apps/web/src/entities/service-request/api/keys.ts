import { createQueryKeys, type Query } from '@shared/api';

/**
 * Ключи запросов заявок на обслуживание оргтехники (ADR 0085).
 *
 * Семейства разведены по виду вопроса, а не по экрану: страница списка (со своими фильтрами),
 * карточка по идентификатору (её открывают ссылкой, минуя список) и история заявки. Под общим
 * ключом карточка, открытая из архива, затирала бы страницу рабочего списка — кто спросил
 * вторым, тот и определил бы ответ обоим.
 *
 * История — своё семейство, а не часть карточки: она приходит отдельной ручкой и устаревает в
 * другие моменты (любой переход дописывает событие, не трогая полей самой заявки).
 *
 * **Одного этого корня мутации модуля мало.** Карточка единицы оргтехники
 * (`officeEquipmentKeys.detail`) собирает историю обслуживания и действующие гарантии ремонтов
 * join-ом на лету, поэтому любое действие по заявке меняет то, что она покажет. Строка самого
 * справочника при этом не меняется вовсе — связь по коду не видна, и открытая рядом карточка
 * принтера показывала бы вчерашние ремонты до перезагрузки страницы. Поэтому каждое место, где
 * гасится `serviceRequestKeys.root`, гасит рядом и `officeEquipmentKeys.root`.
 */
export const serviceRequestKeys = createQueryKeys('service-requests', {
  list: (params: Query) => ['list', params],
  detail: (id: string) => ['detail', id],
  history: (id: string) => ['history', id],
  /**
   * Реестр гарантий — семейство внутри заявок, а не свой корень: строки собираются из позиций
   * объёма работ, и закрытие работ меняет их так же, как список заявок. Свой корень означал бы реестр,
   * который после приёмки показывает вчерашние гарантии, пока страницу не перезагрузят.
   */
  warranties: (params: Query) => ['warranties', params],
  /**
   * Счётчик «ждут меня» для бейджа в меню — семейство внутри заявок, а не свой корень: число
   * считается по тем же заявкам и устаревает от тех же событий. Свой корень означал бы бейдж,
   * который после назначения сервиса продолжает звать в разобранную очередь.
   */
  waitingCount: () => ['waiting-count'],
  /**
   * Лента обсуждения заявки (ADR 0141) — семейство внутри заявок, а не свой корень: реплики
   * живут заявкой и устаревают от неё же. Ключ по идентификатору, без курсора страницы: страницы
   * подгружаются вверх поверх одного и того же ответа, и ключ с `beforeSeq` завёл бы в кэше по
   * записи на каждую прокрутку — гасить их после отправки пришлось бы перебором.
   */
  chat: (id: string) => ['chat', id],
  /**
   * Счётчик непрочитанного для бейджа раздела — своё семейство рядом с `waitingCount`, а не общий
   * с ним ключ: числа отвечают на разные вопросы («где меня ждут» и «где мне написали»), и
   * сложить их нельзя. Семейство внутри заявок по той же причине, что и у соседа: считается по тем
   * же заявкам и устаревает от тех же событий.
   */
  chatUnreadCount: () => ['chat-unread-count'],
});

/**
 * Candidates for named executors (Н5, Н6): the accounts that may be made an executor of THIS
 * request.
 *
 * Its own root, not a family under requests: the list is made of portal accounts and does not
 * follow the course of requests. A shared root would let every estimate approval drop the staff
 * list, and every permission grant drop all open request lists.
 *
 * The request is still part of the key (Р7 of the executor audit plan): the server computes the
 * answer for that request, and a shared key would hand one window a cache computed for another.
 *
 * Writes to accounts and permission grants deliberately do not invalidate this root. A stale list
 * can at worst offer someone who has just lost the right: `PUT /:id/executors` rechecks every
 * executor with the same `canBecomeNamedExecutor` that builds this list and answers 422, so nothing
 * wrong is ever written.
 */
export const serviceExecutorKeys = createQueryKeys('service-executor-candidates', {
  options: (requestId: string) => ['options', requestId],
});
