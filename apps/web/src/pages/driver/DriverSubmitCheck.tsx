import { useCallback } from 'react';
import { App, Typography } from 'antd';
import type { SubmitDiscrepancy } from './readingsSubmit';

/**
 * The window before a day with discrepancies leaves the phone (ADR 0237): the only way past a
 * counter that fell, an implausible growth, an unconfirmed server anomaly or a fuel start that is
 * not the end of the previous shift. It replaced the «Всё верно» checkbox inside the block: a
 * checkbox left ticked an hour ago answered a question nobody was asking now, while the window asks
 * once, at the moment of sending, and lists every discrepancy of the day together.
 *
 * Resolves `true` only on the explicit «Подтверждаю, передать»: closing the window, Escape and the
 * return button all resolve `false`, and the page then sends nothing and opens no attempt — the
 * driver goes back to the form. The wording is the owner's request for a formal text; it names no
 * fault, because a discrepancy is often true (a counter replaced, the tank topped up from the side).
 */
export function useSubmitCheck(): (discrepancies: SubmitDiscrepancy[]) => Promise<boolean> {
  const { modal } = App.useApp();
  return useCallback(
    (discrepancies) =>
      new Promise<boolean>((resolve) => {
        modal.confirm({
          title: 'Проверьте данные перед передачей',
          centered: true,
          maskClosable: false,
          okText: 'Подтверждаю, передать',
          cancelText: 'Вернуться к исправлению',
          // Large, as the footer's button: a gloved finger needs the target (the theme gives 60 px).
          okButtonProps: { size: 'large' },
          cancelButtonProps: { size: 'large' },
          content: (
            <div>
              <Typography.Paragraph>
                В указанных данных выявлены следующие расхождения:
              </Typography.Paragraph>
              <ol style={{ paddingLeft: 20 }}>
                {discrepancies.flatMap((entry) =>
                  entry.notes.map((note, index) => (
                    <li key={`${entry.itemId}:${index}`}>
                      <Typography.Text strong>{entry.label}</Typography.Text>
                      {` — ${note}`}
                    </li>
                  )),
                )}
              </ol>
              <Typography.Paragraph>
                Подтверждаете ли вы, что значения сняты с приборов верно? Если допущена ошибка,
                вернитесь к форме и исправьте её.
              </Typography.Paragraph>
            </div>
          ),
          onOk: () => resolve(true),
          onCancel: () => resolve(false),
        });
      }),
    [modal],
  );
}
