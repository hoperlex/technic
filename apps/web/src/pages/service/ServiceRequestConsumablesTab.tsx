import { Button, Space } from 'antd';
import { ProfileOutlined } from '@ant-design/icons';
import type { ServiceRequestDto } from '@technic/contracts';
import { ServiceConsumablesTable } from '@entities/service-request';
import type { ServiceMenuItem } from './serviceStatusChoices';

/**
 * The «Расходники» tab of a consumables request: the composition and, next to it, the executor's
 * button that opens the composition window.
 *
 * The button takes the READY item `consumables` of the action set, exactly as the estimate tab takes its
 * own: who may edit the composition is decided by the predicates behind the item, and a second
 * condition here would draw a button the server answers with a refusal. Moved out of the card
 * window so that the window stays under the size limit when the contractor's cut was added to it
 * (workflow-fixes plan Р7) — the tab is not built for him at all.
 */
export function ServiceRequestConsumablesTab({
  request,
  edit,
}: {
  request: ServiceRequestDto;
  /** The «Заполнить / Изменить расходники» item of the action set; absent when he may not edit. */
  edit: ServiceMenuItem | undefined;
}) {
  return (
    <Space orientation="vertical" size={12} style={{ width: '100%' }}>
      <ServiceConsumablesTable lines={request.consumables} />
      {edit && (
        <Button
          type="link"
          size="small"
          icon={<ProfileOutlined />}
          style={{ padding: 0, alignSelf: 'flex-start' }}
          onClick={edit.onClick}
        >
          {edit.label}
        </Button>
      )}
    </Space>
  );
}
