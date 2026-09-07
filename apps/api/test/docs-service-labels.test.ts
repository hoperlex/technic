import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  SERVICE_LABELS_PATH,
  buildServiceLabels,
  serviceLabelsText,
} from '../scripts/docs-service-labels';

/**
 * Страж словаря названий для документов — этап Э1 плана
 * `docs/office-equipment-requester-guide-update-plan.md` (субзадача С7).
 *
 * ЗАЧЕМ. Памятка заявителю собирается из `docs/labels/service-request-labels.json`, а файл этот —
 * копия контрактов на диске. Копия без стража живёт до первого переименования: именно так документ
 * пережил переименования статусов `assigned` и `estimate_review`, ни разу о них не узнав (находка
 * Н7 плана). Тест ловит оба случая, которыми копия расходится: контракты поменяли, а файл не
 * пересобрали — и файл поправили руками, минуя контракты.
 *
 * ПОЧЕМУ СРАВНИВАЕТСЯ ТЕКСТ, А НЕ РАЗОБРАННЫЙ ОБЪЕКТ. Проверяются оба: объект отвечает за
 * содержание, текст — за то, что файл лежит ровно в том виде, в каком его пишет экспортёр (два
 * пробела и перевод строки в конце). Иначе `pnpm format:check` и этот тест спорили бы о файле,
 * который ни один из них не собирает.
 */
describe('словарь названий для документов', () => {
  const onDisk = readFileSync(SERVICE_LABELS_PATH, 'utf8');
  const hint = 'пересоберите: pnpm --filter @technic/api docs:labels';

  it(`совпадает с контрактами (${hint})`, () => {
    expect(JSON.parse(onDisk)).toEqual(buildServiceLabels());
  });

  it(`лежит в том же виде, в каком его пишет экспортёр (${hint})`, () => {
    expect(onDisk).toBe(serviceLabelsText());
  });

  /**
   * Памятка обещает читателю только те состояния, в которые заявка попадает. Проверка стоит здесь,
   * а не в генераторе: живой статус вычисляется достижимостью, и ошибка в вычислении — это ошибка
   * словаря, а не документа.
   */
  it('называет живыми ровно те статусы, в которые заявка попадает', () => {
    const live = buildServiceLabels()
      .statuses.filter((status) => status.live)
      .map((status) => status.value);
    expect(live).toEqual(['new', 'in_work', 'on_hold', 'done', 'accepted', 'cancelled']);
  });

  /** Матрица §4.1 плана карточки заявителя: два вида видно, приложить можно один. */
  it('держит перечень документов заявителя из матрицы аудиторий', () => {
    const { fileKinds } = buildServiceLabels();
    expect(fileKinds.filter((kind) => kind.visibleToRequester).map((kind) => kind.value)).toEqual([
      'attachment',
      'warranty_card',
    ]);
    expect(
      fileKinds.filter((kind) => kind.attachableByRequester).map((kind) => kind.value),
    ).toEqual(['attachment']);
  });
});
