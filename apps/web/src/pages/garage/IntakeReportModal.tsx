import { useState } from 'react';
import { Alert, App, Button, Skeleton, Space, Tag, Typography } from 'antd';
import { CheckOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  driverReportStateLabels,
  type DriverReportState,
  type ReportItemDto,
} from '@technic/contracts';
import { vehicleReadingKeys, vehicleReadingsApi } from '@entities/vehicle-reading';
import { isApiError } from '@shared/api';
import { errorMessage } from '@shared/lib';
import { ViewModal } from '@shared/ui';
import { useAuth } from '../../auth/AuthContext';
import { IntakeReportDiscrepancies } from './IntakeReportDiscrepancies';
import { IntakeReportItems } from './IntakeReportItems';
import { IntakeReadingForm } from './IntakeReadingForm';

/**
 * Карточка отчёта дня: состав, расхождения и приём одного дня (ADR 0103; план «Показания
 * техники», §7, Р29).
 *
 * Открывается адресом (`?report=<id>`), а не состоянием экрана: ссылку «вот этот день Петрова»
 * отправляют соседу, и «назад» обязано закрыть разбор и вернуть к реестру. Отчёт при этом
 * запрашивается свой, целиком, а не берётся из ответа реестра: реестр знает про отчёт три числа
 * (Р9а), а разбирают день по составу, расхождениям и готовым причинам, почему принять нельзя.
 *
 * **Причины отказа приходят с сервера списком (`blockers`).** Портал их не выводит и вывести не
 * может: четыре условия приёма проверяются под блокировками, и своя копия правил на экране
 * предлагала бы принять день, который сервер отвергнет (или наоборот). Поэтому при `canAccept ===
 * false` кнопки нет вовсе, а на её месте — перечень причин.
 *
 * **Разбор живёт при своём предмете, а не в шапке карточки.** Подтверждение аномалии и порядок
 * смен — в строке состава ([IntakeReportItems](./IntakeReportItems.tsx)), решение по расхождению и
 * приведение снимка к источнику — в строке расхождения
 * ([IntakeReportDiscrepancies](./IntakeReportDiscrepancies.tsx)). Общего у них ровно одно —
 * правило «после изменения гасится корень слайса и объясняется 409» ([intakeAction](./intakeAction.ts)):
 * оно одно на все четыре действия, и потому написано один раз.
 */

const SHOWN_DATE = 'DD.MM.YYYY';
const SHOWN_TIME = 'DD.MM.YYYY HH:mm';

/** Цвет состояния: «принят» и «требует повторного приёма» обязаны различаться с одного взгляда. */
const STATE_COLORS: Record<DriverReportState, string> = {
  draft: 'default',
  submitted: 'blue',
  accepted: 'green',
  needs_reacceptance: 'orange',
  voided: 'default',
};

/**
 * Отказ приёма по версии и по условиям приходит одним 409 (`readings.ts`), и лечится он одним:
 * увидеть чужое изменение. Собственный текст здесь потому, что серверный зовёт обновить страницу —
 * а карточка перечитывает себя сама, и просьба сделать это руками читалась бы как поломка.
 */
const ACCEPT_CONFLICT =
  'Приём не состоялся: отчёт изменился, пока карточка была открыта. Она перечитана — посмотрите, ' +
  'что стало другим, и примите заново';

export function IntakeReportModal({
  reportId,
  onClose,
}: {
  reportId: string;
  onClose: () => void;
}) {
  const { can } = useAuth();
  const { message } = App.useApp();
  const qc = useQueryClient();
  const canWrite = can('vehicleReadings.write');

  /** Открытая форма показания: строка, за которую вносят. `null` — форма закрыта. */
  const [editing, setEditing] = useState<ReportItemDto | null>(null);

  const {
    data: report,
    isError,
    error,
  } = useQuery({
    queryKey: vehicleReadingKeys.report(reportId),
    queryFn: () => vehicleReadingsApi.report(reportId),
  });

  const accept = useMutation({
    mutationFn: (version: number) => vehicleReadingsApi.accept(reportId, version),
    onSuccess: () => {
      message.success('День принят');
      // Корень слайса (Р19): принятый день меняет и реестр, и сводку парка, и журнал машины.
      void qc.invalidateQueries({ queryKey: vehicleReadingKeys.root });
    },
    onError: (e) => {
      if (isApiError(e) && e.status === 409) {
        message.error(ACCEPT_CONFLICT);
        void qc.invalidateQueries({ queryKey: vehicleReadingKeys.root });
        return;
      }
      message.error(errorMessage(e));
    },
  });

  const title = report
    ? `Отчёт — ${report.personName}, ${dayjs(report.reportDate).format(SHOWN_DATE)}`
    : 'Отчёт';

  return (
    <ViewModal
      title={title}
      open
      onClose={onClose}
      width={840}
      footer={
        <Space>
          <Button onClick={onClose}>Закрыть</Button>
          {/* Кнопки нет, пока сервер не сказал, что принять можно: на её месте — его же причины. */}
          {report && report.canAccept && canWrite && (
            <Button
              type="primary"
              icon={<CheckOutlined />}
              loading={accept.isPending}
              onClick={() => accept.mutate(report.version)}
            >
              Принять день
            </Button>
          )}
        </Space>
      }
    >
      {isError ? (
        <Alert
          type="error"
          showIcon
          message="Отчёт не открылся"
          description={errorMessage(error)}
        />
      ) : !report ? (
        <Skeleton active paragraph={{ rows: 6 }} />
      ) : (
        <Space direction="vertical" size={12} style={{ display: 'flex' }}>
          <Space size={8} wrap>
            <Tag color={STATE_COLORS[report.state]} style={{ marginInlineEnd: 0 }}>
              {driverReportStateLabels[report.state]}
            </Tag>
            {report.acceptedAt ? (
              <Typography.Text type="secondary">
                {`принял ${report.acceptedByName || '—'} ${dayjs(report.acceptedAt).format(SHOWN_TIME)}`}
              </Typography.Text>
            ) : (
              <Typography.Text type="secondary">не принят</Typography.Text>
            )}
            {/*
             * Принятое разошлось с текущим: приём записывает версию содержимого, и правка после
             * него переводит отчёт в «требует повторного приёма». Число здесь не нужно — важно, что
             * подтверждали не это.
             */}
            {report.acceptedContentVersion !== null &&
              report.acceptedContentVersion !== report.contentVersion && (
                <Tag color="orange" style={{ marginInlineEnd: 0 }}>
                  после приёма отчёт правили
                </Tag>
              )}
          </Space>

          {/* Причины приходят готовыми и перечисляются целиком: «не закрыто строк: 2» и «не
              разобрано расхождений: 1» — это разная работа, и одной фразой их не заменить. */}
          {!report.canAccept && (
            <Alert
              type="warning"
              showIcon
              message="Принять этот день нельзя"
              description={
                <Space direction="vertical" size={0} style={{ display: 'flex' }}>
                  {report.blockers.map((blocker) => (
                    <span key={blocker}>{blocker}</span>
                  ))}
                </Space>
              }
            />
          )}

          <IntakeReportDiscrepancies report={report} canWrite={canWrite} />

          <IntakeReportItems
            report={report}
            canWrite={canWrite}
            onEdit={(item) => setEditing(item)}
          />
        </Space>
      )}

      {/*
       * Форма монтируется на время правки одной строки: у каждой строки свои начальные значения, и
       * окно, живущее между открытиями, показывало бы числа соседней смены.
       */}
      {report && editing && (
        <IntakeReadingForm report={report} item={editing} onClose={() => setEditing(null)} />
      )}
    </ViewModal>
  );
}
