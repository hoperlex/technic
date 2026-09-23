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
 * Инвентарь legacy-API — пуст, и это конец работы, а не её отсутствие.
 *
 * Здесь поимённо стояли пять файлов `src/api/**`: реестр ручек, вход, полномочия, учётки и
 * рассылки. Все уехали в слайсы сущностей, каталога `src/api` больше нет, и проверка ниже требует
 * именно этого — появившийся файл роняет её первым же прогоном.
 *
 * Список оставлен пустым, а не снят вместе с проверкой: заводить ручки вне слайса снова никто не
 * собирается, но соблазн «пока положу сюда» возвращается с каждой спешной правкой, и встретить его
 * должна красная проверка, а не память о том, что так делать не принято.
 */
const PENDING_API = [];

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
  // Инвентарь снова непуст — значит кто-то осознанно вписал туда файл: это норма хода работы, а не
  // нарушение, и потому заметка. Сегодня список пуст, и ветка не срабатывает.
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

/*
 * 3. Строковые ключи запросов вне сущностей — ЗАМЕТКА, а не приговор, и вот почему.
 *
 * Сторожит их не этот скрипт, а ратчет бюджетов: `quality.mjs` держит `rawKeyFiles` числом и падает
 * и на росте («ключи новых запросов заводятся в entities/<слайс>/api/keys»), и на незаписанном
 * сокращении. Это тот самый самоподдерживающийся сторож, который доводит волну до нуля по частям и
 * закрепляет каждую; здесь повторять его нечем — вторая копия того же факта разошлась бы с первой
 * молча, и правило одного места запрещает её заводить.
 *
 * Прежде условие стояло иначе: сырые ключи становились ошибкой, как только пустел инвентарь
 * legacy-API выше. Связь была случайной — разрез ручек и сведение ключей разные работы, вторая
 * меняет ячейки кэша, — и снос последнего legacy-файла разом объявил бы нарушением 45 экранов,
 * которых та работа не касалась. Заменять её флагом «волна пройдена» тоже нельзя: константу,
 * которую переворачивают руками, никто не перевернёт, и достигнутое не закрепится.
 *
 * Поэтому здесь остаётся счёт остатка в каждый прогон — чтобы о нём помнили, — а красным его делает
 * бюджет.
 */
const entitiesDir = path.join(SRC, 'entities');
const stringKeyOwners = [];
for (const file of walkTs(SRC)) {
  const rel = path.relative(SRC, file);
  if (isEntityKeysFile(rel)) continue;
  if (hasRawQueryKey(readFileSync(file, 'utf8'))) stringKeyOwners.push(rel);
}
if (stringKeyOwners.length > 0 && existsSync(entitiesDir)) {
  notes.push(
    `строковые ключи запросов вне entities/*/api/keys (${stringKeyOwners.length} файлов): ${stringKeyOwners.slice(0, 5).join(', ')}${stringKeyOwners.length > 5 ? ' …' : ''} — роняет их ратчет rawKeyFiles в quality.mjs`,
  );
}

if (problems.length > 0) {
  console.error('Раскладка этапа 2 нарушена:\n' + problems.map((p) => `  — ${p}`).join('\n'));
  process.exit(1);
}

console.log('Раскладка этапа 2 в порядке.');
for (const note of notes) console.log(`  · ${note}`);
