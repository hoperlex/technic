import { useState } from 'react';
import { Alert, Button, Space } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { useLocation } from 'react-router';
import { useIsMobile } from '@shared/lib';
import { useVersionCheck } from '@shared/lib';

// Ненавязчивый баннер о новой версии приложения. Перезагрузку инициирует пользователь,
// чтобы не терять заполненные формы. zIndex ниже модалок AntD (1000) — во время
// заполнения формы баннер прячется за маской модалки и не отвлекает.
//
// Кроме кабинета водителя: там «Позже» нет, и это не мелочь оформления (план
// driver-readings-first, Р13 п. 3). Устаревшая вкладка кабинета пишет черновик показаний в
// хранилище браузера сама, без сети, — и пишет его в прежнем формате: цена отложенного обновления
// здесь не «страница постарела», а расхождение форматов введённого, которое потом разбирает
// человек переносом чисел. Открытой формы, ради которой «Позже» и заведено, в кабинете при этом
// нет: показания живут в черновике и переживают перезагрузку целиком, а на телефоне в кабине
// откладывать обновление второй раз всё равно некому.
export function AppUpdateBanner() {
  const { latestBuildId } = useVersionCheck();
  const [dismissedBuildId, setDismissedBuildId] = useState<string | null>(null);
  const isMobile = useIsMobile();
  const { pathname } = useLocation();
  // Ровно ветка кабинета, а не всё, что начинается с этих букв: `startsWith('/driver')` накрыл бы
  // и будущий раздел портала вроде «/drivers», где открытая форма стоит дороже свежей вкладки.
  const driverCabinet = pathname === '/driver' || pathname.startsWith('/driver/');

  // Показываем, только если это новый релиз, который пользователь ещё не откладывал.
  if (!latestBuildId || latestBuildId === dismissedBuildId) return null;

  return (
    <div
      role="status"
      style={{
        position: 'fixed',
        insetInline: 0,
        // На мобильном внизу стоит навигация (ADR 0030): баннер садится над ней, иначе кнопка
        // «Обновить» (а в портале и «Позже») оказалась бы под панелью разделов.
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
            {!driverCabinet && (
              <Button size="small" type="text" onClick={() => setDismissedBuildId(latestBuildId)}>
                Позже
              </Button>
            )}
          </Space>
        }
      />
    </div>
  );
}
