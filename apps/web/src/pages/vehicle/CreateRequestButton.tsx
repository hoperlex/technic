import { Button, Dropdown } from 'antd';
import { DownOutlined, PlusOutlined } from '@ant-design/icons';
import { useSearchParams } from 'react-router';
import type { CreatableTab } from './shared';

/** Порядок пунктов — как у вкладок, подписи те же: видно, куда попадёшь. */
const ITEMS: { key: CreatableTab; label: string }[] = [
  { key: 'special-equipment', label: 'Заказ спецтехники' },
  { key: 'freight-transport', label: 'Грузоперевозки' },
];

/**
 * Единая кнопка «Создать заявку» для вкладок раздела «Заказ ТС».
 * Свой тип открывает форму на месте, чужой — переключает вкладку и передаёт ?new=1
 * (см. useOpenCreateFromQuery), чтобы заявка создавалась в том списке, где она потом видна.
 */
export function CreateRequestButton({
  current,
  onCreateHere,
}: {
  current: CreatableTab;
  onCreateHere: () => void;
}) {
  const [, setSearchParams] = useSearchParams();

  return (
    <Dropdown
      trigger={['click']}
      menu={{
        items: ITEMS,
        onClick: ({ key }) => {
          if (key === current) onCreateHere();
          else setSearchParams({ tab: key, new: '1' });
        },
      }}
    >
      <Button type="primary" icon={<PlusOutlined />}>
        Создать заявку
        <DownOutlined />
      </Button>
    </Dropdown>
  );
}
