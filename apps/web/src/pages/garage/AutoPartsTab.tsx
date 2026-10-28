import { Segmented } from 'antd';
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

  // The page-layout classes, not a Space: the receipts table sizes its scrolling body from the
  // height its container is given, and a Space item gives none, so the table shrank to its
  // 160 px floor. The warehouse table has no scroll.y of its own, hence the scrolling body.
  return (
    <div className="page-layout">
      <div className="page-layout__header">
        <Segmented<PartView>
          value={value}
          options={[
            { value: 'receipts', label: 'Чеки' },
            { value: 'warehouse', label: 'Склад' },
          ]}
          onChange={change}
        />
      </div>
      {value === 'warehouse' ? (
        <div className="page-layout__body page-layout__body--scroll">
          <AutoPartWarehouseTab />
        </div>
      ) : (
        <div className="page-layout__body">
          <AutoPartReceiptsTab />
        </div>
      )}
    </div>
  );
}
