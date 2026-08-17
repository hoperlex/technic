import { useState } from 'react';
import { Tabs } from 'antd';
import { AccessPeopleTab } from './AccessPeopleTab';
import { AccessProfilesTab } from './AccessProfilesTab';
import { AccessPermissionsTab } from './AccessPermissionsTab';
import { AccessGrantsTab } from './AccessGrantsTab';

/**
 * Вкладка «Права» — модель доступа: три витринных среза и каталог назначаемых полномочий
 * (`docs/permissions-tab-plan.md`, план реструктуризации §12).
 *
 * Три среза читают одни и те же данные: люди (кто что может и почему), профили (сколько живых учёток
 * стоит за каждой строкой матрицы) и права (у кого есть каждое из них). Первый отвечает на вопросы
 * поддержки, два других — на вопросы пересмотра ролей: незанятая роль, совпадающие профили и
 * право, запертое в одной роли, видны только сводкой по всем учёткам сразу.
 *
 * **Четвёртый срез — «Полномочия» — единственный, где доступ правят** (ADR 0106, этап 3): каталог
 * наборов, конструктор состава и реестр выдач. Прежнее «действий здесь нет ни одного» относилось к
 * витрине и остаётся верным для трёх первых срезов: анализ не смешивается с выдачей, и каталог
 * стоит отдельной подвкладкой, а не кнопками внутри срезов. Собственного права ни у одного из
 * четырёх нет — вкладку целиком открывает `users.manage`, и второго права, которым набирают права,
 * модель не заводит намеренно.
 */
export function AccessTab() {
  const [tab, setTab] = useState('people');

  const items = [
    { key: 'people', label: 'Люди', children: <AccessPeopleTab /> },
    { key: 'profiles', label: 'Профили', children: <AccessProfilesTab /> },
    { key: 'permissions', label: 'Права', children: <AccessPermissionsTab /> },
    { key: 'grants', label: 'Полномочия', children: <AccessGrantsTab /> },
  ];

  return (
    <div style={{ height: '100%' }}>
      {/* Полоса всегда компактная: второй уровень навигации не должен спорить по весу с первым — тем же порядком устроены подвкладки «Пользователей» (ADR 0088). */}
      <Tabs
        className="full-height-tabs"
        size="small"
        activeKey={tab}
        onChange={setTab}
        items={items}
      />
    </div>
  );
}
