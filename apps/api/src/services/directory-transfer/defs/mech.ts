import { eq } from 'drizzle-orm';
import { MECH_MODEL_CODE, MECH_MODEL_CODE_MAX, mechModelNameKey } from '@technic/contracts';
import { db } from '../../../db/client';
import { mechModels, type MechModelRow } from '../../../db/schema';
import { boolCell, intCell, parseBool, parseInt10, parseRequired } from '../cells';
import { directory, type AnyDirectory, type RowContext } from '../types';

/**
 * Справочник моделей малой механизации в обмене файлом (ADR 0073; план
 * `docs/mechanization-models-directory-plan.md`, этап Э1).
 *
 * Описание устроено как у типов контейнеров — код, наименование, порядок, активность, — и одно
 * отличие в нём существенное: наименование уникально по НОРМАЛИЗОВАННОМУ ключу
 * (`mech_models_name_key_unique`). Проверяется это здесь, до записи, а не ответом базы: 23505
 * приходит без имени строки и отменяет весь файл целиком, а человеку нужно знать, какая из ста с
 * лишним строк совпала с какой.
 *
 * Заказчик прислал сто четыре строки списком, и загрузка файлом — тот же путь, каким приедет
 * следующая сотня: заводить их по одной формой никто не станет.
 */

/** Предел наименования — тот же, что в форме справочника: файл не заводит непроходимое формой. */
const NAME_MAX = 255;

/** Предел длины колонки: в базе его нет — колонка текстовая, а форма длину ограничивает. */
function tooLong(value: string, ctx: RowContext, label: string, max: number): boolean {
  if (value.length <= max) return false;
  ctx.fail(`${label} — не длиннее ${max} знаков, получено ${value.length}`);
  return true;
}

/** Обязательный текст с пределом длины: пустая ячейка заведённое значение не трогает. */
function parseText(
  text: string,
  ctx: RowContext,
  label: string,
  current: string,
  max = NAME_MAX,
): string | undefined {
  const v = parseRequired(text, ctx, label, current);
  if (v === undefined || tooLong(v, ctx, label, max)) return undefined;
  return v;
}

/** Строка справочника моделей глазами человека. `name_key` считает БД — его здесь нет. */
interface MechModelModel {
  code: string;
  name: string;
  sortOrder: number;
  isActive: boolean;
  /** Идентификатор заведённой строки; у дописанных человеком его нет. Нужен только сверке имён. */
  savedId?: string;
}

/**
 * Что нужно знать про справочник, чтобы разобрать строку: чем занято какое наименование.
 *
 * `taken` читается один раз на файл — ключ берётся ГЕНЕРИРУЕМОЙ колонкой, то есть посчитан базой,
 * а не второй копией правила. `seen` наполняется по ходу разбора и ловит вторую беду, о которой
 * база сказать не успеет: две одинаково названные строки внутри самого файла. Без него такой файл
 * прошёл бы предпросмотр и упал на записи — на середине.
 */
interface MechModelEnv {
  taken: Map<string, { id: string; code: string; name: string }>;
  seen: Map<string, { row: number; code: string }>;
}

const mechModelsDirectory = directory<MechModelRow, MechModelModel, MechModelEnv>({
  key: 'mech-models',
  env: async () => {
    const rows = await db
      .select({
        id: mechModels.id,
        code: mechModels.code,
        name: mechModels.name,
        nameKey: mechModels.nameKey,
      })
      .from(mechModels);
    return {
      taken: new Map(rows.map((r) => [r.nameKey ?? '', { id: r.id, code: r.code, name: r.name }])),
      seen: new Map(),
    };
  },
  columns: () => [
    {
      header: 'Код',
      width: 44,
      hint: 'Ключ записи: по нему строка ищется в справочнике. Латиница строчными, цифры, части через дефис (vibroplita-reversivnaya-wacker-dpu-3070n). Человеку код не показывается; переименовать код заведённой строки можно только вместе с заполненной колонкой «Идентификатор».',
      get: (m) => m.code,
      set: (m, text, ctx) => {
        const v = parseText(text, ctx, 'Код', m.code, MECH_MODEL_CODE_MAX);
        if (v === undefined) return;
        // Регистр приводится, потому что формат кода задан CHECK-ом: прописных в базе не бывает,
        // и переименовать этим заведённую строку нельзя.
        const code = v.toLowerCase();
        if (!MECH_MODEL_CODE.test(code)) {
          ctx.fail(`Код — латинские строчные буквы и цифры, части через дефис; получено «${v}»`);
          return;
        }
        m.code = code;
      },
    },
    {
      header: 'Наименование',
      width: 60,
      hint: 'Как модель называется в заявке: «Виброплита реверсивная Wacker DPU 3070Н». Пометки заказчика — «(см)», «(компл)», серийный номер — часть наименования и переносятся как есть. Регистр и лишние пробелы модель не различают: «WACKER DPU 3070Н» — та же модель, а не вторая.',
      get: (m) => m.name,
      set: (m, text, ctx) => {
        const v = parseText(text, ctx, 'Наименование', m.name);
        if (v === undefined) return;
        // Пустой ключ отвергает CHECK `mech_models_name_key_not_blank_check`: наименование из
        // одних пробельных знаков не отличает одну модель от другой.
        if (mechModelNameKey(v) === '') {
          ctx.fail(`Наименование — должно содержать буквы или цифры; получено «${v}»`);
          return;
        }
        m.name = v;
      },
    },
    {
      header: 'Порядок',
      width: 10,
      hint: 'Чем меньше число, тем выше строка в списках портала. Присланный список разложен по алфавиту с шагом 10 — новую модель ставят между соседями.',
      get: (m) => intCell(m.sortOrder),
      set: (m, text, ctx) => {
        const v = parseInt10(text, ctx, 'Порядок', { min: 0 });
        if (v !== undefined) m.sortOrder = v;
      },
    },
    {
      header: 'Активна',
      width: 10,
      hint: '«нет» гасит модель: в новой заявке её уже не выбрать, у заведённых она остаётся. Удалить строку файлом нельзя.',
      get: (m) => boolCell(m.isActive),
      set: (m, text, ctx) => {
        const v = parseBool(text, ctx, 'Активна');
        if (v !== undefined) m.isActive = v;
      },
    },
  ],
  help: () => [
    'Модели малой механизации — что можно взять в аренду: «Виброплита реверсивная Wacker DPU 3070Н», «Компрессор Ganta ac500/050 ofs (см)». На них ссылаются заявки механизации.',
    'Загрузка заводит новые модели и правит заведённые. Удаления нет: лишнюю модель гасят колонкой «Активна» — на неё ссылаются оформленные заявки.',
    'Наименование уникально с точностью до написания: регистр и лишние пробелы модель не различают, и завести вторую «Wacker DPU 3070Н» нельзя ни файлом, ни в портале.',
    'Код заведённой строки правится только строкой из выгрузки — той, где заполнена колонка «Идентификатор». Иначе это не переименование, а вторая запись рядом с брошенной первой.',
  ],
  load: () => db.select().from(mechModels).orderBy(mechModels.sortOrder, mechModels.code),
  id: (row) => row.id,
  // `nameKey` в модель не берётся и в базу не пишется: его считает БД (GENERATED), и второй
  // источник правды у него завёлся бы ровно на одну загрузку.
  model: (row) => ({
    code: row.code,
    name: row.name,
    sortOrder: row.sortOrder,
    isActive: row.isActive,
    savedId: row.id,
  }),
  // Умолчания те же, что у колонок в базе: дописанная человеком строка заводится так же, как
  // заведённая формой.
  blank: () => ({ code: '', name: '', sortOrder: 100, isActive: true }),
  keyOf: (m) => m.code,
  titleOf: (m) => m.name || m.code,
  check: (m, ctx, env) => {
    const key = mechModelNameKey(m.name);
    if (key === '') return; // Об этом уже сказала колонка; повторять незачем.

    const taken = env.taken.get(key);
    if (taken !== undefined && taken.id !== m.savedId) {
      ctx.fail(
        `наименование «${m.name}» уже занято моделью «${taken.name}» (код ${taken.code}) — одна модель заводится один раз`,
      );
      return;
    }

    const twin = env.seen.get(key);
    if (twin !== undefined) {
      ctx.fail(
        `наименование «${m.name}» второй раз в файле: та же модель уже названа строкой ${twin.row} (код ${twin.code})`,
      );
      return;
    }
    env.seen.set(key, { row: ctx.row, code: m.code });
  },
  create: async (tx, m) => {
    await tx.insert(mechModels).values({
      code: m.code,
      name: m.name,
      sortOrder: m.sortOrder,
      isActive: m.isActive,
    });
  },
  update: async (tx, row, m) => {
    await tx
      .update(mechModels)
      .set({
        code: m.code,
        name: m.name,
        sortOrder: m.sortOrder,
        isActive: m.isActive,
        updatedAt: new Date(),
      })
      .where(eq(mechModels.id, row.id));
  },
});

export const mechDirectories: AnyDirectory[] = [mechModelsDirectory];
