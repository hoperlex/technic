/**
 * Вопрос человеку прямо в терминале.
 *
 * ПОЧЕМУ ЭТО ВООБЩЕ ПОЯВИЛОСЬ. Тяжёлое окно жило по часам: время вышло — окно закрылось. Час или
 * два были числом из воздуха, а цена ошибки несимметрична: недодал времени — окно закрылось,
 * оставив разобранным полдолга; передал — система молотит, когда человек уже занят другим. Оба
 * случая решаются одним вопросом в нужный момент, и задать его может только тот, кто у терминала.
 *
 * ПОЧЕМУ СИНХРОННОЕ ЧТЕНИЕ И ПОЧЕМУ `/dev/tty`. Команда идёт синхронно от начала до конца: ей
 * нечего делать, пока человек думает. А поток ввода у команды может быть занят — заданием на stdin
 * у агента, конвейером, перенаправлением из файла; `/dev/tty` — это сам терминал, независимо от
 * того, что подставили команде.
 *
 * ОТСУТСТВИЕ ТЕРМИНАЛА — НЕ ОШИБКА. Окно могут запустить из хука, из фонового задания, из скрипта.
 * Тогда спрашивать некого, и молчаливое ожидание ответа было бы худшим из исходов: команда висела
 * бы вечно. `null` означает «спросить не у кого», и вызывающий обязан решить сам.
 */
import { closeSync, openSync, readSync } from 'node:fs';
import process from 'node:process';

/** Сколько знаков читаем: ответ здесь — слово или число, а не текст. */
const ANSWER_LIMIT = 64;

/**
 * Спросить строку. `null` — терминала нет.
 *
 * Вопрос печатается в тот же терминал, а не в общий вывод: в перенаправленном выводе он остался бы
 * в файле, и человек смотрел бы на пустой экран, не зная, что от него ждут ответа.
 */
export function askLine(question: string): string | null {
  let tty: number;
  try {
    tty = openSync('/dev/tty', 'r+');
  } catch {
    return null;
  }
  try {
    const buffer = Buffer.alloc(ANSWER_LIMIT);
    process.stdout.write(question);
    const read = readSync(tty, buffer, 0, ANSWER_LIMIT, null);
    return buffer.toString('utf8', 0, read).trim();
  } catch {
    return null;
  } finally {
    closeSync(tty);
  }
}

export interface Choice {
  /** Что нажать: одна буква или цифра. */
  readonly key: string;
  readonly title: string;
  /** Что это значит для вызывающего. */
  readonly value: number;
}

/**
 * Спросить выбор из лестницы.
 *
 * ЛЕСТНИЦА, А НЕ «ДА/НЕТ». Отказ продолжать редко означает «хватит совсем» — чаще «столько не
 * дам». Вопрос, на который есть только два ответа, превращает «дам полчаса» в «закрывай», и
 * система теряет работу, которую успела бы сделать.
 *
 * `null` — терминала нет либо человек отказался: решение за вызывающим.
 */
export function askChoice(question: string, choices: readonly Choice[]): number | null {
  const menu = choices.map((choice) => `[${choice.key}] ${choice.title}`).join('   ');
  return pickChoice(askLine(`${question}\n  ${menu}\n  ответ (пусто — отказ): `), choices);
}

/**
 * Разбор ответа. Отделён от чтения намеренно: чтение требует терминала и в проверке недоступно, а
 * разбор — это правила, и ошибиться в них легче всего.
 */
export function pickChoice(answer: string | null, choices: readonly Choice[]): number | null {
  if (answer === null || answer.trim() === '') return null;

  const key = answer.trim().toLowerCase();
  const picked = choices.find((choice) => choice.key.toLowerCase() === key);
  if (picked !== undefined) return picked.value;

  // Человек вправе назвать своё число: лестница — подсказка, а не ограда.
  const own = Number.parseInt(key, 10);
  return Number.isFinite(own) && own > 0 ? own : null;
}
