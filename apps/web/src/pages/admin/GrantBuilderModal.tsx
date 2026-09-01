import { useEffect, useState } from 'react';
import { Alert, App, Checkbox, Col, Form, Input, Row, Space, Typography } from 'antd';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { grantCodeSchema, type GrantDto, type Permission, type Role } from '@technic/contracts';
import { userAccountKeys } from '@entities/user-account';
import { FormModal, useFormBlockers } from '@shared/ui';
import { grantKeys, grantsApi } from '../../api/resources';
import { errorMessage } from '../../utils/format';
import { GrantEffectPanel } from './GrantEffectPanel';
import { GrantImpactConfirm } from './GrantImpactConfirm';
import { GrantPermissionPicker } from './GrantPermissionPicker';
import {
  apiViolationTexts,
  GRANTABLE_PERMISSIONS,
  grantRoleOptions,
  roleListText,
} from './grantModel';

/**
 * Конструктор набора (план §12) — экран из трёх частей: слева имя, описание и совместимые роли, в
 * середине права чекбоксами по модулям, справа предпросмотр того, что набор открывает.
 *
 * **Системный набор открывается только на просмотр** (§10, решение 2 ADR 0106): его состав и код
 * живут в коде портала, а строка в базе — их отражение. Вместо сохранения у него кнопка «Создать
 * копию», заводящая обычный пользовательский набор с тем же составом, — и видно это на самом экране,
 * а не выясняется отказом сервера.
 *
 * **Правка существующего набора меняет доступ всем его держателям сразу**, поэтому она не уходит
 * прямо из этого окна: сначала предпросмотр последствий (`GrantImpactConfirm`), и сохранение идёт с
 * отпечатком, который он вернул. Заведение нового набора предпросмотра не требует — держателей у
 * него нет по построению, и подтверждать нечего.
 */

/** Черновик нового набора: им копия системного попадает в конструктор. */
export interface GrantDraft {
  code: string;
  name: string;
  description: string;
  permissions: Permission[];
  roles: Role[];
}

/** Значения полей левой части. Права живут своим состоянием: их правит средняя. */
interface BuilderValues {
  code: string;
  name: string;
  description: string;
  roles: Role[];
}

/** Подтверждаемый состав: то, что уедет в предпросмотр, а затем — в правку. */
interface Proposal {
  name: string;
  description: string;
  permissions: Permission[];
  roles: Role[];
}

interface Props {
  open: boolean;
  /** Набор, который правят или смотрят; `null` — заводят новый. */
  grant: GrantDto | null;
  /** Начальные значения нового набора: состав копируемого системного. */
  draft: GrantDraft | null;
  onClose: () => void;
  /** Копия системного набора: тот же состав, но обычным пользовательским набором. */
  onCopy: (grant: GrantDto) => void;
}

/** Копия системного набора: состав тот же, код и имя — свои, иначе их не примет сервер. */
export function draftOf(grant: GrantDto): GrantDraft {
  return {
    code: `${grant.code}_copy`,
    name: `${grant.name} (копия)`,
    description: grant.description,
    permissions: grant.permissions,
    roles: grant.roles,
  };
}

export function GrantBuilderModal({ open, grant, draft, onClose, onCopy }: Props) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [form] = Form.useForm<BuilderValues>();
  /** Отказ сервера по полю — на самом поле (ADR 0094): «код занят» ищут у кода, а не в тосте. */
  const blockers = useFormBlockers(form);
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [pending, setPending] = useState<Proposal | null>(null);
  /** Нарушения барьеров, названные сервером при отказе: их место — правая часть, рядом с составом. */
  const [violations, setViolations] = useState<string[]>([]);

  /** Системный набор правке не подлежит вовсе — окно открывается просмотром. */
  const readOnly = !!grant?.isSystem;

  useEffect(() => {
    if (!open) return;
    const base = grant ?? draft;
    setViolations([]);
    setPending(null);
    /*
     * Состав чистится списком выдаваемых прав. Невыдаваемого права в наборе не бывает — его не
     * пропустит барьер, — но пришедшее из базы значение, которого конструктор показать не может,
     * молча уехало бы обратно в правку: галочки для него нет, а в списке оно есть.
     */
    setPermissions((base?.permissions ?? []).filter((p) => GRANTABLE_PERMISSIONS.includes(p)));
    setRoles(base?.roles ?? []);
    // Полей у просмотра нет вовсе, и заполнять неподключённую форму нечем: состав системного
    // набора показывают перечень и панель, а не `Form`.
    if (!readOnly) {
      form.setFieldsValue({
        code: grant?.code ?? draft?.code ?? '',
        name: base?.name ?? '',
        description: base?.description ?? '',
        roles: base?.roles ?? [],
      });
    }
    // Значения берутся в момент открытия: следи форма за строкой каталога, набор перескакивал бы
    // под рукой у того, кто его правит, — список перечитывается сам собой.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, grant?.id, draft]);

  const createMut = useMutation({
    mutationFn: (values: BuilderValues) =>
      grantsApi.create({
        code: values.code,
        name: values.name,
        description: values.description ?? '',
        permissions,
        roles: values.roles ?? [],
      }),
    onSuccess: (created) => {
      message.success(`Полномочие «${created.name}» создано`);
      void qc.invalidateQueries({ queryKey: grantKeys.root });
      onClose();
    },
    onError: (e) => {
      // Барьеры сервер называет словами и по виновникам — им место рядом с составом, а не только в
      // тосте: исправлять придётся именно галочки.
      setViolations(apiViolationTexts(e));
      if (!blockers.fromApi(e)) message.error(errorMessage(e));
    },
  });

  const submit = async () => {
    if (readOnly) {
      if (grant) onCopy(grant);
      return;
    }
    let values: BuilderValues;
    try {
      values = await form.validateFields();
    } catch {
      // Форма уже подсветила поля — второго сообщения об этом не нужно.
      return;
    }
    const proposal: Proposal = {
      name: values.name,
      description: values.description ?? '',
      permissions,
      roles: values.roles ?? [],
    };
    if (!grant) {
      createMut.mutate(values);
      return;
    }
    setPending(proposal);
  };

  const title = grant
    ? readOnly
      ? `Системное полномочие «${grant.name}»`
      : `Правка полномочия «${grant.name}»`
    : 'Новое полномочие';

  return (
    <>
      <FormModal
        title={title}
        open={open}
        onCancel={onClose}
        onSubmit={() => void submit()}
        confirmLoading={createMut.isPending}
        width={1040}
        okText={readOnly ? 'Создать копию' : grant ? 'Сохранить' : 'Создать'}
      >
        <Row gutter={[16, 16]}>
          <Col xs={24} md={7}>
            {readOnly ? (
              <Space orientation="vertical" size={8} style={{ width: '100%' }}>
                <Alert
                  type="info"
                  showIcon
                  title="Только просмотр"
                  description="Состав и код системного полномочия живут в коде портала: правка в базе отвязала бы набор от таблиц кода и сломала бы обратимость перевода ролей. Копия заводится обычным пользовательским набором — с тем же составом, но без сквозной области."
                />
                <div>
                  <Typography.Text type="secondary">Код: </Typography.Text>
                  {grant?.code}
                </div>
                <div>
                  <Typography.Text type="secondary">Описание: </Typography.Text>
                  {grant?.description || '—'}
                </div>
                <div>
                  <Typography.Text type="secondary">Совместимые роли: </Typography.Text>
                  {roleListText(roles)}
                </div>
              </Space>
            ) : (
              <Form
                form={form}
                layout="vertical"
                onFinish={() => void submit()}
                {...blockers.formProps}
              >
                {grant ? (
                  <div style={{ marginBottom: 12 }}>
                    <Typography.Text type="secondary">Код: </Typography.Text>
                    {grant.code}
                    <div>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        Код набора не меняется: на нём держатся журнал и реестр выдач.
                      </Typography.Text>
                    </div>
                  </div>
                ) : (
                  <Form.Item
                    name="code"
                    label="Код"
                    // Правило берётся у контрактов: тот же разбор кода, которым отвечает сервер, —
                    // и «код занят системным полномочием» приходит его словами.
                    rules={[
                      {
                        required: true,
                        validator: (_rule, value: string) => {
                          const parsed = grantCodeSchema.safeParse(value);
                          return parsed.success
                            ? Promise.resolve()
                            : Promise.reject(new Error(parsed.error.issues[0]!.message));
                        },
                      },
                    ]}
                  >
                    <Input placeholder="fuel_intake" />
                  </Form.Item>
                )}
                <Form.Item
                  name="name"
                  label="Название"
                  rules={[{ required: true, message: 'Укажите название' }]}
                >
                  <Input placeholder="Приёмка топлива" />
                </Form.Item>
                <Form.Item name="description" label="Описание">
                  <Input.TextArea rows={3} placeholder="Чем набор объясняет себя в каталоге" />
                </Form.Item>
                <Form.Item name="roles" label="Совместимые роли">
                  {/* Роли водителя в списке нет вовсе: кабинет открывает задание конкретного
                      работника, и добавить к нему чужие права нельзя ни одним способом. */}
                  <Checkbox.Group
                    options={grantRoleOptions}
                    onChange={(next) => setRoles(next as Role[])}
                  />
                </Form.Item>
                {grant && grant.holderCount > 0 && (
                  <Alert
                    type="warning"
                    showIcon
                    title={`Набор выдан учётным записям: ${grant.holderCount}`}
                    description="Правка меняет их доступ сразу — перед сохранением портал покажет, кого и как именно."
                  />
                )}
              </Form>
            )}
          </Col>
          <Col xs={24} md={9}>
            <Typography.Text strong>Права</Typography.Text>
            <div style={{ maxHeight: '48vh', overflowY: 'auto', marginTop: 8 }}>
              <GrantPermissionPicker
                value={permissions}
                onChange={setPermissions}
                readOnly={readOnly}
              />
            </div>
          </Col>
          <Col xs={24} md={8}>
            <Typography.Text strong>Что откроется</Typography.Text>
            <div style={{ marginTop: 8 }}>
              <GrantEffectPanel
                permissions={permissions}
                roles={roles}
                violations={violations}
                unknownPermissions={grant?.unknownPermissions}
              />
            </div>
          </Col>
        </Row>
      </FormModal>

      {grant && pending && (
        <GrantImpactConfirm
          open
          title={`Правка «${pending.name}»: последствия`}
          okText="Подтвердить правку"
          load={() =>
            grantsApi.preview(grant.id, {
              name: pending.name,
              permissions: pending.permissions,
              roles: pending.roles,
            })
          }
          /*
           * Версия и отпечаток берутся из **показанного** предпросмотра, а не из строки каталога.
           * Иначе 409 по чужой правке состава стал бы вечным: перечитанный предпросмотр знал бы
           * новую версию, а сохранение по-прежнему предъявляло бы ту, с которой открыли список.
           */
          apply={(impact) =>
            grantsApi.update(grant.id, {
              expectedVersion: impact.version,
              expectedImpactHash: impact.expectedImpactHash,
              name: pending.name,
              description: pending.description,
              permissions: pending.permissions,
              roles: pending.roles,
            })
          }
          onClose={() => setPending(null)}
          onApplied={() => {
            message.success('Полномочие изменено');
            void qc.invalidateQueries({ queryKey: grantKeys.root });
            // Правка состава меняет права всех держателей: витрина «Люди» и выборки учёток обязаны
            // это увидеть, иначе соседняя подвкладка показывала бы прежний доступ.
            void qc.invalidateQueries({ queryKey: userAccountKeys.root });
            setPending(null);
            onClose();
          }}
        />
      )}
    </>
  );
}
