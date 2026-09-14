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
