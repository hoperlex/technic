import { useState, type ReactNode } from 'react';
import { App, Button, Empty, Space, Spin, Table, Tag, Typography } from 'antd';
import type { TableColumnsType } from 'antd';
import { useQuery } from '@tanstack/react-query';
import {
  componentLabels,
  deviceIdentityLabels,
  metricLabels,
  parseRuleMatchKindLabels,
  parseRuleScopeLabels,
  type DeviceParseRuleDto,
} from '@technic/contracts';
import { deviceMailKeys, deviceRuleApi } from '@entities/device-mail';
import { PageTableLayout } from '@shared/ui';
import { formatDateTime } from '../../../utils/format';
import { useDeviceRuleRemove } from '../model/actions';
import { DeviceRuleFormModal } from './DeviceRuleFormModal';

/**
 * ПРАВИЛА РАЗБОРА — режим вкладки «Техника» рядом с очередью и реестром ключей (план
 * `docs/office-equipment-mail-identity-ui-plan.md`, §6.2 и §7).
 *
 * РЯДОМ, А НЕ В СЛУЖЕБНОМ МЕНЮ. Правила настраивает тот же круг, что разбирает письма (решение
 * заказчика 18.09.2026), и заводят их, глядя на письмо, которое портал не понял: развести эти два
 * экрана по разным входам значило бы заставить человека держать письмо в голове, переходя между
 * разделами.
 *
 * ПОРЯДОК — КАК ПРИМЕНЯЕТСЯ: сперва цель, затем номер порядка. Список, отсортированный иначе, чем
 * работает разбор, спорил бы сам с собой ровно в том месте, ради которого его открыли, — «какое
 * правило сработает первым».
 */
export function DeviceRulesBoard({ toolbar }: { toolbar?: ReactNode }) {
  const { modal } = App.useApp();
  const [editing, setEditing] = useState<DeviceParseRuleDto | null>(null);
  const [adding, setAdding] = useState(false);
  const remove = useDeviceRuleRemove();

  const { data, isLoading } = useQuery({
    queryKey: deviceMailKeys.rules(),
    queryFn: () => deviceRuleApi.list(),
  });
  const items = data?.items ?? [];

  const columns: TableColumnsType<DeviceParseRuleDto> = [
    {
      title: 'Что достаёт',
      dataIndex: 'target',
      width: 260,
      render: (_: string, row) => (
        <>
          <div>
            {row.target === 'identity'
              ? deviceIdentityLabels[row.keyKind ?? 'serial']
              : metricLabels[row.metricCode ?? 'marker_life_total']}
          </div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {row.target === 'metric' && row.component
              ? componentLabels[row.component]
              : 'ключ опознания'}
          </Typography.Text>
        </>
      ),
    },
    {
      title: 'Чем ищет',
      dataIndex: 'expression',
      render: (_: string, row) => (
        <>
          <div>{row.expression}</div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {parseRuleMatchKindLabels[row.matchKind]} · {parseRuleScopeLabels[row.scope]}
          </Typography.Text>
        </>
      ),
    },
    {
      title: 'Когда',
      dataIndex: 'whenFrom',
      width: 220,
      render: (_: string, row) => {
        const parts = [
          row.whenProfile ? `профиль ${row.whenProfile}` : '',
          row.whenFrom ? `от «${row.whenFrom}»` : '',
          row.whenSubject ? `тема «${row.whenSubject}»` : '',
        ].filter(Boolean);
        return parts.length === 0 ? (
          <Typography.Text type="secondary">к любому письму</Typography.Text>
        ) : (
          parts.join(', ')
        );
      },
    },
    {
      title: 'Состояние',
      dataIndex: 'isEnabled',
      width: 210,
      render: (_: boolean, row) => (
        <>
          {row.isEnabled ? <Tag color="green">Применяется</Tag> : <Tag>Выключено</Tag>}
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {formatDateTime(row.updatedAt)}
            {row.updatedByName ? ` · ${row.updatedByName}` : ''}
          </Typography.Text>
        </>
      ),
    },
    {
      title: '',
      dataIndex: 'id',
      width: 170,
      render: (_: string, row) => (
        <Space size={4} wrap>
          <Button size="small" type="link" onClick={() => setEditing(row)}>
            Изменить
          </Button>
          {/* Удаление показывается только там, где оно законно: по правилу, при жизни которого
              разбирали письма, оно и не должно предлагаться — иначе кнопка обещала бы то, чем
              сервер ответит отказом. */}
          {row.canDelete && (
            <Button
              size="small"
              type="link"
              danger
              onClick={() =>
                modal.confirm({
                  title: 'Удалить правило?',
                  content: 'По нему ещё не разбирали писем, поэтому оно удаляется совсем.',
                  okText: 'Удалить',
                  okButtonProps: { danger: true },
                  cancelText: 'Отмена',
                  onOk: () => remove.mutateAsync(row.id),
                })
              }
            >
              Удалить
            </Button>
          )}
        </Space>
      ),
    },
  ];

  return (
    <>
      <PageTableLayout
        toolbar={
          <Space wrap>
            {toolbar}
            <Button type="primary" onClick={() => setAdding(true)}>
              Новое правило
            </Button>
          </Space>
        }
      >
        {isLoading ? (
          <Spin size="small" />
        ) : items.length === 0 ? (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={RULES_EMPTY_TEXT} />
        ) : (
          <Table<DeviceParseRuleDto>
            size="small"
            rowKey="id"
            columns={columns}
            dataSource={items}
            pagination={false}
          />
        )}
      </PageTableLayout>

      <DeviceRuleFormModal open={adding} rule={null} onClose={() => setAdding(false)} />
      <DeviceRuleFormModal
        open={editing !== null}
        rule={editing}
        onClose={() => setEditing(null)}
      />
    </>
  );
}

/**
 * «Правил нет — письма читаются встроенными метками»: пустой список это норма, а не недоделка.
 * Правило заводят под формат, который портал не понял, и до первого такого письма их не бывает.
 */
export const RULES_EMPTY_TEXT = 'Правил нет — письма читаются встроенными метками профилей';
