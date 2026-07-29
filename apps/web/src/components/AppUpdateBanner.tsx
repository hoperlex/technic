import { useState } from 'react';
import { Alert, Button, Space } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { useIsMobile } from '../hooks/useIsMobile';
import { useVersionCheck } from '../hooks/useVersionCheck';

// Ненавязчивый баннер о новой версии приложения. Перезагрузку инициирует пользователь,
// чтобы не терять заполненные формы. zIndex ниже модалок AntD (1000) — во время
// заполнения формы баннер прячется за маской модалки и не отвлекает.
export function AppUpdateBanner() {
  const { latestBuildId } = useVersionCheck();
  const [dismissedBuildId, setDismissedBuildId] = useState<string | null>(null);
  const isMobile = useIsMobile();

  // Показываем, только если это новый релиз, который пользователь ещё не откладывал.
  if (!latestBuildId || latestBuildId === dismissedBuildId) return null;

  return (
    <div
      role="status"
      style={{
        position: 'fixed',
        insetInline: 0,
        // На мобильном внизу стоит навигация (ADR 0030): баннер садится над ней, иначе кнопки
        // «Обновить» и «Позже» оказались бы под панелью разделов.
        bottom: isMobile ? 'calc(56px + var(--safe-bottom) + 8px)' : 16,
        display: 'flex',
        justifyContent: 'center',
        zIndex: 900,
        pointerEvents: 'none',
        // Узкий экран: баннеру нужны поля, иначе он ложится вплотную к краям.
        ...(isMobile ? { paddingInline: 12 } : {}),
      }}
    >
      <Alert
        type="info"
        showIcon
        message="Доступна новая версия приложения"
        style={{ pointerEvents: 'auto', boxShadow: '0 4px 16px rgba(0, 0, 0, 0.15)' }}
        action={
          <Space>
            <Button
              size="small"
              type="primary"
              icon={<ReloadOutlined />}
              onClick={() => window.location.reload()}
            >
              Обновить
            </Button>
            <Button size="small" type="text" onClick={() => setDismissedBuildId(latestBuildId)}>
              Позже
            </Button>
          </Space>
        }
      />
    </div>
  );
}
