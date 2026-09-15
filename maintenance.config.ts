/**
 * Проводка системы обслуживания кодовой базы под этот репозиторий.
 *
 * Это единственное место, где переносимое ядро связывается с конкретным проектом: здесь названы
 * поставщик доменов, команды проверки поведения и область работы. Числа — бюджеты, пороги
 * уверенности, условия остановки — лежат не здесь, а в `architecture/policies/maintenance.yaml`:
 * их правят осознанно и редко, и правка обязана быть видна на ревью одной строкой.
 *
 * Постановка и этапы: docs/maintenance-framework-plan.md.
 */
import { defineMaintenanceConfig } from './tools/maintenance/index.ts';
import { codeMapDomains } from './tools/maintenance/project/code-map.ts';

export default defineMaintenanceConfig({
  // Домены берутся разбором карты кода. Второй список тех же областей здесь не заводится: он
  // разошёлся бы с картой в первую же неделю, а `pnpm check:docs` о расхождении не узнал бы.
  domains: codeMapDomains({ file: 'docs/code-map.md' }),

  /*
   * Проверка поведения — существующие ворота качества, а не свои.
   *
   * `pnpm check` — типы, линт и все тесты, кроме db-набора (ADR 0147). Этого хватает как быстрого
   * доказательства: типы ловят половину, тесты портала и сервера — остальное.
   *
   * `pnpm check:db` выключен по умолчанию НЕ из экономии времени. Ему нужна своя свежая база; на
   * общей он даёт ложные падения — а ложное падение хуже пропущенного: оно откатывает верную
   * правку и учит человека не доверять проверке. Включается явно для работ, трогающих сервер и
   * схему.
   */
  verification: [
    {
      id: 'gates',
      title: 'ворота качества',
      command: ['pnpm', 'check'],
      enabledByDefault: true,
      why: 'типы, линт и все тесты, кроме db-набора; сюда же входит целостность документации',
    },
    {
      id: 'database',
      title: 'db-набор',
      command: ['pnpm', 'check:db'],
      enabledByDefault: false,
      why: 'нужна своя свежая база: на общей набор даёт ложные падения',
    },
  ],

  /*
   * Чем добываются факты.
   *
   * Линт зовётся профилем `release`: повседневный профиль ловит ошибки, а обслуживанию нужны ещё и
   * кандидаты — длина, сложность, отложенное. Числа оттуда идут в факты как СИГНАЛ и целью правки
   * не становятся.
   *
   * Алиасы перечислены с областью действия: `@shared/*` — язык портала, и в сервере такой импорт
   * разрешался бы в чужой файл, показывая связь, которой нет. Держать их копией больно, но
   * альтернатива — учить ядро читать tsconfig портала, то есть знать про портал.
   */
  analysis: {
    lintCommand: [
      'pnpm',
      'exec',
      'eslint',
      '.',
      '-c',
      'eslint/release.config.mjs',
      '--format',
      'json',
      '--output-file',
      '{out}',
    ],
    typecheckCommand: ['pnpm', '-r', 'typecheck'],
    sourceExtensions: ['.ts', '.tsx', '.mjs'],
    // Один шаг соседства и потолок в 60 файлов: замер этого дерева — 1763 файла и 8997 связей,
    // на двух шагах область вырастает до сотен файлов и перестаёт быть областью.
    neighbourDepth: 1,
    maxScopeFiles: 60,
    /*
     * Проверка идёт в отдельном дереве: общее дерево здесь почти никогда не бывает зелёным
     * целиком — рядом всегда чья-то незавершённая работа.
     *
     * Пять каталогов зависимостей: корневой и по одному на пакет рабочего пространства. Меньше
     * нельзя — pnpm не найдёт зависимости пакета; больше не нужно.
     */
    // Двенадцать решений по девятьсот знаков: замер корпуса — медиана выжимки 453 знака, девятая
    // дециль 924, так что потолок режет редко и только самые длинные своды.
    maxAdrInPacket: 12,
    maxAdrChars: 900,
    isolateVerification: true,
    linkPaths: [
      'node_modules',
      'apps/api/node_modules',
      'apps/web/node_modules',
      'apps/worker/node_modules',
      'packages/contracts/node_modules',
    ],
    aliases: [
      { prefix: '@technic/contracts', target: 'packages/contracts/src/index.ts' },
      { prefix: '@app/', target: 'apps/web/src/app/', within: 'apps/web/' },
      { prefix: '@pages/', target: 'apps/web/src/pages/', within: 'apps/web/' },
      { prefix: '@widgets/', target: 'apps/web/src/widgets/', within: 'apps/web/' },
      { prefix: '@features/', target: 'apps/web/src/features/', within: 'apps/web/' },
      { prefix: '@entities/', target: 'apps/web/src/entities/', within: 'apps/web/' },
      { prefix: '@shared/', target: 'apps/web/src/shared/', within: 'apps/web/' },
    ],
  },

  /*
   * Кто относит задание агенту.
   *
   * Пока `manual`: система пишет задание, человек отдаёт его агенту в редакторе и приносит ответ.
   * Командный адаптер готов и включается одной строкой (`mode: 'command'`) либо флагом
   * `--agent command` — но это решение о том, кто держит руку на дереве, и умолчанием оно не
   * становится. Первый запуск разумно сделать с `dryRun: true`: адаптер напечатает команду и
   * ничего не запустит.
   */
  agent: {
    mode: 'manual',
    command: ['claude', '-p', '--permission-mode', 'acceptEdits'],
    timeoutMs: 20 * 60 * 1000,
  },

  /*
   * Область работы системы. `docs/**` сюда не входит намеренно: за документацией следит
   * `check-docs`, и второй проверяющий той же территории только раздвоил бы ответственность.
   */
  scope: {
    include: ['apps/**', 'packages/**', 'scripts/**', 'tools/**'],
    exclude: [
      'node_modules/**',
      '**/node_modules/**',
      '**/dist/**',
      '**/coverage/**',
      'apps/api/drizzle/**',
      'apps/web/test/fixtures/**',
      '.maintenance/**',
      'temp/**',
    ],
  },
});
