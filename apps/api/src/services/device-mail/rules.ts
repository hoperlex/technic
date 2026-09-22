import {
  COMPONENT_NONE,
  DEVICE_PARSE_RULE_EXPRESSION_MAX,
  metricUnits,
  type ComponentCode,
  type DeviceIdentityHints,
  type DeviceMailContext,
  type DeviceObservationInput,
  type DeviceProfileCode,
  type MetricCode,
  type ParseRuleMatchKind,
  type ParseRuleScope,
  type ParseRuleTarget,
  type ParseValueForm,
} from '@technic/contracts';
import { findLabeledValue, normalizeSpaces, parseNumericValue, parsePercentValue } from './extract';

/**
 * ПРАВИЛА РАЗБОРА ИЗ БАЗЫ — третья дверь к резолву (план
 * `docs/office-equipment-mail-identity-ui-plan.md`, §5.2 и §6.2).
 *
 * ЗАЧЕМ ОНИ ЕСТЬ. Метки, по которым профиль достаёт серийник и счётчик, перечислены в коде
 * (`extract.ts`), и аппарат, подписавший поле иначе, требовал бы правки кода и выката. Правило из
 * базы закрывает новый формат письма без выката — и это единственная причина, по которой оно
 * заведено.
 *
 * ПРАВИЛО ПЕРЕКРЫВАЕТ ПРОФИЛЬ, А НЕ ДОПОЛНЯЕТ ЕГО. Правило пишут под конкретный формат, а словарь
 * профиля общий: при споре старше тот, кто знает больше. Цена решения названа в плане прямо —
 * неверное правило уводит опознание всего формата, — и оплачивается она проверкой на живом письме
 * до сохранения (`preview`) и следом автора у каждой правки.
 *
 * ВЫРАЖЕНИЕ ОТ ЧЕЛОВЕКА — ВРАЖДЕБНЫЙ ВХОД, и барьера здесь два. Первый статический: длина,
 * компиляция, запрет обратных ссылок и квантификатора на группе, которая сама квантифицирована
 * (катастрофический возврат вешает разбор ВСЕЙ очереди, а не одного письма). Второй —
 * ограничение объёма текста, к которому выражение применяется: письмо с вложением на мегабайты
 * не имеет права стать полигоном для перебора.
 */

/** Сколько текста видит одно правило. Больше письма портал и так не читает — см. потолок приёма. */
export const RULE_TEXT_LIMIT = 64 * 1024;

export interface ParseRuleRow {
  id: string;
  target: ParseRuleTarget;
  keyKind: 'serial' | 'inventory' | 'deviceName' | 'host' | null;
  metricCode: MetricCode | null;
  component: ComponentCode | null;
  valueForm: ParseValueForm | null;
  matchKind: ParseRuleMatchKind;
  expression: string;
  scope: ParseRuleScope;
  whenProfile: DeviceProfileCode | null;
  whenFrom: string;
  whenSubject: string;
  whenModel: string;
}

export interface ParseRuleSet {
  rules: ParseRuleRow[];
  /**
   * Снимок `max(updated_at)`: по нему видно, каким набором разобрано письмо. Отбора на
   * перечитывание по этой отметке нет — он не нужен, пока разобранных писем не существует.
   */
  revision: Date | null;
}

/** Пустой набор: правил не завели ни одного — законное и обычное состояние. */
export const EMPTY_RULE_SET: ParseRuleSet = { rules: [], revision: null };

/** Отказ разбора правила словами: текст доезжает до формы, а не до журнала. */
export class DeviceRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeviceRuleError';
  }
}

/**
 * Статический барьер выражения. Он не обещает «безопасно при любом входе» — такого обещания дать
 * нельзя, — но снимает два известных способа повесить разбор: обратные ссылки и квантификатор,
 * навешенный на группу, внутри которой уже стоит квантификатор (`(a+)+`).
 */
export function assertSafeExpression(expression: string): void {
  if (expression.length > DEVICE_PARSE_RULE_EXPRESSION_MAX) {
    throw new DeviceRuleError(
      `выражение длиннее ${DEVICE_PARSE_RULE_EXPRESSION_MAX} знаков — так формат не описывают`,
    );
  }
  if (/\\\d/u.test(expression) || /\\k<[^>]+>/u.test(expression)) {
    throw new DeviceRuleError('обратные ссылки в выражении запрещены: на них разбор виснет');
  }
  if (/\([^()]*[*+}][^()]*\)\s*[*+]/u.test(expression)) {
    throw new DeviceRuleError(
      'повтор навешен на группу, которая сама повторяется, — такое выражение вешает разбор',
    );
  }
}

/** Компиляция с объяснением словами: «неверное выражение» человек правит, а не относит в поддержку. */
export function compileRule(expression: string): RegExp {
  assertSafeExpression(expression);
  try {
    return new RegExp(expression, 'u');
  } catch (e) {
    throw new DeviceRuleError(
      `выражение не читается: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/**
 * Откуда взялась модель, с которой сверяется условие правила.
 *
 * Род назван отдельным типом, потому что человеку его показывают словами: «правило писано для
 * модели X, а у письма модель Y» без указания, откуда взялась Y, не даёт починить ни правило, ни
 * карточку.
 */
export type RuleModelSource = 'equipment' | 'letter' | 'subject' | 'none';

/**
 * Всё, с чем сверяются условия применимости правила.
 *
 * СОБСТВЕННЫМ ТИПОМ, А НЕ ЧЕТЫРЬМЯ АРГУМЕНТАМИ: условий стало четыре, и следующее добавят не
 * сегодня. Пара из контекста письма и кода профиля разъезжалась бы по вызовам молча.
 *
 * МОДЕЛЬ ПРИХОДИТ СНАРУЖИ, А НЕ ЧИТАЕТСЯ ЗДЕСЬ ИЗ БАЗЫ. Этот файл — чистые функции: профиль и
 * правила обязаны проверяться на `.eml` без базы, конфигурации и часов. Модель карточки достаёт
 * тот, у кого база есть (`intake.ts`, ручка предпросмотра), и отдаёт её строкой.
 */
export interface RuleMatchContext {
  ctx: DeviceMailContext;
  profileCode: DeviceProfileCode;
  /** Модель карточки ОПОЗНАННОГО аппарата; пусто — аппарат ещё не опознан. */
  equipmentModel: string;
  /** Модель, которую назвало само письмо (подсказка профиля); пусто — не назвало. */
  letterModel: string;
}

/**
 * Собрать контекст применимости. Отдельной функцией, чтобы приём и предпросмотр собирали его
 * ОДИНАКОВО: предпросмотр, соврамший про применимость, хуже отсутствующего — человек сохранит
 * правило, поверив проверке.
 */
export function ruleMatchContext(
  ctx: DeviceMailContext,
  profileCode: DeviceProfileCode,
  hints: Pick<DeviceIdentityHints, 'model'>,
  equipmentModel: string | null,
): RuleMatchContext {
  return {
    ctx,
    profileCode,
    equipmentModel: (equipmentModel ?? '').trim(),
    letterModel: (hints.model ?? '').trim(),
  };
}

/**
 * Модель, с которой сверяется условие, и её род.
 *
 * КАСКАД, А НЕ ПЕРЕБОР ВСЕХ ИСТОЧНИКОВ: первый доступный решает, и следующие не спрашиваются
 * (решение заказчика 22.09.2026, ADR 0204). Перебирай мы все три, правило «MP C2011» совпало бы у
 * аппарата, опознанного как совсем другая модель, — достаточно строки в теме пересланного письма.
 *
 * Порядок источников — от точного к приблизительному:
 *
 * 1. **модель карточки** опознанного аппарата: она из справочника, её ведёт человек;
 * 2. **модель, названная письмом**: строка прошивки, но сказанная про себя самим аппаратом;
 * 3. **тема письма**: последняя надежда — часть аппаратов носит модель только там.
 */
export function ruleModel(match: RuleMatchContext): { value: string; source: RuleModelSource } {
  if (match.equipmentModel) return { value: match.equipmentModel, source: 'equipment' };
  if (match.letterModel) return { value: match.letterModel, source: 'letter' };
  if (match.ctx.subject.trim()) return { value: match.ctx.subject, source: 'subject' };
  return { value: '', source: 'none' };
}

const MODEL_SOURCE_WORDS: Record<RuleModelSource, string> = {
  equipment: 'из карточки аппарата',
  letter: 'из письма',
  subject: 'из темы письма',
  none: '',
};

/**
 * Сравнение модели.
 *
 * ПРОБЕЛЫ ПРИВОДЯТСЯ К ОДНОМУ ВИДУ, в отличие от отправителя и темы. Причина предметная: модель
 * приезжает из HTML-отчёта прошивки, где разряды и слова разделены неразрывными пробелами, а
 * человек пишет условие обычным. Сравнение «как есть» не совпало бы ни разу, и починить это было
 * бы нечем — невидимый знак на экране неотличим от обычного.
 */
function modelMatches(needle: string, haystack: string): boolean {
  return normalizeSpaces(haystack)
    .toLocaleLowerCase('ru-RU')
    .includes(normalizeSpaces(needle).toLocaleLowerCase('ru-RU'));
}

/**
 * Почему правило не подошло письму — словами, или `null`, если подошло.
 *
 * ПРИЧИНА И ПРИГОДНОСТЬ СЧИТАЮТСЯ ОДНИМ МЕСТОМ. Раздельно они разошлись бы на первом же новом
 * условии: проверка молчит, объяснение обещает другое, и разбирается человек с текстом, который
 * не имеет отношения к правде.
 */
export function ruleMismatch(rule: ParseRuleRow, match: RuleMatchContext): string | null {
  if (rule.whenProfile && rule.whenProfile !== match.profileCode) {
    return `Правило писано для профиля «${rule.whenProfile}», а письмо разобрано профилем «${match.profileCode}»`;
  }
  if (rule.whenFrom && !match.ctx.fromAddress.toLowerCase().includes(rule.whenFrom.toLowerCase())) {
    return `Правило ждёт отправителя со строкой «${rule.whenFrom}», а письмо пришло с «${match.ctx.fromAddress || 'без адреса'}»`;
  }
  if (
    rule.whenSubject &&
    !match.ctx.subject.toLowerCase().includes(rule.whenSubject.toLowerCase())
  ) {
    return `Правило ждёт тему со строкой «${rule.whenSubject}», а тема письма — «${match.ctx.subject || 'без темы'}»`;
  }
  if (rule.whenModel) {
    const model = ruleModel(match);
    if (model.source === 'none') {
      return `Правило писано для модели «${rule.whenModel}», а письмо модель не назвало ничем — ни карточкой, ни текстом, ни темой`;
    }
    if (!modelMatches(rule.whenModel, model.value)) {
      return `Правило писано для модели «${rule.whenModel}», а у письма модель «${model.value}» (${MODEL_SOURCE_WORDS[model.source]})`;
    }
  }
  return null;
}

/** Условия применимости: профиль, отправитель, тема, модель. Пустое условие не спрашивает ничего. */
export function ruleApplies(rule: ParseRuleRow, match: RuleMatchContext): boolean {
  return ruleMismatch(rule, match) === null;
}

/**
 * Нужна ли этому набору правил модель карточки.
 *
 * СПРАШИВАЕТСЯ ДО РАЗБОРА и стоит одной проверки массива: предварительное опознание ради модели —
 * лишний поход в базу на каждое письмо, и платить за него, пока правил с моделью нет ни одного,
 * незачем. Это не оптимизация ради скорости, а отказ менять поведение приёма там, где новое
 * условие никем не задано.
 */
export function ruleSetNeedsModel(set: ParseRuleSet): boolean {
  return set.rules.some((rule) => rule.whenModel !== '');
}

/**
 * Письмо, суженное до области правила.
 *
 * Своей копией контекста, а не своим поиском: сузив контекст, правило-метка пользуется ТЕМ ЖЕ
 * разбором меток и таблиц, что и профили (`findLabeledValue`). Второй поиск меток, написанный
 * здесь, разошёлся бы с профильным на первом же «метка … значение» через цепочку точек.
 */
function scoped(ctx: DeviceMailContext, scope: ParseRuleScope): DeviceMailContext {
  if (scope === 'any') return ctx;
  const empty = { ...ctx, subject: '', text: '', html: '', tables: [], attachments: [] };
  switch (scope) {
    case 'subject':
      return { ...empty, subject: ctx.subject };
    case 'text':
      return { ...empty, text: ctx.text };
    case 'html':
      return { ...empty, html: ctx.html, tables: ctx.tables };
    case 'attachment':
      return { ...empty, attachments: ctx.attachments };
  }
}

/** Плоский текст области — то, к чему применяется выражение. Урезан: объём здесь и есть барьер. */
function flatText(ctx: DeviceMailContext, scope: ParseRuleScope): string {
  const parts: string[] = [];
  if (scope === 'any' || scope === 'subject') parts.push(ctx.subject);
  if (scope === 'any' || scope === 'text') parts.push(ctx.text);
  if (scope === 'any' || scope === 'html') {
    for (const table of ctx.tables) for (const row of table) parts.push(row.join(' '));
  }
  if (scope === 'any' || scope === 'attachment') {
    for (const attachment of ctx.attachments) parts.push(attachment.text);
  }
  return parts.join('\n').slice(0, RULE_TEXT_LIMIT);
}

/**
 * Что правило нашло в письме — дословно, как написано. `null` — не нашло; это законный исход, а не
 * ошибка: правило пишут под один формат, а писем в ящике много.
 *
 * У выражения значением считается именованная группа `value`, затем первая скобочная группа, затем
 * всё совпадение. Три ступени вместо одной потому, что человек пишет выражение так, как привык, а
 * отказ «нет группы value» он прочитает как «правило не работает».
 */
export function findByRule(rule: ParseRuleRow, ctx: DeviceMailContext): string | null {
  if (rule.matchKind === 'label') {
    return findLabeledValue(scoped(ctx, rule.scope), [rule.expression]);
  }
  const re = compileRule(rule.expression);
  const found = re.exec(flatText(ctx, rule.scope));
  if (!found) return null;
  const value = found.groups?.value ?? found[1] ?? found[0];
  const normalized = normalizeSpaces(value ?? '');
  return normalized === '' ? null : normalized;
}

/**
 * Подсказки опознания после правил. Первое совпавшее правило рода выигрывает — порядок задан
 * человеком, и спорить с ним портал не вправе.
 */
export function applyIdentityRules(
  hints: DeviceIdentityHints,
  match: RuleMatchContext,
  set: ParseRuleSet,
): DeviceIdentityHints {
  const out = { ...hints };
  const taken = new Set<string>();
  for (const rule of set.rules) {
    if (rule.target !== 'identity' || !rule.keyKind) continue;
    if (taken.has(rule.keyKind)) continue;
    if (!ruleApplies(rule, match)) continue;
    const value = findByRule(rule, match.ctx);
    if (value === null) continue;
    out[rule.keyKind] = value;
    taken.add(rule.keyKind);
  }
  return out;
}

/** Число по форме правила: обычное или процент. `null` — метка нашлась, а числа в ней нет. */
export function ruleNumber(rule: ParseRuleRow, raw: string): string | null {
  return rule.valueForm === 'percent' ? parsePercentValue(raw) : parseNumericValue(raw);
}

/**
 * Наблюдения после правил. Правило перекрывает наблюдение профиля с той же парой «метрика плюс
 * разрез» и добавляет своё, если такой пары не было.
 *
 * ЕДИНИЦА БЕРЁТСЯ ИЗ РЕЕСТРА МЕТРИК, а не из правила: она свойство метрики, и второй её носитель
 * разошёлся бы с реестром на первой правке — а разошедшаяся единица это молча испорченный ряд.
 */
export function applyMetricRules(
  observations: readonly DeviceObservationInput[],
  match: RuleMatchContext,
  set: ParseRuleSet,
): DeviceObservationInput[] {
  const out = [...observations];
  const indexOf = new Map<string, number>();
  out.forEach((row, index) =>
    indexOf.set(`${row.metricCode}|${row.component ?? COMPONENT_NONE}`, index),
  );

  const taken = new Set<string>();
  for (const rule of set.rules) {
    if (rule.target !== 'metric' || !rule.metricCode) continue;
    const component = (rule.component ?? COMPONENT_NONE) as ComponentCode;
    const key = `${rule.metricCode}|${component}`;
    if (taken.has(key)) continue;
    if (!ruleApplies(rule, match)) continue;
    const raw = findByRule(rule, match.ctx);
    if (raw === null) continue;
    const value = ruleNumber(rule, raw);
    if (value === null) continue;
    taken.add(key);
    const row: DeviceObservationInput = {
      metricCode: rule.metricCode,
      component,
      value,
      unit: metricUnits[rule.metricCode],
      deviceTime: null,
      // Метка правила остаётся в наблюдении: по ней видно, из какой строки письма пришло число, и
      // спор «почему счётчик такой» решается без сырья.
      rawLabel: rule.expression.slice(0, 200),
    };
    const existing = indexOf.get(key);
    if (existing === undefined) {
      indexOf.set(key, out.length);
      out.push(row);
    } else {
      out[existing] = row;
    }
  }
  return out;
}

/**
 * Обе правки снимка разом: подсказки и наблюдения. Один вход — одно место, где правила влияют.
 *
 * УСЛОВИЯ ОБЕИХ ВЕТВЕЙ СЧИТАЮТСЯ ПО ОДНОМУ И ТОМУ ЖЕ СНИМКУ МОДЕЛИ — тому, что собран ДО правил.
 * Иначе правило ключа, дописавшее подсказку, меняло бы применимость правил показаний в том же
 * письме, и порядок строк в таблице правил начинал бы значить больше, чем написано в них самих.
 */
export function applyParseRules<
  T extends { identity: DeviceIdentityHints; observations: DeviceObservationInput[] },
>(parsed: T, match: RuleMatchContext, set: ParseRuleSet): T {
  if (set.rules.length === 0) return parsed;
  return {
    ...parsed,
    identity: applyIdentityRules(parsed.identity, match, set),
    observations: applyMetricRules(parsed.observations, match, set),
  };
}
