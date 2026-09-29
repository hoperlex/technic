import { Space, Tag, Tooltip, Typography } from 'antd';
import type { ServiceRequestDto } from '@technic/contracts';
import { ServiceCurrentPlaceTag, serviceRequestObjectLabel } from '@entities/service-request';

/**
 * The "where it stands and for whom" value of the request card: where the unit is now, the
 * request's own site, and the two departments.
 *
 * Its own module because the value has two halves with different lifetimes (ADR 0215): the live
 * place after a move, and the snapshot taken at filing, which the move never rewrites.
 */
export function ServiceRequestPlaceValue({ request }: { request: ServiceRequestDto }) {
  const objectLabel = serviceRequestObjectLabel(request);
  return (
    <Space orientation="vertical" size={4}>
      {/* Where to go comes first after a move: executors read this line and kept travelling to
          the declared site after IT had recorded the real one. The request's own site stays
          below — it is the scope and the testimony. */}
      <ServiceCurrentPlaceTag request={request} />
      <Space size={8} wrap>
        {request.currentPlace && objectLabel && (
          <Typography.Text type="secondary">в заявке:</Typography.Text>
        )}
        {objectLabel && <span>{objectLabel}</span>}
        {/* "Wrong site" (Р16): the site of this request was named by a person, not taken from the
            unit's card. The mark is historical and never changes — it records the declaration,
            not the mismatch: the mismatch is computed on the server and goes out by itself once
            IT moves the unit. So the wording speaks about the declaration, not about the unit
            "standing elsewhere" — by the time it is read the unit may have been moved.
            A request without a unit never has this pair: there is no card to disagree with, and
            the server closes that door (Р7). */}
        {request.objectOverridden && (
          <Tooltip title="Заявитель указал, что аппарат стоит на другом объекте: справочник этим не правится — единицу переносит ИТ-служба, разобрав отбор расхождений">
            <Tag color="gold">Объект указан заявителем</Tag>
          </Tooltip>
        )}
        {/* The room inside the site is the snapshot taken at filing (Р57); it is empty when the
            request was filed on another site than the card's (ADR 0215). */}
        {request.equipment?.location && (
          <Typography.Text type="secondary">{request.equipment.location}</Typography.Text>
        )}
        {request.customerDepartment && <Tag>{request.customerDepartment.name}</Tag>}
        {/* The owning department of the unit: scope is computed by it, and it is not always the
            customer — a neighbouring department repairs "someone else's" printer more often than
            one would think. */}
        {request.equipmentDepartment &&
          request.equipmentDepartment.id !== request.customerDepartment?.id && (
            <Typography.Text type="secondary">
              владелец: {request.equipmentDepartment.name}
            </Typography.Text>
          )}
      </Space>
    </Space>
  );
}
