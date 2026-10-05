import { lazy } from 'react';
import { Button } from 'antd';
import type { ServiceRequestDto } from '@technic/contracts';
import { ActiveWindowContent, AsyncContent, ViewModal, WindowActivityScope } from '@shared/ui';

const ServiceChatBody = lazy(() =>
  import('./ServiceChatBody').then((module) => ({ default: module.ServiceChatBody })),
);

/**
 * Service-request discussion (ADR 0141) is a message feed in a separate window.
 *
 * The card answers "what is this request"; a discussion growing to fifty messages in a month
 * would displace that answer. When opened from the card, this window must render INSIDE it
 * (ADR 0140), otherwise it shares the card's layer and can disappear underneath it.
 *
 * Addressees are labels, not visibility restrictions (decision 2): everyone who sees the request
 * can read its messages. The window must not imply privacy that the server does not provide.
 * Keep this shell synchronous for focus and closing while the feed loads; the shell's unread
 * counter uses this same public feature entry but must not download the feed before opening it.
 */
export function ServiceChatModal({
  request,
  onClose,
}: {
  /** null means the window is closed. */
  request: ServiceRequestDto | null;
  onClose: () => void;
}) {
  return (
    <WindowActivityScope open={!!request}>
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
        <ActiveWindowContent>
          {request && (
            <AsyncContent>
              <ServiceChatBody request={request} />
            </AsyncContent>
          )}
        </ActiveWindowContent>
      </ViewModal>
    </WindowActivityScope>
  );
}
