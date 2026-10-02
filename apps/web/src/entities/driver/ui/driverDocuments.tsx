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
 * Shared document presentation for registry columns, mobile cards and the person editor.
 *
 * Every helper either receives a credential type explicitly or derives it from the job title via
 * `requiredCredentialType` (ADR 0095). This prevents an equal category letter on driver and tractor
 * credentials from being presented as the same qualification.
 */

/** Registry validity is always evaluated against today's date. */
const today = () => dayjs().format('YYYY-MM-DD');

/** The server returns newest records first, while credential kinds share one history array. */
function currentDocument(d: DriverDto, type: CredentialTypeCode): DriverLicenseDto | undefined {
  return d.licenses.find((l) => l.credentialTypeCode === type);
}

/**
 * Return only waybill gaps not already expressed by the document cell itself. Labels retain the
 * required credential kind so a machinist is never sent to correct the wrong paper.
 */
function unsaidGaps(d: DriverDto): string[] {
  const type = requiredCredentialType(d.jobTitle);
  return driverDocumentGaps(d, today())
    .filter((g) => g !== 'license' && g !== 'requisites')
    .map((g) => driverDocumentGapLabel(g, type));
}

/**
 * Render separate credential and category columns. Only the kind required by the job title reports
 * completeness gaps; an absent driver license on a tractor operator is a normal state.
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
        // Imported credentials may have no requisites; an explicit label avoids an orphan separator.
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

/** Mobile badges describe the credential required by the person's job title. */
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

/** Build mobile lines for the same visible credential kinds as the desktop columns. */
export function documentCardLines(types: CredentialTypeCode[]): ((r: DriverDto) => ReactNode)[] {
  return [
    // Category and expiry remain separate lines and name their credential kind (ADR 0055).
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
    // Cards have no empty cells, so completeness gaps must be named explicitly.
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
 * Credential history grouped by kind. Empty groups stay visible, and commands sit beside their
 * exact record so verification or correction cannot target a different paper.
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
              {/* Imported records can lack categories, so the separator is conditional too. */}
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
              {/* Correction belongs to each row because duplicates and historical typos are common. */}
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
