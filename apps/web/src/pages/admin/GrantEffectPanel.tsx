import { Alert, Space, Typography } from 'antd';
import {
  MODULE_ENTRY_PERMISSION,
  PERMISSION_CATALOG,
  type Permission,
  type Role,
} from '@technic/contracts';
import { GRANT_MODULE_GROUPS, permissionLabel, roleListText } from './grantModel';

/**
 * Правая часть конструктора (план §12): что набор открывает — какие модули, что на чтение и что на
 * действие, — и чем он не годится.
 *
 * Считается это по отмеченным правам и каталогу прав, то есть по витрине: панель отвечает на «что я
 * собрал», а не на «пустит ли сервер». Приговор приходит от сервера и показывается здесь же готовыми
 * текстами (`violations`) — своего суждения о барьерах у панели нет ни одного, иначе экран начал бы
 * спорить с ответом ручки на глазах у администратора.
 */

interface Props {
  permissions: Permission[];
  roles: Role[];
  /** Нарушения барьеров словами сервера: из предпросмотра правки либо из отказа сохранения. */
  violations: string[];
  /** Строки состава, которых портал больше не знает (право снято из словаря выкатом). */
  unknownPermissions?: string[];
}

/** Права модуля, разложенные на чтение и действие: два разных ответа для того, кто выдаёт набор. */
function splitByAccess(permissions: Permission[]): { read: Permission[]; act: Permission[] } {
  return {
    read: permissions.filter((permission) => PERMISSION_CATALOG[permission].action === 'read'),
    act: permissions.filter((permission) => PERMISSION_CATALOG[permission].action !== 'read'),
  };
}

export function GrantEffectPanel({ permissions, roles, violations, unknownPermissions }: Props) {
  const chosen = new Set(permissions);
  const modules = GRANT_MODULE_GROUPS.map((group) => ({
    ...group,
    chosen: group.permissions.filter((permission) => chosen.has(permission)),
  })).filter((group) => group.chosen.length > 0);

  return (
    <Space orientation="vertical" size={12} style={{ width: '100%' }}>
      {violations.length > 0 && (
        <Alert
          type="error"
          showIcon
          title="Так сохранить нельзя"
          description={
            <Space orientation="vertical" size={4}>
              {violations.map((text) => (
                <span key={text}>{text}</span>
              ))}
            </Space>
          }
        />
      )}

      {unknownPermissions && unknownPermissions.length > 0 && (
        <Alert
          type="warning"
          showIcon
          title="В наборе есть права, которых портал больше не знает"
          // Доступа сирота не даёт никогда, но и молчать о ней нельзя: правка состава уносит её, и
          // администратор должен знать, что состав в базе не совпадал с показанным.
          description={`${unknownPermissions.join(', ')} — правка состава уберёт эти строки из набора.`}
        />
      )}

      <div>
        <Typography.Text strong>Кому можно выдать</Typography.Text>
        <div>
          {roles.length > 0 ? (
            <Typography.Text>{roleListText(roles)}</Typography.Text>
          ) : (
            <Typography.Text type="secondary">
              Роли не отмечены: такой набор не выдаётся никому — он ничего не откроет.
            </Typography.Text>
          )}
        </div>
      </div>

      <div>
        <Typography.Text strong>Открывается модулей: {modules.length}</Typography.Text>
        {modules.length === 0 ? (
          <div>
            <Typography.Text type="secondary">
              Права не отмечены: набор пока ничего не открывает.
            </Typography.Text>
          </div>
        ) : (
          <Space orientation="vertical" size={8} style={{ width: '100%', marginTop: 4 }}>
            {modules.map((group) => {
              const { read, act } = splitByAccess(group.chosen);
              /*
               * Модуль закрывается своим чтением (ADR 0021): набор, давший одно действие, сам по
               * себе раздела не открывает — чтение обязано прийти ролью. Сказать это здесь дешевле,
               * чем получить отказ по барьеру требований на кнопке сохранения.
               */
              const entryMissing = !group.chosen.includes(MODULE_ENTRY_PERMISSION[group.module]);
              return (
                <div key={group.module}>
                  <Typography.Text strong>{group.label}</Typography.Text>
                  {read.length > 0 && (
                    <div>
                      <Typography.Text type="secondary">Смотрит: </Typography.Text>
                      {read.map(permissionLabel).join(', ')}
                    </div>
                  )}
                  {act.length > 0 && (
                    <div>
                      <Typography.Text type="secondary">Действует: </Typography.Text>
                      {act.map(permissionLabel).join(', ')}
                    </div>
                  )}
                  {entryMissing && (
                    <Typography.Text type="warning">
                      Чтения модуля в наборе нет: оно должно прийти должностью, иначе действие
                      останется недостижимым.
                    </Typography.Text>
                  )}
                </div>
              );
            })}
          </Space>
        )}
      </div>
    </Space>
  );
}
