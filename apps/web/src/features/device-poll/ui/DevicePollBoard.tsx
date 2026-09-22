import { useState, type ReactNode } from 'react';
import { Button, Card, Col, Empty, Row, Space, Spin, Tag, Typography } from 'antd';
import { useQuery } from '@tanstack/react-query';
import {
  devicePollOutcomeLabels,
  devicePollWroteValue,
  metricLabels,
  metricUnitLabels,
  type DevicePollAttemptDto,
  type DevicePollOutcome,
  type DevicePollTargetDto,
} from '@technic/contracts';
import { devicePollApi, devicePollKeys } from '@entities/device-poll';
import { PageTableLayout } from '@shared/ui';
import { formatDateTime } from '../../../utils/format';
import { useDevicePoll } from '../model/actions';

/**
 * ОПРОС ПО СЕТИ — режим вкладки «Техника» рядом с письмами, ключами и правилами разбора
 * (решение `docs/adr/0205-device-network-poll.md`).
 *
 * КАРТОЧКАМИ, А НЕ ТАБЛИЦЕЙ, и это не украшение. У соседних вкладок предмет — строки одного рода
 * (письма, ключи, правила), их сравнивают между собой и потому читают столбцами. Здесь предмет —
 * аппарат и состояние связи с ним: адрес, кто ответил, что снято, когда. Это карточка объекта, а не
 * строка списка, и целей на экране единицы.
 *
 * РЯДОМ С ОЧЕРЕДЬЮ ПИСЕМ, потому что работа одна: человек, который разбирает, чем аппарат отчитался
 * письмом, здесь же спрашивает у него то же число напрямую — и сравнивает.
 */

export const POLL_EMPTY_TEXT =
  'Цели опроса не настроены. Их задаёт DEVICE_POLL_TARGETS в окружении портала: ключ, название, адрес, community и серийный номер аппарата';

/**
 * Цвет исхода отвечает на один вопрос — записано ли показание, — а не на вопрос «всё ли хорошо».
 * «Снято, карточка не найдена» и «серийник не подтверждён» выглядят предупреждением именно потому,
 * что число снято, но ряд наработки его не получил: зелёный здесь читался бы как «данные есть».
 */
function outcomeColor(outcome: DevicePollOutcome): string {
  if (outcome === 'ok') return 'green';
  if (outcome === 'ok_unverified' || outcome === 'no_equipment') return 'gold';
  return 'red';
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ fontSize: 13, marginBottom: 2 }}>
      <Typography.Text type="secondary">{label}: </Typography.Text>
      {children}
    </div>
  );
}

/** Ни одной попытки: цель настроена, но её ещё ни разу не опрашивали. */
export const NO_ATTEMPT_TEXT = 'Ещё не опрашивали';

function LastAttempt({ attempt }: { attempt: DevicePollAttemptDto }) {
  return (
    <>
      <Space size={6} wrap style={{ marginBottom: 6 }}>
        <Tag color={outcomeColor(attempt.outcome)}>
          {devicePollOutcomeLabels[attempt.outcome]}
        </Tag>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {formatDateTime(attempt.startedAt)} · {attempt.durationMs} мс
        </Typography.Text>
      </Space>

      {attempt.metricCode && attempt.value !== null && attempt.unit ? (
        <div style={{ marginBottom: 6 }}>
          <Typography.Text strong style={{ fontSize: 20 }}>
            {attempt.value.toLocaleString('ru-RU')}
          </Typography.Text>{' '}
          <Typography.Text type="secondary">
            {metricUnitLabels[attempt.unit]} · {metricLabels[attempt.metricCode]}
          </Typography.Text>
          {/* Снято, но в ряд наработки не попало — сказать это надо рядом с числом, иначе число
              прочтут как записанное. */}
          {!devicePollWroteValue(attempt.outcome) && (
            <div>
              <Typography.Text type="warning" style={{ fontSize: 12 }}>
                в показания не записано
              </Typography.Text>
            </div>
          )}
        </div>
      ) : null}

      <Typography.Paragraph style={{ fontSize: 13, marginBottom: 6 }}>
        {attempt.message}
      </Typography.Paragraph>

      {/* Кто ответил — улика к исходу «отвечает другой аппарат» и к молчаливым расхождениям: по
          sysDescr видно модель, которую мы на этом адресе не ждали. */}
      {attempt.sysDescr ? <Field label="Ответил">{attempt.sysDescr}</Field> : null}
      {attempt.deviceSerial ? (
        <Field label="Серийный номер аппарата">{attempt.deviceSerial}</Field>
      ) : null}
      {attempt.requestedBy ? <Field label="Запросил">{attempt.requestedBy}</Field> : null}
    </>
  );
}

function TargetCard({
  target,
  busy,
  onPoll,
}: {
  target: DevicePollTargetDto;
  busy: boolean;
  onPoll: () => void;
}) {
  return (
    <Card
      size="small"
      title={target.label}
      extra={
        <Button type="primary" size="small" loading={busy} onClick={onPoll}>
          Получить данные
        </Button>
      }
    >
      <Field label="Адрес">{target.address}</Field>
      <Field label="Ожидаемый серийный номер">
        {target.expectedSerial || <Typography.Text type="secondary">не задан</Typography.Text>}
      </Field>
      <Field label="Карточка">
        {target.equipment ? (
          target.equipment.title
        ) : (
          /* Без карточки опрос работает, но показание писать некуда: сказать это надо ДО нажатия,
             а не исходом после него. */
          <Typography.Text type="warning">не найдена — показание записывать некуда</Typography.Text>
        )}
      </Field>

      <div style={{ borderTop: '1px solid rgba(0,0,0,0.06)', margin: '8px 0' }} />

      {target.lastAttempt ? (
        <LastAttempt attempt={target.lastAttempt} />
      ) : (
        <Typography.Text type="secondary">{NO_ATTEMPT_TEXT}</Typography.Text>
      )}
    </Card>
  );
}

export function DevicePollBoard({ toolbar }: { toolbar?: ReactNode }) {
  const poll = useDevicePoll();
  /*
   * Крутится кнопка ТОЙ цели, которую опрашивают, а не все сразу: общий `isPending` показывал бы
   * работу на каждом аппарате экрана, и человек не понял бы, чей ответ он только что увидел.
   */
  const [busyKey, setBusyKey] = useState<string | null>(null);

  const { data, isLoading } = useQuery({
    queryKey: devicePollKeys.targets(),
    queryFn: () => devicePollApi.list(),
  });
  const items = data?.items ?? [];

  const run = (key: string): void => {
    setBusyKey(key);
    void poll
      .mutateAsync(key)
      // Отказ уже объяснён сообщением мутации; здесь он гасится, чтобы не остаться необработанным
      // обещанием.
      .catch(() => undefined)
      .finally(() => setBusyKey((current) => (current === key ? null : current)));
  };

  return (
    <PageTableLayout toolbar={toolbar ? <Space wrap>{toolbar}</Space> : undefined}>
      {isLoading ? (
        <Spin size="small" />
      ) : items.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={POLL_EMPTY_TEXT} />
      ) : (
        <Row gutter={[12, 12]}>
          {items.map((target) => (
            <Col key={target.key} xs={24} md={12} xxl={8}>
              <TargetCard
                target={target}
                busy={busyKey === target.key}
                onPoll={() => run(target.key)}
              />
            </Col>
          ))}
        </Row>
      )}
    </PageTableLayout>
  );
}
