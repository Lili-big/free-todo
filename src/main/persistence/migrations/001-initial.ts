import { TASK_PLANNED_START_SQL } from './003-task-planned-start'

export const INITIAL_SCHEMA_SQL = String.raw`
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  checksum TEXT NOT NULL,
  applied_at_utc INTEGER NOT NULL
) STRICT;

CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL CHECK(json_valid(value_json)),
  updated_at_utc INTEGER NOT NULL
) STRICT;

CREATE TABLE database_meta (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  data_revision INTEGER NOT NULL DEFAULT 0 CHECK(data_revision >= 0),
  last_reconciled_on TEXT NULL CHECK(last_reconciled_on IS NULL OR (length(last_reconciled_on) = 10 AND last_reconciled_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'))
) STRICT;
INSERT INTO database_meta(id, data_revision, last_reconciled_on) VALUES (1, 0, NULL);

CREATE TABLE goal_categories (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 200),
  normalized_name TEXT NOT NULL UNIQUE CHECK(length(normalized_name) > 0),
  created_at_utc INTEGER NOT NULL,
  updated_at_utc INTEGER NOT NULL
) STRICT;

CREATE TABLE goals (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 200),
  description TEXT NULL CHECK(description IS NULL OR length(description) <= 10000),
  category_id TEXT NULL REFERENCES goal_categories(id) ON DELETE RESTRICT,
  priority TEXT NULL CHECK(priority IS NULL OR priority IN ('P0','P1','P2','P3')),
  period_kind TEXT NOT NULL CHECK(period_kind IN ('NONE','MONTH','QUARTER','YEAR','CUSTOM')),
  period_start_on TEXT NULL CHECK(period_start_on IS NULL OR (length(period_start_on) = 10 AND period_start_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')),
  period_end_on TEXT NULL CHECK(period_end_on IS NULL OR (length(period_end_on) = 10 AND period_end_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')),
  status TEXT NOT NULL CHECK(status IN ('ACTIVE','PAUSED','REVIEW_REQUIRED','COMPLETED','ABANDONED')),
  created_at_utc INTEGER NOT NULL,
  updated_at_utc INTEGER NOT NULL,
  row_version INTEGER NOT NULL DEFAULT 1 CHECK(row_version >= 1),
  CHECK (
    (period_kind = 'NONE' AND period_start_on IS NULL AND period_end_on IS NULL)
    OR
    (period_kind <> 'NONE' AND period_start_on IS NOT NULL AND period_end_on IS NOT NULL AND period_start_on <= period_end_on)
  )
) STRICT;

CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  goal_id TEXT NULL REFERENCES goals(id) ON DELETE RESTRICT,
  name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 200),
  description TEXT NULL CHECK(description IS NULL OR length(description) <= 10000),
  status TEXT NOT NULL CHECK(status IN ('ACTIVE','COMPLETED')),
  created_at_utc INTEGER NOT NULL,
  updated_at_utc INTEGER NOT NULL,
  row_version INTEGER NOT NULL DEFAULT 1 CHECK(row_version >= 1)
) STRICT;

CREATE TABLE recurrence_series (
  id TEXT PRIMARY KEY,
  created_on TEXT NOT NULL CHECK(length(created_on) = 10 AND created_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  materialized_through_on TEXT NULL CHECK(materialized_through_on IS NULL OR (length(materialized_through_on) = 10 AND materialized_through_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')),
  created_at_utc INTEGER NOT NULL,
  updated_at_utc INTEGER NOT NULL,
  row_version INTEGER NOT NULL DEFAULT 1 CHECK(row_version >= 1)
) STRICT;

CREATE TABLE recurrence_rule_versions (
  id TEXT PRIMARY KEY,
  series_id TEXT NOT NULL REFERENCES recurrence_series(id) ON DELETE RESTRICT,
  effective_from_on TEXT NOT NULL CHECK(length(effective_from_on) = 10 AND effective_from_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  effective_to_on_exclusive TEXT NULL CHECK(effective_to_on_exclusive IS NULL OR (length(effective_to_on_exclusive) = 10 AND effective_to_on_exclusive GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')),
  timeline_active INTEGER NOT NULL DEFAULT 1 CHECK(timeline_active IN (0,1)),
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  title TEXT NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 200),
  notes TEXT NULL CHECK(notes IS NULL OR length(notes) <= 10000),
  project_id TEXT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  is_important INTEGER NOT NULL CHECK(is_important IN (0,1)),
  is_urgent INTEGER NOT NULL CHECK(is_urgent IN (0,1)),
  rule_kind TEXT NOT NULL CHECK(rule_kind IN ('DAILY','WEEKLY','MONTHLY')),
  rule_start_on TEXT NOT NULL CHECK(length(rule_start_on) = 10 AND rule_start_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  rule_end_on TEXT NULL CHECK(rule_end_on IS NULL OR (length(rule_end_on) = 10 AND rule_end_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')),
  weekday_mask INTEGER NOT NULL DEFAULT 0 CHECK(weekday_mask BETWEEN 0 AND 127),
  monthly_day INTEGER NULL CHECK(monthly_day IS NULL OR monthly_day BETWEEN 1 AND 31),
  created_at_utc INTEGER NOT NULL,
  retired_at_utc INTEGER NULL,
  UNIQUE(id, series_id),
  CHECK(effective_to_on_exclusive IS NULL OR effective_to_on_exclusive > effective_from_on),
  CHECK(rule_end_on IS NULL OR rule_end_on >= rule_start_on),
  CHECK (
    (rule_kind = 'DAILY' AND weekday_mask = 0 AND monthly_day IS NULL)
    OR (rule_kind = 'WEEKLY' AND weekday_mask BETWEEN 1 AND 127 AND monthly_day IS NULL)
    OR (rule_kind = 'MONTHLY' AND weekday_mask = 0 AND monthly_day BETWEEN 1 AND 31)
  )
) STRICT;

CREATE UNIQUE INDEX uq_rule_active_start
  ON recurrence_rule_versions(series_id, effective_from_on)
  WHERE timeline_active = 1;

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 200),
  notes TEXT NULL CHECK(notes IS NULL OR length(notes) <= 10000),
  planned_on TEXT NULL CHECK(planned_on IS NULL OR (length(planned_on) = 10 AND planned_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')),
  status TEXT NOT NULL CHECK(status IN ('TODO','DONE','CANCELLED')),
  project_id TEXT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  project_scope TEXT GENERATED ALWAYS AS (coalesce(project_id, '@none')) STORED,
  parent_task_id TEXT NULL,
  is_important INTEGER NOT NULL DEFAULT 0 CHECK(is_important IN (0,1)),
  is_urgent INTEGER NOT NULL DEFAULT 0 CHECK(is_urgent IN (0,1)),
  completed_on TEXT NULL CHECK(completed_on IS NULL OR (length(completed_on) = 10 AND completed_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')),
  cancelled_on TEXT NULL CHECK(cancelled_on IS NULL OR (length(cancelled_on) = 10 AND cancelled_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')),
  recurrence_series_id TEXT NULL REFERENCES recurrence_series(id) ON DELETE RESTRICT,
  applied_rule_version_id TEXT NULL,
  original_occurrence_on TEXT NULL CHECK(original_occurrence_on IS NULL OR (length(original_occurrence_on) = 10 AND original_occurrence_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')),
  is_recurrence_exception INTEGER NOT NULL DEFAULT 0 CHECK(is_recurrence_exception IN (0,1)),
  created_on TEXT NOT NULL CHECK(length(created_on) = 10 AND created_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  created_at_utc INTEGER NOT NULL,
  updated_at_utc INTEGER NOT NULL,
  row_version INTEGER NOT NULL DEFAULT 1 CHECK(row_version >= 1),
  UNIQUE(id, project_scope),
  FOREIGN KEY(parent_task_id, project_scope) REFERENCES tasks(id, project_scope) DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY(applied_rule_version_id, recurrence_series_id) REFERENCES recurrence_rule_versions(id, series_id) ON DELETE RESTRICT,
  CHECK(parent_task_id IS NULL OR parent_task_id <> id),
  CHECK (
    (status = 'TODO' AND completed_on IS NULL AND cancelled_on IS NULL)
    OR (status = 'DONE' AND completed_on IS NOT NULL AND cancelled_on IS NULL)
    OR (status = 'CANCELLED' AND cancelled_on IS NOT NULL AND completed_on IS NULL)
  ),
  CHECK (
    (recurrence_series_id IS NULL AND applied_rule_version_id IS NULL AND original_occurrence_on IS NULL AND is_recurrence_exception = 0)
    OR
    (recurrence_series_id IS NOT NULL AND applied_rule_version_id IS NOT NULL AND original_occurrence_on IS NOT NULL AND parent_task_id IS NULL AND (status = 'TODO' OR is_recurrence_exception = 1))
  )
) STRICT;

CREATE UNIQUE INDEX uq_task_occurrence
  ON tasks(recurrence_series_id, original_occurrence_on)
  WHERE recurrence_series_id IS NOT NULL;
CREATE INDEX ix_tasks_status_planned ON tasks(status, planned_on);
CREATE INDEX ix_tasks_parent ON tasks(parent_task_id);
CREATE INDEX ix_tasks_project_status ON tasks(project_id, status);
CREATE INDEX ix_tasks_completed_status ON tasks(completed_on, status);

CREATE TABLE task_schedule_history (
  event_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  old_planned_on TEXT NULL CHECK(old_planned_on IS NULL OR (length(old_planned_on) = 10 AND old_planned_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')),
  new_planned_on TEXT NULL CHECK(new_planned_on IS NULL OR (length(new_planned_on) = 10 AND new_planned_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')),
  changed_on TEXT NOT NULL CHECK(length(changed_on) = 10 AND changed_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  changed_at_utc INTEGER NOT NULL
) STRICT;

CREATE TABLE task_status_history (
  event_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
  old_status TEXT NOT NULL CHECK(old_status IN ('TODO','DONE','CANCELLED')),
  new_status TEXT NOT NULL CHECK(new_status IN ('TODO','DONE','CANCELLED')),
  changed_on TEXT NOT NULL CHECK(length(changed_on) = 10 AND changed_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  changed_at_utc INTEGER NOT NULL
) STRICT;
CREATE INDEX ix_task_status_history_day ON task_status_history(changed_on, task_id, event_seq);

CREATE TABLE project_status_history (
  event_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  old_status TEXT NOT NULL CHECK(old_status IN ('ACTIVE','COMPLETED')),
  new_status TEXT NOT NULL CHECK(new_status IN ('ACTIVE','COMPLETED')),
  changed_on TEXT NOT NULL CHECK(length(changed_on) = 10 AND changed_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  changed_at_utc INTEGER NOT NULL
) STRICT;

CREATE TABLE goal_status_history (
  event_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE RESTRICT,
  old_status TEXT NOT NULL CHECK(old_status IN ('ACTIVE','PAUSED','REVIEW_REQUIRED','COMPLETED','ABANDONED')),
  new_status TEXT NOT NULL CHECK(new_status IN ('ACTIVE','PAUSED','REVIEW_REQUIRED','COMPLETED','ABANDONED')),
  changed_on TEXT NOT NULL CHECK(length(changed_on) = 10 AND changed_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  changed_at_utc INTEGER NOT NULL
) STRICT;

CREATE TABLE daily_review_state (
  review_on TEXT PRIMARY KEY CHECK(length(review_on) = 10 AND review_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  first_opened_at_utc INTEGER NULL,
  dismissed_at_utc INTEGER NULL,
  started_at_utc INTEGER NULL,
  finished_at_utc INTEGER NULL
) STRICT;

CREATE INDEX ix_projects_goal_status ON projects(goal_id, status);
CREATE INDEX ix_goals_status_period_end ON goals(status, period_end_on);
CREATE INDEX ix_rule_series_timeline ON recurrence_rule_versions(series_id, timeline_active, effective_from_on);

CREATE TRIGGER trg_rule_no_overlap_insert
BEFORE INSERT ON recurrence_rule_versions
WHEN NEW.timeline_active = 1
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM recurrence_rule_versions existing
    WHERE existing.series_id = NEW.series_id
      AND existing.timeline_active = 1
      AND (existing.effective_to_on_exclusive IS NULL OR NEW.effective_from_on < existing.effective_to_on_exclusive)
      AND (NEW.effective_to_on_exclusive IS NULL OR existing.effective_from_on < NEW.effective_to_on_exclusive)
  ) THEN RAISE(ABORT, 'RECURRENCE_TIMELINE_OVERLAP') END;
END;

CREATE TRIGGER trg_rule_no_overlap_update
BEFORE UPDATE ON recurrence_rule_versions
WHEN NEW.timeline_active = 1
BEGIN
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM recurrence_rule_versions existing
    WHERE existing.series_id = NEW.series_id
      AND existing.timeline_active = 1
      AND existing.id <> NEW.id
      AND (existing.effective_to_on_exclusive IS NULL OR NEW.effective_from_on < existing.effective_to_on_exclusive)
      AND (NEW.effective_to_on_exclusive IS NULL OR existing.effective_from_on < NEW.effective_to_on_exclusive)
  ) THEN RAISE(ABORT, 'RECURRENCE_TIMELINE_OVERLAP') END;
END;

CREATE TRIGGER trg_rule_immutable_update
BEFORE UPDATE ON recurrence_rule_versions
BEGIN
  SELECT CASE WHEN
    OLD.id IS NOT NEW.id OR OLD.series_id IS NOT NEW.series_id OR OLD.effective_from_on IS NOT NEW.effective_from_on
    OR OLD.enabled IS NOT NEW.enabled OR OLD.title IS NOT NEW.title OR OLD.notes IS NOT NEW.notes
    OR OLD.project_id IS NOT NEW.project_id OR OLD.is_important IS NOT NEW.is_important OR OLD.is_urgent IS NOT NEW.is_urgent
    OR OLD.rule_kind IS NOT NEW.rule_kind OR OLD.rule_start_on IS NOT NEW.rule_start_on OR OLD.rule_end_on IS NOT NEW.rule_end_on
    OR OLD.weekday_mask IS NOT NEW.weekday_mask OR OLD.monthly_day IS NOT NEW.monthly_day OR OLD.created_at_utc IS NOT NEW.created_at_utc
  THEN RAISE(ABORT, 'RECURRENCE_VERSION_IMMUTABLE') END;
END;

CREATE TRIGGER trg_rule_completed_project_insert
BEFORE INSERT ON recurrence_rule_versions
WHEN NEW.timeline_active = 1 AND NEW.enabled = 1 AND NEW.project_id IS NOT NULL
  AND NEW.effective_to_on_exclusive IS NULL
BEGIN
  SELECT CASE WHEN EXISTS (SELECT 1 FROM projects WHERE id = NEW.project_id AND status = 'COMPLETED')
    THEN RAISE(ABORT, 'PROJECT_COMPLETED') END;
END;

CREATE TRIGGER trg_series_identity_immutable
BEFORE UPDATE ON recurrence_series
BEGIN
  SELECT CASE WHEN OLD.id IS NOT NEW.id OR OLD.created_on IS NOT NEW.created_on OR OLD.created_at_utc IS NOT NEW.created_at_utc
    THEN RAISE(ABORT, 'RECURRENCE_SERIES_IDENTITY_IMMUTABLE') END;
END;

CREATE TRIGGER trg_task_validate_insert
BEFORE INSERT ON tasks
BEGIN
  SELECT CASE WHEN NEW.parent_task_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM tasks parent WHERE parent.id = NEW.parent_task_id AND parent.parent_task_id IS NOT NULL
  ) THEN RAISE(ABORT, 'TASK_DEPTH_EXCEEDED') END;
  SELECT CASE WHEN NEW.parent_task_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM tasks parent WHERE parent.id = NEW.parent_task_id AND parent.recurrence_series_id IS NOT NULL
  ) THEN RAISE(ABORT, 'RECURRENCE_RELATION_FORBIDDEN') END;
  SELECT CASE WHEN NEW.parent_task_id IS NOT NULL AND NEW.status = 'TODO' AND EXISTS (
    SELECT 1 FROM tasks parent WHERE parent.id = NEW.parent_task_id AND parent.status <> 'TODO'
  ) THEN RAISE(ABORT, 'PARENT_NOT_ACTIVE') END;
  SELECT CASE WHEN NEW.project_id IS NOT NULL AND NEW.status = 'TODO' AND EXISTS (
    SELECT 1 FROM projects project WHERE project.id = NEW.project_id AND project.status = 'COMPLETED'
  ) THEN RAISE(ABORT, 'PROJECT_COMPLETED') END;
  SELECT CASE WHEN NEW.recurrence_series_id IS NOT NULL AND NEW.is_recurrence_exception = 0 AND NOT EXISTS (
    SELECT 1 FROM recurrence_rule_versions version
    WHERE version.id = NEW.applied_rule_version_id AND version.series_id = NEW.recurrence_series_id
      AND NEW.status = 'TODO' AND NEW.planned_on = NEW.original_occurrence_on
      AND NEW.title = version.title AND NEW.notes IS version.notes AND NEW.project_id IS version.project_id
      AND NEW.is_important = version.is_important AND NEW.is_urgent = version.is_urgent
  ) THEN RAISE(ABORT, 'RECURRENCE_PRISTINE_INVALID') END;
END;

CREATE TRIGGER trg_task_validate_update
BEFORE UPDATE ON tasks
BEGIN
  SELECT CASE WHEN NEW.parent_task_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM tasks parent WHERE parent.id = NEW.parent_task_id AND parent.parent_task_id IS NOT NULL
  ) THEN RAISE(ABORT, 'TASK_DEPTH_EXCEEDED') END;
  SELECT CASE WHEN NEW.parent_task_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM tasks child WHERE child.parent_task_id = NEW.id
  ) THEN RAISE(ABORT, 'TASK_DEPTH_EXCEEDED') END;
  SELECT CASE WHEN NEW.parent_task_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM tasks parent WHERE parent.id = NEW.parent_task_id AND parent.recurrence_series_id IS NOT NULL
  ) THEN RAISE(ABORT, 'RECURRENCE_RELATION_FORBIDDEN') END;
  SELECT CASE WHEN NEW.parent_task_id IS NOT NULL AND NEW.status = 'TODO' AND EXISTS (
    SELECT 1 FROM tasks parent WHERE parent.id = NEW.parent_task_id AND parent.status <> 'TODO'
  ) THEN RAISE(ABORT, 'PARENT_NOT_ACTIVE') END;
  SELECT CASE WHEN NEW.project_id IS NOT NULL AND NEW.status = 'TODO' AND EXISTS (
    SELECT 1 FROM projects project WHERE project.id = NEW.project_id AND project.status = 'COMPLETED'
  ) THEN RAISE(ABORT, 'PROJECT_COMPLETED') END;
  SELECT CASE WHEN OLD.recurrence_series_id IS NOT NEW.recurrence_series_id
    OR OLD.original_occurrence_on IS NOT NEW.original_occurrence_on
    THEN RAISE(ABORT, 'RECURRENCE_IDENTITY_IMMUTABLE') END;
  SELECT CASE WHEN OLD.is_recurrence_exception = 1 AND NEW.is_recurrence_exception = 0
    THEN RAISE(ABORT, 'RECURRENCE_EXCEPTION_IMMUTABLE') END;
  SELECT CASE WHEN OLD.applied_rule_version_id IS NOT NEW.applied_rule_version_id
    AND (OLD.is_recurrence_exception = 1 OR NEW.is_recurrence_exception = 1)
    THEN RAISE(ABORT, 'RECURRENCE_VERSION_IMMUTABLE') END;
  SELECT CASE WHEN NEW.recurrence_series_id IS NOT NULL AND NEW.is_recurrence_exception = 0 AND NOT EXISTS (
    SELECT 1 FROM recurrence_rule_versions version
    WHERE version.id = NEW.applied_rule_version_id AND version.series_id = NEW.recurrence_series_id
      AND NEW.status = 'TODO' AND NEW.planned_on = NEW.original_occurrence_on
      AND NEW.title = version.title AND NEW.notes IS version.notes AND NEW.project_id IS version.project_id
      AND NEW.is_important = version.is_important AND NEW.is_urgent = version.is_urgent
  ) THEN RAISE(ABORT, 'RECURRENCE_PRISTINE_INVALID') END;
END;

CREATE TRIGGER trg_task_no_recurrence_parent_insert
BEFORE INSERT ON tasks
WHEN NEW.parent_task_id IS NOT NULL
BEGIN
  SELECT CASE WHEN EXISTS (SELECT 1 FROM tasks WHERE id = NEW.parent_task_id AND recurrence_series_id IS NOT NULL)
    THEN RAISE(ABORT, 'RECURRENCE_RELATION_FORBIDDEN') END;
END;

CREATE TRIGGER trg_task_cannot_become_recurrence_parent
BEFORE UPDATE OF parent_task_id ON tasks
WHEN NEW.parent_task_id IS NOT NULL
BEGIN
  SELECT CASE WHEN EXISTS (SELECT 1 FROM tasks WHERE id = NEW.parent_task_id AND recurrence_series_id IS NOT NULL)
    THEN RAISE(ABORT, 'RECURRENCE_RELATION_FORBIDDEN') END;
END;

CREATE TRIGGER trg_project_complete_guard
BEFORE UPDATE OF status ON projects
WHEN NEW.status = 'COMPLETED' AND OLD.status <> 'COMPLETED'
BEGIN
  SELECT CASE WHEN EXISTS (SELECT 1 FROM tasks WHERE project_id = NEW.id AND status = 'TODO')
    THEN RAISE(ABORT, 'PROJECT_HAS_OPEN_TASKS') END;
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM recurrence_rule_versions
    WHERE project_id = NEW.id AND timeline_active = 1 AND enabled = 1 AND effective_to_on_exclusive IS NULL
  ) THEN RAISE(ABORT, 'PROJECT_HAS_ACTIVE_SERIES') END;
END;
`

const TASK_UPDATE_GUARD_V2 = INITIAL_SCHEMA_SQL.slice(
  INITIAL_SCHEMA_SQL.indexOf('CREATE TRIGGER trg_task_validate_update'),
  INITIAL_SCHEMA_SQL.indexOf('CREATE TRIGGER trg_task_no_recurrence_parent_insert')
).replace(
  "NEW.parent_task_id IS NOT NULL AND NEW.status = 'TODO' AND EXISTS",
  "(OLD.parent_task_id IS NOT NEW.parent_task_id OR OLD.status IS NOT NEW.status) AND NEW.parent_task_id IS NOT NULL AND NEW.status = 'TODO' AND EXISTS"
)

export const MIGRATIONS = [
  { version: 1, name: 'initial', sql: INITIAL_SCHEMA_SQL },
  { version: 2, name: 'task-goal-link', sql: 'ALTER TABLE tasks ADD COLUMN goal_id TEXT NULL REFERENCES goals(id) ON DELETE SET NULL; CREATE INDEX ix_tasks_goal ON tasks(goal_id); DROP TRIGGER trg_task_validate_update;\n' + TASK_UPDATE_GUARD_V2 },
  { version: 3, name: 'task-planned-start', sql: TASK_PLANNED_START_SQL }
] as const
export const CURRENT_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version
export const APPLICATION_ID = 0x5054444f
