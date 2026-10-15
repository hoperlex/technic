import { Alert, Button, Modal, Space, Typography } from 'antd';
import type { DuplicateDraft, Source } from './mechDuplicateStore';

export function MechDuplicateModal({
  selected,
  active,
  busy,
  confirmedId,
  cleanupRequired,
  canCreate,
  onClose,
  onSend,
  onReconcile,
  onCleanup,
  onBeginAnother,
}: {
  selected: Source | null;
  active: DuplicateDraft | null;
  busy: 'send' | 'reconcile' | null;
  confirmedId: string | null;
  cleanupRequired: boolean;
  canCreate: boolean;
  onClose: () => void;
  onSend: () => void;
  onReconcile: () => void;
  onCleanup: () => void;
  onBeginAnother: () => void;
}) {
  return (
    <Modal
      title={selected ? `Дублировать заявку ${selected.displayNumber}` : 'Дублировать заявку'}
      open={!!selected}
      onCancel={onClose}
      footer={
        <Space>
          <Button disabled={!!busy || !!confirmedId} onClick={onClose}>
            Закрыть
          </Button>
          {confirmedId ? (
            cleanupRequired ? (
              <Button loading={busy === 'reconcile'} onClick={onCleanup}>
                Повторить очистку
              </Button>
            ) : (
              <Button type="primary" onClick={onBeginAnother}>
                Создать ещё одну копию
              </Button>
            )
          ) : active?.createAttempt ? (
            <Button loading={busy === 'reconcile'} disabled={!!busy} onClick={onReconcile}>
              Проверить результат
            </Button>
          ) : null}
          {!confirmedId && (
            <Button
              type="primary"
              loading={busy === 'send'}
              disabled={!!busy || !canCreate}
              onClick={onSend}
            >
              {active?.createAttempt ? 'Повторить прежнюю отправку' : 'Дублировать'}
            </Button>
          )}
        </Space>
      }
    >
      {confirmedId ? (
        <Alert
          type={cleanupRequired ? 'error' : 'success'}
          showIcon
          title="Копия создана"
          description={`ID заявки: ${confirmedId}.${cleanupRequired ? ' Сохранённую попытку пока не удалось удалить; новую копию здесь начинать нельзя.' : ' Для ещё одной единицы начните отдельное дублирование.'}`}
        />
      ) : active?.createAttempt ? (
        <Alert
          type="warning"
          showIcon
          title="Результат отправки неизвестен"
          description={`Повтор использует исходный ключ ${active.createAttempt.key}. Новая копия появится только после отдельного действия.`}
        />
      ) : (
        <Typography.Text>
          {active?.nextCreateKey
            ? 'Проверка подтвердила, что копия не создана. Новое нажатие создаст отдельную заявку.'
            : 'Каждое подтверждённое дублирование создаёт отдельную заявку на единицу техники.'}
        </Typography.Text>
      )}
    </Modal>
  );
}
