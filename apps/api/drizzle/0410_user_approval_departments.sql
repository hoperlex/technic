-- Visa departments of an account and «Виза отдела» for the manager (ADR 0245, hotfix 05.11.2026).
--
-- WHY. Two managers must sign for a department and keep every manager right. The manager has no
-- scope axis, so a visa it holds was company-wide; the visa of a grant given to an axis-less role is
-- now limited to the account's visa departments and their sites (`visaLimitedToApprovalDepartments`
-- in `packages/contracts/src/visa-scope.ts`). This migration adds the storage of those departments
-- and makes the grant `department_approval` compatible with `manager`.
--
-- NUMBER. Checked against every local branch before creating the file (05.11.2026): the tree ends
-- at 0406, branches `rest-days-*` hold 0407–0409, so this takes 0410.
--
-- THE DEPLOY WINDOW. Additive only: a new table nobody reads before the restart and one catalog row.
-- Old code running between this migration and the restart never reads the table, and the catalog
-- row lets an administrator grant «Виза отдела» to a manager through an old bundle — the old server
-- then reads the visa as company-wide (no rule yet). No grant is issued by this migration, and
-- nobody holds the grant as a manager before the restart unless an administrator issues it in that
-- window; the deploy checklist of this release forbids grant edits between migration and restart.
--
-- ROLLBACK. DELETE FROM grant_roles WHERE role = 'manager' AND grant_id = (SELECT id FROM grants
-- WHERE code = 'department_approval'); DROP TABLE user_approval_departments. Assignments issued by
-- then stay in the registry and stop acting (`grantPermissionsExpr` joins `grant_roles`).

-- Same shape as `user_departments` (migration 0066) minus the head flag: the pair is the record.
CREATE TABLE user_approval_departments (
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  department_id uuid NOT NULL REFERENCES departments (id) ON DELETE CASCADE,
  created_by uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, department_id)
);

-- Asked from the department side: when its sites change, the visa holders' tokens are bumped too.
CREATE INDEX user_approval_departments_department_idx
  ON user_approval_departments (department_id);

-- The catalog row. The contract (`ROLE_GRANTS.department_approval.roles`) says the
-- same; the grant gate reads this table, so without the row the grant would stay silent on a
-- manager however the contract reads.
INSERT INTO grant_roles (grant_id, role)
SELECT g.id, 'manager'
FROM grants g
WHERE g.code = 'department_approval'
ON CONFLICT DO NOTHING;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM grant_roles gr
    JOIN grants g ON g.id = gr.grant_id
    WHERE g.code = 'department_approval' AND gr.role = 'manager'
  ) THEN
    RAISE EXCEPTION 'grant department_approval not found: the manager row was not added';
  END IF;
END $$;
