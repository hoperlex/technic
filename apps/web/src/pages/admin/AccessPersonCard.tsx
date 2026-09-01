import { type ReactNode } from 'react';
import { Space, Tag, Typography } from 'antd';
import {
  counterpartyTypeLabels,
  describeAccessScope,
  moduleAccess,
  PERMISSION_CATALOG,
  PERMISSION_MODULES,
  PERMISSIONS_BY_MODULE,
  permissionModuleLabels,
  permissionSources,
  roleAddonLabels,
  roleLabels,
  type AccessSubject,
  type Permission,
  type UserAccountDto,
} from '@technic/contracts';
import { ViewModal } from '@shared/ui';
import {
  effectiveSubject,
  grantCodeLabel,
  scopeAnomaly,
  scopeAxisTitles,
  scopeTargets,
  sourceSubject,
} from './accessOverview';
import { grantTags, roleTags } from './accessPeopleCells';

/**
 * Карточка доступа одной учётки: ответ на «почему он это может», разложенный по правам.
 *
 * Отдельно от списка, потому что отвечает на другой вопрос и другим устройством: список сравнивает
 * людей между собой, карточка разбирает одного — все его права по модулям, у каждого источник, и
 * рядом честная оговорка о том, чего витрина знать не может (какое право пришло каким набором).
 * Вместе со списком это полсотни строк объяснений посреди описания колонок, и первым при чтении
 * теряется как раз объяснение.
 */

/**
 * Откуда у субъекта право — **всеми** источниками сразу, с именем роли или надстройки: «почему» без
 * имени неполно, а «почему» одним источником из четырёх — неверно.
 *
 * Набор подписан без имени: сервер отдаёт объединение прав всех наборов учётки, а не разбивку
 * «какое право из какого» (`PermissionOrigin.grantCode` не заполнен ни у кого), и придумать её
 * витрине нечем — состав набора лежит в базе. Какие наборы у человека есть, говорит соседняя
 * колонка и строка «Наборы» в карточке.
 */
function sourceText(subject: AccessSubject, permission: Permission): string {
  return permissionSources(subject, permission)
    .map((origin) => {
      if (origin.kind === 'addon') {
        return origin.addon ? `надстройка «${roleAddonLabels[origin.addon]}»` : 'надстройка';
      }
      if (origin.kind === 'grant') {
        return origin.grantCode ? `набор «${grantCodeLabel(origin.grantCode)}»` : 'набор';
      }
      if (origin.kind === 'counterparty') {
        return subject.counterpartyType
          ? `контрагент: ${counterpartyTypeLabels[subject.counterpartyType]}`
          : 'контрагент';
      }
      return subject.role ? `роль «${roleLabels[subject.role]}»` : 'роль';
    })
    .join(' · ');
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <Typography.Title level={5} style={{ marginTop: 0 }}>
        {title}
      </Typography.Title>
      {children}
    </section>
  );
}

interface CardProps {
  /** `null` — карточка закрыта; поля берутся из строки списка, отдельный запрос за ними не нужен. */
  user: UserAccountDto | null;
  onClose: () => void;
}

/**
 * Карточка доступа: область словами, все права по модулям с источником у каждого и перечень
 * закрытых модулей. Окном просмотра, а не разворотом строки: набор прав администратора — это
 * четыре десятка строк, и в раскрытой строке таблицы он выдавил бы с экрана сам список.
 */
export function AccessCard({ user, onClose }: CardProps) {
  /*
   * Два субъекта на одну карточку, и это не дублирование. Первый отвечает по правам сервера — им
   * считаются открытые модули и область; второй объясняет источники, и в нём наборам отданы только
   * те права, которых матрица объяснить не может. Подставь список сервера в источники — и «набор»
   * стал бы подписью у каждого права, включая ролевые.
   */
  const subject = user ? effectiveSubject(user) : null;
  const origins = user ? sourceSubject(user) : null;
  // Права — из ответа сервера, а не из матрицы: строка карточки обязана перечислять то, что человек
  // действительно может, а объяснение к ней стоит рядом и может быть неполным.
  const held = new Set<Permission>(user?.permissions ?? []);
  const modules = subject
    ? PERMISSION_MODULES.map((module) => ({
        module,
        access: moduleAccess(subject, module),
        granted: PERMISSIONS_BY_MODULE[module].filter((p) => held.has(p)),
      }))
    : [];
  const closed = modules.filter((m) => m.access === 'none');
  const open = modules.filter((m) => m.access !== 'none');
  const targets = user ? scopeTargets(user) : null;
  const anomaly = user ? scopeAnomaly(user) : null;

  return (
    <ViewModal
      title={user ? user.fullName : 'Доступ'}
      open={!!user}
      onClose={onClose}
      width={720}
      // Карточку переоткрывают на соседней учётке — содержимое прошлой ей не годится.
      destroyOnHidden
      footer={null}
    >
      {user && subject && origins && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <Space orientation="vertical" size={4}>
            <Typography.Text type="secondary">{user.email}</Typography.Text>
            {roleTags(user)}
          </Space>

          {/* Наборы (ADR 0106) — рядом с ролью, а не в конце: с ними человек может больше, чем его
              должность, и читать список прав, не зная о них, значит приписывать всё роли. */}
          <Section title="Наборы">
            {user.grantCodes.length === 0 ? (
              <Typography.Text type="secondary">
                Наборов нет: всё, что человек может, идёт от должности.
              </Typography.Text>
            ) : (
              <Space orientation="vertical" size={4}>
                {grantTags(user)}
                {/* Ограничение названо прямо: витрина знает, какие наборы выданы, но не знает их
                    состава — сервер отдаёт объединение прав, а не разбивку по наборам. Догадка «это
                    право, наверное, из этого набора» была бы хуже честного молчания: по ней решают,
                    что отзывать. */}
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  Какое право пришло каким набором, витрина не знает: набор подписан у тех прав,
                  которых должность не даёт.
                </Typography.Text>
              </Space>
            )}
          </Section>

          <Section title="Область">
            <ul style={{ margin: 0, paddingLeft: 20 }}>
              {describeAccessScope(subject).map((rule) => (
                <li key={rule}>{rule}</li>
              ))}
            </ul>
            {targets?.axis ? (
              <div style={{ marginTop: 8 }}>
                <Typography.Text type="secondary">
                  {scopeAxisTitles[targets.axis]}:{' '}
                </Typography.Text>
                {targets.items.length > 0 ? targets.items.join(', ') : 'не заданы'}
              </div>
            ) : null}
            {anomaly ? (
              <div style={{ marginTop: 8 }}>
                <Tag color="warning">{anomaly}</Tag>
              </div>
            ) : null}
          </Section>

          <Section title="Что может">
            {open.length === 0 ? (
              <Typography.Text type="secondary">
                Прав нет ни одного: без роли учётка для портала — никто.
              </Typography.Text>
            ) : (
              <Space orientation="vertical" size={12} style={{ display: 'flex' }}>
                {open.map(({ module, granted }) => (
                  <div key={module}>
                    <Typography.Text strong>{permissionModuleLabels[module]}</Typography.Text>
                    {granted.map((permission) => (
                      <div key={permission}>
                        {PERMISSION_CATALOG[permission].label}{' '}
                        {/* Источник права — мелким вторичным текстом: спрашивают его не в каждой
                            строке, но ответ должен стоять именно у той строки, о которой спросили. */}
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          {sourceText(origins, permission)}
                        </Typography.Text>
                      </div>
                    ))}
                  </div>
                ))}
              </Space>
            )}
          </Section>

          <Section title="Закрыто">
            {closed.length === 0 ? (
              <Typography.Text type="secondary">Закрытых модулей нет.</Typography.Text>
            ) : (
              <Space size={4} wrap>
                {closed.map(({ module }) => (
                  <Tag key={module}>{permissionModuleLabels[module]}</Tag>
                ))}
              </Space>
            )}
          </Section>
        </div>
      )}
    </ViewModal>
  );
}
