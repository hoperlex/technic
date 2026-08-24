import { randomBytes } from 'node:crypto';
import { deflateSync } from 'node:zlib';

// ── Отрисовка капчи ──
// Картинка рисуется своим кодом и кодируется в PNG вручную (node:zlib + CRC32) — без нативных
// модулей и без единой зависимости, которую пришлось бы собирать в образе.
//
// Почему не SVG: разметку читает любой парсер, и ответ уехал бы к боту вместе с картинкой.
// Растр заставляет распознавать изображение — а против самодельного искажения готового решателя
// в природе нет, что и есть основная ценность собственной капчи.
//
// Модуль занимается только пикселями: какой код нарисован и верен ли ответ — дело captcha.ts.

const GLYPH_WIDTH = 8;
const GLYPH_HEIGHT = 12;

/**
 * Цифры 2…9 в виде битовых карт 8×12. Ноль и единица не используются: рядом с «O» и «7» после
 * искажения их различает не всякий человек, а восемь цифр на пять знаков — это 32 768 вариантов,
 * чего с лимитом попыток достаточно.
 */
const GLYPHS: Record<string, string[]> = {
  '2': [
    '..####..',
    '.##..##.',
    '##....##',
    '##....##',
    '.....##.',
    '....##..',
    '...##...',
    '..##....',
    '.##.....',
    '##......',
    '########',
    '########',
  ],
  '3': [
    '.######.',
    '##....##',
    '......##',
    '......##',
    '....###.',
    '....###.',
    '......##',
    '......##',
    '......##',
    '##....##',
    '##....##',
    '.######.',
  ],
  '4': [
    '.....##.',
    '....###.',
    '...####.',
    '..##.##.',
    '.##..##.',
    '##...##.',
    '##...##.',
    '########',
    '########',
    '.....##.',
    '.....##.',
    '.....##.',
  ],
  '5': [
    '########',
    '########',
    '##......',
    '##......',
    '######..',
    '.#####..',
    '......##',
    '......##',
    '......##',
    '##....##',
    '##....##',
    '.######.',
  ],
  '6': [
    '..#####.',
    '.##....#',
    '##......',
    '##......',
    '##.####.',
    '###...##',
    '##.....#',
    '##.....#',
    '##.....#',
    '##....##',
    '.##..##.',
    '..####..',
  ],
  '7': [
    '########',
    '########',
    '......##',
    '.....##.',
    '....##..',
    '....##..',
    '...##...',
    '...##...',
    '..##....',
    '..##....',
    '.##.....',
    '.##.....',
  ],
  '8': [
    '..####..',
    '.##..##.',
    '##....##',
    '##....##',
    '.##..##.',
    '..####..',
    '.##..##.',
    '##....##',
    '##....##',
    '##....##',
    '.##..##.',
    '..####..',
  ],
  '9': [
    '..####..',
    '.##..##.',
    '##....##',
    '##....##',
    '##....##',
    '.##..###',
    '..#####.',
    '......##',
    '......##',
    '##....##',
    '.##..##.',
    '..####..',
  ],
};

/** Алфавит кода: те же цифры, что нарисованы выше. */
export const CAPTCHA_ALPHABET = Object.keys(GLYPHS);

const WIDTH = 240;
const HEIGHT = 80;

// Индексы палитры (PNG color type 3).
const COLOR_BACKGROUND = 0;
const COLOR_INK = 1;
const COLOR_NOISE = 2;

/**
 * Генератор искажений. Криптостойкость здесь не нужна и вредна по скорости: секретен код, а не
 * то, под каким углом повёрнута цифра. Сам код приходит из crypto (captcha.ts).
 */
function makeRandom(): () => number {
  let state = randomBytes(4).readUInt32BE(0) || 1;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

type Rgb = [number, number, number];

function hslToRgb(h: number, s: number, l: number): Rgb {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    h < 60
      ? [c, x, 0]
      : h < 120
        ? [x, c, 0]
        : h < 180
          ? [0, c, x]
          : h < 240
            ? [0, x, c]
            : h < 300
              ? [x, 0, c]
              : [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xed_b8_83_20 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let c = 0xff_ff_ff_ff;
  for (const byte of data) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xff_ff_ff_ff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Buffer {
  const typed = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typed));
  return Buffer.concat([length, typed, crc]);
}

/** PNG с палитрой (color type 3): один байт на пиксель, ни одной внешней библиотеки. */
function encodePng(width: number, height: number, palette: Rgb[], pixels: Uint8Array): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.writeUInt8(8, 8); // бит на пиксель
  ihdr.writeUInt8(3, 9); // color type: палитра
  ihdr.writeUInt8(0, 10); // компрессия: deflate
  ihdr.writeUInt8(0, 11); // фильтрация: стандартная
  ihdr.writeUInt8(0, 12); // без чересстрочности

  const plte = Buffer.from(palette.flat());

  // Каждая строка предваряется байтом фильтра; фильтр 0 («без предсказания») — сжатие и так
  // отличное: в картинке три цвета.
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (width + 1)] = 0;
    Buffer.from(pixels.subarray(y * width, (y + 1) * width)).copy(raw, y * (width + 1) + 1);
  }

  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('PLTE', plte),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', new Uint8Array(0)),
  ]);
}

interface GlyphPlacement {
  glyph: string[];
  centerX: number;
  centerY: number;
  scaleX: number;
  scaleY: number;
  cos: number;
  sin: number;
  shear: number;
}

/**
 * Пиксель ставится обратным преобразованием: для каждой точки холста считаем, откуда она пришла
 * в битовой карте. Прямой обход глифа оставлял бы дыры после поворота и растяжения.
 */
function paintGlyph(pixels: Uint8Array, p: GlyphPlacement): void {
  const reach = Math.ceil(
    (Math.max(GLYPH_WIDTH * p.scaleX, GLYPH_HEIGHT * p.scaleY) / 2) * 1.5 + 2,
  );
  for (let y = Math.max(0, p.centerY - reach); y < Math.min(HEIGHT, p.centerY + reach); y += 1) {
    for (let x = Math.max(0, p.centerX - reach); x < Math.min(WIDTH, p.centerX + reach); x += 1) {
      const dx = x - p.centerX;
      const dy = y - p.centerY;
      const rotatedX = p.cos * dx + p.sin * dy;
      const rotatedY = -p.sin * dx + p.cos * dy;
      const gx = Math.floor((rotatedX - p.shear * rotatedY) / p.scaleX + GLYPH_WIDTH / 2);
      const gy = Math.floor(rotatedY / p.scaleY + GLYPH_HEIGHT / 2);
      if (gx < 0 || gx >= GLYPH_WIDTH || gy < 0 || gy >= GLYPH_HEIGHT) continue;
      if (p.glyph[gy]![gx] === '#') pixels[y * WIDTH + x] = COLOR_INK;
    }
  }
}

/**
 * Волна по вертикали: колонки сдвигаются по синусоиде. Ломает посимвольную сегментацию — по
 * прямым столбцам фона цифры резались бы тривиально.
 */
function applyWave(pixels: Uint8Array, random: () => number): Uint8Array {
  const amplitude = 2 + random() * 3;
  const period = 60 + random() * 60;
  const phase = random() * Math.PI * 2;
  const out = new Uint8Array(pixels.length).fill(COLOR_BACKGROUND);
  for (let x = 0; x < WIDTH; x += 1) {
    const shift = Math.round(amplitude * Math.sin((x / period) * Math.PI * 2 + phase));
    for (let y = 0; y < HEIGHT; y += 1) {
      const source = y + shift;
      if (source < 0 || source >= HEIGHT) continue;
      out[y * WIDTH + x] = pixels[source * WIDTH + x]!;
    }
  }
  return out;
}

/** Линии рисуются цветом текста: отдельным цветом их отфильтровали бы одним проходом. */
function drawNoiseLines(pixels: Uint8Array, random: () => number): void {
  const lines = 1 + Math.floor(random() * 2);
  for (let i = 0; i < lines; i += 1) {
    const amplitude = 6 + random() * 14;
    const period = 70 + random() * 80;
    const phase = random() * Math.PI * 2;
    const base = 10 + random() * (HEIGHT - 20);
    for (let x = 0; x < WIDTH; x += 1) {
      const y = Math.round(base + amplitude * Math.sin((x / period) * Math.PI * 2 + phase));
      if (y >= 0 && y < HEIGHT) pixels[y * WIDTH + x] = COLOR_INK;
    }
  }
}

function drawNoiseDots(pixels: Uint8Array, random: () => number): void {
  const dots = Math.floor(WIDTH * HEIGHT * 0.025);
  for (let i = 0; i < dots; i += 1) {
    const index = Math.floor(random() * pixels.length);
    if (pixels[index] === COLOR_BACKGROUND) pixels[index] = COLOR_NOISE;
  }
}

/** Рисует код и возвращает готовый PNG. */
export function renderCaptcha(code: string): Buffer {
  const random = makeRandom();
  const pixels = new Uint8Array(WIDTH * HEIGHT).fill(COLOR_BACKGROUND);

  const step = WIDTH / (code.length + 1);
  for (const [i, char] of [...code].entries()) {
    const glyph = GLYPHS[char];
    if (!glyph) continue;
    const angle = (random() - 0.5) * 0.5; // ±14°
    const scaleX = 3.1 + random() * 0.8;
    const scaleY = 4.2 + random() * 1.1;
    paintGlyph(pixels, {
      glyph,
      centerX: Math.round(step * (i + 1) + (random() - 0.5) * 6),
      centerY: Math.round(HEIGHT / 2 + (random() - 0.5) * 10),
      scaleX,
      scaleY,
      cos: Math.cos(angle),
      sin: Math.sin(angle),
      shear: (random() - 0.5) * 0.5,
    });
  }

  drawNoiseLines(pixels, random);
  const waved = applyWave(pixels, random);
  drawNoiseDots(waved, random);

  // Один случайный тон на всю картинку: фон светлый, текст тёмный — контраст заведомо высокий,
  // а цветоаномалии не мешают, потому что различать нужно светлое и тёмное, а не оттенки.
  const hue = Math.floor(random() * 360);
  const palette: Rgb[] = [
    hslToRgb(hue, 0.35, 0.94),
    hslToRgb(hue, 0.75, 0.24),
    hslToRgb(hue, 0.4, 0.72),
  ];

  return encodePng(WIDTH, HEIGHT, palette, waved);
}
