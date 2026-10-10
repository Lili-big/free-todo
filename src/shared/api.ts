import type {
  ApiResult,
  BackupExportResultDto,
  BackupInspectionDto,
  BackupProgressDto,
  BackupRestoreResultDto,
  BootstrapDto,
  CalendarRangeDto,
  ChangeNoticeDto,
  ExternalCalendarRangeDto,
  ExternalCalendarStatusDto,
  ExternalCalendarSyncResultDto,
  GoalCategoryDto,
  GoalDto,
  MorningReviewSnapshotDto,
  MutationEnvelope,
  ProjectDto,
  QuadrantSnapshotDto,
  RecurrenceSeriesDto,
  SafetyBackupDto,
  TaskDetailDto,
  TaskListItemDto,
  TodaySnapshotDto
} from './types'
import type {
  ApplyProjectedOccurrenceInput,
  ChangeGoalStatusInput,
  ChangeProjectStatusInput,
  ChangeTaskParentInput,
  ChangeTaskStatusInput,
  ConnectWecomCalendarInput,
  CreateChildTaskInput,
  CreateGoalInput,
  CreateNextStepInput,
  CreateParentAndAttachInput,
  CreateProjectInput,
  CreateRecurrenceSeriesInput,
  CreateTaskInput,
  ExternalCalendarRangeInput,
  GoalListQuery,
  MoveTaskTreeInput,
  SetRecurrenceEnabledInput,
  SetTaskScheduleInput,
  TaskListQuery,
  UpdateGoalInput,
  UpdateProjectInput,
  UpdateRecurrenceFromDateInput,
  UpdateTaskContentInput
} from './inputs'

export interface TodoDesktopApi {
  app: {
    getBootstrap(): Promise<ApiResult<BootstrapDto>>
    getPreferences(): Promise<ApiResult<{ launchAtLogin: boolean }>>
    setLaunchAtLogin(input: { enabled: boolean }): Promise<ApiResult<{ launchAtLogin: boolean }>>
    reconcile(): Promise<ApiResult<MutationEnvelope<{ localDate: string }>>>
    onChanged(listener: (notice: ChangeNoticeDto) => void): () => void
    onDatabaseReplaced(listener: (notice: ChangeNoticeDto) => void): () => void
  }
  today: {
    getSnapshot(): Promise<ApiResult<TodaySnapshotDto>>
    getReviewSnapshot(): Promise<ApiResult<MorningReviewSnapshotDto>>
    dismissReviewCard(input: { expectedLocalDate: string }): Promise<ApiResult<MutationEnvelope<void>>>
    finishReview(input: { expectedLocalDate: string }): Promise<ApiResult<MutationEnvelope<void>>>
  }
  planning: { getSnapshot(): Promise<ApiResult<TaskListItemDto[]>> }
  tasks: {
    list(input?: TaskListQuery): Promise<ApiResult<{ items: TaskListItemDto[]; total: number }>>
    getDetail(input: { id: string }): Promise<ApiResult<TaskDetailDto>>
    create(input: CreateTaskInput): Promise<ApiResult<MutationEnvelope<TaskDetailDto>>>
    updateContent(input: UpdateTaskContentInput): Promise<ApiResult<MutationEnvelope<TaskDetailDto>>>
    setSchedule(input: SetTaskScheduleInput): Promise<ApiResult<MutationEnvelope<TaskDetailDto>>>
    changeStatus(input: ChangeTaskStatusInput): Promise<ApiResult<MutationEnvelope<TaskDetailDto>>>
    createChild(input: CreateChildTaskInput): Promise<ApiResult<MutationEnvelope<TaskDetailDto>>>
    changeParent(input: ChangeTaskParentInput): Promise<ApiResult<MutationEnvelope<TaskDetailDto>>>
    createParentAndAttach(input: CreateParentAndAttachInput): Promise<ApiResult<MutationEnvelope<TaskDetailDto>>>
    moveTree(input: MoveTaskTreeInput): Promise<ApiResult<MutationEnvelope<TaskDetailDto>>>
    createNextStep(input: CreateNextStepInput): Promise<ApiResult<MutationEnvelope<TaskDetailDto>>>
  }
  calendar: { getRange(input: { startOn: string; endOn: string; includeCancelled?: boolean }): Promise<ApiResult<CalendarRangeDto>> }
  quadrants: { getSnapshot(): Promise<ApiResult<QuadrantSnapshotDto>> }
  projects: {
    list(): Promise<ApiResult<ProjectDto[]>>
    getDetail(input: { id: string }): Promise<ApiResult<ProjectDto>>
    create(input: CreateProjectInput): Promise<ApiResult<MutationEnvelope<ProjectDto>>>
    update(input: UpdateProjectInput): Promise<ApiResult<MutationEnvelope<ProjectDto>>>
    changeStatus(input: ChangeProjectStatusInput): Promise<ApiResult<MutationEnvelope<ProjectDto>>>
    remove(input: { id: string; expectedVersion: number }): Promise<ApiResult<MutationEnvelope<void>>>
  }
  goalCategories: {
    list(): Promise<ApiResult<GoalCategoryDto[]>>
    create(input: { name: string }): Promise<ApiResult<MutationEnvelope<GoalCategoryDto>>>
    rename(input: { id: string; name: string }): Promise<ApiResult<MutationEnvelope<GoalCategoryDto>>>
    remove(input: { id: string }): Promise<ApiResult<MutationEnvelope<void>>>
  }
  goals: {
    list(input?: GoalListQuery): Promise<ApiResult<GoalDto[]>>
    getDetail(input: { id: string }): Promise<ApiResult<GoalDto>>
    create(input: CreateGoalInput): Promise<ApiResult<MutationEnvelope<GoalDto>>>
    update(input: UpdateGoalInput): Promise<ApiResult<MutationEnvelope<GoalDto>>>
    changeStatus(input: ChangeGoalStatusInput): Promise<ApiResult<MutationEnvelope<GoalDto>>>
    remove(input: { id: string; expectedVersion: number }): Promise<ApiResult<MutationEnvelope<void>>>
  }
  recurrences: {
    list(): Promise<ApiResult<RecurrenceSeriesDto[]>>
    getDetail(input: { id: string }): Promise<ApiResult<RecurrenceSeriesDto>>
    create(input: CreateRecurrenceSeriesInput): Promise<ApiResult<MutationEnvelope<RecurrenceSeriesDto>>>
    updateFromDate(input: UpdateRecurrenceFromDateInput): Promise<ApiResult<MutationEnvelope<RecurrenceSeriesDto>>>
    setEnabledFromDate(input: SetRecurrenceEnabledInput): Promise<ApiResult<MutationEnvelope<RecurrenceSeriesDto>>>
    applyProjectedOccurrence(input: ApplyProjectedOccurrenceInput): Promise<ApiResult<MutationEnvelope<TaskDetailDto>>>
  }
  wecomCalendar: {
    connect(input: ConnectWecomCalendarInput): Promise<ApiResult<ExternalCalendarStatusDto>>
    disconnect(): Promise<ApiResult<ExternalCalendarStatusDto>>
    sync(input: ExternalCalendarRangeInput): Promise<ApiResult<ExternalCalendarSyncResultDto>>
    getStatus(): Promise<ApiResult<ExternalCalendarStatusDto>>
    getRange(input: ExternalCalendarRangeInput): Promise<ApiResult<ExternalCalendarRangeDto>>
  }
  backups: {
    exportInteractive(): Promise<ApiResult<BackupExportResultDto>>
    selectAndInspectRestore(): Promise<ApiResult<BackupInspectionDto | { cancelled: true }>>
    restore(input: { inspectionToken: string; confirmationToken: string }): Promise<ApiResult<BackupRestoreResultDto>>
    listSafetyBackups(): Promise<ApiResult<SafetyBackupDto[]>>
    onProgress(listener: (progress: BackupProgressDto) => void): () => void
  }
}
