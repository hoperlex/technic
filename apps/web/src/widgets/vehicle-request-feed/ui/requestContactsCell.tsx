import { Typography } from 'antd';
import type { VehicleRequestDto } from '@technic/contracts';
import { requestContacts } from '@entities/vehicle-request';
import { PhoneLink } from '@entities/user-account';
import { ExpandableCell } from '@shared/ui';

/**
 * Contacts in a list row: role with name, then address and phone. It answers "whom to call and
 * where to go", the second question to the request list after the request itself; before this
 * column the answer cost opening every request card. The feed turns entity contact data into
 * call targets without coupling the vehicle-request and user-account entities.
 *
 * The cell collapses (ExpandableCell): freight has two contacts with long addresses, which would
 * stretch every list row to five or six lines.
 */
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
            {/* The number is a tel: link because a list contact is for calling (ADR 0066). */}
            {contact.phone && <PhoneLink phone={contact.phone} />}
          </div>
        </div>
      ))}
    </ExpandableCell>
  );
}
