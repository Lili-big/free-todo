export const TASK_PLANNED_START_SQL = String.raw`
ALTER TABLE tasks ADD COLUMN planned_start_on TEXT NULL CHECK(
  planned_start_on IS NULL OR (
    length(planned_start_on) = 10 AND planned_start_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
    AND (planned_on IS NULL OR planned_start_on <= planned_on)
  )
);
ALTER TABLE task_schedule_history ADD COLUMN old_planned_start_on TEXT NULL;
ALTER TABLE task_schedule_history ADD COLUMN new_planned_start_on TEXT NULL;
CREATE INDEX ix_tasks_planned_range ON tasks(status, planned_start_on, planned_on);
CREATE TRIGGER trg_task_start_pristine_insert BEFORE INSERT ON tasks
WHEN NEW.recurrence_series_id IS NOT NULL AND NEW.is_recurrence_exception = 0 AND NEW.planned_start_on IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'RECURRENCE_PRISTINE_INVALID'); END;
CREATE TRIGGER trg_task_start_pristine_update BEFORE UPDATE ON tasks
WHEN NEW.recurrence_series_id IS NOT NULL AND NEW.is_recurrence_exception = 0 AND NEW.planned_start_on IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'RECURRENCE_PRISTINE_INVALID'); END;
`
