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
  worker: string // worker agent_id
  instruction: string
  status: 'pending' | 'sent' | 'done' | 'failed'
  result?: string
}

export interface CreateTaskParams {
  owner: string
  originThreadId: string
  originEventId: number
  replyTarget: string
  waitAll: boolean
  subtasks: Array<{ worker: string; instruction: string }>
}

export interface AnnounceResult {
  taskCompleted: boolean
  task: Task
}

export interface TaskManager {
  createTask(params: CreateTaskParams): Promise<Task>
  cancelTask(taskId: string): Promise<{ cancelled: boolean }>
  handleAnnounce(taskId: string, workerAgentId: string, result: string, failed: boolean): Promise<AnnounceResult>
  getTask(taskId: string): Promise<Task | null>
  getPendingTasks(): Promise<Task[]>
  isTaskCancelled(taskId: string): Promise<boolean>
}

/**
 * Strip the "agent:" prefix from a worker address if present.
 * e.g. "agent:analyst" → "analyst", "analyst" → "analyst"
 */
export function stripAgentPrefix(id: string): string {
  return id.startsWith('agent:') ? id.slice('agent:'.length) : id
}
