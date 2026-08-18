import { useEffect, useState, type ReactNode } from 'react';
import { Badge, type MenuProps } from 'antd';
import { CustomerServiceOutlined, NotificationOutlined, ReadOutlined } from '@ant-design/icons';
import { useReleases } from '@entities/release';
/*
 * Окно контактов зовётся из легаси-каталога, а не переехало сюда вместе с журналом: его открывает
 * ещё и `quick-create-equipment`, а импорт из фичи в виджет — снизу вверх, то есть запрещённый
 * матрицей границ. Путь относительный — тем же способом окно зовёт сегодня сама фича; уедет оно
 * вместе с ней, а не вместе с каркасом.
 */
import { SupportContactsModal } from '../../../components/SupportContactsModal';
import { ManualsModal } from '../ui/ManualsModal';
import { ReleaseNotesModal } from '../ui/ReleaseNotesModal';

/** Пункт служебного меню. `title` — для свёрнутой панели: там от пункта остаётся одна иконка. */
export interface UtilityMenuItem {
  key: string;
  icon: ReactNode;
  label: string;
  title: string;
  disabled: boolean;
}

export interface UtilityMenuModel {
  /** Пункты как есть: свёрнутая панель рисует их кнопками, а не меню antd. */
  items: UtilityMenuItem[];
  /** Те же пункты полями antd — для подвала панели и меню учётной записи на телефоне (ADR 0030). */
  menuItems: NonNullable<MenuProps['items']>;
  /** Разбор нажатия, один на все места, откуда служебные пункты открывают. */
  openUtility: (key: string) => void;
  /** Узел с окнами: рисует его каркас — там, где окну не мешает ни панель, ни её сворачивание. */
  modals: ReactNode;
  /** Есть непрочитанные выпуски (ADR 0077): точка у пункта и она же на аватаре телефона. */
  hasNews: boolean;
}

/**
 * Служебное меню каркаса: пункты, окна за ними и состояние всех окон в одном месте.
 *
 * Хук, а не компонент, потому что пункты показываются в трёх местах сразу — подвал развёрнутой
 * панели, свёрнутая панель и меню учётной записи на телефоне (ADR 0030), — а состояние окон у них
 * общее. Компонент пришлось бы либо повторить трижды со своим состоянием в каждом, либо накрыть
 * каркас ещё одним контекстом ради трёх булевых значений.
 */
export function useUtilityMenu(): UtilityMenuModel {
  const [manualsOpen, setManualsOpen] = useState(false);
  const [supportOpen, setSupportOpen] = useState(false);
  const [changelogOpen, setChangelogOpen] = useState(false);

  /**
   * Журнал обновлений (ADR 0077). Список спрашивается меню, а не самим окном: он нужен раньше
   * окна — точке в меню, которая и сообщает, что открывать журнал есть зачем.
   */
  const { hasNews, markSeen } = useReleases();

  /*
   * Отметка ставится при открытии окна, а не при закрытии: закрывают и по Esc, и мимо кнопки, — а
   * выпуск к этому моменту уже увидели (ADR 0077).
   *
   * Эффектом, а не строкой в обработчике нажатия: в момент нажатия список мог ещё не доехать, и
   * отмечать было бы нечего — отметка встаёт, как только есть что отмечать, окно при этом уже
   * открыто. Живёт здесь, а не в окне, потому что здесь же считается точка в меню: две копии
   * состояния гасили бы её каждая у себя.
   */
  useEffect(() => {
    if (changelogOpen) markSeen();
  }, [changelogOpen, markSeen]);

  /**
   * Служебные пункты: они не разделы портала и не зависят от прав — читать руководства, писать в
   * поддержку и смотреть журнал обновлений вправе любой вошедший (ADR 0077: право, закрывающее
   * «что нового в портале», пришлось бы выдать всем; у «как пользоваться порталом» причина та же).
   * Страницы за ними нет, поэтому подсветка выключена, а нажатие открывает окно.
   */
  const items: UtilityMenuItem[] = [
    {
      /*
       * Руководства (`docs/manuals-plan.md`) стоят первыми: они отвечают на вопрос «как это
       * делается», а поддержка — на «почему не получилось», и порядок пунктов повторяет порядок
       * действий. Точки «есть новое» здесь нет намеренно: новое руководство — не событие портала,
       * о котором он сигналит, в отличие от выпуска журнала (ADR 0077).
       *
       * Пункт виден всем и всегда, права на него не спрашивают: чтение списка их и не требует
       * (ADR 0021 — правом закрыт только вход на вкладку ведения). Прятать пункт при пустом
       * списке тоже нечем — до открытия окна список ещё не спрашивали, а исчезающий пункт
       * читается как поломка.
       */
      key: 'manuals',
      icon: <ReadOutlined />,
      label: 'Руководства',
      title: 'Руководства',
      disabled: false,
    },
    {
      key: 'support',
      icon: <CustomerServiceOutlined />,
      label: 'Техподдержка',
      // Свёрнутой панели остаётся одна иконка, и `title` — единственное, чем пункт назван.
      title: 'Техподдержка',
      disabled: false,
    },
    {
      key: 'changelog',
      /*
       * Точка, а не число непрочитанных выпусков: в той же панели уже висит счётчик заявок на
       * регистрацию, и два числа рядом начинают спорить за внимание — выигрывает то, которое
       * больше, а не то, которое важнее. «Сколько» здесь ничего и не решает: журнал открывают
       * узнать «что», и одного непрочитанного выпуска для этого достаточно (ADR 0077).
       */
      icon: (
        <Badge dot={hasNews} offset={[4, -2]}>
          <NotificationOutlined />
        </Badge>
      ),
      label: 'Обновления',
      title: 'Обновления',
      disabled: false,
    },
  ];

  /**
   * Разбор ключа один на всех: пункты открываются из трёх мест, и своя ветка у каждого места
   * означала бы три способа ошибиться. Раньше свёрнутая панель звала поддержку на любой пункт:
   * пока «Обновления» стояли выключенными, ошибка была невидимой.
   */
  const openUtility = (key: string) => {
    if (key === 'manuals') setManualsOpen(true);
    if (key === 'support') setSupportOpen(true);
    if (key === 'changelog') setChangelogOpen(true);
  };

  /** Пункт меню antd получает те же поля, что и раньше: `title` нужен только свёрнутой панели. */
  const menuItems: NonNullable<MenuProps['items']> = items.map(
    ({ key, icon, label, disabled }) => ({ key, icon, label, disabled }),
  );

  /** Окна служебные и живут в каркасе: открывают их из меню, а не переходом на страницу. */
  const modals = (
    <>
      <ManualsModal open={manualsOpen} onClose={() => setManualsOpen(false)} />
      <SupportContactsModal open={supportOpen} onClose={() => setSupportOpen(false)} />
      <ReleaseNotesModal open={changelogOpen} onClose={() => setChangelogOpen(false)} />
    </>
  );

  return { items, menuItems, openUtility, modals, hasNews };
}
