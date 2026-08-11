import { Tabs } from 'antd';
import { useQueryClient } from '@tanstack/react-query';
import { useIsMobile } from '@shared/lib';
import { useAuth } from '../auth/AuthContext';
import { UsersTab } from './admin/UsersTab';
import { AccessTab } from './admin/AccessTab';
import { MailingsTab } from './admin/MailingsTab';
import { DirectoryTransferTab } from './admin/DirectoryTransferTab';

export function AdministrationPage() {
  // Компактная полоса вкладок на телефоне — как в справочниках: на 360 px обычная съедает
  // высоту, которой не хватает списку.
  const isMobile = useIsMobile();
  const { can } = useAuth();
  const qc = useQueryClient();
  /**
   * То же, что в справочниках: скрытая вкладка не размонтируется, и по возвращении показала бы
   * кэш. Здесь связи между вкладками прямые — выданное на «Пользователях» право видно в витрине
   * прав, а импорт справочником меняет то, что показывают все остальные разделы.
   */
  const refreshOnSwitch = () => void qc.invalidateQueries();
  // Вкладки — по правам, а не по роли: рассылками занимается тот, кто отвечает за оповещения, и
  // это не обязательно тот же человек, который выдаёт доступы.
  const items = [
    ...(can('users.manage')
      ? [{ key: 'users', label: 'Пользователи', children: <UsersTab /> }]
      : []),
    // Витрина прав (`docs/permissions-tab-plan.md`) стоит рядом с учётками и открыта тем же
    // правом: доступ выдают на соседней вкладке, а здесь смотрят, что из этого вышло. Своего
    // права у неё нет — действий в ней нет тоже.
    ...(can('users.manage') ? [{ key: 'access', label: 'Права', children: <AccessTab /> }] : []),
    ...(can('mailings.read')
      ? [{ key: 'mailings', label: 'Рассылки', children: <MailingsTab /> }]
      : []),
    // Обмен справочниками файлом (ADR 0073) живёт здесь, а не на вкладках самих справочников:
    // одно действие — одно место, и так оно покрывает в том числе справочники без своей вкладки
    // (виды ТС, модели, категории квалификаций, привязки ТТХ).
    ...(can('directories.export')
      ? [
          {
            key: 'directory-transfer',
            label: 'Обмен справочниками',
            children: <DirectoryTransferTab />,
          },
        ]
      : []),
  ];
  return (
    <div style={{ height: '100%' }}>
      <Tabs
        className="full-height-tabs"
        size={isMobile ? 'small' : undefined}
        defaultActiveKey={items[0]?.key}
        onChange={refreshOnSwitch}
        items={items}
      />
    </div>
  );
}
