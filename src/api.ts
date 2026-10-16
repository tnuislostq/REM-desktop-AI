export interface Action { tool: string; summary: string; ok: boolean }
export interface Msg { role: 'user' | 'assistant'; text: string; actions?: Action[] }
export interface Boot { name: string; address: string; model: string; hasKey: boolean; memoryCount: number; history: { role: 'user' | 'assistant'; content: string }[] }
export interface MemoryItem { id: string; text: string; category: string; updatedAt: number }
export interface Stats { platform: string; cpuPercent: number; memoryPercent: number; totalMemoryGB: number; uptimeHours: number }

async function j<T>(res: Response): Promise<T> {
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((data as { error?: string }).error || `Request failed (${res.status})`);
  return data as T;
}

export const api = {
  bootstrap: () => fetch('/api/bootstrap').then(j<Boot>),
  chat: (text: string, event = false) =>
    fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, event }) })
      .then(j<{ reply: string; actions: Action[]; memoryCount: number }>),
  memories: () => fetch('/api/memory').then(j<MemoryItem[]>),
  addMemory: (text: string) =>
    fetch('/api/memory', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, category: 'other' }) }).then(j<MemoryItem>),
  deleteMemory: (id: string) => fetch(`/api/memory/${id}`, { method: 'DELETE' }).then(j<{ ok: boolean }>),
  stats: () => fetch('/api/system-info').then(j<Stats>),
  dueReminders: () => fetch('/api/reminders/due').then(j<{ id: string; text: string }[]>),
};
