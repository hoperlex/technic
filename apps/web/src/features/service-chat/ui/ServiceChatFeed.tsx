import { Alert, Button, Divider, Skeleton, Space, Tag, Typography } from 'antd';
import {
  serviceChatSideLabels,
  type ServiceChatMessageDto,
  type ServiceRequestDto,
} from '@technic/contracts';
import type { ServiceChatFeedState } from '../model/useServiceChatFeed';
import { formatDateTime } from '../../../utils/format';

/** Ярлыки адресатов реплики: сторонами и людьми — ровно теми списками, какими они и хранятся. */
function AddresseeTags({ addressees }: { addressees: ServiceChatMessageDto['addressees'] }) {
  return (
    <>
      {addressees.sides.map((side) => (
        <Tag key={side} color="blue" style={{ marginInlineEnd: 0 }}>
          {serviceChatSideLabels[side]}
        </Tag>
      ))}
      {addressees.users.map((user) => (
        <Tag key={user.id} color="cyan" style={{ marginInlineEnd: 0 }}>
          {user.fullName}
        </Tag>
      ))}
    </>
  );
}

/**
 * Одна реплика: кто, когда, кому и что сказал.
 *
 * Перенесённое «Примечание исполнителя» (§3.9) подписано иначе и БЕЗ имени: автора у него не
 * восстановить — «кем изменено» и «когда изменено» общие поля заявки, и через месяц там стоит тот,
 * кто последним двигал статус. Приблизительная дата под пометкой честнее точной под чужим именем.
 */
function ChatMessage({ message }: { message: ServiceChatMessageDto }) {
  const imported = message.origin === 'import';
  return (
    <div style={{ lineHeight: 1.4 }}>
      <Space size={8} wrap>
        {imported ? (
          <Tag color="default">перенесено из примечания исполнителя</Tag>
        ) : (
          <Typography.Text strong>{message.authorName}</Typography.Text>
        )}
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {formatDateTime(message.createdAt)}
          {imported && ' · дата приблизительная'}
        </Typography.Text>
        <AddresseeTags addressees={message.addressees} />
      </Space>
      {/* Переносы строк сохраняются: списком «что проверили» реплику пишут не реже, чем фразой. */}
      <div style={{ whiteSpace: 'pre-wrap' }}>{message.body}</div>
    </div>
  );
}

/**
 * Лента реплик, растущая вниз, с полосой «Новые» на границе прочитанного и подгрузкой вверх.
 *
 * Полоса стоит по границе, снятой при ОТКРЫТИИ окна (`newFromSeq`): курсор сдвигается сразу после
 * показа, и живое значение утащило бы полосу вниз на глазах у читателя — то есть спрятало бы ровно
 * то, ради чего он окно и открыл.
 */
export function ServiceChatFeed({
  feed,
  request,
}: {
  feed: ServiceChatFeedState;
  request: ServiceRequestDto;
}) {
  if (feed.isPending) return <Skeleton active paragraph={{ rows: 3 }} />;
  if (feed.isError) {
    return (
      <Alert
        type="error"
        showIcon
        message="Обсуждение не загрузилось"
        // Курсор прочтения при этом НЕ двигается (§3.4): непрочитанное остаётся непрочитанным,
        // и метка в списке продолжает звать сюда. Об этом и говорится словами — иначе человек
        // решит, что подсветка врёт.
        description="Реплики остались непрочитанными: подсветка не гаснет, пока лента не показана. Откройте окно ещё раз."
      />
    );
  }
  if (feed.items.length === 0) {
    return (
      <Typography.Text type="secondary">
        По заявке {request.displayNumber} пока ничего не написано.
      </Typography.Text>
    );
  }

  return (
    <div
      // Прокручивается сама лента, а не окно: поле ввода и выбор адресата обязаны остаться на
      // виду — иначе длинная переписка уводит их за нижний край, и «ответить» становится квестом.
      style={{ maxHeight: '46vh', overflowY: 'auto', paddingInlineEnd: 4 }}
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        {feed.hasMore && (
          <Button size="small" onClick={feed.loadOlder} loading={feed.loadingOlder} block>
            Показать более ранние
          </Button>
        )}
        {feed.items.map((message, index) => {
          const previous = feed.items[index - 1];
          const boundary =
            message.seq > feed.newFromSeq && (!previous || previous.seq <= feed.newFromSeq);
          return (
            <div key={message.id}>
              {boundary && (
                <Divider plain style={{ margin: '0 0 12px' }}>
                  <Typography.Text type="danger" style={{ fontSize: 12 }}>
                    Новые
                  </Typography.Text>
                </Divider>
              )}
              <ChatMessage message={message} />
            </div>
          );
        })}
      </Space>
    </div>
  );
}
