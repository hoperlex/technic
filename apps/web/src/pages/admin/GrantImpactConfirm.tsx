import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Space, Spin, Tag, Typography } from 'antd';
import { roleLabels, type GrantImpactDto } from '@technic/contracts';
import { ViewModal } from '@shared/ui';
import { errorMessage } from '../../utils/format';
import {
  impactSummaryText,
  impactViolationTexts,
  isStaleConflict,
  ROLE_MISMATCH_TAG,
  roleMismatchText,
  userDeltaText,
} from './grantModel';

/**
 * Подтверждение операции по предпросмотру последствий (ADR 0106, решение 7; план §12, §13.1).
 *
 * Одно окно на три операции — правку набора, выдачу и отзыв, — потому что подтверждают они одно и то
 * же: показанный расчёт и отпечаток того, из чего он посчитан. Два похожих окна означали бы два
 * разных ответа на 409 и, рано или поздно, одно из них — молча повторяющее запрос.
 *
 * **Отпечаток берётся из показанного предпросмотра и возвращается как есть.** Портал его не считает
 * и посчитать не может: слагаемые — состояние базы на момент расчёта (версия набора, назначения
 * держателей, `authVersion` каждого). Отсюда и весь протокол окна: сначала расчёт, потом кнопка, и
 * подтверждается ровно то, что показано.
 *
 * **409 ведёт к перечитыванию, а не к повтору.** Не совпавший отпечаток означает «за это время
 * изменилось то, от чего расчёт зависел», и повторить запрос с новым отпечатком автоматически —
 * значит применить правку, которой никто не видел. Поэтому предпросмотр запрашивается заново, окно
 * остаётся открытым и говорит, что показанное устарело.
 */

interface Props {
  open: boolean;
  title: string;
  okText: string;
  /** Загрузка предпросмотра. Она же перечитывается после 409 — тем же вызовом, что и в первый раз. */
  load: () => Promise<GrantImpactDto>;
  /**
   * Применение того, что показано. Аргумент — сам предпросмотр, а не один отпечаток: правка
   * предъявляет ещё и версию набора, и брать её надо оттуда же, откуда отпечаток. Возьми она версию
   * из строки каталога — 409 по чужой правке стал бы вечным: перечитанный предпросмотр знал бы новую
   * версию, а запрос уходил бы с прежней.
   */
  apply: (impact: GrantImpactDto) => Promise<unknown>;
  onClose: () => void;
  onApplied: () => void;
}

export function GrantImpactConfirm({
  open,
  title,
  okText,
  load,
  apply,
  onClose,
  onApplied,
}: Props) {
  const [impact, setImpact] = useState<GrantImpactDto | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  /** Показанный расчёт устарел, и вот что об этом сказал сервер. */
  const [stale, setStale] = useState<string | null>(null);

  /*
   * Обработчики держатся в ссылке, а не в зависимостях эффекта: они замыкают состав, который правят
   * прямо сейчас, и пересоздаются на каждую перерисовку родителя. В зависимостях это дало бы
   * запрос предпросмотра на каждый ход мыши; ссылка же остаётся свежей, а перечитывание случается
   * ровно там, где его просят, — при открытии окна и после 409.
   */
  const handlers = useRef({ load, apply });
  useEffect(() => {
    handlers.current = { load, apply };
  });

  const reload = async (): Promise<GrantImpactDto | null> => {
    setLoading(true);
    setLoadError(null);
    try {
      const next = await handlers.current.load();
      setImpact(next);
      return next;
    } catch (e) {
      setImpact(null);
      setLoadError(errorMessage(e));
      return null;
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!open) return;
    setStale(null);
    setApplyError(null);
    // Перечитывание завязано на открытие окна: расчёт делается один раз на показ, иначе он менялся
    // бы под рукой у того, кто его читает.
    void reload();
  }, [open]);

  const onOk = async () => {
    if (!impact) return;
    setApplying(true);
    setApplyError(null);
    try {
      await handlers.current.apply(impact);
      onApplied();
    } catch (e) {
      if (isStaleConflict(e)) {
        setStale(errorMessage(e));
        await reload();
      } else {
        // 400 по барьерам приходит с теми же текстами, что показывает предпросмотр, поэтому
        // перечитывание здесь не нужно: причина не в устаревших данных, а в самом наборе.
        setApplyError(errorMessage(e));
      }
    } finally {
      setApplying(false);
    }
  };

  const violations = impact ? impactViolationTexts(impact) : [];
  const blocked = violations.length > 0;

  return (
    <ViewModal
      title={title}
      open={open}
      onClose={onClose}
      width={680}
      destroyOnHidden
      footer={
        <Space>
          <Button onClick={onClose}>Отмена</Button>
          {/* Кнопки нет, пока нечего подтверждать либо подтверждать нельзя: недоступное портал
              скрывает, а не выключает (ADR 0033 §6). */}
          {impact && !blocked && (
            <Button type="primary" loading={applying} onClick={() => void onOk()}>
              {okText}
            </Button>
          )}
        </Space>
      }
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        {stale && (
          <Alert
            type="warning"
            showIcon
            message={stale}
            description="Предпросмотр перечитан заново: посмотрите, что изменилось, и подтвердите ещё раз."
          />
        )}
        {applyError && <Alert type="error" showIcon message={applyError} />}
        {loadError && <Alert type="error" showIcon message={loadError} />}
        {blocked && (
          <Alert
            type="error"
            showIcon
            message="Так сохранить нельзя"
            description={
              <Space direction="vertical" size={4}>
                {violations.map((text) => (
                  <span key={text}>{text}</span>
                ))}
              </Space>
            }
          />
        )}
        {loading && !impact && <Spin />}
        {impact && (
          <>
            <Typography.Text strong>{impactSummaryText(impact)}</Typography.Text>
            {impact.users.length > 0 && (
              <Space direction="vertical" size={8} style={{ width: '100%' }}>
                {impact.users.map((user) => (
                  <div key={user.userId}>
                    <Space size={6} wrap>
                      <Typography.Text strong>{user.fullName}</Typography.Text>
                      <Typography.Text type="secondary">
                        {user.role ? roleLabels[user.role] : 'роль не назначена'}
                      </Typography.Text>
                      {user.roleMismatch && <Tag color="orange">{ROLE_MISMATCH_TAG}</Tag>}
                    </Space>
                    <div>
                      <Typography.Text type="secondary">{userDeltaText(user)}</Typography.Text>
                    </div>
                    {/* Пометка тегом отвечает «что не так», а словами — «чем это для него
                        кончилось»: выдача жива, а прав по ней нет. */}
                    {user.roleMismatch && (
                      <div>
                        <Typography.Text type="secondary">
                          {roleMismatchText(user.role)}
                        </Typography.Text>
                      </div>
                    )}
                  </div>
                ))}
              </Space>
            )}
          </>
        )}
      </Space>
    </ViewModal>
  );
}
