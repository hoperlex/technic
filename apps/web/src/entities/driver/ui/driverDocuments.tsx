import type { ReactNode } from 'react';
import { Button, Space, Tag, Typography, type TableColumnType } from 'antd';
import { DeleteOutlined, IdcardOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import {
  type CredentialTypeCode,
  credentialTypeLabels,
  credentialTypeShortLabels,
  credentialVerificationStatusColors,
  credentialVerificationStatusLabels,
  driverDocumentGapLabel,
  driverDocumentGaps,
  type DriverDto,
  type DriverLicenseDto,
  licenseCategoriesLabel,
  licenseDefect,
  licenseDefectLabels,
  licenseNumberLabel,
  licenseRequisitesMissing,
  requiredCredentialType,
} from '@technic/contracts';
import { textColumn } from '@shared/ui';

/**
 * Shared document presentation for registry columns, mobile cards and the person editor (ADR 0095).
 * Requests and dialogs live in the driver-documents feature; this module only shows the papers.
 *
 * Every helper either receives a credential type explicitly or derives it from the job title via
 * `requiredCredentialType` (ADR 0095). This prevents an equal category letter on driver and tractor
 * credentials from being presented as the same qualification.
 */

/** Registry validity is always evaluated against today's date. */
const today = () => dayjs().format('YYYY-MM-DD');

/**
 * The current document of a kind is the first of its kind: the server returns records newest first,
 * while both kinds are mixed in one array (DriverDto.licenses).
 */
function currentDocument(d: DriverDto, type: CredentialTypeCode): DriverLicenseDto | undefined {
  return d.licenses.find((l) => l.credentialTypeCode === type);
}

/**
 * What the waybill still lacks, among what the row has not said yet. «No current credential» and
 * «series and number missing» are stated by the row in its own words and places, but an empty issue
 * date is visible nowhere: the waybill then prints with an empty field, and a user who filtered an
 * incomplete set must understand what exactly to fill in.
 *
 * The label names the required credential kind: an excavator operator is asked for a tractor
 * certificate, and «driver license issue date» would send the user after the wrong paper.
 */
function unsaidGaps(d: DriverDto): string[] {
  const type = requiredCredentialType(d.jobTitle);
  return driverDocumentGaps(d, today())
    .filter((g) => g !== 'license' && g !== 'requisites')
    .map((g) => driverDocumentGapLabel(g, type));
}

/**
 * A column pair per credential kind: the document and its categories. A pair, not one cell, because
 * categories are a separate question — «who has CE» (ADR 0055) — and glued to the number they were
 * not findable by eye.
 *
 * Completeness gaps are reported only by the column of the kind the person is admitted by: an empty
 * driver license on a loader operator is not a gap but the normal state of the card.
 */
export function documentColumns(type: CredentialTypeCode): TableColumnType<DriverDto>[] {
  const short = credentialTypeShortLabels[type];
  return [
    textColumn<DriverDto>({
      key: `license-${type}`,
      title: short,
      dataIndex: 'licenses',
      sortable: false,
      searchable: false,
      width: 240,
      render: (_v, r) => {
        const license = currentDocument(r, type);
        const gaps = requiredCredentialType(r.jobTitle) === type ? unsaidGaps(r) : [];
        const missing = gaps.length > 0 && (
          <Typography.Text type="warning">{gaps.join(' · ')}</Typography.Text>
        );
        if (!license) {
          return (
            <Space orientation="vertical" size={0}>
              <Typography.Text type="secondary">Не заведено</Typography.Text>
              {missing}
            </Space>
          );
        }
        const defect = licenseDefect(license, today());
        // Credentials from the staff import may have no requisites: without this branch the line
        // would start with an orphan separator, and «not entered» would read as a layout glitch.
        const noRequisites = licenseRequisitesMissing(licenseNumberLabel(license));
        return (
          <Space orientation="vertical" size={0}>
            <span>
              {noRequisites ? (
                <Typography.Text type="warning">Серия и номер не внесены</Typography.Text>
              ) : (
                licenseNumberLabel(license)
              )}
            </span>
            <Space size={4}>
              {defect ? (
                <Tag color="red">{licenseDefectLabels[defect]}</Tag>
              ) : (
                <Typography.Text type="secondary">
                  {license.expiresOn
                    ? `до ${dayjs(license.expiresOn).format('DD.MM.YYYY')}`
                    : 'бессрочно'}
                </Typography.Text>
              )}
              <Tag color={credentialVerificationStatusColors[license.verificationStatus]}>
                {credentialVerificationStatusLabels[license.verificationStatus]}
              </Tag>
            </Space>
            {missing}
          </Space>
        );
      },
    }),
    textColumn<DriverDto>({
      key: `categories-${type}`,
      title: `Категории ${short}`,
      dataIndex: 'licenses',
      sortable: false,
      searchable: false,
      width: 160,
      render: (_v, r) => {
        const license = currentDocument(r, type);
        const label = license ? licenseCategoriesLabel(license) : '';
        return label || <Typography.Text type="secondary">—</Typography.Text>;
      },
    }),
  ];
}

/**
 * The state of the credential required by the job title, as the mobile card badge: an excavator
 * operator is asked for a tractor certificate, and an empty driver license has no place on top.
 */
export function documentBadge(r: DriverDto): ReactNode {
  const type = requiredCredentialType(r.jobTitle);
  const license = currentDocument(r, type);
  if (!license) return <Tag>нет {credentialTypeShortLabels[type]}</Tag>;
  const defect = licenseDefect(license, today());
  return defect ? (
    <Tag color="red">{licenseDefectLabels[defect]}</Tag>
  ) : (
    <Tag color={credentialVerificationStatusColors[license.verificationStatus]}>
      {credentialVerificationStatusLabels[license.verificationStatus]}
    </Tag>
  );
}

/** The primary line describes the same credential kind as the badge. */
export function documentPrimary(r: DriverDto): ReactNode {
  const type = requiredCredentialType(r.jobTitle);
  const license = currentDocument(r, type);
  if (!license) return `${credentialTypeShortLabels[type]} не заведено`;
  return licenseRequisitesMissing(licenseNumberLabel(license))
    ? 'Серия и номер не внесены'
    : licenseNumberLabel(license);
}

/**
 * Card lines about documents: one set per visible kind plus a shared tail about what the waybill
 * lacks. The kinds are the same as the desktop columns — filtered by job title, only its own.
 */
export function documentCardLines(types: CredentialTypeCode[]): ((r: DriverDto) => ReactNode)[] {
  return [
    // Categories and expiry are separate lines per visible kind, as columns are on desktop
    // (ADR 0055): people open the directory for categories, and glued to the number they got lost.
    // The kind is named in the line itself: «Категории C, CE» alone cannot tell a driver from an
    // operator.
    ...types.flatMap((type) => {
      const short = credentialTypeShortLabels[type];
      return [
        (r: DriverDto) => {
          const license = currentDocument(r, type);
          const label = license ? licenseCategoriesLabel(license) : '';
          return label ? `Категории ${short}: ${label}` : null;
        },
        (r: DriverDto) => {
          const license = currentDocument(r, type);
          if (!license) return null;
          return license.expiresOn
            ? `${short} действует до ${dayjs(license.expiresOn).format('DD.MM.YYYY')}`
            : `${short} бессрочно`;
        },
      ];
    }),
    // What the waybill lacks, as a line: a card shows no empty cell, and a user who filtered an
    // incomplete set must understand what exactly to fill in.
    (r: DriverDto) => unsaidGaps(r).join(' · ') || null,
  ];
}

/** Command ports supplied by the document-management feature. */
export interface DriverDocumentActions {
  canWrite: boolean;
  /** Open replacement with this credential kind preselected. */
  onReplace: (d: DriverDto, type: CredentialTypeCode) => void;
  onVerify: (d: DriverDto, license: DriverLicenseDto, status: 'verified' | 'rejected') => void;
  onRevoke: (d: DriverDto, license: DriverLicenseDto) => void;
  /** Destructive correction uses `records.purge`, independently of ordinary document writes. */
  canDelete: boolean;
  /** Correct any historical row, not only the current credential. */
  onDelete: (d: DriverDto, license: DriverLicenseDto) => void;
}

/**
 * Documents of one kind in the card: history plus commands on the current one.
 *
 * A block per kind rather than one list: commands belong to a specific document, and «Отметить
 * проверенным» next to a mixed history would mark the wrong paper. An empty block is shown too —
 * that is how a missing tractor certificate of an operator becomes visible.
 */
export function documentsBlock(
  d: DriverDto,
  type: CredentialTypeCode,
  actions: DriverDocumentActions,
) {
  const licenses = d.licenses.filter((l) => l.credentialTypeCode === type);
  const license = licenses[0];
  const required = requiredCredentialType(d.jobTitle) === type;
  return (
    <div key={type}>
      <Typography.Title level={5}>{credentialTypeLabels[type]}</Typography.Title>
      {licenses.length === 0 && (
        <Typography.Paragraph type="secondary">
          {required
            ? 'Не заведено — в выбор при переводе заявки в работу водитель не попадёт.'
            : 'Не заведено. По должности этот документ от человека и не требуется.'}
        </Typography.Paragraph>
      )}
      <Space orientation="vertical" size={4} style={{ width: '100%' }}>
        {licenses.map((l, i) => {
          const defect = licenseDefect(l, today());
          return (
            <Space key={l.id} size={8} wrap>
              {/* The separator appears only with categories: a document can lack them (requisites
                  entered, set not yet), and a dangling dot would read as a truncated line. */}
              <span>
                {i === 0 ? 'Действующее:' : 'Прежнее:'} {licenseNumberLabel(l)}
                {licenseCategoriesLabel(l) ? ` · ${licenseCategoriesLabel(l)}` : ''}
              </span>
              {l.expiresOn && <span>до {dayjs(l.expiresOn).format('DD.MM.YYYY')}</span>}
              {defect && <Tag color="red">{licenseDefectLabels[defect]}</Tag>}
              <Tag color={credentialVerificationStatusColors[l.verificationStatus]}>
                {credentialVerificationStatusLabels[l.verificationStatus]}
              </Tag>
              {l.verifiedByName && (
                <Typography.Text type="secondary">проверил {l.verifiedByName}</Typography.Text>
              )}
              {l.revokeReason && <Typography.Text type="danger">{l.revokeReason}</Typography.Text>}
              {/* The button sits on each row, not in the shared action bar: the bar speaks about
                  the current document, while the one removed is usually the stray one — a
                  duplicate or a typo in an older record. */}
              {actions.canDelete && (
                <Button
                  size="small"
                  danger
                  type="text"
                  icon={<DeleteOutlined />}
                  title="Убрать документ из карточки"
                  aria-label={`Убрать документ ${licenseNumberLabel(l)}`}
                  onClick={() => actions.onDelete(d, l)}
                />
              )}
            </Space>
          );
        })}
      </Space>
      {actions.canWrite && (
        <Space wrap style={{ marginTop: 12 }}>
          <Button size="small" icon={<IdcardOutlined />} onClick={() => actions.onReplace(d, type)}>
            Заменить
          </Button>
          {license && !license.revokedAt && (
            <>
              <Button
                size="small"
                onClick={() => actions.onVerify(d, license, 'verified')}
                disabled={license.verificationStatus === 'verified'}
              >
                Отметить проверенным
              </Button>
              <Button
                size="small"
                onClick={() => actions.onVerify(d, license, 'rejected')}
                disabled={license.verificationStatus === 'rejected'}
              >
                Отклонить
              </Button>
              <Button size="small" danger onClick={() => actions.onRevoke(d, license)}>
                Аннулировать
              </Button>
            </>
          )}
        </Space>
      )}
    </div>
  );
}
