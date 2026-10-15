import { Alert, Button, Popconfirm, Space } from 'antd';

export function RequestCreateAttemptNotice({
  pending,
  legacy,
  checking,
  onCheck,
  onLegacyReset,
}: {
  pending: boolean;
  legacy?: boolean;
  checking: boolean;
  onCheck: () => void;
  onLegacyReset?: () => void;
}) {
  if (!pending) return null;
  return (
    <Alert
      type="warning"
      showIcon
      style={{ marginBottom: 12 }}
      title={legacy ? 'Исход прежней отправки требует ручной проверки' : 'Исход отправки ещё не подтверждён'}
      description={
        <Space orientation="vertical">
          {legacy ? (
            <>
              Эта попытка создана прежней версией портала. Проверьте заявку в списке вручную:
              автоматическая проверка не может установить её исход. После проверки можно открыть
              новую отправку с сохранёнными полями.
              {onLegacyReset && (
                <Popconfirm
                  title="Сбросить старую попытку?"
                  description="Первая отправка ещё может завершиться позже. Новая отправка может создать дубль заявки. Сначала проверьте список."
                  okText="Сбросить после проверки"
                  cancelText="Отмена"
                  onConfirm={onLegacyReset}
                >
                  <Button size="small">Начать новую отправку</Button>
                </Popconfirm>
              )}
            </>
          ) : (
            <>
              Изменения в форме сохраняются, но повторная отправка использует исходные данные.
              Проверьте результат, прежде чем исправлять и отправлять их заново.
              <Button size="small" loading={checking} onClick={onCheck}>
                Проверить создание
              </Button>
            </>
          )}
        </Space>
      }
    />
  );
}
