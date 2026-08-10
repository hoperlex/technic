import { useState } from 'react';
import { Tabs } from 'antd';
import { AccessPeopleTab } from './AccessPeopleTab';
import { AccessProfilesTab } from './AccessProfilesTab';
import { AccessPermissionsTab } from './AccessPermissionsTab';

/**
 * Вкладка «Права» — витрина действующей модели доступа (`docs/permissions-tab-plan.md`).
 *
 * Три среза одних и тех же данных: люди (кто что может и почему), профили (сколько живых учёток
 * стоит за каждой строкой матрицы) и права (у кого есть каждое из них). Первый отвечает на вопросы
 * поддержки, два других — на вопросы пересмотра ролей: незанятая роль, совпадающие профили и
 * право, запертое в одной роли, видны только сводкой по всем учёткам сразу.
 *
 * Действий здесь нет ни одного, и это не этап работы, а решение: выдача прав — предмет отдельной
 * панели, и смешивать её с анализом нельзя, пока роли не пересмотрены. Отсюда же отсутствие
 * собственного права: право заводится вместе с действием, а вкладку открывает `users.manage`.
 */
export function AccessTab() {
  const [tab, setTab] = useState('people');

  const items = [
    { key: 'people', label: 'Люди', children: <AccessPeopleTab /> },
    { key: 'profiles', label: 'Профили', children: <AccessProfilesTab /> },
    { key: 'permissions', label: 'Права', children: <AccessPermissionsTab /> },
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
