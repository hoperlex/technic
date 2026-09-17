/**
 * Ручной адаптер: задание относит человек.
 *
 * Это сегодняшний порядок работы, оформленный в интерфейс, а не новая возможность. Ценность
 * оформления в том, что ручной способ перестаёт быть «отсутствием адаптера»: цикл зовёт одну и ту
 * же `deliver`, а разницу между человеком и командой видит только исход. Заодно ручной адаптер
 * остаётся запасным путём — когда внешнего агента нет или ему нельзя показывать дерево.
 */
import path from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { AgentAdapter, AgentContext, AgentReply } from './adapter.ts';
import type { WorkPacket } from '../work-packets/types.ts';
import { renderPacket } from '../work-packets/render.ts';

export function manualAdapter(): AgentAdapter {
  return {
    id: 'manual',
    title: 'Ручная передача: человек отдаёт задание агенту и кладёт ответ в файл',
    deliver(packet: WorkPacket, context: AgentContext): AgentReply {
      // Задание переписывается при каждой доставке: человек мог отдать агенту старый текст, и
      // тогда расхождение между заданием на диске и намерением системы стоит дороже лишней записи.
      writeTask(packet, context);

      // Ответ читается ровно в том месте, которое названо агенту в самом задании. Если файла нет,
      // ждём — это не поломка, а нормальное состояние ручного цикла между двумя командами.
      if (!existsSync(context.answerFile)) {
        return { kind: 'awaiting', where: relative(context) };
      }
      const text = readFileSync(context.answerFile, 'utf8');
      // Пустой файл — почти наверняка следствие оборванного копирования: агент не отвечает
      // пустотой. Считать его ответом значило бы получить «ни одной находки» вместо вопроса.
      if (text.trim() === '') return { kind: 'awaiting', where: relative(context) };
      return { kind: 'answer', text };
    },
  };
}

/**
 * Свежесть ответа здесь НЕ проверяется — и это осознанно.
 *
 * Отличить ответ этого прохода от ответа прошлого по времени файла нельзя надёжно: человек мог
 * подготовить его заранее или скопировать с сохранением дат. Поэтому ответы прошлого прохода
 * убирает тот, кто знает про проходы, — цикл в `cli/converge.ts` перед выдачей нового задания.
 */
function writeTask(packet: WorkPacket, context: AgentContext): void {
  mkdirSync(path.dirname(context.taskFile), { recursive: true });
  mkdirSync(path.dirname(context.answerFile), { recursive: true });
  writeFileSync(context.taskFile, renderPacket(packet, 'file'), 'utf8');
}

/** Путь печатается человеку, поэтому он относительный: абсолютный в терминале только мешает. */
function relative(context: AgentContext): string {
  return path.relative(context.root, context.answerFile) || context.answerFile;
}
