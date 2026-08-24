import { Space, Tag, Tooltip } from 'antd';
import type { WasteTicketBadgeDto } from '@technic/contracts';

/**
 * Значок разбора талонов в строке списка заявок (ADR 0114, Р24).
 *
 * Четыре числа, и каждое отвечает на свой вопрос: **⛔** — цифры не сошлись либо два слепых чтения
 * разошлись, нужен разбор; **⚠️** — похоже на расхождение, но бывает законно (похожий номер, чужой
 * адрес); **⏳** — бумага прочитана и ждёт подтверждения человеком; **🚫** — прочитать не удалось
 * вовсе, нужен новый скан или ручной ввод.
 *
 * Показываются только ненулевые: строка списка тесная, а четыре нуля подряд не сообщают ничего,
 * кроме того, что колонка существует. Заявка совсем без бумаги значка не получает — `badge` у неё
 * `null`, и это не то же самое, что «все нули»: у первой разбирать нечего, у второй всё разобрано.
 */
export function TicketBadge({ badge }: { badge: WasteTicketBadgeDto | null }) {
  if (!badge) return null;
  const { errors, warnings, pendingConfirmation, failures } = badge;
  if (errors + warnings + pendingConfirmation + failures === 0) {
    return (
      <Tooltip title="Талоны разобраны, расхождений нет">
        <Tag color="success" style={{ marginInlineEnd: 0 }}>
          ✓
        </Tag>
      </Tooltip>
    );
  }
  return (
    <Space size={4} wrap>
      {errors > 0 && (
        <Tooltip title={`Расхождений: ${errors}`}>
          <Tag color="error" style={{ marginInlineEnd: 0 }}>
            ⛔ {errors}
          </Tag>
        </Tooltip>
      )}
      {warnings > 0 && (
        <Tooltip title={`Предупреждений: ${warnings}`}>
          <Tag color="warning" style={{ marginInlineEnd: 0 }}>
            ⚠️ {warnings}
          </Tag>
        </Tooltip>
      )}
      {pendingConfirmation > 0 && (
        <Tooltip title={`Ждут подтверждения: ${pendingConfirmation}`}>
          <Tag color="processing" style={{ marginInlineEnd: 0 }}>
            ⏳ {pendingConfirmation}
          </Tag>
        </Tooltip>
      )}
      {failures > 0 && (
        <Tooltip title={`Не удалось прочитать: ${failures}. Нужен новый скан или ручной ввод`}>
          <Tag color="default" style={{ marginInlineEnd: 0 }}>
            🚫 {failures}
          </Tag>
        </Tooltip>
      )}
    </Space>
  );
}
