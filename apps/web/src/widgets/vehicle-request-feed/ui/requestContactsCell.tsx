import { Typography } from 'antd';
import type { VehicleRequestDto } from '@technic/contracts';
import { requestContacts } from '@entities/vehicle-request';
import { PhoneLink } from '@entities/user-account';
import { ExpandableCell } from '@shared/ui';

/** The feed turns entity contact data into direct call targets without coupling two entities. */
export function RequestContactsCell({ request }: { request: VehicleRequestDto }) {
  const contacts = requestContacts(request);
  if (contacts.length === 0) return <Typography.Text type="secondary">—</Typography.Text>;
  return (
    <ExpandableCell>
      {contacts.map((contact, index) => (
        <div key={contact.role} style={{ marginTop: index === 0 ? 0 : 4 }}>
          <div>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {contact.role}
            </Typography.Text>{' '}
            {contact.name || '—'}
          </div>
          <div style={{ fontSize: 12 }}>
            {contact.address && (
              <Typography.Text type="secondary" style={{ fontSize: 12 }} title={contact.address}>
                {contact.address}
              </Typography.Text>
            )}
            {contact.address && contact.phone ? ' · ' : null}
            {contact.phone && <PhoneLink phone={contact.phone} />}
          </div>
        </div>
      ))}
    </ExpandableCell>
  );
}
