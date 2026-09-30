import { Segmented, Space } from 'antd';
import { useSearchParams } from 'react-router';
import { AutoPartReceiptsTab } from './AutoPartReceiptsTab';
import { AutoPartWarehouseTab } from './AutoPartWarehouseTab';

type PartView = 'receipts' | 'warehouse';

/** One garage section with two views over the same receipt-backed accounting source. */
export function AutoPartsTab() {
  const [params, setParams] = useSearchParams();
  const value: PartView = params.get('partsSub') === 'warehouse' ? 'warehouse' : 'receipts';
  const change = (next: PartView) => {
    const updated = new URLSearchParams(params);
    if (next === 'warehouse') updated.set('partsSub', next);
    else updated.delete('partsSub');
    setParams(updated, { replace: true });
  };

  return (
    <Space orientation="vertical" size={12} style={{ display: 'flex' }}>
      <Segmented<PartView>
        value={value}
        options={[
          { value: 'receipts', label: 'Чеки' },
          { value: 'warehouse', label: 'Склад' },
        ]}
        onChange={change}
      />
      {value === 'warehouse' ? <AutoPartWarehouseTab /> : <AutoPartReceiptsTab />}
    </Space>
  );
}
