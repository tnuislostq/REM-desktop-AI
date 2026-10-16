import { spawn } from 'node:child_process';
import os from 'node:os';
import type Anthropic from '@anthropic-ai/sdk';
import { JsonStore, memory } from './memory.ts';

export interface Reminder { id: string; text: string; dueAt: number; done: boolean }
export interface Note { id: string; text: string; createdAt: number }
export interface ActionLog { tool: string; summary: string; ok: boolean }

export const reminders = new JsonStore<Reminder[]>('reminders.json', []);
const notes = new JsonStore<Note[]>('notes.json', []);

type Cmd = string[];
const P = process.platform;
const win = (...a: string[]): Cmd => ['cmd', '/c', 'start', '', ...a];

/** Approved apps only. Rem can never run an arbitrary command. */
const APPS: Record<string, { label: string; win32: Cmd; darwin: Cmd; linux: Cmd }> = {
  vscode:     { label: 'Visual Studio Code', win32: ['cmd', '/c', 'code'], darwin: ['open', '-a', 'Visual Studio Code'], linux: ['code'] },
  chrome:     { label: 'Google Chrome', win32: win('chrome'), darwin: ['open', '-a', 'Google Chrome'], linux: ['google-chrome'] },
  browser:    { label: 'your default browser', win32: win('https://www.google.com'), darwin: ['open', 'https://www.google.com'], linux: ['xdg-open', 'https://www.google.com'] },
  notepad:    { label: 'a text editor', win32: ['notepad.exe'], darwin: ['open', '-a', 'TextEdit'], linux: ['gedit'] },
  calculator: { label: 'the calculator', win32: ['calc.exe'], darwin: ['open', '-a', 'Calculator'], linux: ['gnome-calculator'] },
  terminal:   { label: 'a terminal', win32: win('wt.exe'), darwin: ['open', '-a', 'Terminal'], linux: ['gnome-terminal'] },
  files:      { label: 'the file manager', win32: ['explorer.exe'], darwin: ['open', '.'], linux: ['xdg-open', '.'] },
  settings:   { label: 'system settings', win32: win('ms-settings:'), darwin: ['open', '-a', 'System Settings'], linux: ['gnome-control-center'] },
  taskmanager:{ label: 'the task manager', win32: ['taskmgr.exe'], darwin: ['open', '-a', 'Activity Monitor'], linux: ['gnome-system-monitor'] },
  spotify:    { label: 'Spotify', win32: win('spotify:'), darwin: ['open', '-a', 'Spotify'], linux: ['spotify'] },
  discord:    { label: 'Discord', win32: win('discord:'), darwin: ['open', '-a', 'Discord'], linux: ['discord'] },
};

function launch(cmd: Cmd): Promise<string> {
  return new Promise(resolve => {
    const [bin, ...args] = cmd;
    try {
      const child = spawn(bin, args, { detached: true, stdio: 'ignore', windowsHide: true });
      child.once('error', e => resolve(`failed: ${e.message}`));
      child.once('spawn', () => { child.unref(); resolve('ok'); });
    } catch (e) {
      resolve(`failed: ${(e as Error).message}`);
    }
  });
}

function openUrl(url: string): Promise<string> {
  // rundll32 avoids cmd.exe parsing, so '&' in a URL cannot inject anything.
  const cmd: Cmd = P === 'win32' ? ['rundll32', 'url.dll,FileProtocolHandler', url] : P === 'darwin' ? ['open', url] : ['xdg-open', url];
  return launch(cmd);
}

async function cpuPercent(): Promise<number> {
  const snap = () => os.cpus().reduce((a, c) => {
    const t = Object.values(c.times).reduce((x, y) => x + y, 0);
    return { idle: a.idle + c.times.idle, total: a.total + t };
  }, { idle: 0, total: 0 });
  const a = snap();
  await new Promise(r => setTimeout(r, 250));
  const b = snap();
  const total = b.total - a.total;
  return total > 0 ? Math.round((1 - (b.idle - a.idle) / total) * 100) : 0;
}

export async function systemInfo() {
  const total = os.totalmem();
  const used = total - os.freemem();
  return {
    platform: `${os.type()} ${os.release()}`,
    cpuPercent: await cpuPercent(),
    memoryPercent: Math.round((used / total) * 100),
    totalMemoryGB: Math.round(total / 1024 ** 3),
    uptimeHours: Math.round((os.uptime() / 3600) * 10) / 10,
  };
}

export const TOOLS: Anthropic.Tool[] = [
  {
    name: 'remember',
    description: 'Save a durable fact about the user to lifetime memory.',
    input_schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'One clear fact, third person.' },
        category: { type: 'string', enum: ['identity', 'preference', 'project', 'people', 'routine', 'goal', 'other'] },
      },
      required: ['text'],
    },
  },
  {
    name: 'update_memory',
    description: 'Replace the text of an existing memory (by id) when a fact has changed.',
    input_schema: { type: 'object', properties: { id: { type: 'string' }, text: { type: 'string' } }, required: ['id', 'text'] },
  },
  {
    name: 'forget',
    description: 'Delete a memory by id. Use when the user asks you to forget something.',
    input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'open_app',
    description: `Launch an approved desktop app. Allowed: ${Object.keys(APPS).join(', ')}.`,
    input_schema: { type: 'object', properties: { app: { type: 'string', enum: Object.keys(APPS) } }, required: ['app'] },
  },
  {
    name: 'web_search',
    description: 'Open a web search for the query in the default browser.',
    input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
  {
    name: 'system_status',
    description: 'Report CPU load, memory use, platform and uptime of this computer.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'take_note',
    description: 'Save a note to the desktop notebook.',
    input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
  {
    name: 'list_notes',
    description: 'Read back the most recent notes.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'set_reminder',
    description: 'Set a reminder that fires after a number of minutes while Rem is running.',
    input_schema: {
      type: 'object',
      properties: { minutes: { type: 'number', description: 'Minutes from now (may be fractional).' }, text: { type: 'string' } },
      required: ['minutes', 'text'],
    },
  },
];

type Input = Record<string, unknown>;
const str = (v: unknown) => (typeof v === 'string' ? v : '');

export async function runTool(name: string, input: Input): Promise<{ output: string; action?: ActionLog }> {
  switch (name) {
    case 'remember': {
      const m = memory.add(str(input.text), str(input.category) || 'other');
      return m
        ? { output: `Saved (${m.id}).`, action: { tool: name, summary: `Remembered: ${m.text}`, ok: true } }
        : { output: 'Nothing to save.' };
    }
    case 'update_memory': {
      const ok = memory.update(str(input.id), str(input.text));
      return { output: ok ? 'Updated.' : 'No memory with that id.', action: { tool: name, summary: `Updated memory: ${str(input.text)}`, ok } };
    }
    case 'forget': {
      const ok = memory.remove(str(input.id));
      return { output: ok ? 'Forgotten.' : 'No memory with that id.', action: { tool: name, summary: 'Forgot a memory', ok } };
    }
    case 'open_app': {
      const app = APPS[str(input.app)];
      if (!app) return { output: 'That app is not on the approved list.' };
      const cmd = P === 'win32' ? app.win32 : P === 'darwin' ? app.darwin : app.linux;
      const result = await launch(cmd);
      const ok = result === 'ok';
      return { output: ok ? `Launched ${app.label}.` : `Could not launch ${app.label}: ${result}`, action: { tool: name, summary: `Open ${app.label}`, ok } };
    }
    case 'web_search': {
      const q = str(input.query).slice(0, 300);
      const result = await openUrl(`https://www.google.com/search?q=${encodeURIComponent(q)}`);
      const ok = result === 'ok';
      return { output: ok ? 'Search opened in the browser.' : `Could not open the browser: ${result}`, action: { tool: name, summary: `Search: ${q}`, ok } };
    }
    case 'system_status': {
      const info = await systemInfo();
      return { output: JSON.stringify(info), action: { tool: name, summary: `CPU ${info.cpuPercent}%, memory ${info.memoryPercent}%`, ok: true } };
    }
    case 'take_note': {
      const list = notes.read();
      list.unshift({ id: `n_${Date.now()}`, text: str(input.text), createdAt: Date.now() });
      notes.write(list.slice(0, 500));
      return { output: 'Note saved.', action: { tool: name, summary: `Note: ${str(input.text)}`, ok: true } };
    }
    case 'list_notes': {
      const list = notes.read().slice(0, 10);
      return { output: list.length ? list.map(n => `- ${n.text}`).join('\n') : 'The notebook is empty.' };
    }
    case 'set_reminder': {
      const minutes = Math.min(Math.max(Number(input.minutes) || 1, 0.1), 60 * 24 * 7);
      const list = reminders.read();
      list.push({ id: `r_${Date.now()}`, text: str(input.text), dueAt: Date.now() + minutes * 60_000, done: false });
      reminders.write(list);
      return { output: `Reminder set for ${Math.round(minutes * 10) / 10} minutes from now.`, action: { tool: name, summary: `Reminder in ${Math.round(minutes * 10) / 10} min: ${str(input.text)}`, ok: true } };
    }
    default:
      return { output: `Unknown tool: ${name}` };
  }
}
