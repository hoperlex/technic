/**
 * Задание в виде документа, который человек открывает и отдаёт агенту в редакторе.
 *
 * Пока адаптер ручной, этот файл и есть протокол: система его пишет, человек передаёт, агент
 * исполняет, система читает ответ. Поэтому документ обязан быть читаемым обоими — без
 * служебного шума и с явно названным местом, куда положить ответ.
 */
import type { WorkPacket } from './types.ts';

/** Сколько путей показывать списком: дальше перечень перестаёт читаться и мешает увидеть границу. */
const SCOPE_LIST_LIMIT = 60;

const ROLE_TITLE: Record<WorkPacket['role'], string> = {
  reviewer: 'Ревьюер: найти и описать, не править',
  fixer: 'Исполнитель: исправить утверждённое, не искать новое',
};

export function renderPacket(packet: WorkPacket): string {
  const lines: string[] = [];
  const say = (text = '') => lines.push(text);

  say(`# ${ROLE_TITLE[packet.role]}`);
  say();
  say('> Задание собрано системой обслуживания кодовой базы. Выйти за описанные здесь границы');
  say('> нельзя: то, что не поместилось в задание, — предмет следующего задания, а не этого.');
  say();
  say('## Цель');
  say();
  say(packet.goal);
  say();

  say('## Область работы');
  say();
  if (packet.scope.length === 0) {
    say('Область не ограничена списком файлов — работайте в пределах, названных в фактах.');
  } else {
    /*
     * Перечень обрезается, и это не экономия места. Задание на две тысячи путей перестаёт быть
     * заданием: читатель — и человек, и модель — видит стену имён вместо границы работы, а сама
     * граница тонет. При полном обзоре ориентиры дают факты: крупнейшие файлы, нарушения, домены.
     */
    for (const item of packet.scope.slice(0, SCOPE_LIST_LIMIT)) say(`- ${item}`);
    if (packet.scope.length > SCOPE_LIST_LIMIT) {
      say(
        `- … и ещё ${packet.scope.length - SCOPE_LIST_LIMIT} файлов: полный список в снимке фактов, ` +
          '`.maintenance/context/project-facts.json`',
      );
    }
  }
  say();

  for (const input of packet.inputs) {
    say(`## ${input.title}`);
    say();
    say(input.body.trim());
    say();
  }

  say('## Ограничения');
  say();
  for (const item of packet.constraints) say(`- ${item}`);
  say();

  say('## Запрещено');
  say();
  for (const item of packet.forbidden) say(`- ${item}`);
  say();

  say('## Ответ');
  say();
  say(packet.expectedOutput.trim());
  say();
  say(`Положите ответ в файл \`${packet.outputFile}\` — строго в этой форме:`);
  say();
  say('```json');
  say(packet.outputSchema.trim());
  say('```');
  say();
  return `${lines.join('\n')}\n`;
}
