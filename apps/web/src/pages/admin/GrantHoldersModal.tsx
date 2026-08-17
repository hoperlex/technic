import { useState } from 'react';
import { Alert, App, Button, Select, Space, Spin, Tag, Typography } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { roleLabels, type GrantDto, type GrantHolderDto } from '@technic/contracts';
import { userAccountKeys } from '@entities/user-account';
import { DICTIONARY_PAGE_SIZE } from '@shared/config';
import { ViewModal } from '@shared/ui';
import { grantKeys, grantsApi, userGrantsApi, usersApi } from '../../api/resources';
import { errorMessage, formatDateTime } from '../../utils/format';
import { GrantImpactConfirm } from './GrantImpactConfirm';
import { ROLE_MISMATCH_TAG, roleListText, roleMismatchText } from './grantModel';

/**
 * Реестр выдач набора (план §12): у кого полномочие есть, кто его выдал и когда, — и обе операции
 * над этим списком, выдача и отзыв.
 *
 * Обратный срез заведён затем, чтобы забытую выдачу было видно: «сотрудник уволился, а полномочие
 * осталось» решается здесь одной строкой, а не поиском человека по карточкам учёток (§12.3).
 *
 * Обе операции идут через предпросмотр с отпечатком — тем же окном, что и правка набора: цель у них
 * другая (учётка, а не набор), а подтверждается то же самое — показанный расчёт.
 */

interface Props {
  open: boolean;
  /** Строка каталога: ею рисуется шапка, пока едет карточка с реестром. */
  grant: GrantDto;
  onClose: () => void;
}

/** Что подтверждают: выдачу набора этой учётке или отзыв у неё. */
interface Operation {
  kind: 'assign' | 'revoke';
  userId: string;
  fullName: string;
}

/** Строка реестра: кому, чем и когда — плюс пометки, объясняющие странности. */
function HolderRow({ holder, onRevoke }: { holder: GrantHolderDto; onRevoke: () => void }) {
  return (
    <div style={{ borderTop: '1px solid #f0f0f0', padding: '8px 0' }}>
      <Space style={{ width: '100%', justifyContent: 'space-between' }} align="start" wrap>
        <div>
          <Space size={6} wrap>
            <Typography.Text strong>{holder.fullName}</Typography.Text>
            <Typography.Text type="secondary">
              {holder.role ? roleLabels[holder.role] : 'роль не назначена'}
            </Typography.Text>
            {holder.roleMismatch && <Tag color="orange">{ROLE_MISMATCH_TAG}</Tag>}
            {!holder.isActive && <Tag>доступ выключен</Tag>}
            {holder.isArchived && <Tag>в архиве</Tag>}
            {/* Происхождение: выданное переводом ролей снимается откатом перевода, выданное
                руками — только руками, и различать их приходится по строке реестра. */}
            {holder.origin === 'migration' && <Tag color="purple">перевод ролей</Tag>}
          </Space>
          <div>
            <Typography.Text type="secondary">
              {holder.email} · выдал {holder.grantedByName ?? 'неизвестно кто'},{' '}
              {formatDateTime(holder.grantedAt)}
            </Typography.Text>
          </div>
          {/* Тег говорит о несоответствии, а фраза — о его последствии: прав по набору у человека
              нет вовсе, хотя выдача жива. Без неё строка читается как мелкое замечание. */}
          {holder.roleMismatch && (
            <div>
              <Typography.Text type="warning">{roleMismatchText(holder.role)}</Typography.Text>
            </div>
          )}
        </div>
        {/* Имя держателя — в подписи действия: реестр бывает длинным, и «Отозвать» без имени
            одинаково выглядит у всех строк — и для чтения с экрана, и для проверки. */}
        <Button size="small" danger aria-label={`Отозвать: ${holder.fullName}`} onClick={onRevoke}>
          Отозвать
        </Button>
      </Space>
    </div>
  );
}

export function GrantHoldersModal({ open, grant, onClose }: Props) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [userId, setUserId] = useState<string | undefined>(undefined);
  const [operation, setOperation] = useState<Operation | null>(null);

  const { data: card, isFetching } = useQuery({
    queryKey: grantKeys.card(grant.id),
    queryFn: () => grantsApi.get(grant.id),
    enabled: open,
  });

  /**
   * Учётки для выдачи — тем же общим списком, каким их спрашивают фильтры журнала: и там, и здесь
   * нужен полный перечень людей, и второй запрос за тем же ответом лишний.
   */
  const { data: users } = useQuery({
    queryKey: userAccountKeys.options(),
    queryFn: () =>
      usersApi.list({
        page: 1,
        pageSize: DICTIONARY_PAGE_SIZE,
        sortBy: 'fullName',
        sortOrder: 'asc',
      }),
    enabled: open,
  });

  const holders = card?.holders ?? [];
  const held = new Set(holders.map((holder) => holder.userId));
  /*
   * Список отфильтрован совместимостью с ролью (§12): несовместимую пару сервер отклонит 409, и
   * показывать её в выборе значило бы предлагать действие, которого не будет. Недоступное портал
   * скрывает, а не выключает, — поэтому такие учётки из списка убраны, а не помечены.
   */
  const options = (users?.items ?? [])
    .filter(
      (user) =>
        user.isActive &&
        !user.deletedAt &&
        !!user.role &&
        grant.roles.includes(user.role) &&
        !held.has(user.id),
    )
    .map((user) => ({
      value: user.id,
      label: `${user.fullName} — ${user.role ? roleLabels[user.role] : ''}`,
    }));

  const removeMut = useMutation({
    mutationFn: () => grantsApi.remove(grant.id),
    onSuccess: () => {
      message.success('Полномочие удалено');
      void qc.invalidateQueries({ queryKey: grantKeys.root });
      onClose();
    },
    onError: (e) => message.error(errorMessage(e)),
  });

  const applied = (text: string) => {
    message.success(text);
    void qc.invalidateQueries({ queryKey: grantKeys.root });
    // Права учёток изменились — список «Люди» и выборки учёток обязаны это увидеть.
    void qc.invalidateQueries({ queryKey: userAccountKeys.root });
    setOperation(null);
    setUserId(undefined);
  };

  const chosen = options.find((option) => option.value === userId);

  return (
    <>
      <ViewModal
        title={`Выдачи полномочия «${grant.name}»`}
        open={open}
        onClose={onClose}
        width={720}
        destroyOnHidden
        footer={
          <Space>
            {/* Удаление показывается только там, где оно возможно: системный набор не удаляется
                никогда, выданный — до отзыва всех выдач. Ждём приехавшую карточку: до неё «выдач
                нет» означает «реестр ещё не прочитан», и кнопка мигала бы у выданного набора. */}
            {!grant.isSystem && card && holders.length === 0 && (
              <Button danger loading={removeMut.isPending} onClick={() => removeMut.mutate()}>
                Удалить полномочие
              </Button>
            )}
            <Button onClick={onClose}>Закрыть</Button>
          </Space>
        }
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <div>
            <Typography.Text type="secondary">
              {grant.code} · {grant.isSystem ? 'системное' : 'пользовательское'} · прав в наборе:{' '}
              {grant.permissions.length}
            </Typography.Text>
            <div>
              <Typography.Text type="secondary">Совместимые роли: </Typography.Text>
              {roleListText(grant.roles)}
            </div>
          </div>

          {grant.roles.length === 0 ? (
            <Alert
              type="info"
              showIcon
              message="Выдавать этот набор некому"
              description="Совместимых ролей у него нет: отметьте роли в конструкторе, иначе набор не откроет ничего никому."
            />
          ) : (
            <Space align="end" wrap>
              <div>
                <label htmlFor="grant-assignee">
                  <Typography.Text>Кому выдать</Typography.Text>
                </label>
                <div>
                  <Select
                    id="grant-assignee"
                    showSearch
                    optionFilterProp="label"
                    style={{ width: 320 }}
                    placeholder="Учётная запись"
                    value={userId}
                    options={options}
                    onChange={setUserId}
                    notFoundContent="Подходящих учёток нет"
                  />
                </div>
              </div>
              {userId && chosen && (
                <Button
                  type="primary"
                  onClick={() => setOperation({ kind: 'assign', userId, fullName: chosen.label })}
                >
                  Выдать полномочие
                </Button>
              )}
            </Space>
          )}

          <div>
            <Typography.Text strong>Держатели: {holders.length}</Typography.Text>
            {isFetching && holders.length === 0 && <Spin size="small" style={{ marginLeft: 8 }} />}
            {!isFetching && holders.length === 0 && (
              <div>
                <Typography.Text type="secondary">
                  Полномочие пока никому не выдано.
                </Typography.Text>
              </div>
            )}
            {holders.map((holder) => (
              <HolderRow
                key={holder.assignmentId}
                holder={holder}
                onRevoke={() =>
                  setOperation({
                    kind: 'revoke',
                    userId: holder.userId,
                    fullName: holder.fullName,
                  })
                }
              />
            ))}
          </div>
        </Space>
      </ViewModal>

      {operation && (
        <GrantImpactConfirm
          open
          title={
            operation.kind === 'assign'
              ? `Выдача «${grant.name}»: последствия`
              : `Отзыв «${grant.name}»: последствия`
          }
          // Подписи не совпадают с кнопками, которые окно открыли («Выдать полномочие», «Отозвать»):
          // одинаковые слова на кнопке-входе и кнопке-подтверждении читаются как повтор действия.
          okText={operation.kind === 'assign' ? 'Подтвердить выдачу' : 'Подтвердить отзыв'}
          load={() =>
            userGrantsApi.preview(operation.userId, {
              operation: operation.kind,
              grantId: grant.id,
            })
          }
          apply={(impact) =>
            operation.kind === 'assign'
              ? userGrantsApi.assign(operation.userId, {
                  grantId: grant.id,
                  expectedImpactHash: impact.expectedImpactHash,
                })
              : userGrantsApi.revoke(operation.userId, grant.id, impact.expectedImpactHash)
          }
          onClose={() => setOperation(null)}
          onApplied={() =>
            applied(
              operation.kind === 'assign'
                ? `Полномочие выдано: ${operation.fullName}`
                : `Полномочие отозвано: ${operation.fullName}`,
            )
          }
        />
      )}
    </>
  );
}
