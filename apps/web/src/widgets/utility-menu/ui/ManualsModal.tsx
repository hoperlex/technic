import { Button, Empty, Skeleton, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { FileTextOutlined } from '@ant-design/icons';
import type { ManualDto } from '@technic/contracts';
import { activeManualsQuery } from '@entities/manual';
import { ViewModal } from '@shared/ui';

interface Props {
  open: boolean;
  onClose: () => void;
}

/**
 * Строка списка — ссылка целиком, тем же видом, что и контакты поддержки: иконка, название и
 * пояснение под ним. Общий вид не случаен — оба окна отвечают на вопрос «куда пойти за помощью»,
 * и вторая манера показа списка ссылок в одном и том же углу меню читалась бы как другой портал.
 *
 * `target="_blank"` вместе с `rel="noreferrer noopener"`: документ лежит в чужом хранилище, и
 * открывать его вместо портала нельзя — человек ушёл бы из заявки, которую как раз и заполнял по
 * руководству. `rel` при этом обязателен: без него открытая вкладка получает `window.opener` и
 * может увести исходную куда угодно.
 */
function ManualLink({ manual }: { manual: ManualDto }) {
  return (
    <a className="support-contact" href={manual.url} target="_blank" rel="noreferrer noopener">
      <FileTextOutlined className="support-contact__icon" />
      <span className="support-contact__body">
        <span className="support-contact__title">{manual.title}</span>
        {/* Пояснение необязательно и пустой строкой не рисуется: пустая вторая строка выглядит
            обрезанной подписью, а не отсутствием пояснения. */}
        {manual.description && <span className="support-contact__hint">{manual.description}</span>}
      </span>
    </a>
  );
}

/**
 * Руководства пользователя (`docs/manuals-plan.md`): список ссылок на документы, которые ведёт
 * администратор на своей вкладке — без правки кода и выката.
 *
 * Список спрашивается при открытии окна, а не вместе с каркасом: точки «есть новое» у пункта нет
 * (новое руководство — не событие, о котором портал сигналит), и до нажатия список никому не
 * нужен. Этим окно и отличается от журнала обновлений, которому список нужен раньше открытия —
 * по нему считается точка в меню (ADR 0077).
 *
 * Пустой список объясняется словами: пункт меню виден всем и всегда, и пустое окно без объяснения
 * читалось бы как недогрузившееся.
 */
export function ManualsModal({ open, onClose }: Props) {
  const { data, isLoading, isError } = useQuery({ ...activeManualsQuery(), enabled: open });
  const manuals = data?.items ?? [];

  return (
    <ViewModal
      title="Руководства"
      open={open}
      onClose={onClose}
      width={480}
      footer={<Button onClick={onClose}>Закрыть</Button>}
    >
      <Typography.Paragraph type="secondary">
        Документы открываются в новой вкладке — портал их не хранит, а только знает, где они лежат.
      </Typography.Paragraph>

      {isLoading ? (
        <Skeleton active paragraph={{ rows: 3 }} />
      ) : isError && manuals.length === 0 ? (
        /* Именно «ошибка и показывать нечего»: при неудачном перезапросе react-query поднимает
           `isError`, но прежний список оставляет при себе, — и окно с руководствами на экране
           сменилось бы отказом, хотя ссылки в нём рабочие и никуда не делись. */
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Список сейчас недоступен" />
      ) : manuals.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Руководств пока нет" />
      ) : (
        manuals.map((manual) => <ManualLink key={manual.id} manual={manual} />)
      )}
    </ViewModal>
  );
}
