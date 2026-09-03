import { App, Alert, Switch, Table, Typography } from 'antd';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  moduleMailEventHints,
  moduleMailEventLabels,
  type ModuleMailEventSettingDto,
} from '@technic/contracts';
import { isApiError } from '@shared/api';
import { moduleMailEventKeys, moduleMailEventsApi } from '@entities/module-mail';
import { useAuth } from '../../auth/AuthContext';
import { errorMessage, formatDateTime } from '../../utils/format';

/**
 * Рубильники событий: уходит ли письмо по событию вообще (план
 * `docs/office-equipment-mail-expansion-plan.md`, §5.1; ADR 0159, решение 3).
 *
 * Отдельной подвкладкой рядом со «Служебными адресами», а не колонкой в них: там строка отвечает на
 * вопрос «кому уходит копия письма», здесь — «шлём ли мы по этому событию письма». Вопросы разные,
 * и адресатов у события может быть заведено сколько угодно, а рубильник у него ровно один.
 *
 * Заводить и удалять строки отсюда нельзя, и кнопки такой нет: реестр событий закрыт `Record` в
 * контрактах, строка приходит миграцией вместе с событием. Портал показывает то, что прислал
 * сервер, и не дорисовывает строки событий, которых сервер не назвал: событие без строки трактуется
 * сервером как выключенное, и нарисованный порталом переключатель «включено» врал бы про молчание.
 */

/** Что именно меняет один щелчок: строка нужна целиком — из неё берётся `version`. */
interface ToggleVars {
  row: ModuleMailEventSettingDto;
  isEnabled: boolean;
}

/**
 * Подпись рядом с переключателем. Названа сторона, которой письмо уходит: у сервисной компании
 * портала может не быть вовсе, и «включено» здесь означает письмо человеку за пределами конторы, а
 * не строку в журнале.
 */
const ENABLED_NOTE = 'Письма уходят, в том числе наружу — сервисной компании и её людям';
const DISABLED_NOTE = 'Писем нет: по этому событию портал молчит';

/**
 * Строки настройки у события нет вовсе (`updatedAt === null`). Сказано словами, а не показано
 * выключенным переключателем с прочерком в дате: «выключено руками» и «настройки не существует» —
 * разные положения дел. Второе означает, что событие молчит fail-closed, а строку заводит миграция
 * вместе с самим событием, и админ, ждущий тут своего щелчка, ждал бы напрасно.
 */
const MISSING_NOTE = 'Строка настройки не заведена — событие молчит';

/** Что написано рядом с переключателем: включено, выключено или строки настройки нет вовсе. */
function noteOf(row: ModuleMailEventSettingDto): string {
  if (row.updatedAt === null) return MISSING_NOTE;
  return row.isEnabled ? ENABLED_NOTE : DISABLED_NOTE;
}

/** Ненастроенная строка — не будни выключенного события: её видно предупреждением, а не серым. */
function noteTypeOf(row: ModuleMailEventSettingDto): 'warning' | 'secondary' | undefined {
  if (row.updatedAt === null) return 'warning';
  return row.isEnabled ? undefined : 'secondary';
}

export function ServiceMailEventsBlock() {
  const { message, modal } = App.useApp();
  const { can } = useAuth();
  const canManage = can('mailings.manage');
  const qc = useQueryClient();

  const { data: rows, isLoading } = useQuery({
    queryKey: moduleMailEventKeys.list(),
    queryFn: () => moduleMailEventsApi.list(),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: moduleMailEventKeys.root });

  const toggleMut = useMutation({
    mutationFn: ({ row, isEnabled }: ToggleVars) =>
      moduleMailEventsApi.update(row.event, { isEnabled, version: row.version }),
    onSuccess: async (_res, { isEnabled }) => {
      message.success(isEnabled ? 'Письма по событию включены' : 'Письма по событию выключены');
      await invalidate();
    },
    /**
     * 409 означает, что рубильником уже щёлкнули в другом окне, и версия на руках устарела. Список
     * перечитывается сразу: иначе переключатель показывал бы позапрошлое состояние, а второй
     * щелчок упирался бы в тот же отказ — версия сама по себе не обновится.
     */
    onError: async (e) => {
      message.error(errorMessage(e));
      if (isApiError(e) && e.status === 409) await invalidate();
    },
  });

  /**
   * Выключение подтверждения не спрашивает, включение спрашивает — и это не разная строгость, а
   * разная цена ошибки. Выключенное событие молчит, и вернуть его назад стоит одного щелчка;
   * включённое немедленно начинает слать письма наружу, и отправленное письмо не отзывается.
   */
  const toggle = (row: ModuleMailEventSettingDto, next: boolean): void => {
    if (!next) {
      toggleMut.mutate({ row, isEnabled: false });
      return;
    }
    modal.confirm({
      title: `Включить письма по событию «${moduleMailEventLabels[row.event]}»?`,
      content:
        'Письма пойдут наружу — сервисной компании, её операторам и назначенным исполнителям. ' +
        'Выключить событие можно тем же переключателем, но уже ушедшее письмо не вернуть: ' +
        'убедитесь, что адрес компании в справочнике контрагентов заведён верно.',
      okText: 'Включить',
      cancelText: 'Отмена',
      onOk: () => toggleMut.mutateAsync({ row, isEnabled: true }),
    });
  };

  return (
    <div style={{ padding: 16, maxWidth: 960 }}>
      <Typography.Title level={4} style={{ marginTop: 0, marginBottom: 16 }}>
        События писем
      </Typography.Title>

      <Alert
        type="warning"
        showIcon
        style={{ marginBottom: 16 }}
        title="Включённое событие шлёт письма наружу"
        description={
          'Здесь решается не то, кому уйдёт копия, а то, уходит ли письмо по событию вообще. ' +
          'Включённое событие начинает слать письма наружу — сервисной компании, её операторам и ' +
          'назначенным исполнителям, у которых учётной записи в портале может не быть. ' +
          'Выключенное молчит: заявка ведётся как обычно, портал про отсутствующее письмо ничего ' +
          'не говорит, а в журнале заявки остаётся, что письма не было и почему. ' +
          'Событие, о котором сервер не знает, писем не шлёт — строку заводит миграция вместе с ' +
          'самим событием.'
        }
      />

      <Table<ModuleMailEventSettingDto>
        size="small"
        rowKey="event"
        loading={isLoading}
        dataSource={rows ?? []}
        pagination={false}
        locale={{ emptyText: 'Событий нет — писем по ним портал не шлёт' }}
        columns={[
          {
            key: 'event',
            title: 'Событие',
            render: (_v, r) => (
              <div style={{ lineHeight: 1.4 }}>
                <div>{moduleMailEventLabels[r.event]}</div>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {moduleMailEventHints[r.event]}
                </Typography.Text>
              </div>
            ),
          },
          {
            key: 'enabled',
            title: 'Письма',
            width: 300,
            render: (_v, r) => (
              <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', lineHeight: 1.4 }}>
                <Switch
                  size="small"
                  checked={r.isEnabled}
                  disabled={!canManage || toggleMut.isPending}
                  onChange={(next) => toggle(r, next)}
                  aria-label={`Письма по событию «${moduleMailEventLabels[r.event]}»`}
                />
                <Typography.Text type={noteTypeOf(r)} style={{ fontSize: 12 }}>
                  {noteOf(r)}
                </Typography.Text>
              </div>
            ),
          },
          {
            key: 'updated',
            title: 'Щёлкнули',
            width: 180,
            render: (_v, r) => (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {formatDateTime(r.updatedAt)}
                {r.updatedByName ? ` · ${r.updatedByName}` : ''}
              </Typography.Text>
            ),
          },
        ]}
      />
    </div>
  );
}
