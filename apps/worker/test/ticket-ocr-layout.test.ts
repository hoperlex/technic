import { describe, expect, it } from 'vitest';
import {
  detectQuarterTurn,
  detectSheetBox,
  detectSkew,
  otsuThreshold,
  type GreyImage,
} from '../src/ticket-ocr/layout';

/**
 * Геометрия листа (план `docs/waste-ticket-ocr-plan.md`, Р9).
 *
 * Проверяется на нарисованных картинках, а не на настоящих сканах, и это осознанно: настоящий скан
 * талона — персональные данные подрядчика, а репозиторий публичный. Нарисованный лист даёт то же
 * самое свойство, на котором держатся все три метода, — текст лежит строками, — и позволяет знать
 * правильный ответ заранее.
 *
 * Цена ошибки здесь несимметрична, и тесты это отражают: не найти наклон — потерять немного
 * качества чтения, а срезать по ошибке угол листа с номером талона — потерять строку, которую
 * никто уже не восстановит. Поэтому половина проверок — про отказ обрезать.
 */

function blank(width: number, height: number, value = 255): GreyImage {
  return { data: new Uint8Array(width * height).fill(value), width, height };
}

function fillRect(img: GreyImage, x0: number, y0: number, x1: number, y1: number, value: number) {
  for (let y = Math.max(0, y0); y <= Math.min(img.height - 1, y1); y += 1) {
    for (let x = Math.max(0, x0); x <= Math.min(img.width - 1, x1); x += 1) {
      img.data[y * img.width + x] = value;
    }
  }
}

/** Лист с «текстом»: горизонтальные тёмные полосы, при желании заваленные на `angleDeg`. */
function sheetWithText(width: number, height: number, angleDeg = 0): GreyImage {
  const img = blank(width, height);
  const tan = Math.tan((angleDeg * Math.PI) / 180);
  for (let line = 1; line * 24 < height - 24; line += 1) {
    const baseY = line * 24;
    for (let x = 40; x < width - 40; x += 1) {
      const y = Math.round(baseY + x * tan);
      fillRect(img, x, y, x, y + 5, 20);
    }
  }
  return img;
}

/** Тот же кадр, повёрнутый на четверть: так приходит треть снимков (замер §2 плана). */
function rotate90(img: GreyImage): GreyImage {
  const out = new Uint8Array(img.data.length);
  for (let y = 0; y < img.height; y += 1) {
    for (let x = 0; x < img.width; x += 1) {
      out[x * img.height + (img.height - 1 - y)] = img.data[y * img.width + x]!;
    }
  }
  return { data: out, width: img.height, height: img.width };
}

describe('порог чернил', () => {
  it('делит бумагу и текст, а не выбирает середину шкалы', () => {
    const img = sheetWithText(400, 300);
    const threshold = otsuThreshold(img);
    expect(threshold).toBeGreaterThanOrEqual(20);
    expect(threshold).toBeLessThan(255);
  });
});

describe('поворот на четверть', () => {
  it('ровно лежащий лист не трогает', () => {
    expect(detectQuarterTurn(sheetWithText(600, 800))).toBe(0);
  });

  it('лежащий на боку разворачивает', () => {
    expect(detectQuarterTurn(rotate90(sheetWithText(600, 800)))).toBe(90);
  });

  it('пустой лист оставляет как есть: угадывать не по чему', () => {
    expect(detectQuarterTurn(blank(400, 300))).toBe(0);
  });
});

describe('наклон', () => {
  it('ровный кадр не доворачивает', () => {
    expect(detectSkew(sheetWithText(600, 500))).toBe(0);
  });

  it.each([2, -3, 5])('находит завал в %i° и возвращает поправку в другую сторону', (angle) => {
    const found = detectSkew(sheetWithText(700, 600, angle));
    expect(found).toBeCloseTo(-angle, 0);
  });

  it('на пустом кадре отвечает нулём, а не выдуманным углом', () => {
    expect(detectSkew(blank(400, 400))).toBe(0);
  });
});

describe('контур листа', () => {
  it('находит бумагу на тёмном столе', () => {
    const img = blank(500, 400, 90);
    fillRect(img, 100, 60, 400, 340, 250);
    const box = detectSheetBox(img);
    expect(box).not.toBeNull();
    // Рамка берётся с запасом в полтора процента: печать у самого края не должна попасть под нож.
    expect(box!.left).toBeLessThanOrEqual(100);
    expect(box!.top).toBeLessThanOrEqual(60);
    expect(box!.left + box!.width).toBeGreaterThanOrEqual(400);
    expect(box!.top + box!.height).toBeGreaterThanOrEqual(340);
  });

  it('скан, уже занимающий кадр целиком, не режет', () => {
    expect(detectSheetBox(sheetWithText(600, 800))).toBeNull();
  });

  it('отказывается резать, когда «лист» вышел меньше трети кадра', () => {
    const img = blank(500, 400, 60);
    fillRect(img, 20, 20, 120, 120, 250);
    expect(detectSheetBox(img)).toBeNull();
  });
});
