import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Alert, App, Button, Checkbox, Form, Space, Spin, Tooltip, Typography } from 'antd';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  GRANT_CONFLICT_CODES,
  type CounterpartyType,
  type GrantDto,
  type GrantStatement,
  type Role,
  type UserAccountDto,
  type UserGrantRefDto,
} from '@technic/contracts';
import { isApiError } from '@shared/api';
import { grantFormApi, grantKeys } from '../../api/grants';
import { apiViolationTexts, GRANT_ROLES, permissionLabel } from './grantModel';
import {
  applyGrantToggle,
  buildGrantStatements,
  grantAddedPermissions,
  grantCompositionText,
  hydrateGrantSelection,
  lockedGrantIds,
  NO_GRANT_EDITS,
  outOfRangeGrants,
  outOfRangeHintText,
  roleGateNoticeText,
} from './userGrantsModel';

/**
 * Поле «Полномочия» окна учётки (план «полномочия назначаются в окне учётки», Р1): наборы прав,
 * которые администратор выдаёт вместе с ролью, областью и активацией — одной операцией.
 *
 * Заменяет поле «Надстройки», а не встаёт рядом с ним: две системные надстройки — это те же наборы
 * (`SYSTEM_GRANT_CODES`), и показанные дважды они были бы двумя выключателями одного доступа.
 *
 * Поля нет вовсе в трёх случаях, и каждый — решение, а не умолчание: роль не выбрана (полномочия
 * выдаются поверх должности), роль `driver` (барьер 2 ADR 0106) и своя учётка (инвариант 6, Р9).
 * Недоступное портал не показывает даже выключенным (ADR 0033 §6).
 *
 * Расчётная часть — в `userGrantsModel`: гидратацию и сборку тела проверяют юнит-тестами по
 * значениям, а не кликами по разметке.
 */

/** Что читает поле и куда отдаёт результат. */
interface Params {
  /** Окно открыто. Закрытие сбрасывает ручные отметки (Р4) и показанный отказ. */
  open: boolean;
  /** Правится своя учётка: поля нет (Р9). */
  isSelf: boolean;
  /** Роль, выбранная в форме **прямо сейчас**: список задаёт она, а не роль в базе (Р2). */
  role: Role | null;
  /** Тип контрагента из формы — вторая половина субъекта строки «Добавится» (§6). */
  counterpartyType: CounterpartyType | null;
  /** Правимая учётка: её назначения и роль «до». У новой их нет. */
  record: UserAccountDto | null;
  /**
   * Коды наборов, предложенных пожеланием заявителя (план «пожелание при регистрации заполняет
   * форму активации», §3.6). Пусто или не передано — подстановки нет: так открывается обычная
   * учётка и заведение новой.
   *
   * Третьим множеством гидратации, а не присваиванием в поле, и это другая механика, чем автомат
   * инициализации формы (§3.5): роль и область он подставляет **однажды**, а наборы
   * пересчитываются на каждой смене роли. Разница видна на одном сценарии — сменил роль и вернул
   * обратно: галочки наборов вернутся (пожелание никуда не делось), а снятая руками не вернётся
   * (`unchecked` живёт, пока открыто окно).
   */
  suggestedCodes?: readonly string[];
  /** Перечитать данные учётки: зовётся, когда сохранение упёрлось в устаревший экран. */
  onReload: () => void;
}

export interface UserGrantsControl {
  /** Поле показывается: роль выбрана, она не `driver`, учётка не своя. */
  shown: boolean;
  /**
   * Каталог дочитан до конца — то есть о полномочиях есть что сказать. Форме он нужен барьером
   * одобрения заявки (§3.6), и `blocked` его не заменяет: тот считается по ошибке и `complete ===
   * false`, а **первоначальная загрузка** (`data === undefined`) в него не входит вовсе. В этом
   * окне `statements()` молча возвращает `undefined` — поле полномочий не уходит в тело.
   *
   * Пока роль не подставлялась, молчание было безвредно: администратор ничего не отметил, ничего и
   * не сохранилось. С подставленной ролью — вредно: можно включить «Активен» и сохранить, получив
   * учётку с ролью и **без** предложенных наборов, причём молча. Поэтому признак отдаётся честным
   * (`complete === true`), а запрет одобрять недочитанное ставит валидатор поля роли — тот же, что
   * держит «заявку рассматривают целиком».
   */
  ready: boolean;
  /**
   * Каталог отдан неполным или не отдан вовсе — ошибкой; ожидание первого ответа сюда не входит,
   * его показывает `ready`. Блокирует **и поле роли**: молчание о полномочиях законно лишь пока
   * роль не переключает их действие (§4.2), и форма не должна доводить до отказа, причину которого
   * создала сама.
   */
  blocked: boolean;
  /** Высказывание для тела запроса; `undefined` — не отправлять поле вовсе (§4.1). */
  statements: () => GrantStatement[] | undefined;
  /** Разложить отказ сервера по полю. `true` — отказ показан, общей ошибки не нужно (Р8). */
  handleError: (error: unknown) => boolean;
  /** Сама разметка поля; `null`, когда поля нет. */
  field: ReactNode;
}

/**
 * Роль, под ключом которой лежит каталог выключенного запроса. `driver` годится ровно потому, что
 * поля у неё не бывает никогда: запрос под этим ключом не выполняется, и подобрать по нему чужой
 * ответ нельзя.
 */
const NO_CATALOG_ROLE: Role = 'driver';

export function useUserGrantsField(params: Params): UserGrantsControl {
  const { open, isSelf, role, counterpartyType, record, suggestedCodes, onReload } = params;
  const { message } = App.useApp();
  const qc = useQueryClient();

  const shown = !!role && !isSelf && GRANT_ROLES.includes(role);
  /*
   * Назначения приходят карточкой учётки — все, включая несовместимые с её нынешней ролью: из них
   * гидратируются галочки, ими же берётся версия набора, которого нет в отфильтрованном каталоге
   * (Р7). Подстраховка `?? []` — на ответ портала, отданный сервером до выката поля.
   */
  const assigned: UserGrantRefDto[] = useMemo(() => record?.grants ?? [], [record]);
  const roleBefore = record?.role ?? null;

  const catalogQuery = useQuery({
    queryKey: grantKeys.formCatalog(role ?? NO_CATALOG_ROLE),
    queryFn: () => grantFormApi.catalog(role ?? NO_CATALOG_ROLE),
    enabled: open && shown,
    /*
     * Каталог перечитывается при каждом открытии окна: его версии уходят в тело (Р7), и показанный
     * из кэша прошлогодний состав обернулся бы 409 на сохранении — там, где человек ничего не менял.
     */
    staleTime: 0,
  });
  const catalog: GrantDto[] = useMemo(() => catalogQuery.data?.items ?? [], [catalogQuery.data]);
  /** Список дочитан до конца — только тогда о полномочиях можно высказываться (§6, §3.6). */
  const ready = shown && catalogQuery.data?.complete === true;
  const blocked = shown && (catalogQuery.isError || catalogQuery.data?.complete === false);

  const [edits, setEdits] = useState(NO_GRANT_EDITS);
  const [errors, setErrors] = useState<string[]>([]);
  /** Ушло ли поле в последнем запросе: отказ по молчанию подсвечивать нечем (Р8). */
  const sent = useRef(false);
  /** Роль, о последствиях которой уже сказали: сообщение не повторяется на каждый рендер. */
  const noticed = useRef<Role | null>(null);

  useEffect(() => {
    if (open) return;
    // Закрытие окна сбрасывает решение целиком: ручные отметки живут, пока открыто окно (Р4).
    setEdits(NO_GRANT_EDITS);
    setErrors([]);
    noticed.current = null;
  }, [open]);

  const value = useMemo(
    () => hydrateGrantSelection({ assigned, catalog, edits, suggestedCodes }),
    [assigned, catalog, edits, suggestedCodes],
  );
  const outOfRange = useMemo(() => outOfRangeGrants(assigned, catalog), [assigned, catalog]);

  /*
   * Смена роли: сказать надо о последствии, а не о снятии (Р4). Момент выбран не «когда кликнули по
   * роли», а «когда пришёл каталог новой роли»: до него неизвестно, что именно перестанет
   * действовать, — совместимость считает сервер, а не экран.
   */
  useEffect(() => {
    if (!ready || !role) return;
    if (role === roleBefore) {
      noticed.current = role;
      return;
    }
    if (noticed.current === role) return;
    noticed.current = role;
    const text = roleGateNoticeText(
      role,
      outOfRange.filter((g) => !g.roleMismatch),
    );
    if (text) message.info(text);
  }, [ready, role, roleBefore, outOfRange, message]);

  const statements = (): GrantStatement[] | undefined => {
    // Поля нет или список неполон — `grants` в тело не уходит вовсе: правка сохранит всё
    // остальное, назначений не касаясь (§6).
    if (!shown || !ready) {
      sent.current = false;
      return undefined;
    }
    sent.current = true;
    return buildGrantStatements({
      assigned,
      catalog,
      selected: value,
      roleBefore,
      roleAfter: role,
    });
  };

  const handleError = (error: unknown): boolean => {
    if (!isApiError(error)) return false;
    if (error.status === 409 && error.code === GRANT_CONFLICT_CODES.impactChanged) {
      // Состав набора изменили между открытием карточки и сохранением (Р7): подписывали не то, что
      // применилось бы. Исход у этого один — перечитать и открыть заново.
      message.error(`${error.message} — состав полномочия изменили, откройте карточку заново`);
      void qc.invalidateQueries({ queryKey: grantKeys.root });
      onReload();
      return true;
    }
    /*
     * 400 раскладывается на поле, но только если поле в запросе было (Р8): отказ по молчанию —
     * смена роли, переключающая действие назначений, — виноват не галочкой, а устаревшим экраном, и
     * подсвечивать в нём нечего.
     */
    if (error.status !== 400 || !sent.current) return false;
    const texts = [
      ...(error.fields?.grants ? [error.fields.grants] : []),
      ...apiViolationTexts(error),
    ];
    if (texts.length === 0) return false;
    setErrors(texts);
    return true;
  };

  return {
    shown,
    ready,
    blocked,
    statements,
    handleError,
    field: shown ? (
      <GrantsField
        catalog={catalog}
        assigned={assigned}
        value={value}
        onChange={(next) => {
          setEdits(applyGrantToggle(edits, value, next));
          setErrors([]);
        }}
        loading={catalogQuery.isPending}
        blocked={blocked}
        onRetry={() => void catalogQuery.refetch()}
        errors={errors}
        outOfRangeHint={outOfRangeHintText(outOfRange)}
        added={grantAddedPermissions({ role, counterpartyType, catalog, selected: value })
          .map(permissionLabel)
          .join(', ')}
      />
    ) : null,
  };
}

interface FieldProps {
  catalog: GrantDto[];
  assigned: UserGrantRefDto[];
  value: string[];
  onChange: (next: string[]) => void;
  loading: boolean;
  blocked: boolean;
  onRetry: () => void;
  errors: string[];
  outOfRangeHint: string | null;
  /** Права сверх должности, уже подписями каталога: пусто — набор ничего не добавляет. */
  added: string;
}

/** Наборы совместимой роли чекбоксами: подпись — имя, подсказка — состав (§6). */
function GrantsField({
  catalog,
  assigned,
  value,
  onChange,
  loading,
  blocked,
  onRetry,
  errors,
  outOfRangeHint,
  added,
}: FieldProps) {
  const locked = lockedGrantIds(assigned);

  return (
    <Form.Item
      label="Полномочия"
      tooltip="Наборы прав поверх должности (ADR 0106). Область учётки они не меняют — кроме наборов со сквозной областью, о ней сказано в подсказке набора"
      validateStatus={errors.length > 0 ? 'error' : undefined}
      help={
        errors.length > 0 ? (
          <Space orientation="vertical" size={0}>
            {errors.map((text) => (
              <span key={text}>{text}</span>
            ))}
          </Space>
        ) : undefined
      }
      extra={
        blocked ? undefined : (
          <Space orientation="vertical" size={0}>
            {/* Что полномочия дают сверх должности — двумя субъектами, а не вычитанием из прав
                записи: у заявки их нет вовсе, а при смене роли они описывают прежнего человека. */}
            {value.length > 0 ? (
              <span>
                {added
                  ? `Добавится сверх должности: ${added}`
                  : 'Сверх должности ничего не добавится: эти права уже даёт роль'}
              </span>
            ) : null}
            {/* Назначения вне диапазона роли: они живы, но прав по ним нет (§13.1). */}
            {outOfRangeHint ? <span>{outOfRangeHint}</span> : null}
          </Space>
        )
      }
    >
      {blocked ? (
        <Alert
          type="warning"
          showIcon
          title="Список полномочий загрузился не полностью"
          description={
            <Space orientation="vertical" size={4}>
              <span>
                Пока он неполон, полномочия и роль не правятся: сохранение оставит назначения
                нетронутыми. Снять и выдать наборы можно во вкладке «Права».
              </span>
              <Button size="small" onClick={onRetry}>
                Загрузить заново
              </Button>
            </Space>
          }
        />
      ) : loading ? (
        <Spin size="small" />
      ) : catalog.length === 0 ? (
        <Typography.Text type="secondary">
          Наборов, совместимых с этой ролью, нет — выдавать нечего.
        </Typography.Text>
      ) : (
        <Checkbox.Group<string> value={value} onChange={onChange}>
          <Space orientation="vertical" size={0}>
            {catalog.map((grant) => (
              <Checkbox key={grant.id} value={grant.id} disabled={locked.has(grant.id)}>
                <Tooltip title={grantCompositionText(grant)}>
                  <span>{grant.name}</span>
                </Tooltip>
                {/* Взведённое переводом ролей (ADR 0113) не снимается здесь вовсе: часть
                    подготовленного перевода снимают в реестре выдач, где видно, что снимается (Р4). */}
                {locked.has(grant.id) ? (
                  <Typography.Text type="secondary">
                    {' '}
                    · взведено переводом ролей — снять можно в реестре выдач
                  </Typography.Text>
                ) : null}
              </Checkbox>
            ))}
          </Space>
        </Checkbox.Group>
      )}
    </Form.Item>
  );
}
