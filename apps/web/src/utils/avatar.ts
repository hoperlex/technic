/**
 * CSS-аватары по инициалам: без картинок, только цветной кружок с буквами.
 * Цвет детерминирован по имени, палитра подобрана под белый текст (AA-контраст).
 */

// Инициалы: две буквы из первых двух слов ФИО; одно слово → одна буква; пусто → «?».
export function getInitials(name?: string | null): string {
  const words = (name ?? '').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  const letters = words.length === 1 ? words[0]![0]! : words[0]![0]! + words[1]![0]!;
  return letters.toUpperCase();
}

// Тёмные оттенки (Material 800/900): белый текст читается на каждом.
const PALETTE = [
  '#c62828', // red
  '#ad1457', // pink
  '#6a1b9a', // purple
  '#4527a0', // deep purple
  '#283593', // indigo
  '#1565c0', // blue
  '#0277bd', // light blue
  '#00838f', // cyan
  '#00695c', // teal
  '#2e7d32', // green
  '#e65100', // orange
  '#d84315', // deep orange
  '#4e342e', // brown
  '#37474f', // blue grey
];

const FALLBACK_COLOR = '#9e9e9e';

// Детерминированный цвет фона: одно имя → всегда один цвет палитры.
export function avatarColor(name?: string | null): string {
  const s = (name ?? '').trim();
  if (!s) return FALLBACK_COLOR;
  let hash = 0;
  for (let i = 0; i < s.length; i++) hash = (hash * 31 + s.charCodeAt(i)) >>> 0;
  return PALETTE[hash % PALETTE.length]!;
}
