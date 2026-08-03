import { describe, expect, it } from 'vitest';
import {
  updateWasteOperatorCommentSchema,
  wasteOperatorCommentEditable,
  wasteRequestCommentLines,
} from '@technic/contracts';

// Комментарий заявки на вывоз разведён по сторонам (ADR 0053): площадка пишет свою строку формой
// заявки, исполнитель — свою, отдельной ручкой. Здесь проверяется контракт этой ручки и то, как
// обе строки собираются к показу: подписи — часть модели, а не верстки конкретного экрана.

const line = (comment: string, operatorComment: string, operatorName: string | null) =>
  wasteRequestCommentLines({ comment, operatorComment, operatorName });

describe('контракт примечания исполнителя', () => {
  it('обрезает пробелы и требует версию заявки', () => {
    const parsed = updateWasteOperatorCommentSchema.parse({
      operatorComment: '  будем после 15:00  ',
      version: 3,
    });
    expect(parsed.operatorComment).toBe('будем после 15:00');
    expect(parsed.version).toBe(3);
    expect(() => updateWasteOperatorCommentSchema.parse({ operatorComment: 'текст' })).toThrow();
  });

  // Пустая строка — это «снять примечание», а не пропущенное поле: сказанное вчера сегодня
  // может быть неправдой, и стереть его должно быть можно тем же полем.
  it('принимает пустую строку — так примечание снимают', () => {
    expect(
      updateWasteOperatorCommentSchema.parse({ operatorComment: '   ', version: 0 })
        .operatorComment,
    ).toBe('');
  });

  it('не принимает текст длиннее комментария площадки и посторонние поля', () => {
    expect(() =>
      updateWasteOperatorCommentSchema.parse({ operatorComment: 'а'.repeat(2001), version: 1 }),
    ).toThrow();
    // Предмет заявки этой ручкой не правят: лишнее поле — ошибка, а не молчаливое «не учли».
    expect(() =>
      updateWasteOperatorCommentSchema.parse({
        operatorComment: 'текст',
        version: 1,
        comment: 'чужая строка',
      }),
    ).toThrow();
  });
});

describe('строки комментария заявки', () => {
  it('подписывает площадку словом, исполнителя — названием контрагента', () => {
    expect(line('заезд со двора', 'будем после 15:00', 'ООО «ЭкоТранс»')).toEqual([
      { key: 'site', label: 'Площадка', text: 'заезд со двора' },
      { key: 'operator', label: 'ООО «ЭкоТранс»', text: 'будем после 15:00' },
    ]);
  });

  it('пустая сторона строкой не показывается', () => {
    expect(line('заезд со двора', '', 'ООО «ЭкоТранс»')).toEqual([
      { key: 'site', label: 'Площадка', text: 'заезд со двора' },
    ]);
    expect(line('', 'будем после 15:00', 'ООО «ЭкоТранс»')).toEqual([
      { key: 'operator', label: 'ООО «ЭкоТранс»', text: 'будем после 15:00' },
    ]);
    expect(line('', '', null)).toEqual([]);
  });

  // Назначение оператора снимают, а написанное им остаётся: подписать его именем контрагента,
  // которого у заявки уже нет, было бы неправдой.
  it('снятый оператор подписывается словом, а не чужим именем', () => {
    expect(line('', 'будем после 15:00', null)).toEqual([
      { key: 'operator', label: 'Оператор', text: 'будем после 15:00' },
    ]);
  });
});

describe('граница правки примечания', () => {
  it('закрытая заявка примечания больше не принимает', () => {
    expect(wasteOperatorCommentEditable('new')).toBe(true);
    expect(wasteOperatorCommentEditable('confirmed')).toBe(true);
    expect(wasteOperatorCommentEditable('done')).toBe(false);
    expect(wasteOperatorCommentEditable('cancelled')).toBe(false);
  });
});
