import { Space, Tag, Typography } from 'antd';
import {
  moduleAccess,
  PERMISSION_MODULES,
  permissionModuleLabels,
  roleAddonColors,
  roleAddonLabels,
  roleColors,
  roleLabels,
  type UserAccountDto,
} from '@technic/contracts';
import { effectiveSubject, grantCodeLabel, scopeAnomaly, scopeText } from './accessOverview';

/**
 * Ячейки среза «Люди»: одна учётка, показанная пятью способами.
 *
 * Отдельным файлом, потому что читает их не одна таблица: та же роль с надстройками, те же наборы
 * стоят и в карточке доступа, и в карточке строки на телефоне. Разъедься эти три места, одна и та
 * же учётка выглядела бы в них по-разному — а витрину как раз и открывают, чтобы сверить, что
 * человек может; расхождение вёрстки читалось бы там как расхождение прав.
 *
 * Своего представления о доступе здесь по-прежнему нет ни строчки: модули считаются по правам
 * сервера, подписи и цвета берутся из контрактов.
 */

/**
 * Роль и надстройки одной ячейкой (ADR 0086) — теми же пометками, что в списке учёток: строку
 * ищут глазами по цвету роли, и вторая раскраска сбивала бы. Подписи и цвета берутся из
 * контрактов; повторена здесь только вёрстка — у списка учёток она своя (`userAccountLabels`), и
 * свести две витрины к одной подписи значило бы решать, кто из них кому сосед.
 */
export function roleTags(user: UserAccountDto) {
  if (!user.role) return '—';
  return (
    <Space size={4} wrap>
      <Tag color={roleColors[user.role]}>{roleLabels[user.role]}</Tag>
      {user.addons.map((addon) => (
        <Tag key={addon} color={roleAddonColors[addon]}>
          {roleAddonLabels[addon]}
        </Tag>
      ))}
    </Space>
  );
}

export function personCell(user: UserAccountDto) {
  return (
    <Space orientation="vertical" size={0}>
      <span>{user.fullName}</span>
      <Typography.Text type="secondary">{user.email}</Typography.Text>
    </Space>
  );
}

export function scopeCell(user: UserAccountDto) {
  const anomaly = scopeAnomaly(user);
  return (
    <Space orientation="vertical" size={2}>
      <span>{scopeText(user)}</span>
      {/* Учётка, которая не видит ничего: роль требует области, а области нет. Ради таких строк
          срез и читают, поэтому они помечены предупреждением, а не пропуском. */}
      {anomaly ? <Tag color="warning">{anomaly}</Tag> : null}
    </Space>
  );
}

/**
 * Модули, открытые учётке. Цветом отмечены те, где она действует, серым — те, где только смотрит:
 * «видит» и «работает» — разные ответы, и в витрине их путать нельзя.
 *
 * Считается по серверному списку прав (`effectiveSubject`), а не по роли: модуль, открытый набором,
 * до этого показывался закрытым — то есть витрина отвечала «раздела у него нет» про человека,
 * которому раздел открыт.
 */
export function moduleTags(user: UserAccountDto) {
  const subject = effectiveSubject(user);
  const open = PERMISSION_MODULES.map((module) => ({
    module,
    access: moduleAccess(subject, module),
  })).filter((m) => m.access !== 'none');
  if (open.length === 0) return '—';
  return (
    <Space size={4} wrap>
      {open.map(({ module, access }) => (
        <Tag key={module} color={access === 'write' ? 'blue' : undefined}>
          {permissionModuleLabels[module]}
        </Tag>
      ))}
    </Space>
  );
}

/** Наборы учётки: у системных — подпись, у собранного администратором — код (имён витрина не знает). */
export function grantTags(user: UserAccountDto) {
  if (user.grantCodes.length === 0) return '—';
  return (
    <Space size={4} wrap>
      {user.grantCodes.map((code) => (
        <Tag key={code}>{grantCodeLabel(code)}</Tag>
      ))}
    </Space>
  );
}
