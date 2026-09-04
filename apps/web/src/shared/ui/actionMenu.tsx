import { useRef, type ReactNode } from 'react';
import { Button, Dropdown, type MenuProps } from 'antd';
import type { ActionSheetItem } from './ActionSheet';

/**
 * Набор действий записи — пунктами выпадающего меню antd.
 *
 * Отдельной функцией, а не одинаковым `map` в каждом месте показа: меню строки списка и меню
 * карточки показывают ОДИН набор, и разойтись им нечем, кроме недосмотра. Так они и разошлись —
 * строка передавала `disabled`, карточка нет, — и выключенный пункт «Закрыть работы» из карточки
 * нажимался, открывал окно и упирался в 422 сервера. Планку держал сервер, а человек получал
 * дверь, за которой отказ.
 *
 * Причина запрета уходит двумя дорогами сразу, потому что читателей у неё двое. Мыши достаётся
 * нативная подсказка (`title`): выключенный пункт событий указателя не отдаёт, и `Tooltip` на нём
 * не открылся бы — тот же приём стоит у «Завершена» в вывозе мусора. Озвучиванию причина достаётся
 * текстом внутри подписи: `title` читают не все программы чтения с экрана и не во всех режимах, а
 * спрятанный текст входит в доступное имя пункта — «Закрыть работы. Сначала подшейте акт…».
 * Видимая подпись при этом остаётся отдельным узлом, и поиск по ней — глазами, тестом или
 * автоматизацией — не ломается.
 *
 * Ничего, кроме перевода набора в пункты, функция не делает: доступность действий считают
 * предикаты контрактов, и второй карты правил здесь нет (см. `serviceRequestMenu.tsx`).
 */
export function actionMenuItems(items: ActionSheetItem[]): NonNullable<MenuProps['items']> {
  return items.map((item) => ({
    key: item.key,
    danger: item.danger,
    disabled: item.disabled,
    title: item.disabledReason,
    label: item.disabledReason ? (
      <>
        <span>{item.label}</span>
        <span className="visually-hidden">. {item.disabledReason}</span>
      </>
    ) : (
      item.label
    ),
  }));
}

/**
 * Кнопка, открывающая меню действий записи, — вместе с возвратом фокуса.
 *
 * Отдельным компонентом ради второго: `Escape` меню закрывает, но фокус на триггер не возвращает.
 * Вернуть его обещает сама библиотека, однако на нынешней паре antd и React ссылка на триггер
 * внутри неё пуста, и фокус остаётся на снятом со страницы пункте — для того, кто ведёт заявки с
 * клавиатуры, это потеря места: следующий `Tab` уводит в начало документа.
 *
 * Возврат сделан на закрытии любым способом, а не только клавишей: мышью он безвреден — кнопка и
 * так под курсором, — а различать способы закрытия значило бы заводить своё состояние там, где
 * достаточно одного обработчика.
 */
export function ActionMenuButton({
  items,
  ariaLabel,
  size,
  icon,
  children,
}: {
  items: ActionSheetItem[];
  ariaLabel?: string;
  size?: 'small' | 'middle' | 'large';
  icon?: ReactNode;
  children?: ReactNode;
}) {
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <Dropdown
      trigger={['click']}
      menu={{
        items: actionMenuItems(items),
        onClick: ({ key }) => items.find((item) => item.key === key)?.onClick(),
      }}
      onOpenChange={(open) => {
        if (!open) trigger.current?.focus();
      }}
    >
      <Button ref={trigger} size={size} icon={icon} aria-label={ariaLabel}>
        {children}
      </Button>
    </Dropdown>
  );
}
