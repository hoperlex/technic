import { Typography } from 'antd';
import type { HookAPI as ModalApi } from 'antd/es/modal/useModal';
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
 *
 * A plain function of the page's `modal`, not a hook: the submit handler calls it, and a hook's
 * result is a value the cache-invalidation scan cannot open — it left the whole submit unresolved.
 */
export function confirmSubmitDiscrepancies(
  modal: ModalApi,
  discrepancies: SubmitDiscrepancy[],
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    modal.confirm({
      title: 'Проверьте данные перед передачей',
      centered: true,
      maskClosable: false,
      // Binds the window to its layout in styles.css: the buttons stay pinned at the bottom and the
      // text above them scrolls. Without it a long list pushes «Подтверждаю, передать» below the
      // screen edge, and a driver who sees only the return button leaves the day unsent.
      className: 'driver-submit-check',
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
          {/* No bottom margin: the scrolling text must end with the text. A trailing margin left a
              window that scrolled with nothing more to show, and its bottom shade stayed on. */}
          <Typography.Paragraph style={{ marginBottom: 0 }}>
            Подтверждаете ли вы, что значения сняты с приборов верно? Если допущена ошибка,
            вернитесь к форме и исправьте её.
          </Typography.Paragraph>
        </div>
      ),
      onOk: () => resolve(true),
      onCancel: () => resolve(false),
    });
  });
}
