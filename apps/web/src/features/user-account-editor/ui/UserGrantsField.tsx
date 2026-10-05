import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, App, Button, Checkbox, Form, Space, Spin, Tooltip, Typography } from 'antd';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  GRANT_CONFLICT_CODES,
  type GrantDto,
  type GrantStatement,
  type OfficeEquipmentProfileId,
  type Role,
  type UserGrantRefDto,
} from '@technic/contracts';
import {
  apiViolationTexts,
  grantFormApi,
  grantKeys,
  GRANT_ROLES,
  permissionLabel,
} from '@entities/grant';
import { isApiError } from '@shared/api';
import { GrantProfileField } from './GrantProfileField';
import {
  applyGrantToggle,
  buildGrantStatements,
  grantAddedPermissions,
  grantCompositionText,
  grantProfileOptions,
  hydrateGrantSelection,
  lockedGrantIds,
  NO_GRANT_EDITS,
  outOfRangeGrants,
  outOfRangeHintText,
  profilePresetCodes,
  roleGateNoticeText,
  type GrantProfileOption,
} from '../model/userGrantsModel';
import type { UserGrantsControl, UserGrantsFieldParams } from '../model/userGrantsFieldTypes';

/**
 * The "Grants" field of the account window (plan "grants are assigned in the account window",
 * R1): permission sets the administrator grants together with role, scope and activation — in a
 * single operation.
 *
 * It replaces the "Add-ons" field rather than standing next to it: the two system
 * add-ons are the same grant sets (`SYSTEM_GRANT_CODES`), and shown twice they would be two
 * switches for one access.
 *
 * The field is absent in three cases, each a decision rather than a default: no role selected
 * (grants sit on top of the position), role `driver` (barrier 2 of ADR 0106) and one's own account
 * (invariant 6, R9). The portal does not show what is unavailable, not even disabled (ADR 0033 §6).
 *
 * The computation lives in `userGrantsModel`: hydration and body assembly are checked by
 * value-level unit tests, not by clicking through markup.
 */

/**
 * The role used as the catalog key of a disabled query. `driver` fits precisely because it never
 * has the field: a query under this key never runs, so it cannot pick up someone else's response.
 */
const NO_CATALOG_ROLE: Role = 'driver';

export function useUserGrantsField(params: UserGrantsFieldParams): UserGrantsControl {
  const { open, isSelf, role, counterpartyType, record, suggestedCodes, onReload } = params;
  const { message } = App.useApp();
  const qc = useQueryClient();

  const shown = !!role && !isSelf && GRANT_ROLES.includes(role);
  /*
   * Assignments come with the account card — all of them, including those incompatible with its
   * current role: checkboxes are hydrated from them, and they supply the version of a set missing
   * from the filtered catalog (R7). The `?? []` fallback covers a response from a server that
   * predates the field's rollout.
   */
  const assigned: UserGrantRefDto[] = useMemo(() => record?.grants ?? [], [record]);
  const roleBefore = record?.role ?? null;

  const catalogQuery = useQuery({
    queryKey: grantKeys.formCatalog(role ?? NO_CATALOG_ROLE),
    queryFn: () => grantFormApi.catalog(role ?? NO_CATALOG_ROLE),
    enabled: open && shown,
    /*
     * The catalog is refetched on every window open: its versions go into the body (R7), and a
     * stale composition served from cache would turn into a 409 on save where nothing was changed.
     */
    staleTime: 0,
  });
  const catalog: GrantDto[] = useMemo(() => catalogQuery.data?.items ?? [], [catalogQuery.data]);
  /** The list is read to the end — only then may the form speak about grants (§6, §3.6). */
  const ready = shown && catalogQuery.data?.complete === true;
  const blocked = shown && (catalogQuery.isError || catalogQuery.data?.complete === false);

  const [edits, setEdits] = useState(NO_GRANT_EDITS);
  /**
   * The selected profile preset (R7) is field state, not a form value: the GRANT SETS are saved,
   * not the profile; in `UserFormValues` it would be a second statement about the same access.
   */
  const [profile, setProfile] = useState<OfficeEquipmentProfileId | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  /** Was the field in the last request: a rejection over silence has nothing to mark (R8). */
  const sent = useRef(false);
  /** Role whose consequences were already announced: the message must not repeat on each render. */
  const noticed = useRef<Role | null>(null);

  useEffect(() => {
    if (open) return;
    // Closing the window discards the whole decision: manual edits live only while it is open (R4).
    setEdits(NO_GRANT_EDITS);
    // The preset is part of that one-sitting decision: a reopened account shows what is assigned.
    setProfile(null);
    setErrors([]);
    noticed.current = null;
  }, [open]);

  /*
   * Suggested is ONE set fed by two sources (R7): the applicant's wish on activation (ADR 0143) and
   * the selected profile. A second hydration argument would mean a second prefill rule, diverging
   * from the first exactly on manually unchecked boxes.
   */
  const suggested = useMemo(
    () => [...(suggestedCodes ?? []), ...profilePresetCodes(profile)],
    [suggestedCodes, profile],
  );
  const value = useMemo(
    () => hydrateGrantSelection({ assigned, catalog, edits, suggestedCodes: suggested }),
    [assigned, catalog, edits, suggested],
  );
  const outOfRange = useMemo(() => outOfRangeGrants(assigned, catalog), [assigned, catalog]);

  /*
   * Role change: speak about the consequence, not about removal (R4). The moment is not "when the
   * role was clicked" but "when the new role's catalog arrived": before that it is unknown what
   * stops being in effect — compatibility is computed by the server, not the screen.
   */
  useEffect(() => {
    if (!ready || !role) return;
    if (role === roleBefore) {
      noticed.current = role;
      return;
    }
    if (noticed.current === role) return;
    noticed.current = role;
    const text = roleGateNoticeText(
      role,
      outOfRange.filter((g) => !g.roleMismatch),
    );
    if (text) message.info(text);
  }, [ready, role, roleBefore, outOfRange, message]);

  const statements = (): GrantStatement[] | undefined => {
    // No field or an incomplete list — `grants` is left out of the body entirely: the edit saves
    // everything else without touching assignments (§6).
    if (!shown || !ready) {
      sent.current = false;
      return undefined;
    }
    sent.current = true;
    return buildGrantStatements({
      assigned,
      catalog,
      selected: value,
      roleBefore,
      roleAfter: role,
    });
  };

  const handleError = (error: unknown): boolean => {
    if (!isApiError(error)) return false;
    if (error.status === 409 && error.code === GRANT_CONFLICT_CODES.impactChanged) {
      // The set's composition changed between opening the card and saving (R7): what was signed is
      // not what would be applied. The only outcome is to reload and reopen.
      message.error(`${error.message} — состав полномочия изменили, откройте карточку заново`);
      void qc.invalidateQueries({ queryKey: grantKeys.root });
      onReload();
      return true;
    }
    /*
     * A 400 is mapped onto the field only if the field was in the request (R8): a rejection over
     * silence — a role change that switches assignments' effect — is caused not by a checkbox but
     * by a stale screen, and there is nothing in it to highlight.
     */
    if (error.status !== 400 || !sent.current) return false;
    const texts = [
      ...(error.fields?.grants ? [error.fields.grants] : []),
      ...apiViolationTexts(error),
    ];
    if (texts.length === 0) return false;
    setErrors(texts);
    return true;
  };

  return {
    shown,
    ready,
    blocked,
    statements,
    handleError,
    field: shown ? (
      <GrantsField
        catalog={catalog}
        assigned={assigned}
        value={value}
        profile={profile}
        profileOptions={grantProfileOptions(catalog)}
        onProfile={(next) => {
          setProfile(next);
          setErrors([]);
        }}
        onChange={(next) => {
          setEdits(applyGrantToggle(edits, value, next));
          setErrors([]);
        }}
        loading={catalogQuery.isPending}
        blocked={blocked}
        onRetry={() => void catalogQuery.refetch()}
        errors={errors}
        outOfRangeHint={outOfRangeHintText(outOfRange)}
        added={grantAddedPermissions({ role, counterpartyType, catalog, selected: value })
          .map(permissionLabel)
          .join(', ')}
      />
    ) : null,
  };
}

interface FieldProps {
  catalog: GrantDto[];
  assigned: UserGrantRefDto[];
  value: string[];
  onChange: (next: string[]) => void;
  /** Selected preset; `null` — none chosen: checkboxes then describe the assignment alone. */
  profile: OfficeEquipmentProfileId | null;
  /** Profiles that have something to say under this role (`grantProfileOptions`). */
  profileOptions: GrantProfileOption[];
  onProfile: (next: OfficeEquipmentProfileId | null) => void;
  loading: boolean;
  blocked: boolean;
  onRetry: () => void;
  errors: string[];
  outOfRangeHint: string | null;
  /** Permissions beyond the position, already as catalog labels: empty — the sets add nothing. */
  added: string;
}

/** Grant sets of the compatible role as checkboxes: label is the name, tooltip the content (§6). */
function GrantsField({
  catalog,
  assigned,
  value,
  onChange,
  profile,
  profileOptions,
  onProfile,
  loading,
  blocked,
  onRetry,
  errors,
  outOfRangeHint,
  added,
}: FieldProps) {
  const locked = lockedGrantIds(assigned);

  return (
    <>
      {/* Profile preset (R7) — its own field and file. While the catalog is loading or arrived
          incomplete it is absent: offering a profile whose sets are unknown promises half a
          grant. */}
      {!blocked && !loading ? (
        <GrantProfileField profile={profile} options={profileOptions} onChange={onProfile} />
      ) : null}
      <Form.Item
        label="Полномочия"
        tooltip="Наборы прав поверх должности (ADR 0106). Область учётки они не меняют — кроме наборов со сквозной областью, о ней сказано в подсказке набора"
        validateStatus={errors.length > 0 ? 'error' : undefined}
        help={
          errors.length > 0 ? (
            <Space orientation="vertical" size={0}>
              {errors.map((text) => (
                <span key={text}>{text}</span>
              ))}
            </Space>
          ) : undefined
        }
        extra={
          blocked ? undefined : (
            <Space orientation="vertical" size={0}>
              {/* What grants give beyond the position — via two subjects, not by subtracting from
                the record's permissions: an application has none, and after a role change they
                describe the previous person. */}
              {value.length > 0 ? (
                <span>
                  {added
                    ? `Добавится сверх должности: ${added}`
                    : 'Сверх должности ничего не добавится: эти права уже даёт роль'}
                </span>
              ) : null}
              {/* Assignments outside the role's range: alive, but yield no permissions (§13.1). */}
              {outOfRangeHint ? <span>{outOfRangeHint}</span> : null}
            </Space>
          )
        }
      >
        {blocked ? (
          <Alert
            type="warning"
            showIcon
            title="Список полномочий загрузился не полностью"
            description={
              <Space orientation="vertical" size={4}>
                <span>
                  Пока он неполон, полномочия и роль не правятся: сохранение оставит назначения
                  нетронутыми. Снять и выдать наборы можно во вкладке «Права».
                </span>
                <Button size="small" onClick={onRetry}>
                  Загрузить заново
                </Button>
              </Space>
            }
          />
        ) : loading ? (
          <Spin size="small" />
        ) : catalog.length === 0 ? (
          <Typography.Text type="secondary">
            Наборов, совместимых с этой ролью, нет — выдавать нечего.
          </Typography.Text>
        ) : (
          <Checkbox.Group<string> value={value} onChange={onChange}>
            <Space orientation="vertical" size={0}>
              {catalog.map((grant) => (
                <Checkbox key={grant.id} value={grant.id} disabled={locked.has(grant.id)}>
                  <Tooltip title={grantCompositionText(grant)}>
                    <span>{grant.name}</span>
                  </Tooltip>
                  {/* A grant armed by the role migration (ADR 0113) cannot be removed here at all:
                    part of a prepared migration is removed in the grants registry, where it is
                    visible what gets removed (R4). */}
                  {locked.has(grant.id) ? (
                    <Typography.Text type="secondary">
                      {' '}
                      · взведено переводом ролей — снять можно в реестре выдач
                    </Typography.Text>
                  ) : null}
                </Checkbox>
              ))}
            </Space>
          </Checkbox.Group>
        )}
      </Form.Item>
    </>
  );
}
