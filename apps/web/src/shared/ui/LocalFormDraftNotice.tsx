import { Alert, Button, Space, Typography } from 'antd';
import type { LocalDraftStatus } from '@shared/lib';

export function LocalFormDraftNotice<Draft extends { id: string; savedAt: number }>({
  active,
  pending,
  status,
  onRestore,
  onDiscard,
  restoring = false,
  restoreDisabled = false,
  fileNotice = false,
  createMayHaveSucceeded = false,
}: {
  active: boolean;
  pending: Draft[];
  status: LocalDraftStatus;
  onRestore: (draft: Draft) => void;
  onDiscard: () => void;
  restoring?: boolean;
  restoreDisabled?: boolean;
  fileNotice?: boolean;
  createMayHaveSucceeded?: boolean;
}) {
  if (pending.length) {
    return (
      <Alert
        type="warning"
        showIcon
        style={{ marginBottom: 12 }}
        title="На этом устройстве есть незавершённая заявка"
        description={
          <Space orientation="vertical" size={8}>
            {createMayHaveSucceeded && (
              <Typography.Text>
                Если заявку уже отправляли и ответ потерялся, проверьте список перед повторной
                отправкой.
              </Typography.Text>
            )}
            {pending.map((candidate) => (
              <Space key={candidate.id} wrap>
                <Typography.Text>
                  Черновик от {new Date(candidate.savedAt).toLocaleString('ru-RU')}
                </Typography.Text>
                <Button
                  size="small"
                  loading={restoring}
                  disabled={restoreDisabled}
                  onClick={() => onRestore(candidate)}
                >
                  Восстановить
                </Button>
              </Space>
            ))}
            <Button size="small" onClick={onDiscard}>
              Удалить черновики и начать заново
            </Button>
          </Space>
        }
      />
    );
  }
  if (!active) return null;
  return (
    <Alert
      type={status.available ? 'info' : 'error'}
      style={{ marginBottom: 12 }}
      description={
        status.available
          ? status.savedAt
            ? `Черновик сохранён на этом устройстве ${new Date(status.savedAt).toLocaleTimeString('ru-RU')}.${fileNotice ? ' Новые файлы нужно прикрепить повторно после закрытия вкладки.' : ''}`
            : `Сохраняем черновик на этом устройстве.${fileNotice ? ' Новые файлы после закрытия вкладки нужно прикрепить повторно.' : ''}`
          : 'Не удалось записать черновик на этом устройстве. Проверьте доступность хранилища браузера; при закрытии вкладки ввод может пропасть.'
      }
    />
  );
}
