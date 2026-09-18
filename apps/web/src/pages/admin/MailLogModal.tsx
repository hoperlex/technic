import { Alert, Descriptions, Modal, Segmented, Skeleton, Tag, Typography } from 'antd';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  mailAccountLabels,
  mailKindLabels,
  mailStatusColors,
  mailStatusLabels,
} from '@technic/contracts';
import { mailLogApi, mailLogKeys } from '@entities/mail-log';
import { formatDateTime } from '../../utils/format';

/**
 * Письмо целиком — по клику на строке журнала (ADR 0199).
 *
 * **Тело показывается двумя видами, и текстовый стоит первым.** Разбирают по журналу не вёрстку, а
 * содержание: «что именно ушло подрядчику», — и текстовая часть отвечает на это без единого
 * стороннего пикселя. Вид «как выглядит» нужен реже и ровно для одного вопроса — о вёрстке письма.
 *
 * **HTML показывается в `iframe` с пустым `sandbox`, а не вставкой в страницу.** Тело собирал
 * портал, но данные в нём чужие: описание поломки пишет заявитель, имя файла приносит подрядчик.
 * Вставь мы это в DOM админки — и любой из них получил бы исполнение своего кода в сессии
 * администратора. Пустой `sandbox` запрещает и скрипты, и формы, и переходы; `srcDoc` держит
 * документ в собственном origin.
 */
export function MailLogModal(props: { id: string | null; onClose: () => void }) {
  const [view, setView] = useState<'text' | 'html'>('text');
  const { data, isLoading } = useQuery({
    queryKey: mailLogKeys.message(props.id ?? 'none'),
    queryFn: () => mailLogApi.message(props.id!),
    enabled: props.id !== null,
  });

  return (
    <Modal
      open={props.id !== null}
      onCancel={props.onClose}
      footer={null}
      width={820}
      title={data ? data.subject : 'Письмо'}
      // Вид сбрасывается на текстовый при каждом открытии: следующее письмо открывают, чтобы
      // прочитать его, а не чтобы посмотреть вёрстку предыдущего.
      afterClose={() => setView('text')}
      destroyOnHidden
    >
      {isLoading || !data ? (
        <Skeleton active paragraph={{ rows: 6 }} />
      ) : (
        <>
          <Descriptions size="small" column={1} bordered style={{ marginBottom: 16 }}>
            <Descriptions.Item label="Причина">{mailKindLabels[data.kind]}</Descriptions.Item>
            <Descriptions.Item label="Получатель">{data.toEmail}</Descriptions.Item>
            <Descriptions.Item label="Состояние">
              <Tag color={mailStatusColors[data.status]}>{mailStatusLabels[data.status]}</Tag>
              {data.sentAt ? ` ${formatDateTime(data.sentAt)}` : null}
            </Descriptions.Item>
            <Descriptions.Item label="Составлено">
              {formatDateTime(data.createdAt)}
            </Descriptions.Item>
            <Descriptions.Item label="Канал">{mailAccountLabels[data.account]}</Descriptions.Item>
            {/* Обратный адрес показывается только свой: пустой означает общий адрес портала, и
                строка «—» рядом с остальными ничего бы не добавила. */}
            {data.replyTo ? (
              <Descriptions.Item label="Ответ уйдёт на">{data.replyTo}</Descriptions.Item>
            ) : null}
          </Descriptions>

          {/* Отказ SMTP — первым делом и красным: ради него журнал чаще всего и открывают. */}
          {data.lastError ? (
            <Alert
              type="error"
              showIcon
              style={{ marginBottom: 16 }}
              title="Почтовый сервер отказал"
              description={data.lastError}
            />
          ) : null}

          <Segmented
            value={view}
            onChange={(v) => setView(v as 'text' | 'html')}
            options={[
              { value: 'text', label: 'Текст письма' },
              { value: 'html', label: 'Как выглядит' },
            ]}
            style={{ marginBottom: 12 }}
          />

          {view === 'text' ? (
            <Typography.Paragraph
              style={{ whiteSpace: 'pre-wrap', margin: 0, maxHeight: 420, overflowY: 'auto' }}
            >
              {data.bodyText}
            </Typography.Paragraph>
          ) : (
            <iframe
              title="Письмо"
              sandbox=""
              srcDoc={data.bodyHtml}
              style={{ width: '100%', height: 420, border: '1px solid #f0f0f0', borderRadius: 8 }}
            />
          )}
        </>
      )}
    </Modal>
  );
}
