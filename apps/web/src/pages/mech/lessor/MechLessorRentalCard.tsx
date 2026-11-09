import { useState } from 'react';
import { Alert, Button, Space, Tag, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import {
  requestStatusColors,
  requestStatusLabels,
  type MechLessorReceiptAccess,
  type MechLessorRentalDto,
} from '@technic/contracts';
import {
  mechDayLabel,
  mechDaysLeftLabel,
  mechModelLabel,
  mechRateLabel,
  mechRequestKeys,
  mechRequestsApi,
  mechTermLabel,
  MechLessorReceiptMarkTag,
} from '@entities/mech-request';
import { useAuth } from '@entities/session';
import { PhoneLink } from '@entities/user-account';
import {
  lessorReceiptLine,
  MechLessorReceiptUploadModal,
  MechLessorReceiptVersionLine,
  MechLessorReceiptVersions,
} from '@features/mech-lessor-receipt';
import { isApiError } from '@shared/api';
import { ViewFields, ViewModal, type ViewField } from '@shared/ui';
import { lessorAttachHint, lessorRentalMark, mechLessorRentalAccess } from './lessorRental';

/*
 * The lessor's rental card (lessor receipt plan, P12, O7): the fields of his DTO and his receipt.
 * Built from his allow-list alone — not the office card with fields hidden: there is no department,
 * requester, comment, files, visa, worked units, final cost, extension or history here, because his
 * DTO does not carry them, and the receipt lines are his view's (no staff names, no reason but a
 * rejection's).
 */

function cardFields(rental: MechLessorRentalDto, today: string): ViewField[] {
  const left = mechDaysLeftLabel(rental, today);
  const mark = lessorRentalMark(rental);
  const fields: ViewField[] = [
    { key: 'num', label: '№', children: rental.displayNumber },
    {
      key: 'status',
      label: 'Состояние',
      children: (
        <Space size={4} wrap>
          <Tag color={requestStatusColors[rental.status]} style={{ marginInlineEnd: 0 }}>
            {requestStatusLabels[rental.status]}
          </Tag>
          {mark && <MechLessorReceiptMarkTag mark={mark} />}
        </Space>
      ),
    },
    {
      key: 'object',
      label: 'Площадка',
      full: true,
      children: (
        <>
          {rental.objectName}
          {rental.objectAddress.trim() && (
            <Typography.Text type="secondary" style={{ display: 'block', fontSize: 12 }}>
              {rental.objectAddress}
            </Typography.Text>
          )}
        </>
      ),
    },
    { key: 'model', label: 'Модель', children: mechModelLabel(rental) },
    { key: 'rate', label: 'Ставка', children: mechRateLabel(rental.rate, rental.rateUnit) },
    {
      key: 'planned',
      label: 'Плановый срок',
      children: (
        <>
          {mechTermLabel(rental)}
          {left && (
            <Typography.Text
              type={left.overdue ? 'danger' : 'secondary'}
              style={{ display: 'block', fontSize: 12 }}
            >
              {left.text}
            </Typography.Text>
          )}
        </>
      ),
    },
  ];
  if (rental.actualFrom) {
    fields.push({ key: 'actualFrom', label: 'Выдана', children: mechDayLabel(rental.actualFrom) });
  }
  if (rental.actualTo) {
    fields.push({ key: 'actualTo', label: 'Возвращена', children: mechDayLabel(rental.actualTo) });
  }
  fields.push({
    key: 'responsible',
    label: 'Принимает технику',
    children: (
      <>
        {rental.responsibleName || '—'}
        {rental.responsiblePhone && (
          <div>
            <PhoneLink phone={rental.responsiblePhone} />
          </div>
        )}
      </>
    ),
  });
  return fields;
}

/**
 * «Чек арендодателя» as the lessor sees it: the current version of this deal, his one button and
 * the earlier versions of the same deal, each file openable (O8 within the deal). The button is
 * `mechLessorReceiptAccess` — «Заменить чек» only over a pending or rejected version (O13); over an
 * approved one the hint names who replaces it instead of a button that would end in a refusal.
 */
function LessorReceiptBlock({
  rental,
  access,
  hint,
  onAttach,
}: {
  rental: MechLessorRentalDto;
  /** `null` — the rental left his list: nothing may be done with it any more. */
  access: MechLessorReceiptAccess | null;
  hint: string | null;
  onAttach: (replace: boolean) => void;
}) {
  const { current, retired, required } = rental.lessorReceipt;
  return (
    <section aria-label="Чек арендодателя" style={{ marginTop: 16 }}>
      <Typography.Title level={5} style={{ marginTop: 0 }}>
        Чек арендодателя
      </Typography.Title>
      {current ? (
        <MechLessorReceiptVersionLine line={lessorReceiptLine(current)} />
      ) : (
        <Typography.Text type="secondary">
          {required
            ? 'Чек не прикреплён. Прикрепите скан или фото чека: аренду закрывают после его утверждения'
            : 'Чек не прикреплён'}
        </Typography.Text>
      )}
      {access?.attach ? (
        <div style={{ marginTop: 8 }}>
          <Button type="primary" size="small" onClick={() => onAttach(access.replace)}>
            {access.replace ? 'Заменить чек' : 'Прикрепить чек'}
          </Button>
        </div>
      ) : (
        access &&
        hint && (
          <Typography.Text type="secondary" style={{ display: 'block', marginTop: 8 }}>
            {hint}
          </Typography.Text>
        )
      )}
      <MechLessorReceiptVersions lines={retired.map(lessorReceiptLine)} count={retired.length} />
    </section>
  );
}

export function MechLessorRentalCard({
  rental: row,
  today,
  onClose,
}: {
  /** `null` — closed. The list row: the card draws it while the fresh one is on its way. */
  rental: MechLessorRentalDto | null;
  today: string;
  onClose: () => void;
}) {
  const { user, can } = useAuth();

  /*
   * The card reads itself: the receipt's decision may arrive while it is open, and the attach door
   * needs the version of now, not of the list row (R21). A 404 means the rental left «В работе» or
   * changed hands in the meantime — the row is still drawn, without anything to do.
   */
  const { data: fresh, error } = useQuery({
    queryKey: mechRequestKeys.lessorDetail(row?.id ?? ''),
    queryFn: () => mechRequestsApi.lessorRental(row!.id),
    enabled: !!row,
    placeholderData: row ?? undefined,
  });
  const gone = isApiError(error) && error.status === 404;
  const rental = row ? (fresh?.id === row.id ? fresh : row) : null;

  /** The window keeps the rental it was opened with: a reread under it changes nothing it sends. */
  const [upload, setUpload] = useState<{ rental: MechLessorRentalDto; replace: boolean } | null>(
    null,
  );

  const access = rental && !gone ? mechLessorRentalAccess(user, rental, can) : null;
  const hint = rental && access && !access.attach ? lessorAttachHint(user, rental) : null;

  return (
    <ViewModal
      title={rental ? `Аренда ${rental.displayNumber}` : 'Аренда'}
      open={!!rental}
      onClose={onClose}
      width={760}
      destroyOnHidden
      footer={[
        <Button key="close" onClick={onClose}>
          Закрыть
        </Button>,
      ]}
    >
      {rental && (
        <>
          {gone && (
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 12 }}
              title="Аренда ушла из вашего списка"
              description="Её завершили, отменили или изменили договорённость. Вопросы — к диспетчеру."
            />
          )}
          <ViewFields items={cardFields(rental, today)} />
          <LessorReceiptBlock
            rental={rental}
            access={access}
            hint={hint}
            onAttach={(replace) => setUpload({ rental, replace })}
          />
        </>
      )}

      {/* Inside the card, not next to it (ADR 0140): otherwise the window opens under the card. */}
      <MechLessorReceiptUploadModal
        rental={upload?.rental ?? null}
        replace={upload?.replace ?? false}
        onClose={() => setUpload(null)}
      />
    </ViewModal>
  );
}
