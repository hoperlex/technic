import { Button, Space } from 'antd';
import type { ServiceRequestDto } from '@technic/contracts';
import { ServiceRequestContext } from '@entities/service-request';
import { ViewModal } from '@shared/ui';
import { useServiceChatFeed } from '../model/useServiceChatFeed';
import { ServiceChatComposer } from './ServiceChatComposer';
import { ServiceChatFeed } from './ServiceChatFeed';

/**
 * Тело окна — отдельным компонентом, потому что в нём живут запросы, опрос и курсор прочтения.
 * Окно `destroyOnHidden`, поэтому закрытие размонтирует тело: у следующей заявки лента, граница
 * «Новых» и подтверждённый курсор начинаются заново, а не достаются ей от предыдущей.
 */
function ServiceChatBody({ request }: { request: ServiceRequestDto }) {
  const feed = useServiceChatFeed(request.id);
  return (
    <Space orientation="vertical" size={12} style={{ width: '100%' }}>
      {/* Шапка та же, что у окон действий (Р57): решение принимает и тот, кто пришёл по ссылке из
          письма, — он не помнит, что за заявка, а спорит в ней о конкретном аппарате. */}
      <ServiceRequestContext request={request} />
      <ServiceChatFeed feed={feed} request={request} />
      <ServiceChatComposer request={request} onSent={feed.append} />
    </Space>
  );
}

/**
 * Обсуждение заявки на обслуживание (ADR 0141) — лента реплик отдельным окном.
 *
 * Окном, а не секцией карточки: карточка отвечает на вопрос «что за заявка», и лента, которая за
 * месяц вырастает в полсотни строк, вытеснила бы из неё ответ. Вызванное из карточки, окно
 * рендерится ВНУТРИ неё (ADR 0140) — иначе оно делит слой с карточкой и прячется под ней.
 *
 * Адресат здесь — пометка, а не ограничение видимости (решение 2 ADR): текст реплики видят все,
 * кому видна заявка, и окно не делает вид, что что-то прячет.
 */
export function ServiceChatModal({
  request,
  onClose,
}: {
  /** `null` — окно закрыто. */
  request: ServiceRequestDto | null;
  onClose: () => void;
}) {
  return (
    <ViewModal
      title={request ? `Обсуждение ${request.displayNumber}` : 'Обсуждение'}
      open={!!request}
      onClose={onClose}
      width={720}
      destroyOnHidden
      footer={[
        <Button key="close" onClick={onClose}>
          Закрыть
        </Button>,
      ]}
    >
      {request && <ServiceChatBody request={request} />}
    </ViewModal>
  );
}
