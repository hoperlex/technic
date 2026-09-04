import { useRef, useState } from 'react';
import { Button, Dropdown, Space, Typography } from 'antd';
import { DownOutlined, LoadingOutlined } from '@ant-design/icons';
import {
  serviceRequestStatusLabels,
  type AuthUser,
  type ServiceRequestDto,
} from '@technic/contracts';
import { ServiceStatusTag, serviceStatusLine } from '@entities/service-request';
import { actionMenuItems, ActionSheet } from '@shared/ui';
import { useIsMobile } from '@shared/lib';
import { serviceStatusChoices, type ServiceMenuItem } from './serviceStatusChoices';

/** Значок у тега: мелкий и приглушённый — он подсказка, а не вторая кнопка рядом с состоянием. */
const CHEVRON = { fontSize: 10, color: 'rgba(0,0,0,0.45)' } as const;

/**
 * Тег статуса как вход в ход заявки (ADR 0161): на десктопе — выпадающий список разрешённых
 * переходов, на телефоне — шит снизу.
 *
 * Живёт на уровне модуля, а не внутри страницы: объявленный в теле компонента, он был бы новым
 * типом на каждый рендер — React разрушал бы поддерево и терял его состояние, из-за чего открытый
 * на телефоне шит закрывался бы сам при любом обновлении списка (урок `WasteStatusCell`).
 *
 * Своего про доступ компонент не знает и знать не должен: пункты приходят готовыми
 * (`serviceStatusChoices` по набору действий). Пустой список означает «ходов нет» — у заявителя, у
 * терминальной заявки, у архивной, — и тогда это обычный тег: кнопка, открывающая пустое меню,
 * читается как поломка портала.
 *
 * Фильтры мест показа (`listMenuItems`, `cardMenuItems`) сюда НЕ применяются, и это не пропуск: тег
 * — объявленный второй вход хода заявки (ADR 0162, признак `statusTag` реестра входов), а не пятое
 * меню. Пропусти мы набор через фильтр карточки, «Отменена · не согласовать объём работ» исчезло бы
 * с тега именно там, где оно и нужнее всего.
 */
export function ServiceStatusCell({
  request,
  items,
  pending,
  showAge,
}: {
  request: ServiceRequestDto;
  /** Набор действий заявки: переходы из него отберёт и подпишет `serviceStatusChoices`. */
  items: ServiceMenuItem[];
  /** Идёт действие именно по этой заявке: тег ждёт ответа и нажатий не принимает. */
  pending: boolean;
  /** Показывать возраст ожидания в теге: в столбце списка — да, в карточке рядом своя строка. */
  showAge?: boolean;
}) {
  const isMobile = useIsMobile();
  const [sheetOpen, setSheetOpen] = useState(false);
  /**
   * Триггер меню: на закрытие фокус возвращается сюда. Тем же приёмом и по той же причине, что в
   * `ActionMenuButton` (ADR 0162): `Escape` меню закрывает, но фокус на триггер antd не возвращает
   * — он остаётся на снятом со страницы пункте, и следующий `Tab` уводит в начало документа.
   */
  const trigger = useRef<HTMLButtonElement>(null);
  /**
   * Открыто ли выпадающее меню. Своим состоянием, хотя antd умеет открывать его сам: `aria-expanded`
   * триггеру он не проставляет, а без него незрячий читатель не знает, раскрылся список или нажатие
   * пропало. Признак нужен только ради подписи — сам показ по-прежнему ведёт antd.
   */
  const [menuOpen, setMenuOpen] = useState(false);
  const choices = serviceStatusChoices(items, request);

  const tag = (
    <ServiceStatusTag
      status={request.status}
      statusChangedAt={showAge ? request.statusChangedAt : undefined}
    />
  );
  if (choices.length === 0) return tag;

  /*
   * Значок справа от тега: шеврон зовёт открыть список, спиннер говорит «идёт действие». Одной
   * заготовкой на оба режима — десктопная кнопка antd своё ожидание рисует сама (`loading`), а на
   * телефоне другого места для индикатора нет: выключенная кнопка без него читается как зависший
   * портал.
   */
  const chevron = pending ? <LoadingOutlined style={CHEVRON} /> : <DownOutlined style={CHEVRON} />;

  // Подпись называет и действие, и текущее состояние: «Изменить статус» без него заставляет
  // читателя экранного диктора искать значение в соседней ячейке.
  const label = `Изменить статус: ${serviceRequestStatusLabels[request.status]}`;

  // На телефоне переходы показываются списком снизу: выпадающее меню у тега в карточке
  // открывается под палец мимо цели, а подписи в нём — те же (ADR 0030).
  if (isMobile) {
    return (
      <>
        <button
          type="button"
          className="status-trigger"
          aria-label={label}
          aria-haspopup="dialog"
          aria-expanded={sheetOpen}
          disabled={pending}
          onClick={(e) => {
            // Тап по тегу не должен заодно открывать карточку заявки: по самой карточке списка
            // нажимают именно ради неё, и второй смысл у того же жеста означал бы «начал действие
            // вместо того, чтобы посмотреть».
            e.stopPropagation();
            setSheetOpen(true);
          }}
        >
          <Space size={4}>
            {tag}
            {chevron}
          </Space>
        </button>
        <ActionSheet
          title="Изменить статус"
          open={sheetOpen}
          onClose={() => setSheetOpen(false)}
          items={choices}
        />
      </>
    );
  }

  return (
    <Dropdown
      trigger={['click']}
      disabled={pending}
      open={menuOpen}
      onOpenChange={(open) => {
        setMenuOpen(open);
        if (!open) trigger.current?.focus();
      }}
      menu={{
        /*
         * Перевод набора в пункты — ОБЩИЙ (`actionMenuItems`, ADR 0162), а не свой `map`.
         *
         * Свой был у каждого места показа, и разошлись они молча: меню строки передавало
         * `disabled`, меню карточки нет — выключенное «Закрыть работы» оттуда нажималось и
         * упиралось в 422. Общая функция вдобавок отдаёт причину запрета ДВАЖДЫ: `title` для мыши
         * и скрытым текстом в подписи для озвучивания, — а список переходов, оставленный со своим
         * переводом, снова показывал бы причину только половине читателей.
         */
        items: actionMenuItems(choices),
        onClick: ({ key, domEvent }) => {
          // Меню рисуется порталом, но событие идёт по дереву React — то есть через строку списка,
          // из которой меню открыли: без остановки выбор перехода открывал бы заодно карточку.
          domEvent.stopPropagation();
          choices.find((item) => item.key === key)?.onClick();
        },
      }}
    >
      <Button
        ref={trigger}
        type="text"
        size="small"
        loading={pending}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        style={{ padding: 0, height: 'auto', border: 'none' }}
        onClick={(e) => e.stopPropagation()}
      >
        <Space size={4}>
          {tag}
          {chevron}
        </Space>
      </Button>
    </Dropdown>
  );
}

/**
 * Ячейка столбца «Статус» (Р100): тег-вход в ход заявки и под ним — подпись состояния «кто тянет и
 * что требуется от меня» (Р101).
 *
 * Отдельным компонентом от самого столбца: у обеих половин ячейки своя длинная причина быть такой,
 * какая они есть, а файл колонок отвечает на вопрос «какие столбцы у списка» и упирается в предел
 * длины (`scripts/quality.mjs`).
 */
export function ServiceStatusLineCell({
  request,
  items,
  pending,
  user,
}: {
  request: ServiceRequestDto;
  items: ServiceMenuItem[];
  pending: boolean;
  user: AuthUser | null;
}) {
  const line = serviceStatusLine(request, user);
  /*
   * Главный шаг состояния — то самое действие, к которому зовёт подпись «Вам: …» (Р117). Берётся
   * из УЖЕ полученного набора (признак `primary` у пункта), а не отдельным обработчиком снаружи:
   * тот строил набор заново — третий раз на ту же строку, — и был вторым источником одного факта.
   * Вторая карта «статус → окно» здесь по-прежнему не заводится: признак ставит тот же модуль,
   * что и сам пункт.
   */
  const act = line?.mine ? (items.find((item) => item.primary)?.onClick ?? null) : null;
  return (
    <div style={{ lineHeight: 1.35 }}>
      <ServiceStatusCell request={request} items={items} pending={pending} showAge />
      {line && (
        <div style={{ fontSize: 12 }}>
          {act ? (
            <Typography.Link
              // Мишень — сам текст, а не ячейка (Р117): строку списка задевают мышью чаще, чем
              // нажимают, а клик по ней открывает карточку — всплыви он, окно действия открылось
              // бы под карточкой.
              onClick={(e) => {
                e.stopPropagation();
                act();
              }}
            >
              {line.text}
            </Typography.Link>
          ) : line.mine ? (
            line.text
          ) : (
            <Typography.Text type="secondary">{line.text}</Typography.Text>
          )}
        </div>
      )}
    </div>
  );
}
