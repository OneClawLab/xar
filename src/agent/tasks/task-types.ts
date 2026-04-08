export interface Task {
  task_id: string
  owner: string // orchestrator agent_id
  origin: {
    thread_id: string
    event_id: number
    reply_target: string // "peer:<id>" or "agent:<id>"
  }
  status: 'pending' | 'waiting' | 'done' | 'failed' | 'cancelled'
  wait_all: boolean
  subtasks: SubTask[]
  created_at: string // ISO 8601
  updated_at: string // ISO 8601
}

export interface SubTask {
  subtask_id: string
  /** Unique id stamped on the delegation message; used for idempotent announce matching. */
  delegation_id: string
  worker: string // worker agent_id
  instruction: string
  status: 'pending' | 'sent' | 'done' | 'failed'
  result?: string
  /** Steer history: previous instructions sent to this worker before the current one. */
  steer_history?: Array<{ instruction: string; delegation_id: string; steered_at: string }>
}

export interface CreateTaskParams {
  owner: string
  originThreadId: string
  originEventId: number
  replyTarget: string
  waitAll: boolean
  subtasks: Array<{ worker: string; instruction: string }>
}

export interface SteerTaskParams {
  taskId: string
  /** Target worker agent_id (without "agent:" prefix). */
  worker: string
  newInstruction: string
}

export interface SteerTaskResult {
  steered: boolean
  /** The new delegation_id to stamp on the steer message. */
  delegation_id: string
  message?: string
}

export interface AnnounceResult {
  taskCompleted: boolean
  task: Task
}

export interface TaskManager {
  createTask(params: CreateTaskParams): Promise<Task>
  cancelTask(taskId: string): Promise<{ cancelled: boolean }>
  /**
   * Handle a worker announce.
   * @param delegationId - the delegation_id stamped on the subtask; used for idempotent matching.
   */
  handleAnnounce(taskId: string, workerAgentId: string, result: string, failed: boolean, delegationId?: string): Promise<AnnounceResult>
  steerTask(params: SteerTaskParams): Promise<SteerTaskResult>
  getTask(taskId: string): Promise<Task | null>
  getPendingTasks(): Promise<Task[]>
  isTaskCancelled(taskId: string): Promise<boolean>
  /** Return all tasks whose subtasks are still in 'sent' state (stale after daemon restart). */
  getStaleTasks(): Promise<Task[]>
}

/**
 * Strip the "agent:" prefix from a worker address if present.
 * e.g. "agent:analyst" → "analyst", "analyst" → "analyst"
 */
export function stripAgentPrefix(id: string): string {
  return id.startsWith('agent:') ? id.slice('agent:'.length) : id
}
