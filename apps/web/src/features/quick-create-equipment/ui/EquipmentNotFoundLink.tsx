import { useState } from 'react';
import { Alert, Button, Typography } from 'antd';
import { CustomerServiceOutlined } from '@ant-design/icons';
import type { OfficeEquipmentDto } from '@technic/contracts';
import { SupportContactsModal } from '../../../components/SupportContactsModal';
import { QuickCreateEquipmentModal } from './QuickCreateEquipmentModal';

/**
 * Текст обращения, собранный за человека: что искали и где стоит техника. Пишется он не в портале
 * (переписки в нём нет, ADR 0077), а в мессенджере поддержки, поэтому контекст показывается
 * готовым к копированию — иначе первым ответом поддержки будет «а что именно вы искали?».
 *
 * Строки, которых портал не знает, не печатаются вовсе: пустое «Объект: —» в обращении хуже, чем
 * его отсутствие, — оно выглядит ответом, которого никто не давал.
 */
function supportText(search: string, objectName: string | undefined): string {
  return [
    'Не нашёл технику в справочнике портала — не могу завести заявку на обслуживание.',
    search.trim() ? `Искал: ${search.trim()}` : null,
    objectName ? `Объект: ${objectName}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * Тупик «нужной техники нет в справочнике» под полем выбора единицы (этап 7, Р40).
 *
 * Ответов два, и различает их не роль, а право вести справочник. Кто его ведёт — заводит карточку
 * здесь же, не выходя из заявки. Кто не ведёт — идёт в техподдержку с готовым текстом обращения.
 *
 * **Почему заказчику показана техподдержка, а не контакт «оператора вашей площадки».** Такого
 * контакта в портале не существует: надстройка роли (ADR 0086) область учётки не меняет, и связи
 * «оператор ↔ площадка» в данных нет — есть лишь ничем не гарантированное пересечение объектов.
 * При централизованном операторе «оператор вашей площадки» назвал бы одного человека всей
 * компании, при нескольких — список без признака, кому писать; вдобавок это была бы новая ручка,
 * раздающая ФИО и телефоны сотрудников каждому, кто видит модуль. Обещание такого контакта
 * отменено критикой К3 плана, и восстанавливать его догадкой нельзя: понадобится настоящий
 * адресат — его заводят данными, отдельной таблицей «оператор ↔ объект», как у вывоза мусора.
 */
export function EquipmentNotFoundLink({
  canCreate,
  search,
  objectName,
  onCreated,
}: {
  /** Есть право вести справочник (`officeEquipment.write`) — тогда карточка заводится здесь. */
  canCreate: boolean;
  /** Что человек набирал в поле выбора техники — контекст обращения в поддержку. */
  search: string;
  /** Площадка учётки, когда она одна и её можно назвать; иначе объект называет сам человек. */
  objectName?: string;
  /** Заведённой единицей заполняется поле «Техника» формы заявки. */
  onCreated: (equipment: OfficeEquipmentDto) => void;
}) {
  const [createOpen, setCreateOpen] = useState(false);
  const [hintOpen, setHintOpen] = useState(false);
  const [supportOpen, setSupportOpen] = useState(false);
  const text = supportText(search, objectName);

  return (
    <div style={{ marginTop: -12, marginBottom: 16 }}>
      <Button
        type="link"
        size="small"
        style={{ padding: 0 }}
        onClick={() => (canCreate ? setCreateOpen(true) : setHintOpen((prev) => !prev))}
      >
        Не нашли технику?
      </Button>

      {/* Подсказка разворачивается по нажатию, а не висит под полем всегда: у большинства заявок
          техника находится с первой буквы, и постоянный блок про поддержку читался бы как отказ. */}
      {!canCreate && hintOpen && (
        <Alert
          type="info"
          showIcon
          style={{ marginTop: 8 }}
          message="Карточки нет в справочнике"
          description={
            <>
              <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
                Карточки заводит ответственный за оргтехнику. Напишите в техподдержку — карточку
                заведут, и заявку вы подадите по ней.
              </Typography.Paragraph>
              <Typography.Paragraph
                copyable={{ text }}
                style={{ whiteSpace: 'pre-line', marginBottom: 8 }}
              >
                {text}
              </Typography.Paragraph>
              <Button icon={<CustomerServiceOutlined />} onClick={() => setSupportOpen(true)}>
                Написать в техподдержку
              </Button>
            </>
          }
        />
      )}

      {canCreate ? (
        <QuickCreateEquipmentModal
          open={createOpen}
          onClose={() => setCreateOpen(false)}
          onCreated={onCreated}
        />
      ) : (
        /* То же окно контактов, что открывает каркас портала: другого канала поддержки нет, и
           заводить его ради одного тупика значило бы обещать ответ там, где его никто не читает. */
        <SupportContactsModal open={supportOpen} onClose={() => setSupportOpen(false)} />
      )}
    </div>
  );
}
