export const priorities = ['URGENT', 'MEDIUM', 'LOW'] as const
export const statuses = ['OPEN', 'WAITING', 'RESOLVED', 'CLOSED'] as const
export type Priority = typeof priorities[number]
export type Status = typeof statuses[number]
export type Identity = { id: string; displayName: string; role: 'AGENT' | 'CUSTOMER' }
export type Ticket = { id: string; reference: string; subject: string; status: Status; priority: Priority; createdAt: string }
export type Message = { id: string; body: string; kind: 'CUSTOMER_PUBLIC' | 'AGENT_PUBLIC' | 'INTERNAL'; author: { displayName: string }; createdAt: string }
export type Detail = Ticket & { description: string; resolvedAt: string | null; closedAt: string | null; messages: (Message & { kind: 'CUSTOMER_PUBLIC' | 'AGENT_PUBLIC' })[] }
export type Clock = { cycle: number; status: 'ACTIVE' | 'OVERDUE' | 'PAUSED' | 'COMPLETED_ON_TIME' | 'COMPLETED_LATE' | 'COMPLETED_UNKNOWN' | 'CANCELED';
  deadline: string | null; completedAt: string | null; firstBreachedAt: string | null; remainingMs: number; consumedMs: number; overdueWorkingMs: number }
export type StaffTicket = Ticket & { assignee: Pick<Identity, 'id' | 'displayName'> | null; updatedAt: string;
  waitingSince: string | null; closeDueAt: string | null; closeProcessedAt: string | null;
  sla: { asOf: string; response: Clock | null; resolution: Clock | null; historicalBreach: boolean;
    resolutionHistoryIncomplete: boolean; resolutionHistory?: Clock[] } }
export type StaffDetail = Omit<Detail, 'messages'> & StaffTicket & { messages: Message[] }
export type Page<T> = { items: T[]; total: number; page: number; limit: number }
export type StaffPage = Page<StaffTicket> & { counts: { open: number; overdue: number; waiting: number } }
export type AuditEvent = { id: string; action: string; actor: { kind: 'USER' | 'SYSTEM'; id: string | null }; effectiveAt: string; recordedAt: string;
  oldStatus: Status | null; newStatus: Status | null; details: { oldPriority?: Priority; priority?: Priority; cutoff?: string; processedAt?: string; resolutionCycle?: number; resolution?: {cycle: number} } }
export type AuditPage = { items: AuditEvent[]; nextAfterId: string | null }
