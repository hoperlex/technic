import type { ReactNode } from 'react';
import { Button, Space, Tag, Typography, type TableColumnType } from 'antd';
import { IdcardOutlined } from '@ant-design/icons';
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
 * Документы водителя в справочнике (ADR 0095): колонки пары «документ + категории», строки карточки
 * на телефоне и блоки документов в карточке человека.
 *
 * Отдельным модулем рядом со страницей: `DriversTab` держит состояние, запросы и окна, а показ
 * бумаг живёт здесь. Со вторым видом документа этой части стало больше половины справочника, и
 * правят её саму по себе — от фильтров и формы заведения человека она не зависит.
 *
 * Вид документа здесь спрашивается везде явно: у машиниста погрузчика «C» стоит в тракторном, и
 * графа, не назвавшая вид, читалась бы как допуск к грузовику. Там, где вид не назван снаружи, его
 * говорит должность (`requiredCredentialType`).
 */

/** Сегодняшняя дата — ею меряется годность документа в списке. */
const today = () => dayjs().format('YYYY-MM-DD');

/**
 * Действующий документ этого вида — первый среди своих: сервер отдаёт их от свежего к старому, а
 * виды перемешаны в одном списке (`DriverDto.licenses`).
 */
function currentDocument(d: DriverDto, type: CredentialTypeCode): DriverLicenseDto | undefined {
  return d.licenses.find((l) => l.credentialTypeCode === type);
}

/**
 * Чего не хватает для путевого листа — из того, о чём строка ещё не сказала. «Действующего
 * удостоверения нет» и «серия и номер не внесены» она называет своими словами и своими местами,
 * а вот пустая дата выдачи не видна нигде: без неё лист печатается с пустой графой, и человек,
 * отобравший неполный комплект фильтром, обязан понимать, что именно вносить.
 *
 * Документ в подписи назван своим именем: у машиниста экскаватора спрашивают тракторное, и «дата
 * выдачи ВУ» отправила бы человека искать не ту бумагу.
 */
function unsaidGaps(d: DriverDto): string[] {
  const type = requiredCredentialType(d.jobTitle);
  return driverDocumentGaps(d, today())
    .filter((g) => g !== 'license' && g !== 'requisites')
    .map((g) => driverDocumentGapLabel(g, type));
}

/**
 * Пара колонок на вид документа: сам документ и его категории. Пара, а не одна графа на всё:
 * категории спрашивают отдельным вопросом — «кто у нас с CE» (ADR 0055), — и приклеенные к номеру
 * они не искались глазами.
 *
 * Пробелы комплекта называет только колонка того документа, которым человек допущен: пустое ВУ у
 * машиниста погрузчика — не пробел, а нормальное состояние карточки.
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
            <Space direction="vertical" size={0}>
              <Typography.Text type="secondary">Не заведено</Typography.Text>
              {missing}
            </Space>
          );
        }
        const defect = licenseDefect(license, today());
        // Реквизитов нет у документов из кадровой выгрузки: без этой ветки строка начиналась бы
        // с осиротевшего разделителя, и «не внесено» читалось бы как сбой вёрстки.
        const noRequisites = licenseRequisitesMissing(licenseNumberLabel(license));
        return (
          <Space direction="vertical" size={0}>
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
 * Состояние документа по должности — бейджем карточки на телефоне: у машиниста экскаватора
 * спрашивают тракторное, и пустое ВУ выносить наверх незачем.
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

/** Главная строка карточки — реквизиты того же документа, о котором сказал бейдж. */
export function documentPrimary(r: DriverDto): ReactNode {
  const type = requiredCredentialType(r.jobTitle);
  const license = currentDocument(r, type);
  if (!license) return `${credentialTypeShortLabels[type]} не заведено`;
  return licenseRequisitesMissing(licenseNumberLabel(license))
    ? 'Серия и номер не внесены'
    : licenseNumberLabel(license);
}

/**
 * Строки карточки про документы — по строке видимых видов и общий хвост о недостающем для листа.
 * Виды приходят те же, что и колонками: отфильтрованные по должности — только её собственный.
 */
export function documentCardLines(types: CredentialTypeCode[]): ((r: DriverDto) => ReactNode)[] {
  return [
    // Категории и срок — своими строками на каждый видимый вид документа, как и колонками на
    // большом экране (ADR 0055): за категориями в справочник и приходят, а приклеенные к номеру
    // они терялись. Вид назван в самой строке: «Категории C, CE» без него не отличить водителя
    // от машиниста.
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
    // Недостающее для листа — строкой: на карточке пустой графы не видно, а отобрав неполный
    // комплект фильтром, человек должен понимать, что именно вносить.
    (r: DriverDto) => unsaidGaps(r).join(' · ') || null,
  ];
}

/** Учётные действия над документом: их держит страница — у неё запросы и окна с причиной. */
export interface DriverDocumentActions {
  canWrite: boolean;
  /** Заменить: окно «Новое удостоверение» с подставленным видом документа. */
  onReplace: (d: DriverDto, type: CredentialTypeCode) => void;
  onVerify: (d: DriverDto, license: DriverLicenseDto, status: 'verified' | 'rejected') => void;
  onRevoke: (d: DriverDto, license: DriverLicenseDto) => void;
}

/**
 * Документы одного вида в карточке: история и учётные действия над действующим.
 *
 * Блок на вид, а не общий список: действия у документов свои, и «Отметить проверенным» рядом с
 * перемешанной историей поставило бы отметку не на ту бумагу. Пустой блок тоже показывается —
 * им и видно, что тракторного у машиниста нет вовсе.
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
      <Space direction="vertical" size={4} style={{ width: '100%' }}>
        {licenses.map((l, i) => {
          const defect = licenseDefect(l, today());
          return (
            <Space key={l.id} size={8} wrap>
              {/* Категории — через разделитель, но только когда они есть: документ бывает и без
                  них (реквизиты внесли, набор ещё нет), и висящая точка читалась бы как обрыв. */}
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
