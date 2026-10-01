import { Button } from 'antd';
import type { ReactNode } from 'react';
import { Link } from 'react-router';
import type { VehicleRequestDto } from '@technic/contracts';

/**
 * Vehicle request card footer actions: edit, copy, open in the list, and close.
 *
 * This stays separate for the same reason the lifecycle descriptions moved out of the modal:
 * `VehicleRequestViewModal` is covered by the max-lines ratchet. Moving the whole footer keeps
 * the answer to "what can the user do after reading the card?" in one place.
 *
 * Return an array because `ViewModal` accepts footer nodes and lays them out itself. A wrapper
 * component would add an extra DOM node and break the equal-width mobile footer layout.
 */
export function vehicleRequestCardFooter({
  request,
  onClose,
  onEdit,
  onCopy,
  requestListHref,
  isMobile,
}: {
  /** null — окно закрыто; тогда от футера остаётся одна «Закрыть». */
  request: VehicleRequestDto | null;
  onClose: () => void;
  onEdit?: (r: VehicleRequestDto) => void;
  onCopy?: (r: VehicleRequestDto) => void;
  /**
   * Адрес вкладки раздела с открытой карточкой этой же заявки; `null` — двери нет (читалку
   * открыли без права на архив, и ссылка кончилась бы отказом).
   */
  requestListHref: string | null;
  isMobile: boolean;
}): ReactNode[] {
  return [
    ...(request && onEdit
      ? [
          <Button key="edit" type="primary" onClick={() => onEdit(request)}>
            Редактировать
          </Button>,
        ]
      : []),
    // Копия заказа (ADR 0173): обычной кнопкой, а не главной, — главное действие карточки одно, и
    // повтор заказа не оно. Стоит рядом с правкой: обе ведут в ту же форму, и разница между ними —
    // «поправить эту» или «завести такую же».
    //
    // Надписью взят второй из этих вопросов, а не «Создать копию» (ADR 0206): копию снимают теперь
    // с заявки любого статуса, и у выполненной «копия» обещала бы наследование её состояния —
    // техники, рейса, факта, — которого в новой заявке не будет. Заводится новый заказ по образцу.
    ...(request && onCopy
      ? [
          <Button key="copy" onClick={() => onCopy(request)}>
            Завести такую же
          </Button>,
        ]
      : []),
    // Читалку действия не ведут — вместо них дверь туда, где ведут: в список заявок с открытой
    // карточкой этой же заявки (план §3.5). Адрес считается по уже загруженному DTO, потому что
    // одного статуса мало: удалённая заявка живёт в архиве, и выбирает его `deletedAt`. Он же
    // закрыт своим правом — без `archive.read` адреса не будет вовсе (`vehicleRequestLink` вернёт
    // `null`), и кнопки тогда нет: ссылка, кончающаяся отказом, хуже её отсутствия.
    //
    // Настоящей ссылкой, а не `navigate` по нажатию: список заявок открывают соседней вкладкой,
    // оставив рейс на экране, — тем же приёмом, что и `EntityLink`. Переход при этом уносит из
    // адреса `request` и `route`, и окна закрываются сами: состояние окон живёт только в
    // адресе (§3.1).
    ...(requestListHref
      ? [
          <Link key="list" to={requestListHref}>
            {/* На телефоне кнопки футера делят ширину поровну (`.sheet-footer`), и делит её
              ссылка, а не кнопка внутри неё: без `block` кнопка осталась бы по тексту, а соседняя
              «Закрыть» — во всю свою долю. */}
            <Button type="primary" block={isMobile}>
              Открыть в списке заявок
            </Button>
          </Link>,
        ]
      : []),
    <Button key="close" onClick={onClose}>
      Закрыть
    </Button>,
  ];
}
