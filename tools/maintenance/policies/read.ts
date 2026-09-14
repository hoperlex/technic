/**
 * Чтение YAML с проверкой формы.
 *
 * ЗАЧЕМ ПРОВЕРЯТЬ. Политика — вход системы, которая правит код. Опечатка в `severity` без проверки
 * превращается в `undefined`, `undefined` не равно `hard`, и жёсткое правило молча перестаёт
 * действовать. Такую поломку не видно ни в одном отчёте: всё зелено, просто правил стало меньше.
 * Поэтому любое поле спрашивается поимённо, а промах называет файл, запись и поле.
 *
 * Схемного валидатора (zod и подобных) здесь нет намеренно: он есть в контрактах приложения, но
 * тянуть его в переносимое ядро значит навязать будущей внешней библиотеке зависимость ради
 * десятка полей.
 */
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { MaintenanceConfigError } from '../core/errors.ts';

export type Node = Record<string, unknown>;

export function readYaml(file: string, shortName: string): Node {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (cause) {
    throw new MaintenanceConfigError(
      shortName,
      `не удалось прочитать: ${(cause as Error).message}`,
    );
  }
  let value: unknown;
  try {
    value = parse(text);
  } catch (cause) {
    throw new MaintenanceConfigError(
      shortName,
      `не разобрался как YAML: ${(cause as Error).message}`,
    );
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new MaintenanceConfigError(shortName, 'ожидался объект верхнего уровня');
  }
  return value as Node;
}

/** Контекст промаха: без него сообщение «поле id обязательно» не отвечает на вопрос «где». */
export interface Where {
  readonly file: string;
  readonly at: string;
}

function fail(where: Where, message: string): never {
  throw new MaintenanceConfigError(where.file, `${where.at}: ${message}`);
}

export function asNode(where: Where, value: unknown): Node {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(where, 'ожидался объект');
  }
  return value as Node;
}

export function nodeList(where: Where, value: unknown, { optional = false } = {}): Node[] {
  if (value === undefined || value === null) {
    if (optional) return [];
    fail(where, 'ожидался список');
  }
  if (!Array.isArray(value)) fail(where, 'ожидался список');
  return value.map((item, index) =>
    asNode({ file: where.file, at: `${where.at}[${index}]` }, item),
  );
}

export function str(where: Where, node: Node, key: string): string {
  const value = node[key];
  if (typeof value !== 'string' || value.trim() === '') fail(where, `поле ${key} обязательно`);
  return value.trim();
}

export function optionalStr(where: Where, node: Node, key: string): string | undefined {
  const value = node[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') fail(where, `поле ${key} обязано быть строкой`);
  return value.trim();
}

export function strList(where: Where, node: Node, key: string, { optional = true } = {}): string[] {
  const value = node[key];
  if (value === undefined || value === null) {
    if (optional) return [];
    fail(where, `поле ${key} обязательно`);
  }
  if (!Array.isArray(value)) fail(where, `поле ${key} обязано быть списком строк`);
  return value.map((item, index) => {
    if (typeof item !== 'string') fail(where, `${key}[${index}] обязано быть строкой`);
    return item.trim();
  });
}

export function oneOf<T extends string>(
  where: Where,
  node: Node,
  key: string,
  allowed: readonly T[],
  fallback?: T,
): T {
  const value = node[key];
  if ((value === undefined || value === null) && fallback !== undefined) return fallback;
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    fail(where, `поле ${key} обязано быть одним из: ${allowed.join(', ')}`);
  }
  return value as T;
}

export function bool(where: Where, node: Node, key: string, fallback: boolean): boolean {
  const value = node[key];
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') fail(where, `поле ${key} обязано быть true или false`);
  return value;
}

export function num(where: Where, node: Node, key: string): number {
  const value = node[key];
  if (typeof value !== 'number' || !Number.isFinite(value))
    fail(where, `поле ${key} обязано быть числом`);
  return value;
}
