import fs from 'node:fs';
import path from 'node:path';

export const DATA_DIR = path.resolve(process.cwd(), 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

/** Tiny JSON-file store. Atomic writes so a crash never corrupts your memories. */
export class JsonStore<T> {
  private file: string;
  constructor(name: string, private fallback: T) {
    this.file = path.join(DATA_DIR, name);
  }
  read(): T {
    try {
      return JSON.parse(fs.readFileSync(this.file, 'utf8')) as T;
    } catch {
      return structuredClone(this.fallback);
    }
  }
  write(value: T): void {
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
    fs.renameSync(tmp, this.file);
  }
}

export interface Memory {
  id: string;
  text: string;
  category: string;
  createdAt: number;
  updatedAt: number;
}

const store = new JsonStore<Memory[]>('memory.json', []);
const STOP = new Set(['the', 'and', 'for', 'with', 'what', 'who', 'how', 'was', 'are', 'you', 'that', 'this', 'have', 'about', 'can', 'please']);

const tokens = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(t => t.length > 2 && !STOP.has(t));

export const memory = {
  all(): Memory[] {
    return store.read().sort((a, b) => b.updatedAt - a.updatedAt);
  },

  add(text: string, category = 'general'): Memory | null {
    const clean = text.trim();
    if (!clean) return null;
    const list = store.read();
    const dupe = list.find(m => m.text.toLowerCase() === clean.toLowerCase());
    if (dupe) return dupe;
    const now = Date.now();
    const entry: Memory = { id: `m_${now.toString(36)}${Math.random().toString(36).slice(2, 5)}`, text: clean, category, createdAt: now, updatedAt: now };
    store.write([entry, ...list]);
    return entry;
  },

  update(id: string, text: string): boolean {
    const list = store.read();
    const m = list.find(x => x.id === id);
    if (!m || !text.trim()) return false;
    m.text = text.trim();
    m.updatedAt = Date.now();
    store.write(list);
    return true;
  },

  remove(id: string): boolean {
    const list = store.read();
    const next = list.filter(m => m.id !== id);
    if (next.length === list.length) return false;
    store.write(next);
    return true;
  },

  /** Everything if the vault is small; otherwise the most relevant + most recent. */
  relevant(query: string, limit = 80): Memory[] {
    const list = this.all();
    if (list.length <= limit) return list;
    const q = new Set(tokens(query));
    const scored = list.map((m, i) => ({
      m,
      score: tokens(m.text + ' ' + m.category).filter(t => q.has(t)).length * 3 + (list.length - i) / list.length,
    }));
    return scored.sort((a, b) => b.score - a.score).slice(0, limit).map(s => s.m);
  },
};
