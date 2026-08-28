import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Alert, Button, Form, Space, type FormInstance } from 'antd';
import { useQuery } from '@tanstack/react-query';
import {
  activationDefaultsFor,
  expectedCounterpartyType,
  registrationRequestDetail,
  requestRoleTitle,
  roleLabels,
  type Role,
} from '@technic/contracts';
import { departmentRecordsQuery } from '@entities/department';
import { grantFormApi, grantKeys } from '../../api/grants';
import type { UserAccountDto } from '../../api/resources';
import {
  matchReasonLabels,
  NO_SUGGESTION,
  suggestCounterparty,
  suggestSubdivision,
  type AreaSuggestion,
  type MatchRecord,
} from './activationSuggestion';
import {
  approvesRegistration,
  HALF_APPROVAL,
  hasExternalEmail,
  isPendingRegistration,
} from './registrationApproval';
import { requestedDetailText } from './userAccountLabels';
import type { UserFormValues } from './UsersTab';

/**
 * Заполнение формы рассмотрения заявки по пожеланию заявителя (план «пожелание при регистрации
 * называет должность и заполняет форму активации», §3.5–§3.8): автомат инициализации полей,
 * кандидаты подбора под полем и вторая строка баннера — о том, что заполнено.
 *
 * Отдельным файлом от `UsersTab` по тому же доводу, что `userGrantsModel` и `registrationApproval`:
 * это расчёт, а не разметка. «Какой источник приехал, что он предлагает и было ли поле тронуто» —
 * ответы на эти вопросы проверяются значениями, а не кликами по полям, а разложенные по трём
 * обработчикам полей они превратились бы в три похожих куска, расходящихся в первую же правку;
 * однократность подстановки при этом пришлось бы держать в голове у каждого из трёх.
 *
 * Разметки здесь ровно две мелочи — строка кандидатов и баннер, — и живут они с расчётом не по
 * недосмотру: обе целиком описываются тем, что посчитал автомат, и в форме от них остаётся одно
 * имя. Разложенная по трём полям области, строка кандидатов была бы тремя копиями одной строки.
 *
 * Прав здесь не выдаётся и заявок не одобряется: «Активен» не подставляется никогда (§3.5), а
 * подставленное уходит на сервер только вместе с одобрением (§3.6) — тело собирает сама форма.
 * Подстановка — предложение экрана, а не значение заявки.
 */

/** Поля области, которые заполняет подбор: у каждого свой справочник и своя подпись в баннере. */
export type ActivationAreaField = 'constructionObjectIds' | 'departmentIds' | 'counterpartyId';

/** Поля, которых касается подстановка: три поля области плюс роль. */
type FilledField = 'role' | ActivationAreaField;

export interface ActivationControl {
  /**
   * Коды наборов, предложенных пожеланием, — в поле полномочий (§3.6). Пусто у обычной учётки и у
   * заведения новой: подставлять не с чего.
   */
  grantCodes: readonly string[];
  /** Строка кандидатов под полем области; `undefined` — подсказки нет вовсе (§3.7). */
  hint: (field: ActivationAreaField) => ReactNode;
  /** Справка о заявке: что заявитель указал и что по этому заполнено. `null` — пожелания нет. */
  banner: ReactNode;
}

/**
 * Отказ одобрить заявку, пока каталог полномочий не дочитан (§3.6).
 *
 * Барьер стоит именно на одобрении, а не на всей форме: молчание о полномочиях безвредно, пока
 * роль не назначается, — но с подставленной ролью «Сохранить» выдало бы доступ с ролью и **без**
 * предложенных наборов, причём молча. Прочие правки заявки (ФИО, телефон) через него проходят.
 */
const CATALOG_NOT_READY =
  'Список полномочий ещё загружается — дождитесь его: иначе заявка будет одобрена с ролью, но без предложенных наборов';

/**
 * Что не так с полем роли — одним ответом на оба правила рассмотрения заявки.
 *
 * Правил два, и оба про одно решение, поэтому и место у них одно (§3.6): заявку рассматривают
 * целиком (`HALF_APPROVAL` — роль без активации и активация без роли равно недоделаны) и одобряют
 * не раньше, чем дочитан каталог полномочий (`CATALOG_NOT_READY`). Второе появилось вместе с
 * подстановкой: пока каталог не пришёл, поле полномочий молчит в теле запроса, и одобренная в этом
 * окне заявка получила бы роль **без** предложенных наборов, причём молча.
 *
 * Роли без каталога барьера не знают вовсе (`grants.shown === false`): поля полномочий у водителя и
 * у своей учётки нет по построению, и ждать нечего. Прочие правки заявки — ФИО, телефон — проходят
 * при любом состоянии каталога: они полномочий не касаются, а запирать окно ради поля, которого у
 * половины ролей нет, значило бы платить за подстановку теми правками, что делались и раньше.
 *
 * Здесь, а не в `registrationApproval`: там живёт общий с сервером предикат рассмотрения, а это —
 * правило экрана, у которого второй половины на сервере нет.
 */
export function roleIssue(
  record: UserAccountDto | null,
  role: Role | undefined,
  isActive: boolean | undefined,
  grants: { shown: boolean; ready: boolean },
): string | undefined {
  if (approvesRegistration(record, role, isActive) && grants.shown && !grants.ready)
    return CATALOG_NOT_READY;
  if (role) return undefined;
  // У заявки роль ждёт решения, а не заполнения: оставить её в очереди — законный исход.
  if (!record || !isPendingRegistration(record)) return 'Выберите роль';
  return isActive ? HALF_APPROVAL : undefined;
}

/**
 * Роль, под ключом которой лежит каталог, когда подставлять нечего. `driver` годится потому, что
 * поля полномочий у неё не бывает никогда: чужого ответа под этим ключом не окажется.
 */
const NO_CATALOG_ROLE: Role = 'driver';

/**
 * Что уже сделано и для какой заявки (§3.5, правила 1 и 2).
 *
 * Ключ — `record.id`: открыли другую заявку — умолчания первой не протекают во вторую, закрыли и
 * открыли ту же — подстановка считается заново. Признаков три, а не один: источники приезжают
 * врозь — пожелание вместе с окном, справочники когда ответят, — и поздний ответ второго
 * справочника не переписывает уже применённое.
 */
interface Progress {
  key: string | null;
  role: boolean;
  subdivision: boolean;
  counterparty: boolean;
}

/** Что подстановка действительно сделала: этим и только этим говорит вторая строка баннера. */
interface Applied {
  role: Role | null;
  /** Готовыми кусками строки — «объект «С-12 — ЖК Северный» (совпал по названию)». */
  areas: string[];
}

const NOTHING_APPLIED: Applied = { role: null, areas: [] };

interface Params {
  /** Окно открыто: закрытое считается «заявку не рассматривают», и подстановка сбрасывается. */
  open: boolean;
  /** Правимая учётка; заявкой её делает `isPendingRegistration`, а не сам факт правки. */
  record: UserAccountDto | null;
  form: FormInstance<UserFormValues>;
  /** Объекты и контрагенты — те же списки, что форма показывает в своих полях. */
  objects: readonly MatchRecord[] | undefined;
  counterparties: readonly MatchRecord[] | undefined;
}

/** Как запись называется в списке: код и наименование, если код есть, — иначе одно наименование. */
const recordLabel = (record: MatchRecord): string =>
  record.code ? `${record.code} — ${record.name}` : record.name;

/** Кусок баннера о подставленной области: чем совпало — обязательная его часть (§3.7). */
const areaText = (kind: string, record: MatchRecord, reason: keyof typeof matchReasonLabels) =>
  `${kind} «${recordLabel(record)}» (совпал ${matchReasonLabels[reason]})`;

/**
 * Записать умолчание в поле — только в пустое и не тронутое (§3.5, правило 3).
 *
 * «Тронуто» спрашивается у формы (`isFieldTouched`), а не сравнением значений: администратор,
 * вернувший поле к прежнему значению руками, всё равно принял решение, и поздний ответ справочника
 * его не отменяет. Пустота у списка — нулевая длина: «выбрано ничего» и `[]` здесь одно и то же.
 *
 * Отвечает, подставила ли: баннер говорит о произведённом действии, а не о том, что могло бы быть.
 */
function fill(
  form: FormInstance<UserFormValues>,
  name: FilledField,
  value: string | string[],
): boolean {
  if (form.isFieldTouched(name)) return false;
  const current: unknown = form.getFieldValue(name);
  const empty = Array.isArray(current) ? current.length === 0 : !current;
  if (!empty) return false;
  form.setFieldValue(name, value);
  return true;
}

/**
 * Кандидаты под полем — только под пустым: подсказка «похоже на» рядом с уже выбранной записью
 * спорит с самим выбором, а нажатие в ней переписало бы решение администратора молча.
 */
function hintsFor(
  suggestion: AreaSuggestion,
  current: string | string[] | null | undefined,
  choose: (id: string) => void,
): ReactNode {
  const empty = Array.isArray(current) ? current.length === 0 : !current;
  if (!empty || suggestion.kind !== 'candidates') return undefined;
  return (
    <Space size={4} wrap>
      Похоже на:
      {suggestion.records.map((record) => (
        <Button key={record.id} size="small" type="link" onClick={() => choose(record.id)}>
          {recordLabel(record)}
        </Button>
      ))}
    </Space>
  );
}

/**
 * Вторая строка баннера — **в прошедшем времени** (§3.8): она описывает произведённое действие, а
 * не текущее состояние формы, и остаётся правдой после того, как администратор поправит роль.
 * «Подставлено: роль Площадка» при выбранной другой роли стало бы ложью на экране.
 */
function filledText(applied: Applied, grantNames: string[]): string | undefined {
  const parts = [
    applied.role ? `роль «${roleLabels[applied.role]}»` : undefined,
    grantNames.length > 0
      ? `полномочия ${grantNames.map((name) => `«${name}»`).join(', ')}`
      : undefined,
    ...applied.areas,
  ].filter(Boolean);
  if (parts.length === 0) return undefined;
  return `Заполнено по заявке: ${parts.join(', ')}. Проверьте перед сохранением.`;
}

export function useActivationDefaults(params: Params): ActivationControl {
  const { open, record, form, objects, counterparties } = params;
  /*
   * Отделы — исходными полями (`code` и `name` врозь), а не подписями списка: разобрать склеенное
   * «код — имя» обратно нельзя, первое же наименование с тире разделилось бы не по тому тире
   * (§3.7). Второй наблюдатель того же запроса — ключ общий с выпадающим списком формы, лишнего
   * похода на сервер не возникает. Объекты и контрагенты приходят доводом: их форма держит сама.
   */
  const { data: departments } = useQuery(departmentRecordsQuery());

  /** Заявка на рассмотрении — единственное, с чего есть что подставлять (§3.5). */
  const request = open && record && isPendingRegistration(record) ? record : null;
  const defaults = activationDefaultsFor(request?.requestedRole);
  // Объект и отдел — одно поле заявки на два справочника, и различает их только пожелание (§3.4).
  const detail = request?.requestedRole ? registrationRequestDetail[request.requestedRole] : 'none';
  const subdivisionField =
    detail === 'object'
      ? 'constructionObjectIds'
      : detail === 'department'
        ? 'departmentIds'
        : null;
  const subdivisionRecords =
    detail === 'object' ? objects : detail === 'department' ? departments : undefined;
  const expectedType = expectedCounterpartyType(request?.requestedRole);

  const subdivision = useMemo(
    () =>
      subdivisionRecords
        ? suggestSubdivision(request?.requestedObject, subdivisionRecords)
        : NO_SUGGESTION,
    [request?.requestedObject, subdivisionRecords],
  );
  const counterparty = useMemo(
    () =>
      counterparties
        ? suggestCounterparty(request?.requestedCompany, counterparties, expectedType)
        : NO_SUGGESTION,
    [request?.requestedCompany, counterparties, expectedType],
  );

  /*
   * Ход подстановки — ссылкой, а не состоянием: признаки ставятся и читаются внутри одного прохода
   * эффекта, и перерисовка на каждый из них означала бы лишний круг ровно там, где мы правим форму.
   * Итог же — состоянием: о нём рассказывает баннер.
   */
  const done = useRef<Progress>({
    key: null,
    role: false,
    subdivision: false,
    counterparty: false,
  });
  const [applied, setApplied] = useState<Applied>(NOTHING_APPLIED);

  useEffect(() => {
    const key = request?.id ?? null;
    if (done.current.key !== key) {
      done.current = { key, role: false, subdivision: false, counterparty: false };
      setApplied(NOTHING_APPLIED);
    }
    if (!request) return;

    /*
     * Роль: источник — само пожелание, приезжает вместе с окном. Признак ему всё равно нужен —
     * иначе подстановка повторялась бы на каждый ответ любого справочника, возвращая роль,
     * которую администратор к тому времени уже стёр.
     */
    if (!done.current.role) {
      done.current.role = true;
      const role = defaults.role;
      if (role && fill(form, 'role', role)) setApplied((was) => ({ ...was, role }));
    }

    // Объект или отдел: до ответа своего справочника ждём — пустой список не «не совпало».
    if (!done.current.subdivision && subdivisionField && subdivisionRecords) {
      done.current.subdivision = true;
      if (subdivision.kind === 'match' && fill(form, subdivisionField, [subdivision.record.id])) {
        const kind = subdivisionField === 'constructionObjectIds' ? 'объект' : 'отдел';
        const area = areaText(kind, subdivision.record, subdivision.reason);
        setApplied((was) => ({ ...was, areas: [...was.areas, area] }));
      }
    }

    // Контрагент: тот же порядок, но искать его позволено только внутри ожидаемого типа (§3.3).
    if (!done.current.counterparty && counterparties) {
      done.current.counterparty = true;
      if (counterparty.kind === 'match' && fill(form, 'counterpartyId', counterparty.record.id)) {
        const area = areaText('контрагент', counterparty.record, counterparty.reason);
        setApplied((was) => ({ ...was, areas: [...was.areas, area] }));
      }
    }
  }, [
    request,
    form,
    defaults,
    subdivision,
    subdivisionField,
    subdivisionRecords,
    counterparty,
    counterparties,
  ]);

  /*
   * Имена наборов — из каталога, а не из таблицы умолчаний: имя набора правится выкатом, и
   * источник правды остаётся за базой (§3.8). Читается он **вторым наблюдателем** запроса поля
   * полномочий (`enabled: false`): подпись в баннере — не повод идти на сервер, здесь читается то,
   * что уже спросило поле. Ключ — по подставленной роли: строка баннера в прошедшем времени, и
   * смена роли администратором её не переписывает.
   */
  const catalogRole = applied.role ?? NO_CATALOG_ROLE;
  const catalog = useQuery({
    queryKey: grantKeys.formCatalog(catalogRole),
    queryFn: () => grantFormApi.catalog(catalogRole),
    enabled: false,
  });
  const grantNames = (catalog.data?.items ?? [])
    .filter((item) => (defaults.grants as readonly string[]).includes(item.code))
    .map((item) => item.name);

  const objectIds = Form.useWatch('constructionObjectIds', form);
  const departmentIds = Form.useWatch('departmentIds', form);
  const counterpartyId = Form.useWatch('counterpartyId', form);

  /** Подставить кандидата нажатием: портал предлагает, но не выбирает (§3.7). */
  const choose = (field: ActivationAreaField, id: string) =>
    form.setFieldValue(field, field === 'counterpartyId' ? id : [id]);
  const currentValue: Record<ActivationAreaField, string | string[] | null | undefined> = {
    constructionObjectIds: objectIds,
    departmentIds: departmentIds,
    counterpartyId: counterpartyId,
  };

  return {
    grantCodes: defaults.grants,
    hint: (field) =>
      hintsFor(
        field === 'counterpartyId'
          ? counterparty
          : field === subdivisionField
            ? subdivision
            : NO_SUGGESTION,
        currentValue[field],
        (id) => choose(field, id),
      ),
    banner: record?.requestedRole ? (
      /*
       * Одним баннером, двумя строками (§3.8): второй рядом превратил бы верх формы в два абзаца
       * до первого поля. Пожелание печатается `requestRoleTitle`, а не прямым обращением к
       * словарю: в день упразднения пожелания словарь ответил бы `undefined` в строке заявки,
       * которую уже не переписать.
       */
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message={[
          `При регистрации указал: ${requestRoleTitle(record.requestedRole)}`,
          requestedDetailText(record),
          // Тот же признак, что и пометкой в списке (ADR 0090): решение принимается в этом окне,
          // и увиденное в списке к этому моменту уже забыто.
          hasExternalEmail(record) ? 'Адрес внешней почты' : undefined,
        ]
          .filter(Boolean)
          .join(' · ')}
        description={filledText(applied, grantNames)}
      />
    ) : null,
  };
}
