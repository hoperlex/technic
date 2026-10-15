import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const METHODS = new Set(['get', 'post', 'patch', 'put', 'delete']);
const WRITES = new Set(['insert', 'update', 'delete']);
const READS = new Set(['from']);

const property = (node) =>
  ts.isPropertyAccessExpression(node) ? node.name.text : ts.isIdentifier(node) ? node.text : null;

/**
 * Follow route callbacks into local and relative imported helpers. Table names come from imports
 * of the DB schema, not from a maintained route or cache registry. A helper may be shared by
 * several doors; each caller inherits its actual SQL writes.
 */
export function serverRouteEffects(apiRoot) {
  const files = new Map();
  const load = (file) => {
    if (files.has(file)) return files.get(file);
    if (!existsSync(file)) return null;
    const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const imports = new Map();
    const tables = new Set();
    const functions = new Map();
    for (const stmt of sf.statements) {
      if (ts.isImportDeclaration(stmt) && ts.isStringLiteral(stmt.moduleSpecifier)) {
        const source = stmt.moduleSpecifier.text;
        const spec = stmt.importClause?.namedBindings;
        if (spec && ts.isNamedImports(spec))
          for (const item of spec.elements) {
            const local = item.name.text;
            if (source.endsWith('/db/schema')) tables.add(local);
            else if (source.startsWith('.') && !/\/(?:lib|auth|db)\//.test(source)) {
              const target = path.resolve(path.dirname(file), source + '.ts');
              imports.set(local, { file: target, name: item.propertyName?.text ?? local });
            }
          }
        const defaultName = stmt.importClause?.name?.text;
        if (defaultName && source.startsWith('.') && !/\/(?:lib|auth|db)\//.test(source))
          imports.set(defaultName, {
            file: path.resolve(path.dirname(file), source + '.ts'),
            name: 'default',
          });
      }
      if (ts.isFunctionDeclaration(stmt) && stmt.name) functions.set(stmt.name.text, stmt);
      if (
        ts.isFunctionDeclaration(stmt) &&
        stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)
      )
        functions.set('default', stmt);
      if (ts.isVariableStatement(stmt))
        for (const decl of stmt.declarationList.declarations)
          if (
            ts.isIdentifier(decl.name) &&
            decl.initializer &&
            (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer))
          )
            functions.set(decl.name.text, decl.initializer);
    }
    const info = { sf, imports, tables, functions };
    files.set(file, info);
    return info;
  };

  const analyze = (file, node, seen = new Set()) => {
    const result = { reads: new Set(), writes: new Set() };
    const info = load(file);
    if (!info || !node) return result;
    const visit = (part) => {
      if (ts.isCallExpression(part)) {
        const method = property(part.expression);
        const first = part.arguments[0];
        if (first && ts.isIdentifier(first) && info.tables.has(first.text)) {
          if (WRITES.has(method)) result.writes.add(first.text);
          if (READS.has(method)) result.reads.add(first.text);
        }
        if (ts.isIdentifier(part.expression)) {
          const name = part.expression.text;
          const local = info.functions.get(name);
          const imported = info.imports.get(name);
          const target = imported ? load(imported.file)?.functions.get(imported.name) : local;
          const targetFile = imported?.file ?? file;
          const key = `${targetFile}:${imported?.name ?? name}`;
          if (target && !seen.has(key)) {
            seen.add(key);
            const nested = analyze(targetFile, target, seen);
            for (const table of nested.reads) result.reads.add(table);
            for (const table of nested.writes) result.writes.add(table);
            seen.delete(key);
          }
        }
      }
      ts.forEachChild(part, visit);
    };
    visit(node);
    return result;
  };

  const app = load(path.join(apiRoot, 'app.ts'));
  if (!app) return { routes: [], available: false };
  const prefixes = new Map();
  const visitRegistrations = (node) => {
    if (ts.isCallExpression(node) && property(node.expression) === 'register') {
      const module = node.arguments[0];
      const options = node.arguments[1];
      const prefix =
        options && ts.isObjectLiteralExpression(options)
          ? options.properties.find(
              (p) => ts.isPropertyAssignment(p) && property(p.name) === 'prefix',
            )?.initializer
          : null;
      if (module && ts.isIdentifier(module) && prefix && ts.isStringLiteral(prefix)) {
        const source = app.imports.get(module.text);
        if (source) prefixes.set(source.file, prefix.text.replace(/^\/api\/v1/, ''));
      }
    }
    ts.forEachChild(node, visitRegistrations);
  };
  visitRegistrations(app.sf);

  const routes = [];
  for (const [file, prefix] of prefixes) {
    const info = load(file);
    if (!info) continue;
    const visitRoutes = (node) => {
      if (ts.isCallExpression(node)) {
        const method = property(node.expression);
        const relative = node.arguments[0];
        const handler = node.arguments.at(-1);
        if (
          METHODS.has(method) &&
          relative &&
          ts.isStringLiteral(relative) &&
          handler &&
          (ts.isArrowFunction(handler) || ts.isFunctionExpression(handler))
        ) {
          const effects = analyze(file, handler);
          routes.push({
            method: method.toUpperCase(),
            path: `${prefix}${relative.text}`.replace(/\/$/, ''),
            reads: [...effects.reads].sort(),
            writes: [...effects.writes].sort(),
          });
        }
      }
      ts.forEachChild(node, visitRoutes);
    };
    visitRoutes(info.sf);
  }
  return { routes, available: true };
}
