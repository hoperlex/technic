import { Space } from 'antd';
import type { ServiceRequestDto } from '@technic/contracts';
import { ServiceRequestContext } from '@entities/service-request';
import { useServiceChatFeed } from '../model/useServiceChatFeed';
import { ServiceChatComposer } from './ServiceChatComposer';
import { ServiceChatFeed } from './ServiceChatFeed';

/**
 * The body owns requests, polling and the read cursor. The destroyOnHidden shell unmounts it on
 * close, so the next request starts with its own feed, "New" boundary and acknowledged cursor
 * instead of inheriting another request's conversation state.
 */
export function ServiceChatBody({ request }: { request: ServiceRequestDto }) {
  const feed = useServiceChatFeed(request.id);
  return (
    <Space orientation="vertical" size={12} style={{ width: '100%' }}>
      {/* The same context as action windows (R57): a reader arriving from an email may not
          remember the request, but the discussion concerns one specific piece of equipment. */}
      <ServiceRequestContext request={request} />
      <ServiceChatFeed feed={feed} request={request} />
      <ServiceChatComposer request={request} onSent={feed.append} />
    </Space>
  );
}
