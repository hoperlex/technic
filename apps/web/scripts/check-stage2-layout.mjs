#!/usr/bin/env node
/**
 * Раскладка этапа 2: что уже разрезано по сущностям, а что ещё ждёт своей очереди.
 *
 * Скрипт заводится в начале этапа, а не в конце: проверять раскладку нужно после каждого
 * мини-переезда, иначе «ещё не переехало» и «переехало, но забыли убрать» неотличимы. По ходу
 * этапа списки ниже сокращаются — слайс за слайсом.
 *
 * Грепом это не проверить: оставшиеся файлы обязаны импортировать переехавшее, и поиск «@entities
 * в старых каталогах» непуст даже в правильном результате.
 *
 * Запуск: pnpm --filter @technic/web check:stage2-layout
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
// Детекция сырых ключей общая с бюджетами качества: разъехавшись, две проверки начали бы считать
// по-разному, и расхождение вылезло бы там, где на одну из них полагаются.
import { walkTs, hasRawQueryKey, isEntityKeysFile } from './lib/source-scan.mjs';

const SRC = path.resolve(process.cwd(), 'src');

/**
 * Ещё не разрезано: инвентарь файлов `src/api/**` — поимённо и с причиной у каждого.
 *
 * Список явный, как и LEGACY ниже, и сверяется с деревом в обе стороны. Фиксированных двух имён
 * оказалось мало: за девять дней августа реестр ручек разрезали вбок, рядом с ним легли
 * `grants.ts`, `users.ts` и `mailings.ts` — тот же legacy-слой, и проверка не заметила ни одного
 * (docs/frontend-followup-plan.md §3). Читать каталог целиком вместо списка значит вернуть ту же
 * тишину: барьером служит не число файлов, а строка в диффе, которую автор нового файла обязан
 * написать и объяснить (docs/frontend-barriers-stage.md §2.2).
 *
 * Список пустеет по мере этапа; когда опустеет — каталога `src/api` быть не должно.
 */
const PENDING_API = [
  /**
   * Реестр ручек портала. Уедет последним: он реэкспортирует всё уже переехавшее — и в слайсы
   * (`@entities/department`, `@entities/object`), и вбок (учётки, полномочия, рассылки), — а адрес
   * `api/resources` знают десятки экранов, и переписать их все ради разреза реестра значит сделать
   * правку, которую невозможно проверить глазами.
   */
  'api/resources.ts',
  /**
   * Вход, регистрация, подтверждение адреса и смена пароля. Ждёт слайса `session`
   * (docs/frontend-fsd-stage-2.md §2.1), которого ещё нет: эти ручки не только ходят на сервер, но
   * и ведут сессию (`startSession`, `renewToken`, `clear`), и переезжать им вместе с ней.
   */
  'api/auth.ts',
  /**
   * Назначаемые полномочия (ADR 0106) — вынуты из реестра вбок, в тот же legacy-слой, и своего
   * слайса не получили. Домен связан внутри себя жёстче, чем со справочниками: обе ручки
   * предпросмотра и обе боевые держатся одного правила — правка идёт только с отпечатком того
   * расчёта, который показали человеку, — и объяснено оно ровно один раз, в шапке файла.
   */
  'api/grants.ts',
  /**
   * Учётки и журнал действий с ними (ADR 0088, 0109). Дом готов наполовину: слайсы `user-account`
   * и `user-audit` содержат только `keys.ts` — ключи переехали, ручки нет
   * (docs/frontend-barriers-stage.md §3, К4). Вместе с ручками здесь живут тела запросов, которых
   * нет в контрактах, и переезжать им одним куском.
   */
  'api/users.ts',
  /**
   * Почтовый контур (ADR 0075, 0111): расписания рассылок, история запусков и отладочная отправка.
   * Соседний слайс `mail-log` (ADR 0199) забрал не этот домен, а журнал отправки — чтение очереди
   * писем. Половина файла — портальные типы ответов административных ручек, которых нет в
   * контрактах, и живут они там же, где ручки, их отдающие.
   */
  'api/mailings.ts',
];

/**
 * Что остаётся в старых каталогах до своих этапов. Список точный: новый файл здесь — повод решить,
 * куда он относится, а не привычка. Причины — в docs/frontend-fsd-stage-2.md §2.1.
 */
const LEGACY = {
  hooks: [
    'useDepartmentScope.ts',
    'useObjectScope.ts',
    // Удаление насовсем одинаково у справочников и учёток (ADR 0060, 0063), а учётки ведутся в
    // другом разделе: слайсу справочников хук не принадлежит, импорт между соседями запрещён.
    'usePurgeAction.ts',
    // Площадочная ось (ADR 0062, ADR 0201) — бывший `useWasteObjectScope`: её спрашивают вывоз
    // мусора, механизация и заказ ТС, поэтому в слайс одного из них она не уедет; своё место ей
    // искать вместе с общей моделью доступа портала, а не со списком заявок.
    'usePlaceObjectScope.ts',
    'useVehicleClassificationFilter.tsx',
    'useVehicleClassifications.ts',
  ],
  // Адреса записей портала: знают вкладки обоих модулей заявок сразу — переедут, когда переедут оба.
  utils: ['date.ts', 'format.ts', 'links.ts'],
  components: [
    'AppLayout.tsx',
    'AppUpdateBanner.tsx',
    'CancelReasonModal.tsx',
    'CaptchaField.tsx',
    'FileLinks.tsx',
    'MobileAppBar.tsx',
    'MobileNav.tsx',
    'ObjectCell.tsx',
    'PageTabs.tsx',
    'PasswordField.tsx',
    'PersonNameFields.tsx',
    'PhoneField.tsx',
    // Маска телефона — часть поля `PhoneField`, и переедет вместе с ним.
    'PhoneInput.tsx',
    'PortalLogo.tsx',
    'RequestHistory.tsx',
    'ResponsibleFields.tsx',
    // Контакты поддержки открывает не только служебное меню каркаса (оно уже виджет), но и
    // `features/quick-create-equipment`, а импорт из фичи в виджет запрещён матрицей границ:
    // окно ждёт переезда второго потребителя, а не первого.
    'SupportContactsModal.tsx',
    'TimeInput.tsx',
    'UserAvatar.tsx',
    // Загрузка виджета SmartCaptcha и жизненный цикл токена (ADR 0130) — вторая половина
    // `CaptchaField.tsx`, отделённая только потому, что поле рисует, а хук ведёт. Порознь они
    // бессмысленны и переедут одним куском.
    'useCaptcha.ts',
    // Вложения путевого листа: зовут waybillsApi и filesApi — уедут в `waybill` вместе с печатью.
    'WaybillFiles.tsx',
    'WaybillPrint.tsx',
  ],
};

const problems = [];
const notes = [];

// 1. Разрез legacy-API: инвентарь и дерево сверяются в обе стороны.
const apiDir = path.join(SRC, 'api');
const actualApi = existsSync(apiDir)
  ? walkTs(apiDir).map((file) => path.relative(SRC, file).split(path.sep).join('/'))
  : [];
const stillPending = PENDING_API.filter((rel) => actualApi.includes(rel));

for (const rel of actualApi) {
  if (!PENDING_API.includes(rel))
    problems.push(
      `src/${rel} не значится в инвентаре legacy-API: заведите слайс в entities и положите ручки туда либо впишите файл в PENDING_API этого скрипта с причиной`,
    );
}

/*
 * Исчезнувший файл — такое же событие, как новый, и молчать о нём нельзя: пока строка висит в
 * инвентаре, под ней бесплатно заводится файл с тем же именем, а достигнутое не закреплено ничем.
 * Так же устроен ратчет бюджетов (`quality.mjs`): он падает и на росте, и на незаписанном
 * улучшении, потому что записывает улучшение только осознанная правка, видная на ревью.
 */
for (const rel of PENDING_API) {
  if (!actualApi.includes(rel))
    problems.push(
      `src/${rel} есть в инвентаре legacy-API, но не в дереве — ручки уехали в слайс: вычеркните строку из PENDING_API, иначе освободившееся место молча займёт следующий файл`,
    );
}

if (stillPending.length > 0) {
  // Пока перечисленное живо — это норма хода этапа, а не нарушение: заметка, а не ошибка.
  notes.push(`ещё не разрезано: ${stillPending.join(', ')}`);
} else if (existsSync(apiDir)) {
  // Инвентарь пуст — разрез закончен, и каталогу неоткуда взяться. Остаток в нём (файл не на
  // TypeScript, пустой каталог после переезда) означает недоделанный переезд, а не готовый этап.
  problems.push('инвентарь legacy-API пуст, а каталог src/api на месте: уберите каталог');
}

/*
 * 2. Старые каталоги: ровно то, что отложено, — и сверка идёт в обе стороны, как у инвентаря выше.
 *
 * Односторонней проверки здесь уже не хватило: `AddressAutoComplete.tsx` уехал в `entities/address`
 * и пролежал вычеркнутым из дерева, но не из списка, до сверки 22.09.2026. Пока строка висит,
 * освободившееся имя занимается заново без единого сообщения — а именно от этого список и заведён.
 */
for (const [dir, expected] of Object.entries(LEGACY)) {
  const full = path.join(SRC, dir);
  const actual = existsSync(full) ? readdirSync(full).filter((f) => /\.tsx?$/.test(f)) : [];
  for (const file of actual) {
    if (!expected.includes(file)) {
      problems.push(
        `src/${dir}/${file} не значится в списке отложенного: перенесите его в свой слайс либо впишите в скрипт с причиной`,
      );
    }
  }
  for (const file of expected) {
    if (!actual.includes(file)) {
      problems.push(
        `src/${dir}/${file} значится в списке отложенного, но в дереве его нет — файл уехал в слайс: вычеркните строку, иначе его имя молча займут снова`,
      );
    }
  }
}

// 3. Строковые ключи запросов вне сущностей.
const entitiesDir = path.join(SRC, 'entities');
const stringKeyOwners = [];
for (const file of walkTs(SRC)) {
  const rel = path.relative(SRC, file);
  if (isEntityKeysFile(rel)) continue;
  if (hasRawQueryKey(readFileSync(file, 'utf8'))) stringKeyOwners.push(rel);
}
if (stringKeyOwners.length > 0) {
  const done = existsSync(entitiesDir) && stillPending.length === 0;
  const message = `строковые ключи запросов вне entities/*/api/keys (${stringKeyOwners.length} файлов): ${stringKeyOwners.slice(0, 5).join(', ')}${stringKeyOwners.length > 5 ? ' …' : ''}`;
  // Пока разрез не закончен, это ожидаемое состояние — но видеть остаток полезно каждый прогон.
  (done ? problems : notes).push(message);
}

if (problems.length > 0) {
  console.error('Раскладка этапа 2 нарушена:\n' + problems.map((p) => `  — ${p}`).join('\n'));
  process.exit(1);
}

console.log('Раскладка этапа 2 в порядке.');
for (const note of notes) console.log(`  · ${note}`);
