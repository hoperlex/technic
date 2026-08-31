import { useState, useSyncExternalStore } from 'react';
import { Alert, Button, Space, Typography } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { useLocation } from 'react-router';
import { isClientUpgradeRequired, onClientUpgradeRequired } from '@shared/api';
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
//
// Второй режим того же компонента — ТРЕБОВАНИЕ обновиться, а не предложение (ADR 0146, решение 7).
// Его включает отказ сервера `426 client_upgrade_required`: сборка вкладки ниже пола
// `MIN_CLIENT_CONTRACT`, и работать она уже не будет — ни этот запрос, ни следующие. Отменить его
// нечем, и это ровно то, чего не умеет баннер выше: «Позже» пережило бы оба выпуска.
//
// Оба режима держит один компонент, потому что говорят они об одном («страница устарела») и
// показываться вместе не должны: предложение под требованием читалось бы как выбор, которого нет.
export function AppUpdateBanner() {
  const { latestBuildId } = useVersionCheck();
  const [dismissedBuildId, setDismissedBuildId] = useState<string | null>(null);
  const isMobile = useIsMobile();
  const { pathname } = useLocation();
  // Требование живёт вне дерева React — его ставит транспорт, отвечая на чужой запрос, — поэтому
  // подпиской, а не состоянием. Третий аргумент нужен серверному рендеру и стоит того же:
  // состояние модуля от способа отрисовки не зависит.
  const upgradeRequired = useSyncExternalStore(
    onClientUpgradeRequired,
    isClientUpgradeRequired,
    isClientUpgradeRequired,
  );
  // Ровно ветка кабинета, а не всё, что начинается с этих букв: `startsWith('/driver')` накрыл бы
  // и будущий раздел портала вроде «/drivers», где открытая форма стоит дороже свежей вкладки.
  const driverCabinet = pathname === '/driver' || pathname.startsWith('/driver/');

  // Требование сильнее предложения: пока сервер отказывает по версии, обычный баннер не
  // показывается вовсе.
  if (upgradeRequired) {
    return (
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label="Портал обновился"
        style={{
          position: 'fixed',
          inset: 0,
          // Выше модалок AntD (1000) и выше баннера (900): требование обязано накрывать и открытую
          // форму — работать в ней всё равно больше нельзя, каждый её запрос получит тот же отказ.
          zIndex: 2000,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 16,
          background: 'rgba(0, 0, 0, 0.45)',
        }}
      >
        <Alert
          type="warning"
          showIcon
          style={{ maxWidth: 520, boxShadow: '0 8px 32px rgba(0, 0, 0, 0.25)' }}
          message="Портал обновился"
          description={
            <Space direction="vertical" size="middle" style={{ width: '100%' }}>
              <Typography.Text>
                Эта вкладка работает на устаревшей версии, и продолжать на ней нельзя: сервер
                отвечает на её запросы отказом. Обновите страницу — портал откроется заново.
              </Typography.Text>
              {/* Единственное действие. Кнопки «Позже» здесь нет и быть не может: откладывать
                  нечего — вкладка уже не работает. */}
              <Button
                type="primary"
                icon={<ReloadOutlined />}
                onClick={() => window.location.reload()}
              >
                Обновить страницу
              </Button>
            </Space>
          }
        />
      </div>
    );
  }

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
