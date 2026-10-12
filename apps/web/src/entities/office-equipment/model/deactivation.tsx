import { App, Typography } from 'antd';
import { officeEquipmentTitle, type OfficeEquipmentDto } from '@technic/contracts';

/**
 * ПРЕДУПРЕЖДЕНИЕ ПЕРЕД ВЫКЛЮЧЕНИЕМ КАРТОЧКИ ОРГТЕХНИКИ (план
 * `docs/office-equipment-candidate-plan.md`, §13 Ф4; решено владельцем продукта 04.09.2026).
 *
 * Откуда взялась надобность. Удаление карточки сервер не даёт, пока по технике есть незакрытая
 * заявка (`assertNoOpenServiceRequest` у `DELETE /office-equipment/:id`), а снятая галочка
 * «Активна» не проверяла ничего. Раньше это почти ничего и не значило, но фикс Ф2 научил
 * `resolveRequestSubject` отбивать 422 заведение НОВОЙ заявки на выведенную из эксплуатации
 * карточку — и с этого дня оператор, сняв галочку, закрывает вход новым заявкам по аппарату, сам
 * того не замечая. Дверь захлопывается молча, а обнаруживает это третий человек — заявитель, — и
 * не здесь, а в форме заявки, отказом про чужое решение.
 *
 * **ПРЕДУПРЕЖДЕНИЕ, А НЕ ОТКАЗ — И ЭТО НЕ НЕДОДЕЛКА.** Соблазн «довести до конца» и запретить
 * выключение по аналогии с удалением здесь прямо вреден: карточку гасят ровно тогда, когда аппарат
 * уехал в ремонт или списан, то есть В ТОТ САМЫЙ МОМЕНТ, когда живая заявка по нему и существует.
 * Запрет означал бы «пока техника чинится, вывести её из эксплуатации нельзя», и оператор выбирал
 * бы из двух зол: оставить карточку включённой (тогда на сломанный аппарат заведут вторую заявку)
 * или закрыть чужую заявку ради галочки. Удаление отбивается насовсем потому, что отнимает у
 * заявки предмет; выключение не отнимает ничего — заведённые заявки идут своим чередом,
 * дорабатываются и принимаются как раньше (границу закрепил сам Ф2: активность спрашивается только
 * у входа, правку и ход цикла она не трогает). Терять здесь нечего, знать — есть что, поэтому окно
 * называет последствие словами и пропускает.
 *
 * The open request numbers come from `openServiceRequestNumbers` of `GET /office-equipment/:id`
 * (ADR 0169, E5b), which the edit window fetches anyway. The server computes the list exactly, with
 * no limit, in the request scope, and decides "open" by the contract predicate. The portal neither
 * filters statuses nor reads the card section or the `serviceHistory` slice for it: the slice was
 * cut at ten rows and the section at five, so a number beyond them was silently missing from the
 * warning, and E6 removes `serviceHistory` from the answer altogether.
 *
 * **WHY THE TEXT FALLS BACK TO A GENERAL PHRASE.** The field is absent when the viewer has no
 * `serviceRequests.read`, a deliberate server answer: an empty list would mean "no requests". And
 * exactly such people keep the directory: the operator who maintains objects and counterparties
 * also maintains equipment cards and does no repairs. There are no numbers to show them, but the
 * consequence does not go away, and silence would be the worst outcome: they would simply not
 * know. So the branch without numbers says the same thing conditionally, "if there are any". Nor
 * may they be refused the deactivation for not knowing: that would punish them for a permission
 * someone else has. The field is also absent from a server older than E5b (a deploy window or a
 * rollback), and the same phrase covers it.
 *
 * The same general phrase answers "the permission is there, but no open request is visible", ON
 * PURPOSE in one branch. The portal may not say "there are no open requests": the list is narrowed
 * by the request scope (department roles have their own), so "not visible" is not "none". The named
 * numbers are a lower bound of the fact, and the phrase promises exactly that: these are open. No
 * branch promises completeness.
 */
export interface OfficeEquipmentDeactivationWarning {
  title: string;
  /** Абзацы окна по порядку: сперва про уже заведённые заявки, следом — про новые. */
  lines: string[];
}

/**
 * Текст предупреждения по карточке и тому, что известно про её заявки.
 *
 * Готовой фразой, а не набором признаков (`{ openNumbers, canRead }`): решение «что именно сказать»
 * принимается один раз и здесь. Отдай мы признаки наружу, второе место выключения карточки —
 * окно проверки кандидата (Р12) — сложило бы из них свою редакцию, и две разошлись бы на первой же
 * правке формулировки.
 */
export function officeEquipmentDeactivationWarning(
  record: Pick<OfficeEquipmentDto, 'name' | 'serialNumber' | 'inventoryNumber'>,
  card?: Pick<OfficeEquipmentDto, 'openServiceRequestNumbers'>,
): OfficeEquipmentDeactivationWarning {
  const open = card?.openServiceRequestNumbers ?? [];

  return {
    title: `Выключить карточку «${officeEquipmentTitle(record)}»?`,
    lines: [
      open.length > 0
        ? `Незакрытые заявки на обслуживание: ${open.join(', ')}. Они продолжатся как обычно — выключенная карточка их не останавливает.`
        : 'Незакрытые заявки на обслуживание, если они есть, продолжатся как обычно — выключенная карточка их не останавливает.',
      'А вот новую заявку на этот аппарат завести будет нельзя, пока карточка выключена: сервер её не примет. Вернуть аппарат в работу — той же галочкой «Активна».',
    ],
  };
}

/** Что отправляет форма карточки: состояние «до», уже полученная карточка и новая галочка. */
export interface OfficeEquipmentDeactivationIntent {
  /** Карточка до правки; `null` — заведение новой единицы. */
  record: OfficeEquipmentDto | null;
  /** Ответ `GET /office-equipment/:id` той же единицы, если он уже приехал. */
  card?: Pick<OfficeEquipmentDto, 'openServiceRequestNumbers'>;
  /** Значение «Активна» в отправляемой форме. */
  next: boolean;
}

/**
 * Сохранение карточки с разбором одной развилки — снятой галочки «Активна».
 *
 * Хуком, а не голосом самой вкладки: подтверждение спрашивают через `App.useApp()`, то есть только
 * из React, — а форма карточки живёт в двух местах (справочник и быстрое заведение из заявки), и
 * третьим станет окно проверки кандидата. Развилка одна на всех, и разъехаться ей нельзя.
 *
 * Ловится ПЕРЕХОД `true → false`, а не состояние: правка уже выключенной карточки (сменили кабинет
 * списанному принтеру) ничего не меняет, и окно на каждое сохранение быстро превратилось бы в то,
 * что прокликивают не читая. Заведение сюда не заходит вовсе (`record === null`) — у новой карточки
 * заявок быть не может, а выключенной её заводят намеренно.
 */
export function useOfficeEquipmentDeactivationConfirm(): (
  intent: OfficeEquipmentDeactivationIntent,
  save: () => Promise<unknown>,
) => void {
  const { modal } = App.useApp();

  return ({ record, card, next }, save) => {
    if (!record?.isActive || next) {
      // Отказ гасится здесь: про ошибку сохранения человеку рассказывает `onError` самой мутации,
      // а неперехваченный `mutateAsync` уходил бы необработанным отказом промиса в консоль.
      void save().catch(() => undefined);
      return;
    }
    const warning = officeEquipmentDeactivationWarning(record, card);
    modal.confirm({
      title: warning.title,
      content: warning.lines.map((line) => (
        <Typography.Paragraph key={line} style={{ marginBottom: 8 }}>
          {line}
        </Typography.Paragraph>
      )),
      // Кнопка не красная, в отличие от удаления карточки и деактивации моделей: красным в портале
      // помечено то, что отнимает (`FormModal.okDanger` — «необратимо»), а здесь не отнимается
      // ничего — заявки живут, галочка возвращается тем же движением. Красная кнопка сказала бы
      // «сейчас что-то сломается», и оператор перестал бы выключать карточки вовсе.
      okText: 'Выключить и сохранить',
      cancelText: 'Отмена',
      onOk: save,
    });
  };
}
