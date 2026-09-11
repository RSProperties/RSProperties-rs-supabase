-- ============================================================
-- Phase 3 cutover (2026-09-07): flips reports/workspace/warehouse RLS
-- from `using (true)` to auth.uid()-based policies. ONLY apply this
-- after confirming (via team-auth) that a real login actually returns
-- a working access_token and that dbH()/_tuH() on the client are
-- already deployed to use it - otherwise every session still on the
-- anon-key fallback gets locked out of reports/workspace/warehouse
-- the instant this runs.
-- ============================================================

-- 3. reports — maps 1:1 to the existing 'reports' permission group.
drop policy if exists team_reports on reports;
create policy reports_select on reports for select
  using (team_has_permission('reports', 'view'));
create policy reports_write on reports for insert
  with check (team_has_permission('reports', 'edit'));
create policy reports_update on reports for update
  using (team_has_permission('reports', 'edit'))
  with check (team_has_permission('reports', 'edit'));
create policy reports_delete on reports for delete
  using (team_has_permission('reports', 'edit'));

-- 4. workspace — a single generic key/value store shared by ~30 different
--    features (properties, settlements, tasks, backups, ...) that doesn't
--    map cleanly onto one permission group each. Coarse gate: any active
--    team member (still a massive improvement over "the entire internet",
--    and matches how loosely the client already treats this store).
drop policy if exists team_workspace on workspace;
create policy workspace_all on workspace for all
  using (team_is_active())
  with check (team_is_active());

-- 5. warehouse — viewing stays open to any active team member (matches
--    current behaviour); adding/adjusting stock requires the dedicated
--    'sklad_edit' permission group that already exists for exactly this.
drop policy if exists sklad_all on warehouse_items;
create policy warehouse_items_select on warehouse_items for select
  using (team_is_active());
create policy warehouse_items_write on warehouse_items for insert
  with check (team_has_permission('sklad_edit', 'edit'));
create policy warehouse_items_update on warehouse_items for update
  using (team_has_permission('sklad_edit', 'edit'))
  with check (team_has_permission('sklad_edit', 'edit'));
create policy warehouse_items_delete on warehouse_items for delete
  using (team_has_permission('sklad_edit', 'edit'));

drop policy if exists log_all on warehouse_log;
create policy warehouse_log_select on warehouse_log for select
  using (team_is_active());
create policy warehouse_log_write on warehouse_log for insert
  with check (team_has_permission('sklad_edit', 'edit'));
create policy warehouse_log_update on warehouse_log for update
  using (team_has_permission('sklad_edit', 'edit'))
  with check (team_has_permission('sklad_edit', 'edit'));
create policy warehouse_log_delete on warehouse_log for delete
  using (team_has_permission('sklad_edit', 'edit'));

notify pgrst, 'reload schema';
