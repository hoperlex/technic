import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, URL as NodeURL } from 'node:url';
import ts from 'typescript';

/**
 * These audited public entries only re-export declarations; none owns bootstrap work. Shell
 * counters otherwise pull closed service forms, and permission checks pull unrelated schemas,
 * through the same entry module. Keep the assertion narrow: shared/lib initializes dayjs, so a
 * blanket "all index.ts are pure" policy would silently discard required initialization.
 */
export const PURE_BARRELS = [
  'apps/web/src/entities/service-request/index.ts',
  'apps/web/src/entities/office-equipment/index.ts',
  'packages/contracts/src/index.ts',
] as const;

const REPO = fileURLToPath(new NodeURL('../../../', import.meta.url));

/**
 * Top-level work that may live in a module reached through a pure barrel, each with its reason.
 *
 * The bundler drops more than the barrel itself: rolldown discards top-level effects of modules
 * reachable only through a side-effect-free entry (a registry `set`, a `globalThis` assignment, a
 * transitive bare import were all verified to vanish). Vitest does not tree-shake, so such a loss
 * shows up in production only. An entry here is a reviewed statement that the effect is harmless
 * when dropped or is kept alive by another importer.
 */
const ALLOWED_EFFECTS: readonly { file: string; startsWith: string; reason: string }[] = [
  {
    file: 'apps/web/src/shared/ui/FormGrid.tsx',
    startsWith: 'FormGrid.Full',
    reason: 'attaches a sub-component to its own export; dropped together with an unused FormGrid',
  },
  {
    file: 'apps/web/src/shared/lib/dayjs.ts',
    startsWith: "import 'dayjs/locale/ru'",
    reason: 'the locale is also loaded by main.tsx through setupDayjs, outside any pure barrel',
  },
];

const WEB_ALIASES: Record<string, string> = {
  '@app/': 'apps/web/src/app/',
  '@pages/': 'apps/web/src/pages/',
  '@widgets/': 'apps/web/src/widgets/',
  '@features/': 'apps/web/src/features/',
  '@entities/': 'apps/web/src/entities/',
  '@shared/': 'apps/web/src/shared/',
};

const STYLE_IMPORT = /\.(css|less|scss|sass)(\?.*)?$/;

/** Repo-relative file a specifier names, `null` for a package outside the repository. */
export function resolvePortalModule(fromFile: string, specifier: string): string | null {
  let base: string | undefined;
  if (specifier.startsWith('.')) base = path.posix.join(path.posix.dirname(fromFile), specifier);
  else if (specifier === '@technic/contracts') return 'packages/contracts/src/index.ts';
  else {
    const alias = Object.keys(WEB_ALIASES).find((prefix) => specifier.startsWith(prefix));
    if (alias) base = WEB_ALIASES[alias] + specifier.slice(alias.length);
  }
  if (base === undefined) return null;
  if (STYLE_IMPORT.test(base)) return base;
  const stem = base.replace(/\.js$/, '');
  for (const candidate of [
    stem,
    `${stem}.ts`,
    `${stem}.tsx`,
    `${stem}/index.ts`,
    `${stem}/index.tsx`,
  ]) {
    if (/\.tsx?$/.test(candidate) && existsSync(path.join(REPO, candidate))) return candidate;
  }
  throw new Error(`Pure barrel closure cannot resolve ${specifier} from ${fromFile}`);
}

export function assertPureReexports(code: string, file: string) {
  const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if (
    source.statements.length === 0 ||
    !source.statements.every(
      (statement) =>
        ts.isExportDeclaration(statement) &&
        statement.moduleSpecifier &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        // './x' only: '../x' would re-export another slice's module under this entry's purity.
        statement.moduleSpecifier.text.startsWith('./'),
    )
  ) {
    throw new Error(`Pure barrel acquired executable code or a non-local export: ${file}`);
  }
}

const DECLARATION_KINDS = new Set([
  ts.SyntaxKind.VariableStatement,
  ts.SyntaxKind.FunctionDeclaration,
  ts.SyntaxKind.ClassDeclaration,
  ts.SyntaxKind.InterfaceDeclaration,
  ts.SyntaxKind.TypeAliasDeclaration,
  ts.SyntaxKind.EnumDeclaration,
  ts.SyntaxKind.ModuleDeclaration,
  ts.SyntaxKind.ExportAssignment,
  ts.SyntaxKind.EmptyStatement,
]);

/**
 * Every module statically reachable from a pure barrel may only declare. Problems are returned, not
 * thrown, so a test can name them. What is not checked: effects hidden inside a variable
 * initializer (`const x = register()`); the audit at introduction found none, and flagging every
 * call would bury the signal under schema builders.
 */
export function pureClosureProblems(
  entry: string,
  read: (file: string) => string = (file) => readFileSync(path.join(REPO, file), 'utf8'),
  resolve: (from: string, specifier: string) => string | null = resolvePortalModule,
): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  const queue = [entry];
  const allowed = (file: string, text: string) =>
    ALLOWED_EFFECTS.some((rule) => rule.file === file && text.startsWith(rule.startsWith));

  while (queue.length > 0) {
    const file = queue.shift()!;
    if (seen.has(file)) continue;
    seen.add(file);
    if (STYLE_IMPORT.test(file)) {
      problems.push(`${file}: stylesheet in a pure closure`);
      continue;
    }
    const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
    const source = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true, kind);
    const follow = (specifier: ts.Expression | undefined) => {
      if (!specifier || !ts.isStringLiteral(specifier)) return;
      const target = resolve(file, specifier.text);
      if (target) queue.push(target);
    };

    for (const statement of source.statements) {
      const text = statement.getText(source);
      if (ts.isImportDeclaration(statement)) {
        if (!statement.importClause) {
          if (!allowed(file, text)) problems.push(`${file}: import for its side effect — ${text}`);
          follow(statement.moduleSpecifier);
        } else if (!statement.importClause.isTypeOnly) follow(statement.moduleSpecifier);
        continue;
      }
      if (ts.isExportDeclaration(statement)) {
        if (!statement.isTypeOnly) follow(statement.moduleSpecifier);
        continue;
      }
      if (ts.isImportEqualsDeclaration(statement)) continue;
      if (DECLARATION_KINDS.has(statement.kind)) continue;
      if (!allowed(file, text))
        problems.push(`${file}: top-level ${ts.SyntaxKind[statement.kind]} — ${text.slice(0, 80)}`);
    }
  }
  return problems;
}

/** Fail the production build if a selected entry or anything it reaches acquires initialization. */
export function checkPureBarrels() {
  for (const file of PURE_BARRELS) {
    assertPureReexports(readFileSync(path.join(REPO, file), 'utf8'), file);
    const problems = pureClosureProblems(file);
    if (problems.length > 0)
      throw new Error(
        `Pure barrel ${file} reaches top-level work that tree shaking would drop:\n  ${problems.join('\n  ')}`,
      );
  }
}

export const pureBarrelRules = PURE_BARRELS.map((file) => ({
  test: new RegExp(`/${file.replaceAll('.', '\\.').replaceAll('/', '\\/')}$`),
  sideEffects: false as const,
}));
