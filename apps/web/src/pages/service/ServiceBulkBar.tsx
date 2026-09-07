import { useEffect, useState } from 'react';
import { Button, Typography } from 'antd';
import {
  SERVICE_REQUEST_BULK_LIMIT,
  canUseServiceBulk,
  type ServiceRequestDto,
} from '@technic/contracts';
import { listScopeKey, type SelectionConfig } from '@shared/ui';
import { useAuth } from '../../auth/AuthContext';
import type { ServiceMenuItem } from './serviceStatusChoices';
import {
  readServiceBulkRun,
  serviceBulkCommands,
  serviceBulkRefusal,
  serviceBulkRequestsLabel,
  type ServiceBulkCommand,
} from './serviceBulkCommands';
import { ServiceBulkModal, type ServiceBulkTarget } from './ServiceBulkModal';

/**
 * Полоса массовых действий над выбранными заявками — ВТОРОЙ, ОБЪЯВЛЕННЫЙ вход к тем же действиям
 * (ADR 0162, Р16 плана `docs/office-equipment-bulk-actions-plan.md`).
 *
 * Своей карты правил у полосы нет: команды считает проекция набора действий
 * (`serviceBulkCommands`), а допуск к массовому режиму — предикат контрактов. Заявитель не
 * получает ни полосы, ни чекбоксов вовсе (Н11): `selection` ему не передаётся, и выбирать нечем.
 * На телефоне полосы нет по другой причине и решает это `DataTable`: карточка списка чекбоксов не
 * имеет, а полоса без них — управление тем, чего нельзя выбрать (Р15).
 */

/** Что полоса берёт у реестра: строки страницы и тот же набор действий, что рисует меню строки. */
export interface ServiceBulkGrid {
  requests: ServiceRequestDto[];
  actions: (request: ServiceRequestDto) => ServiceMenuItem[];
}

function BulkBar({
  commands,
  total,
  busy,
  onPick,
  onClear,
}: {
  commands: ServiceBulkCommand[];
  total: number;
  busy: boolean;
  onPick: (command: ServiceBulkCommand) => void;
  onClear: () => void;
}) {
  return (
    <>
      <Typography.Text strong>{`Выбрано ${serviceBulkRequestsLabel(total)}`}</Typography.Text>
      {commands.map((command) => (
        <Button
          key={command.operation}
          danger={command.danger}
          disabled={busy}
          onClick={() => onPick(command)}
        >
          {/* Счётчик применимых — прямо в подписи (Р6): «какая из строк мешает» отвечается до
              нажатия, а не загадкой из отказа. */}
          {`${command.label} (${command.rows.length} из ${total})`}
        </Button>
      ))}
      {commands.length === 0 && (
        <Typography.Text type="secondary">Общих действий у выбранных заявок нет</Typography.Text>
      )}
      {!busy && <Button onClick={onClear}>Снять выбор</Button>}
    </>
  );
}

/**
 * Выбор строк реестра заявок и полоса над ним. Возвращает готовый `SelectionConfig` — либо
 * `undefined` тому, кому массовый режим не положен: полоса, чекбоксы и окно появляются вместе.
 *
 * ОКНО ПАЧКИ ЖИВЁТ ПРИ ПОЛОСЕ, а полоса — при непустом выборе (`DataTable` рисует её только
 * тогда). Отсюда две оговорки, и обе намеренные. Набор снимается не по завершении операции, а по
 * закрытию отчёта: сними мы его раньше, отчёт о чужой работе исчез бы у человека из-под рук
 * (Р12). А отпечаток отбора на время открытого окна ЗАМОРАЖИВАЕТСЯ — смена фильтра посреди пачки
 * не должна уносить вместе с выбором и отчёт уже запущенной операции (§7.2); снимается набор всё
 * равно, но при закрытии окна.
 */
export function useServiceBulk(
  grid: ServiceBulkGrid,
  query: Record<string, unknown>,
): SelectionConfig<ServiceRequestDto> | undefined {
  const { user } = useAuth();
  const scope = listScopeKey(query);
  const [keys, setKeys] = useState<string[]>([]);
  const [frozen, setFrozen] = useState<string | null>(null);
  const [target, setTarget] = useState<ServiceBulkTarget | null>(null);

  /*
   * Пачка, пережившая перезагрузку вкладки (§7.2): ключ, отпечаток и тело лежат в
   * `sessionStorage`, пока операция не завершилась. Выбор восстанавливается вместе с окном —
   * иначе полосы не будет, а с ней исчезнет и окно, в котором человек ждал отчёта.
   */
  useEffect(() => {
    const run = readServiceBulkRun();
    if (!run) return;
    setKeys(run.body.rows.map((row) => row.id));
    setFrozen(scope);
    setTarget({ kind: 'restored', run });
    // Ровно один раз при открытии реестра: восстанавливают брошенную пачку, а не следят за отбором.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Допуск к массовому режиму — продуктовое ограничение поверх прав (Р5): у заявителя есть
  // `serviceRequests.delete` на свою новую заявку, но массового интерфейса он не получает.
  if (!canUseServiceBulk(user)) return undefined;

  const selected = grid.requests.filter((row) => keys.includes(row.id));
  const commands = serviceBulkCommands(selected, grid.actions, user);

  const close = (used: boolean) => {
    setTarget(null);
    setFrozen(null);
    // Пачка ушла — набор снят: версии выбранных строк заведомо устарели. Отменённое подтверждение
    // выбор оставляет: человек передумал про команду, а не про строки.
    if (used) setKeys([]);
  };

  return {
    keys,
    onChange: setKeys,
    scopeKey: frozen ?? scope,
    maxSelected: SERVICE_REQUEST_BULK_LIMIT,
    disabled: (request) => serviceBulkRefusal(request, grid.actions, user),
    bar: () => (
      <>
        <BulkBar
          commands={commands}
          total={keys.length}
          busy={!!target}
          onPick={(command) => {
            setFrozen(scope);
            setTarget({ kind: 'command', command });
          }}
          onClear={() => setKeys([])}
        />
        {target && (
          <ServiceBulkModal
            target={target}
            latest={(id) => grid.requests.find((row) => row.id === id)}
            onClose={close}
          />
        )}
      </>
    ),
  };
}
