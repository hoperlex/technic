import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ACCESS_PROFILES,
  permissionsFor,
  SERVICE_REQUEST_STATUSES,
  type AuthUser,
  type ServiceRequestDto,
  type ServiceRequestStatus,
} from '@technic/contracts';
import { authUser } from './factories/auth';
import {
  assignedServiceRequest,
  estimatePendingServiceRequest,
  heldServiceRequest,
  SERVICE_COUNTERPARTY,
  serviceCustomer,
  serviceExecutor,
  serviceInHouseExecutor,
  serviceOperator,
  serviceRequest,
  serviceRequestFile,
} from './factories/service';
import {
  cardListMenuItems,
  cardMenuItems,
  HIDDEN_IN_CARD_LIST_MENU,
  HIDDEN_IN_CARD_MENU,
  HIDDEN_IN_ROW_MENU,
  rowMenuItems,
} from '../src/pages/service/serviceMenuPlacement';
import { serviceRequestMenuItems } from '../src/pages/service/serviceRequestMenu';
import {
  serviceStatusChoices,
  type ServiceMenuItem,
} from '../src/pages/service/serviceStatusChoices';
import type { ServiceRequestModals } from '../src/pages/service/serviceRequestModals';

/**
 * Караул состава: где какой пункт действий заявки показывается и чем он заменён там, где его нет
 * (план `docs/office-equipment-request-actions-menu-plan.md`, §7.4, решения Р3 и Р9).
 *
 * **Реестр живёт здесь, а не рядом с меню, и это решение Р9.** Соблазн завести
 * `SERVICE_ACTION_ENTRIES` в продовом коде велик, но такой перечень — вторая карта правил: разойтись
 * с набором действий он смог бы молча, и экран спорил бы не с тестом, а с документом. Поэтому
 * ожидаемый состав объявлен таблицей ниже, а ФАКТИЧЕСКИЙ берётся из рабочего кода: из наборов
 * скрытия и самих фильтров места (`serviceMenuPlacement`), из набора действий
 * (`serviceRequestMenuItems`) на синтетических заявках и из проекции на тег статуса.
 *
 * Что ловится:
 *
 *  - пункт, вычеркнутый из меню карточки без другого входа В ТОЙ ЖЕ карточке, — это не «сняли
 *    дубль», а «отняли работу»;
 *  - новый пункт, заведённый мимо реестра, — и наоборот, строка реестра, которой в коде уже нет;
 *  - расхождение мест: пункт, спрятанный в одном меню и забытый в другом, выглядит решением, а не
 *    ошибкой, и без караула отличить их нечем.
 *
 * Чего НЕ ловится: удобство входа и соответствие реестра намерению заказчика — это приёмка на
 * пилоте (§7.5 плана). Меню соседних модулей («Механизация», «Вывоз мусора») устроены иначе, и
 * караул на них не распространяется (§1 плана).
 */

/**
 * Строка реестра: чем этот пункт отличается от обычного.
 *
 * **Умолчание — «пункт есть во всех трёх местах и второго входа не имеет»**, и заполнены поэтому
 * только клетки-исключения: так таблица и читается таблицей, а не двадцатью тремя одинаковыми
 * абзацами. Признаки объявлены как `?: true`, а не парой булевых значений, ровно затем, чтобы
 * `hiddenInCard: false` нельзя было написать вовсе — «спрятан» и «не спрятан» не должны выглядеть
 * одинаково длинно.
 */
interface EntryRow {
  /** Подпись пункта: реестр читают глазами, а по одним ключам он нечитаем. */
  label: string;
  /**
   * Пункта нет в меню СПИСКА — ни в строке на десктопе (М1), ни в карточке списка на телефоне (М2).
   *
   * Одним признаком на два места, потому что и набор один: оба меню строит `listMenuItems`
   * (`serviceRequestGrid.tsx`). Разойдись они — действие пропало бы на одном экране и осталось на
   * другом, и заметить это было бы некому.
   */
  hiddenInRow?: true;
  /**
   * Пункта нет в меню карточки СПИСКА на телефоне (М2). Отдельно от строки: кнопок там нет ни у
   * чего, и вычеркнутый пункт означал бы отнятое действие, а не убранный дубль.
   */
  hiddenInCardList?: true;
  /** Пункта нет в меню КАРТОЧКИ — ни в «Действия ▾» на десктопе (М3), ни в шите на телефоне (М4). */
  hiddenInCard?: true;
  /**
   * Другой вход в САМОЙ карточке: кнопка у поля, на вкладке, в подвале.
   *
   * Обязателен у всякого, кто из меню карточки вычеркнут: пустая клетка здесь и означала бы
   * действие, отнятое вместе с пунктом.
   */
  cardEntry?: string;
  /** Другой вход в СПИСКЕ: быстрая кнопка, подпись состояния, метка у номера. */
  listEntry?: string;
  /**
   * Пункт показывается ещё и на теге статуса (ADR 0161). Это ОБЪЯВЛЕННЫЙ второй вход (§4.2), а не
   * пятое место показа: тег берёт проекцию того же набора действий (`serviceStatusChoices`) и
   * своего перебора коридора не держит.
   */
  statusTag?: true;
  /** Почему строка выглядит необычно. Обязательна там, где вход в карточке есть, а пункт остался. */
  note?: string;
}

/**
 * Реестр входов (§4.2 плана). Порядок строк — порядок пунктов в наборе действий: сперва ход заявки
 * по циклу (`serviceRequestMenu.tsx`), затем обстоятельства (`serviceRequestExtras.tsx`), затем
 * распоряжение записью (`RequestsTab.tsx`); отмена стоит последней из ходов — она отнимает работу
 * целиком.
 */
const ENTRIES: Record<string, EntryRow> = {
  assign: {
    label: 'Назначить / Изменить исполнителей',
    hiddenInCard: true,
    cardEntry: 'кнопка у поля «Исполнители» (ADR 0140)',
    /*
     * Вычеркнут ИЗ СТРОКИ и оставлен в карточке списка (Э5): на десктопе рядом стоит своя кнопка
     * (`AssignButton`), а на телефоне кнопок в списке нет вовсе — там шит и есть единственный
     * адрес действия. Прежде входа не было ни там, ни там: подпись «Вам: назначить исполнителей»
     * ведёт в то же окно, но только у ПЕРВОГО назначения (`primary: first`), а переназначение
     * оставалось без быстрого входа — находка Н3 плана.
     */
    hiddenInRow: true,
    listEntry: 'кнопка в столбце действий строки; подпись «Вам: …» — у первого назначения',
  },
  start: {
    label: 'Принять в работу',
    statusTag: true,
    cardEntry: 'кнопка «Принять в работу» в подвале карточки',
    listEntry: 'быстрая кнопка в столбце действий и подпись «Вам: принять в работу»',
    // Единственный ход, у которого вход в карточке есть, а пункт в меню оставлен намеренно: на
    // телефоне подвал узкий, и шит остаётся единственным надёжным адресом главного шага (§4.2).
    note: 'вторая дверь в карточке объявлена планом: подвал на телефоне ненадёжен',
  },
  // Отказ статуса не меняет (Р7): заявка остаётся «Новой», меняется состав исполнителей, — и в
  // списке переходов ему делать нечего.
  decline: { label: 'Отказаться от заявки' },
  estimate: { label: 'Объём работ' },
  approve: {
    label: 'Согласовать объём работ',
    hiddenInCard: true,
    cardEntry: 'кнопка «Согласовать» под таблицей объёма работ',
    // Согласие статуса не двигает — двигает только отказ, и потому на теге виден один `reject`.
  },
  reject: {
    label: 'Не согласовать объём работ',
    hiddenInCard: true,
    cardEntry: 'кнопка «Не согласовано» под таблицей объёма работ',
    // Вторая дуга в «Отменена» (§4.2): решение по объёму работ меняет статус побочно, и список
    // переходов о нём молчать не может.
    statusTag: true,
  },
  reopen: {
    label: 'Вернуть объём в правку',
    hiddenInCard: true,
    cardEntry: 'кнопка «Вернуть в правку» под таблицей объёма работ',
    /*
     * Третье решение того же блока (`DECISION_KEYS` в `ServiceRequestEstimate.tsx`) и вычеркнуто по
     * той же причине, что «Согласовать» и «Не согласовано»: решение по объёму работ принимают там,
     * где объём видно. Расхождение нашёл этот караул — до него из меню карточки уходили только
     * первые два, и у возврата в правку оставалось две двери.
     */
    note: 'две двери в карточке: пункт меню и третья кнопка вкладки — в §4.2 не объявлено',
  },
  complete: { label: 'Закрыть работы', statusTag: true },
  accept: { label: 'Принять работу', statusTag: true },
  rework: { label: 'Вернуть на доработку', statusTag: true },
  'rollback-start': { label: 'Вернуть в «Новую»', statusTag: true },
  'rollback-accept': { label: 'Отменить приёмку', statusTag: true },
  'reopen-request': { label: 'Вернуть в работу', statusTag: true },
  // Меню — основной вход (заказчик назвал «Отложить» и «Отменить» к сохранению), тег — второй:
  // список переходов без остановки и без отмены врал бы о коридоре (Р6).
  hold: { label: 'Отложить', statusTag: true },
  // У возврата цель динамическая (`serviceResumeTarget`), поэтому `toStatus` у пункта нет — на тег
  // он попадает особым случаем проекции, и реестр обязан это помнить.
  resume: { label: 'Возобновить', statusTag: true },
  cancel: { label: 'Отменить заявку', statusTag: true },
  consumables: {
    label: 'Заполнить / Изменить номенклатуру',
    hiddenInCard: true,
    cardEntry: 'кнопка под таблицей на вкладке «Номенклатура»',
  },
  // Склад двигает отметка выдачи, а не статус заявки (Р6): перехода здесь нет.
  'consumables-issued': { label: 'Отметить выдачу / Изменить выданное' },
  urgency: { label: 'Отметить срочной / Снять срочность' },
  chat: {
    label: 'Обсуждение',
    hiddenInCard: true,
    cardEntry: 'кнопка со счётчиком в подвале карточки (ADR 0141)',
    // Метка непрочитанного у номера (`ServiceChatMark`) открывает ту же переписку, не разворачивая
    // меню: «есть ли там новое» человек обязан видеть, не открывая список действий.
    listEntry: 'метка непрочитанного у номера заявки',
  },
  'move-equipment': {
    label: 'Записать перемещение техники',
    /*
     * Единственный пункт, вычеркнутый из ОБОИХ меню: правка мастер-данных справочника, сделанная не
     * открыв заявку, и есть источник расхождений «где записано» и «где стоит» (backlog §12).
     * Своего входа в списке у него нет вовсе, и это намеренно — вход один, и он в карточке.
     */
    hiddenInRow: true,
    hiddenInCardList: true,
    hiddenInCard: true,
    cardEntry: 'кнопка у поля «Какой аппарат» (`onMoveEquipment`)',
  },
  edit: {
    label: 'Редактировать',
    hiddenInCard: true,
    cardEntry: 'кнопка «Редактировать» в подвале карточки',
    /*
     * Пункт дописывает не набор действий, а сама страница (`RequestsTab.tsx`), и в карточке он
     * дублировал главную кнопку подвала. Условия у обоих дословно одни и те же
     * (`isServiceRequestEditable` + `serviceRequests.update`), поэтому вычеркнуть пункт безопасно:
     * кнопка есть везде, где был пункт. Расхождение нашёл этот караул.
     */
    note: 'в карточке правку открывает главная кнопка подвала, пункт вычеркнут',
  },
  delete: { label: 'Удалить' },
};

const REGISTRY_KEYS = Object.keys(ENTRIES);

/** Ключи по признаку реестра — вместо шести одинаковых `filter` по месту вызова. */
const keysWhere = (pick: (row: EntryRow) => boolean): string[] =>
  REGISTRY_KEYS.filter((key) => pick(ENTRIES[key]!));

const sorted = (keys: Iterable<string>): string[] => [...keys].sort();

/* ─── фактический состав: то, что строит рабочий код ─────────────────────────────────────────── */

/** Набор окон, который ничего не открывает: перечень пунктов от их устройства не зависит. */
const MODALS: ServiceRequestModals = {
  assign: () => {},
  estimate: () => {},
  approval: () => {},
  consumables: () => {},
  complete: () => {},
  issue: () => {},
  accept: () => {},
  hold: () => {},
  urgency: () => {},
  chat: () => {},
  moveEquipment: () => {},
  ask: () => {},
  close: () => {},
  pending: false,
  node: null,
};

const RUN = { start: () => {}, approve: () => {}, rollbackStart: () => {} };

function itemsFor(request: ServiceRequestDto, user: AuthUser): ServiceMenuItem[] {
  return serviceRequestMenuItems(request, { user, modals: MODALS, run: RUN });
}

/**
 * Кому показываем. Перебор поставочных профилей плюс фикстуры модуля: `ACCESS_PROFILES` описывает
 * субъекта ролью, типом контрагента и надстройками, а поимённый исполнитель приходит модульным
 * НАБОРОМ без надстройки (`office_equipment_executor`) — его перебор профилей не строит, и половина
 * ходов исполнителя осталась бы непокрытой.
 */
const SUBJECTS: AuthUser[] = [
  ...ACCESS_PROFILES.map((subject) =>
    authUser({
      role: subject.role,
      counterpartyType: subject.counterpartyType ?? null,
      // Тот же контрагент, что у заявок фикстур: без него оператор подрядчика не исполнитель ни на
      // одной строке (Р8 аудита исполнителей), и его пункты не показались бы ни разу.
      counterpartyId: subject.counterpartyType ? SERVICE_COUNTERPARTY.id : null,
      addons: subject.addons ? [...subject.addons] : [],
      grantCodes: subject.addons ? [...subject.addons] : [],
      permissions: [...permissionsFor(subject)],
    }),
  ),
  serviceOperator(),
  serviceExecutor(),
  serviceInHouseExecutor(),
  serviceCustomer(),
  authUser({ role: 'admin' }),
];

/**
 * Составы заявки, на которых набор действий различается: статус после Р1 отвечает не за всё —
 * назначенность держит состав исполнителей, ожидание подписи — `estimatePendingRevision`, а вид
 * заявки открывает пару пунктов номенклатуры.
 */
function requestsIn(status: ServiceRequestStatus): ServiceRequestDto[] {
  const rows = [
    serviceRequest({ status }),
    assignedServiceRequest({ status }),
    // С подшитым актом «Закрыть работы» перестаёт быть выключенным: на состав это не влияет, но
    // именно так заявка и доживает до приёмки.
    assignedServiceRequest({ status, files: [serviceRequestFile('act')] }),
    estimatePendingServiceRequest({ status, service: { ...SERVICE_COUNTERPARTY } }),
    // Расходники: объёма работ у них нет, зато есть состав номенклатуры и отметка выдачи.
    assignedServiceRequest({ status, kind: 'consumable' }),
  ];
  // У отложенной цель возврата берётся из самой заявки, и без исходного статуса пункт возобновления
  // не попал бы в список переходов вовсе.
  if (status === 'on_hold') {
    return [...rows, heldServiceRequest('in_work'), heldServiceRequest('new')];
  }
  return rows;
}

/**
 * Все пункты, какие набор действий выдаёт на синтетических заявках, — по одному представителю на
 * ключ.
 *
 * Способ выбран такой, а не чтением продового перечня, ровно по Р9: перечня в коде нет и заводить
 * его нельзя. Полнота держится на двух опорах сразу — на матрице «профиль × статус × состав» здесь
 * и на разборе исходников ниже: матрица приносит динамические ключи (`hold`/`resume` собираются
 * выражением, а не литералом), разбор — пункт, до ветки которого фикстуры не добрались.
 */
function collectItems(): Map<string, ServiceMenuItem> {
  const found = new Map<string, ServiceMenuItem>();
  for (const user of SUBJECTS) {
    for (const status of SERVICE_REQUEST_STATUSES) {
      for (const request of requestsIn(status)) {
        for (const item of itemsFor(request, user)) {
          if (!found.has(item.key)) found.set(item.key, item);
        }
      }
    }
  }
  return found;
}

const OBSERVED = collectItems();

/** Ключи, встреченные проекцией на тег статуса, — вторым входом §4.2, а не местом показа меню. */
function collectStatusTagKeys(): Set<string> {
  const keys = new Set<string>();
  for (const user of SUBJECTS) {
    for (const status of SERVICE_REQUEST_STATUSES) {
      for (const request of requestsIn(status)) {
        for (const choice of serviceStatusChoices(itemsFor(request, user), request)) {
          keys.add(choice.key);
        }
      }
    }
  }
  return keys;
}

const SERVICE_DIR = join(import.meta.dirname, '../src/pages/service');
const readSource = (file: string): string => readFileSync(join(SERVICE_DIR, file), 'utf8');

/**
 * Ключи, объявленные в исходниках литералом.
 *
 * Три источника — те же, что у набора действий: ход заявки, обстоятельства и распоряжение записью
 * («Редактировать» и «Удалить» дописывает `RequestsTab.tsx` поверх набора, и матрица выше их не
 * увидит вовсе). Динамическую пару `hold`/`resume` разбор не находит — она собирается выражением
 * `key: holdMode`, — и её приносит матрица; поэтому обе опоры и нужны.
 */
function declaredKeys(): Set<string> {
  const keys = new Set<string>();
  for (const file of ['serviceRequestMenu.tsx', 'serviceRequestExtras.tsx', 'RequestsTab.tsx']) {
    for (const match of readSource(file).matchAll(/key: '([a-z-]+)'/g)) keys.add(match[1]!);
  }
  return keys;
}

describe('реестр входов совпадает с наборами скрытия (§7.4)', () => {
  it('в меню строки списка скрыто ровно то, чего реестр там не ждёт', () => {
    expect(sorted(HIDDEN_IN_ROW_MENU)).toEqual(sorted(keysWhere((row) => !!row.hiddenInRow)));
  });

  it('в меню карточки списка — своё, и оно уже: кнопок на телефоне нет', () => {
    expect(sorted(HIDDEN_IN_CARD_LIST_MENU)).toEqual(
      sorted(keysWhere((row) => !!row.hiddenInCardList)),
    );
  });

  it('в меню карточки — то же самое', () => {
    expect(sorted(HIDDEN_IN_CARD_MENU)).toEqual(sorted(keysWhere((row) => !!row.hiddenInCard)));
  });

  it('фильтры места отдают ровно то, что обещает реестр', () => {
    /*
     * Сверяются не константы, а сами фильтры: набор скрытия можно оставить прежним и перестать его
     * применять — меню тогда покажет всё, а сравнение множеств выше об этом промолчит.
     */
    const all: ServiceMenuItem[] = REGISTRY_KEYS.map((key) => ({
      key,
      label: ENTRIES[key]!.label,
      onClick: () => {},
    }));
    expect(rowMenuItems(all).map((item) => item.key)).toEqual(keysWhere((row) => !row.hiddenInRow));
    expect(cardListMenuItems(all).map((item) => item.key)).toEqual(
      keysWhere((row) => !row.hiddenInCardList),
    );
    expect(cardMenuItems(all).map((item) => item.key)).toEqual(
      keysWhere((row) => !row.hiddenInCard),
    );
  });
});

describe('вычеркнутый пункт обязан иметь другой вход (Р3, Р9)', () => {
  it('у каждого скрытого в карточке реестр называет вход в самой карточке', () => {
    for (const key of HIDDEN_IN_CARD_MENU) {
      const row = ENTRIES[key];
      expect(
        row?.cardEntry,
        `«${row?.label ?? key}» вычеркнут из меню карточки, а другого входа В КАРТОЧКЕ реестр не ` +
          'называет: это не снятый дубль, а отнятое действие. Заведите вход и опишите его в ' +
          '`cardEntry`, либо верните пункт в меню (§4.2 плана меню действий).',
      ).toBeTruthy();
    }
  });

  it('названный вход подключён в коде карточки, а не только объявлен словами', () => {
    /*
     * Прозу реестра машина не проверит, но проверит проводку: вынесенная кнопка берёт ГОТОВЫЙ пункт
     * набора по ключу — в самой карточке (`ServiceRequestViewModal`) либо на вкладке объёма работ
     * (`ServiceRequestEstimate`, перечень `DECISION_KEYS`). Ключа нет ни там, ни там — значит, пункт
     * вычеркнули, а кнопку не завели, и `cardEntry` описывает несуществующее.
     */
    const wiring =
      readSource('ServiceRequestViewModal.tsx') + readSource('ServiceRequestEstimate.tsx');
    for (const key of HIDDEN_IN_CARD_MENU) {
      expect(
        wiring.includes(`'${key}'`),
        `вход «${ENTRIES[key]?.cardEntry}» объявлен реестром, но ключа «${key}» нет ни в карточке, ` +
          'ни на вкладке объёма работ: кнопке взять пункт неоткуда',
      ).toBe(true);
    }
  });

  it('вычеркнутый из карточки списка сохраняет вход в карточке заявки', () => {
    /*
     * У карточки списка (телефон) правило строгое: кнопок там нет ни у чего, поэтому вычеркнуть
     * пункт можно, только УВЕЗЯ вход в карточку заявки — так и поступили с перемещением техники.
     * Нельзя другого: увезти в никуда.
     */
    for (const key of HIDDEN_IN_CARD_LIST_MENU) {
      const row = ENTRIES[key];
      expect(
        row?.cardEntry ?? (row && !row.hiddenInCard ? 'меню карточки' : undefined),
        `«${row?.label ?? key}» вычеркнут из карточки списка, и в карточке заявки его тоже нет: ` +
          'у действия не осталось ни одного входа',
      ).toBeTruthy();
    }
  });

  it('вычеркнутый из строки списка сохраняет вход в самой строке либо в карточке', () => {
    /*
     * У строки правило мягче: рядом с меню помещается кнопка, и вход можно оставить ПРЯМО ЗДЕСЬ —
     * так сделано с назначением (Э5). Поэтому годится любое из двух: своя кнопка в строке
     * (`listEntry`) или вход в карточке заявки. Ничего из двух — снова «увезли в никуда».
     */
    for (const key of HIDDEN_IN_ROW_MENU) {
      const row = ENTRIES[key];
      expect(
        row?.listEntry ??
          row?.cardEntry ??
          (row && !row.hiddenInCard ? 'меню карточки' : undefined),
        `«${row?.label ?? key}» вычеркнут из меню строки, а другого входа ему не объявлено: ни ` +
          'кнопки в строке, ни места в карточке заявки',
      ).toBeTruthy();
    }
  });

  it('вторая дверь в том же месте объявлена явно', () => {
    /*
     * Обратная сторона того же правила (§4.2: «всё, чего в таблице нет, имеет ровно один вход в
     * каждом месте»). Вход в карточке при живом пункте меню — это две ручки к одному действию в
     * одном окне; бывает законно (`start` — §4.2), но всегда осознанно. Молча такая пара не
     * заводится: без пояснения строка падает.
     */
    for (const key of keysWhere((row) => !!row.cardEntry && !row.hiddenInCard)) {
      expect(
        ENTRIES[key]!.note,
        `у «${ENTRIES[key]!.label}» в карточке две двери — пункт меню и ${ENTRIES[key]!.cardEntry}. ` +
          'Либо вычеркните пункт (и допишите ключ в `HIDDEN_IN_CARD_MENU`), либо объясните пару в ' +
          '`note`',
      ).toBeTruthy();
    }
  });
});

describe('состав набора действий не разошёлся с реестром (§4.2)', () => {
  it('незнакомых ключей в наборе нет', () => {
    for (const key of [...OBSERVED.keys(), ...declaredKeys()]) {
      expect(
        REGISTRY_KEYS.includes(key),
        `пункт «${key}» появился в наборе действий мимо реестра: добавь в реестр §4.2 плана — ` +
          'назови места показа и вход, который у действия остаётся там, где пункта нет',
      ).toBe(true);
    }
  });

  it('в реестре нет строк, которых в коде уже нет', () => {
    const live = new Set([...OBSERVED.keys(), ...declaredKeys()]);
    for (const key of REGISTRY_KEYS) {
      expect(
        live.has(key),
        `реестр держит «${key}», а набор действий его больше не выдаёт: снимите строку вместе с ` +
          'пунктом — иначе караул сторожит несуществующее',
      ).toBe(true);
    }
  });

  it('на теге статуса показываются ровно объявленные пункты', () => {
    // Тег — объявленный второй вход, а не место показа меню (§2.2), и столбец реестра обязан
    // совпадать с проекцией: забытый `toStatus` тихо убирает ход с тега, лишний — тихо добавляет.
    expect(sorted(collectStatusTagKeys())).toEqual(sorted(keysWhere((row) => !!row.statusTag)));
  });

  it('перебор фикстур действительно доходит до каждого ключа набора', () => {
    /*
     * Караул самого караула: пункт, до которого матрица не добралась, сторожит один лишь разбор
     * исходников — а он не видит ни динамических ключей, ни условий показа. Ожидание закрытое:
     * матрице недоступны ровно «Редактировать» и «Удалить», потому что их дописывает страница
     * (`RequestsTab.tsx`), а не набор действий.
     */
    expect(sorted(REGISTRY_KEYS.filter((key) => !OBSERVED.has(key)))).toEqual(['delete', 'edit']);
  });
});
