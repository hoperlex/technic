/**
 * Геометрия листа: куда он повёрнут, насколько завален и где на кадре кончается бумага
 * (план `docs/waste-ticket-ocr-plan.md`, Р9 — «автоповорот, deskew, обрезка по контуру листа
 * **без шаблонов**»).
 *
 * Почему отдельным файлом и без `sharp`. Здесь нет ни одного обращения к декодеру: на вход
 * приходит серая матрица пикселей, на выходе — три числа (четверть поворота, угол наклона,
 * прямоугольник листа). Это единственная часть подготовки, которую можно проверить тестом
 * поточечно, на нарисованной в памяти картинке, а не на глаз по выходному JPEG. `preprocess.ts`
 * остаётся оркестровкой пайплайна, и читается как последовательность шагов.
 *
 * Почему «без шаблонов» — не оговорка, а требование. Бланки у перевозчиков разные, талон
 * фотографируют на столе, на капоте и на весовой, треть кадров повёрнута на 90°, а на трети их
 * два (замер 22 талонов, §2 плана). Любая привязка к рамке конкретного бланка развалилась бы на
 * втором перевозчике. Поэтому все три метода опираются на одно свойство, общее у любой бумаги:
 * **текст лежит строками**, а строки дают резкий профиль проекции.
 *
 * Обработка нарочно консервативна: каждый метод умеет ответить «не знаю» (ноль градусов, `null`
 * вместо рамки). Ошибка распознавания стоит одного ручного ввода, а срезанный по ошибке угол
 * листа с номером талона — потерянной строки, которую никто уже не восстановит.
 */

/** Серая матрица: один байт на пиксель, строки подряд. */
export interface GreyImage {
  data: Uint8Array;
  width: number;
  height: number;
}

/** Прямоугольник в пикселях исходной матрицы — в том же виде, в каком его ждёт `sharp.extract`. */
export interface SheetBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Гистограмма яркостей: считается один раз и переиспользуется всеми порогами. */
function histogram(img: GreyImage): Uint32Array {
  const hist = new Uint32Array(256);
  const { data } = img;
  // `noUncheckedIndexedAccess` заставляет писать это длинно: индекс здесь заведомо в пределах
  // 0..255, но компилятор об этом знать не обязан.
  for (let i = 0; i < data.length; i += 1) {
    const value = data[i]!;
    hist[value] = (hist[value] ?? 0) + 1;
  }
  return hist;
}

/**
 * Порог «чернила против бумаги» методом Оцу.
 *
 * Фиксированный порог (скажем, 128) не годится: талон снимают и в тени под навесом, и на солнце,
 * и сканером с задранной яркостью. Оцу ищет порог, максимизирующий межклассовую дисперсию, то
 * есть подстраивается под конкретный кадр, и стоит один проход по гистограмме.
 */
export function otsuThreshold(img: GreyImage): number {
  const hist = histogram(img);
  const total = img.data.length;
  if (total === 0) return 128;
  let sum = 0;
  for (let i = 0; i < 256; i += 1) sum += i * hist[i]!;
  let sumB = 0;
  let weightB = 0;
  let best = 0;
  let bestVariance = -1;
  for (let t = 0; t < 256; t += 1) {
    weightB += hist[t]!;
    if (weightB === 0) continue;
    const weightF = total - weightB;
    if (weightF === 0) break;
    sumB += t * hist[t]!;
    const meanB = sumB / weightB;
    const meanF = (sum - sumB) / weightF;
    const variance = weightB * weightF * (meanB - meanF) * (meanB - meanF);
    if (variance > bestVariance) {
      bestVariance = variance;
      best = t;
    }
  }
  return best;
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

/**
 * Координаты тёмных пикселей — то, по чему считаются все профили.
 *
 * Точки, а не матрица, потому что профиль под наклоном приходится пересчитывать три десятка раз
 * (перебор углов). По матрице это тридцать полных проходов по кадру, по списку точек — тридцать
 * проходов по 5 % пикселей, которые вообще что-то значат. `limit` прореживает список на сплошь
 * чёрных кадрах (скан с закрытой крышкой), где точек столько же, сколько пикселей.
 */
export function inkPoints(img: GreyImage, threshold: number, limit = 60_000): Int32Array {
  const { data, width, height } = img;
  let count = 0;
  // Порог включающий: Оцу возвращает последнюю яркость, ещё относящуюся к тёмному классу, и
  // строгое сравнение выбрасывало бы из чернил ровно те пиксели, по которым порог и выбран.
  for (let i = 0; i < data.length; i += 1) if (data[i]! <= threshold) count += 1;
  if (count === 0) return new Int32Array(0);
  /*
   * Шаг прореживания подбирается взаимно простым с шириной кадра, и это не украшение. Точки идут
   * в порядке строк, поэтому шаг, делящий ширину нацело (двойка при ширине 600), выбирает в каждой
   * строке одни и те же столбцы — и рисует в профиле по оси X частокол, которого на картинке нет.
   * На нём определение поворота уверенно объявляло бы повёрнутым любой ровно лежащий лист.
   */
  let step = Math.max(1, Math.ceil(count / limit));
  while (step > 1 && gcd(step, width) !== 1) step += 1;
  const out = new Int32Array(Math.ceil(count / step) * 2);
  let seen = 0;
  let n = 0;
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    for (let x = 0; x < width; x += 1) {
      if (data[row + x]! > threshold) continue;
      if (seen % step === 0 && n + 1 < out.length) {
        out[n] = x;
        out[n + 1] = y;
        n += 2;
      }
      seen += 1;
    }
  }
  return out.subarray(0, n);
}

/**
 * Резкость профиля проекции: сумма квадратов приращений соседних корзин.
 *
 * Текст, лежащий строками, даёт частокол «строка — межстрочье — строка», и приращения в нём
 * велики. Тот же текст, снятый под углом, размазывается по корзинам, и приращения падают. На этом
 * держатся и определение четверти поворота, и deskew: обе задачи сводятся к «при каком повороте
 * профиль резче».
 *
 * Нормировка на длину профиля и квадрат общего числа точек нужна ровно затем, чтобы сравнивать
 * профили **разной длины** — вертикальный с горизонтальным у неквадратного кадра. Без неё
 * широкая сторона выигрывала бы у высокой просто числом корзин.
 */
function profileSharpness(profile: Float64Array, totalPoints: number): number {
  if (totalPoints === 0 || profile.length < 2) return 0;
  let acc = 0;
  for (let i = 0; i + 1 < profile.length; i += 1) {
    const d = profile[i + 1]! - profile[i]!;
    acc += d * d;
  }
  return (acc * profile.length) / (totalPoints * totalPoints);
}

/** Профиль проекции точек на ось Y при наклоне строк `tan`: корзина = y − x·tan. */
function skewedRowProfile(points: Int32Array, height: number, tan: number): Float64Array {
  const width = Math.abs(tan) * height;
  const offset = Math.ceil(width) + 1;
  const profile = new Float64Array(height + 2 * offset + 2);
  const total = points.length / 2;
  for (let i = 0; i < total; i += 1) {
    const x = points[i * 2]!;
    const y = points[i * 2 + 1]!;
    const bin = Math.round(y - x * tan) + offset;
    if (bin >= 0 && bin < profile.length) profile[bin] = (profile[bin] ?? 0) + 1;
  }
  return profile;
}

/** Профиль проекции точек на ось X — тот же счёт, но по столбцам. */
function columnProfile(points: Int32Array, width: number): Float64Array {
  const profile = new Float64Array(width + 2);
  const total = points.length / 2;
  for (let i = 0; i < total; i += 1) {
    const x = points[i * 2]!;
    if (x >= 0 && x < width) profile[x] = (profile[x] ?? 0) + 1;
  }
  return profile;
}

/**
 * Насколько увереннее вертикальный профиль должен быть горизонтального, чтобы кадр признали
 * повёрнутым. Запас в четверть — цена ошибки: развернув правильно лежащий талон, мы делаем хуже
 * и модели, и человеку, который смотрит на ту же картинку в карточке.
 */
const QUARTER_TURN_MARGIN = 1.25;

/**
 * Нужен ли кадру поворот на четверть (Р9, «автоповорот... иначе по ориентации»).
 *
 * Возвращает 0 или 90 — на сколько градусов **по часовой** повернуть, чтобы строки текста легли
 * горизонтально. Треть снимков приходит повёрнутой на 90° (замер §2), и это не косметика:
 * мультимодальная модель читает лежащий на боку бланк заметно хуже, чем перевёрнутый.
 *
 * Чего этот метод принципиально не умеет и не будет: отличить 90° от 270° и «вверх ногами» от
 * «правильно». Профиль проекции симметричен, различает их только смысл написанного — то есть уже
 * само распознавание. Поэтому мы приводим кадр к «строки горизонтальны», а неоднозначность в
 * 180° честно оставляем модели: перевёрнутый текст она читает, лежащий на боку — хуже.
 * Направление выбрано по часовой стрелке как соглашение, и от него зависит `PREPROCESSING_VERSION`:
 * поменяем — сменится версия предобработки, и кэш попыток разъедется правильно (Р12).
 */
export function detectQuarterTurn(img: GreyImage): 0 | 90 {
  if (img.width < 16 || img.height < 16) return 0;
  const points = inkPoints(img, otsuThreshold(img));
  const total = points.length / 2;
  // Пустой лист и сплошная заливка одинаково не дают строк: угадывать по ним нечего.
  if (total < 200) return 0;
  const rows = profileSharpness(skewedRowProfile(points, img.height, 0), total);
  const cols = profileSharpness(columnProfile(points, img.width), total);
  return cols > rows * QUARTER_TURN_MARGIN ? 90 : 0;
}

/** Дальше этого угла бумагу не кладут — там начинается уже поворот на четверть. */
const MAX_SKEW_DEG = 8;

/**
 * Угол, на который надо довернуть кадр, чтобы строки стали горизонтальными (Р9, deskew).
 *
 * Возвращается **поправка** в градусах для `sharp.rotate` (по часовой): текст, завалившийся
 * вправо, даёт отрицательное значение. Так вызывающему не приходится помнить про знак — он
 * передаёт число прямо в поворот.
 *
 * Метод — перебор наклонов с проекцией по строкам (Postl): при верном угле все буквы строки
 * попадают в одну корзину, и профиль становится частоколом. Сначала грубо, шагом в градус, потом
 * уточнение десятыми вокруг найденного — полный перебор с шагом 0.1° стоил бы в десять раз
 * дороже, а разницы в результате не даёт.
 *
 * Ноль возвращается не только при ровном кадре, но и когда судить не по чему: мало точек,
 * крохотная картинка, профиль без выраженного максимума. Повернуть кадр на выдуманный угол —
 * это подрисовать белые клинья по краям и размыть интерполяцией то, что и так читалось.
 */
export function detectSkew(img: GreyImage): number {
  if (img.width < 32 || img.height < 32) return 0;
  const points = inkPoints(img, otsuThreshold(img));
  const total = points.length / 2;
  if (total < 200) return 0;

  const score = (deg: number): number =>
    profileSharpness(skewedRowProfile(points, img.height, Math.tan((deg * Math.PI) / 180)), total);

  let bestDeg = 0;
  let bestScore = score(0);
  for (let deg = -MAX_SKEW_DEG; deg <= MAX_SKEW_DEG; deg += 1) {
    if (deg === 0) continue;
    const s = score(deg);
    if (s > bestScore) {
      bestScore = s;
      bestDeg = deg;
    }
  }
  for (let deg = bestDeg - 0.9; deg <= bestDeg + 0.9 + 1e-9; deg += 0.1) {
    const rounded = Math.round(deg * 10) / 10;
    if (Math.abs(rounded) > MAX_SKEW_DEG) continue;
    const s = score(rounded);
    if (s > bestScore) {
      bestScore = s;
      bestDeg = rounded;
    }
  }
  // Найденный наклон строк — это то, что надо скомпенсировать: поворачиваем в обратную сторону.
  return Math.abs(bestDeg) < 0.2 ? 0 : -bestDeg;
}

/**
 * Доля светлого, с которой ряд причисляется к бумаге: не абсолютная, а от самого светлого ряда
 * кадра. Абсолютный порог здесь и был первой ошибкой: строка с крупным текстом или тёмная графа
 * таблицы закрывает чернилами больше половины ширины, и ряд посреди листа переставал считаться
 * бумагой — рамка обрывалась на первой же строке текста.
 */
const PAPER_ROW_SHARE = 0.35;
/** Ниже этого ряд светлым не считается вовсе: иначе за бумагу сойдёт градиент стола. */
const PAPER_ROW_MIN = 0.1;
/** Меньше этой доли кадра рамка не бывает: значит, нашлось не то, и обрезать нельзя. */
const MIN_SHEET_AREA = 0.3;
/** Больше этой доли обрезать незачем: лист и так занимает кадр целиком (скан, а не фотография). */
const MAX_SHEET_AREA = 0.97;
/** Запас вокруг найденной рамки: печать у самого края бланка не должна попасть под нож. */
const SHEET_MARGIN = 0.015;

/**
 * Границы светлого — первый и последний ряд, где светлого не меньше порога.
 *
 * Именно границы, а не самый длинный сплошной участок: дырки внутри листа — это норма (строка
 * текста, тёмная графа, печать поверх), и обрывать по ним рамку значит резать лист пополам.
 * Ошибка в другую сторону — засчитать бликом лишний ряд — стоит нескольких пикселей стола в кадре
 * либо отказа от обрезки вовсе, и обе цены несопоставимы с отрезанным номером талона.
 */
function brightBounds(fractions: Float64Array): { from: number; to: number } | null {
  let peak = 0;
  for (let i = 0; i < fractions.length; i += 1) peak = Math.max(peak, fractions[i]!);
  if (peak <= 0) return null;
  const threshold = Math.max(PAPER_ROW_MIN, peak * PAPER_ROW_SHARE);
  let from = -1;
  let to = -1;
  for (let i = 0; i < fractions.length; i += 1) {
    if (fractions[i]! < threshold) continue;
    if (from < 0) from = i;
    to = i;
  }
  return from < 0 ? null : { from, to };
}

/**
 * Рамка листа на кадре (Р9, «обрезка по контуру листа без шаблонов») или `null`, если резать не
 * надо.
 *
 * Бумага на снимке — самое светлое, что там есть. Поэтому вместо поиска контуров берётся простое:
 * порог светлого от 95-го процентиля яркости (так в него не попадает блик от вспышки, задирающий
 * максимум), а затем границы рядов и столбцов, где светлого заметно больше, чем в самом тёмном
 * ряду кадра. Печати, тёмные графы и строки текста внутри листа этому не мешают: рамка ищется по
 * краям светлого, а не по сплошному заполнению.
 *
 * Отказ от обрезки — штатный ответ, и он возвращается чаще, чем рамка. Скан с МФУ уже обрезан
 * (`MAX_SHEET_AREA`), кадр «лист во весь экран» обрезать нечем, а если «лист» вышел меньше трети
 * кадра (`MIN_SHEET_AREA`) — нашлась не бумага, а бумажка на столе, засвеченный угол или лист
 * бумаги в чужих руках, и резать по ней значит выбросить талон.
 */
export function detectSheetBox(img: GreyImage): SheetBox | null {
  const { data, width, height } = img;
  if (width < 32 || height < 32) return null;

  const hist = histogram(img);
  const total = width * height;
  let acc = 0;
  let p95 = 255;
  for (let v = 0; v < 256; v += 1) {
    acc += hist[v]!;
    if (acc >= total * 0.95) {
      p95 = v;
      break;
    }
  }
  // Бумага темнее блика, но заметно светлее стола: порог берём долей от «почти максимума».
  const bright = Math.max(40, Math.round(p95 * 0.72));

  const rowFrac = new Float64Array(height);
  const colFrac = new Float64Array(width);
  for (let y = 0; y < height; y += 1) {
    const row = y * width;
    let inRow = 0;
    for (let x = 0; x < width; x += 1) {
      if (data[row + x]! >= bright) {
        inRow += 1;
        colFrac[x] = (colFrac[x] ?? 0) + 1;
      }
    }
    rowFrac[y] = inRow / width;
  }
  for (let x = 0; x < width; x += 1) colFrac[x] = colFrac[x]! / height;

  const rows = brightBounds(rowFrac);
  const cols = brightBounds(colFrac);
  if (!rows || !cols) return null;

  const marginY = Math.round(height * SHEET_MARGIN);
  const marginX = Math.round(width * SHEET_MARGIN);
  const top = Math.max(0, rows.from - marginY);
  const bottom = Math.min(height - 1, rows.to + marginY);
  const left = Math.max(0, cols.from - marginX);
  const right = Math.min(width - 1, cols.to + marginX);
  const box: SheetBox = {
    left,
    top,
    width: right - left + 1,
    height: bottom - top + 1,
  };

  const area = (box.width * box.height) / total;
  if (area < MIN_SHEET_AREA || area > MAX_SHEET_AREA) return null;
  return box;
}
