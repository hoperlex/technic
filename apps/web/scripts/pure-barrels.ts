import { readFileSync } from 'node:fs';
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

export function assertPureReexports(code: string, file: string) {
  const source = ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  if (
    source.statements.length === 0 ||
    !source.statements.every(
      (statement) =>
        ts.isExportDeclaration(statement) &&
        statement.moduleSpecifier &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        statement.moduleSpecifier.text.startsWith('.'),
    )
  ) {
    throw new Error(`Pure barrel acquired executable code or a non-local export: ${file}`);
  }
}

/** Fail the production build if a selected entry acquires initialization of its own. */
export function checkPureBarrels() {
  for (const file of PURE_BARRELS) {
    const full = fileURLToPath(new NodeURL(`../../../${file}`, import.meta.url));
    assertPureReexports(readFileSync(full, 'utf8'), file);
  }
}

export const pureBarrelRules = PURE_BARRELS.map((file) => ({
  test: new RegExp(`/${file.replaceAll('.', '\\.').replaceAll('/', '\\/')}$`),
  sideEffects: false as const,
}));
