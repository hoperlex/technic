import { Alert, Button, Space, Typography } from 'antd';
import type { DuplicateDraft } from './mechDuplicateStore';

export function MechDuplicateNotice({
  saved,
  busy,
  onOpen,
}: {
  saved: DuplicateDraft[];
  busy: boolean;
  onOpen: (item: DuplicateDraft) => void;
}) {
  if (!saved.length) return null;
  return (
    <Alert
      type="warning"
      showIcon
      style={{ marginBottom: 12 }}
      title="Есть незавершённое дублирование заявки"
      description={
        <Space orientation="vertical" size={8}>
          <Typography.Text>
            Проверьте исход отправки перед новой копией. Если сервер подтвердил, что копия не
            создана, её можно создать отдельным нажатием.
          </Typography.Text>
          {saved.map((item) => (
            <Button key={item.id} size="small" disabled={busy} onClick={() => onOpen(item)}>
              {item.nextCreateKey ? 'Продолжить дублирование' : 'Проверить копию'}{' '}
              {item.payload.displayNumber} от {new Date(item.savedAt).toLocaleString('ru-RU')}
            </Button>
          ))}
        </Space>
      }
    />
  );
}
