import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { JsonStore, memory } from './memory.ts';
import { buildSystemPrompt } from './persona.ts';
import { TOOLS, reminders, runTool, systemInfo, type ActionLog } from './tools.ts';

const PORT = Number(process.env.PORT) || 3001;
const MODEL = process.env.JARVIS_MODEL || 'claude-sonnet-5-5';
const NAME = process.env.ASSISTANT_NAME || 'Rem';
const ADDRESS = process.env.JARVIS_ADDRESS || "ma'am";
const hasKey = Boolean(process.env.ANTHROPIC_API_KEY);
const client = hasKey ? new Anthropic() : null;

interface Turn { role: 'user' | 'assistant'; content: string; at: number }
const history = new JsonStore<Turn[]>('history.json', []);

const app = express();
app.use(express.json({ limit: '64kb' }));

// This server controls your PC: only accept requests from this machine's own pages.
app.use('/api', (req, res, next) => {
  const origin = req.headers.origin;
  if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
    res.status(403).json({ error: 'Forbidden origin' });
    return;
  }
  next();
});

function userName(): string {
  const m = memory.all().find(x => x.category === 'identity' && /name/i.test(x.text));
  return m ? m.text.replace(/^.*?\bis\b\s*/i, '').replace(/[.]+$/, '') : '';
}

app.get('/api/bootstrap', (_req, res) => {
  res.json({
    name: NAME,
    address: ADDRESS,
    model: MODEL,
    hasKey,
    memoryCount: memory.all().length,
    history: history.read().slice(-30).filter(t => !t.content.startsWith('[SYSTEM EVENT]')),
  });
});

app.post('/api/chat', async (req, res) => {
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  const isEvent = req.body?.event === true;
  if (!text) { res.status(400).json({ error: 'Empty message' }); return; }
  if (!client) { res.status(503).json({ error: 'ANTHROPIC_API_KEY is not set. Add it to .env and restart.' }); return; }

  const turns = history.read();
  const content = isEvent ? `[SYSTEM EVENT] ${text}` : text;

  // The API needs strictly alternating turns that start with the user.
  let recent = turns.slice(-24);
  while (recent.length && recent[0].role !== 'user') recent = recent.slice(1);
  const messages: Anthropic.MessageParam[] = [...recent.map(t => ({ role: t.role, content: t.content })), { role: 'user', content }];

  const system = buildSystemPrompt({
    name: NAME,
    address: ADDRESS,
    userName: userName(),
    memories: memory.relevant(text),
    firstRun: memory.all().length === 0 && turns.length === 0,
  });

  const actions: ActionLog[] = [];
  try {
    let reply = '';
    for (let step = 0; step < 6; step++) {
      const response = await client.messages.create({ model: MODEL, max_tokens: 700, system, tools: TOOLS, messages });
      const textBlocks = response.content.filter((b): b is Anthropic.TextBlock => b.type === 'text');
      reply = textBlocks.map(b => b.text).join(' ').trim();
      if (response.stop_reason !== 'tool_use') break;

      messages.push({ role: 'assistant', content: response.content });
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;
        const { output, action } = await runTool(block.name, block.input as Record<string, unknown>);
        if (action) actions.push(action);
        results.push({ type: 'tool_result', tool_use_id: block.id, content: output });
      }
      messages.push({ role: 'user', content: results });
    }

    if (!reply) reply = `Something went quietly wrong on my end, ${ADDRESS}. Might I suggest trying again?`;
    const now = Date.now();
    history.write([...turns, { role: 'user' as const, content, at: now }, { role: 'assistant' as const, content: reply, at: now }].slice(-200));
    res.json({ reply, actions, memoryCount: memory.all().length });
  } catch (e) {
    const msg = e instanceof Anthropic.APIError ? `${e.status ?? ''} ${e.message}` : (e as Error).message;
    console.error('[chat]', msg);
    res.status(502).json({ error: msg });
  }
});

app.get('/api/memory', (_req, res) => res.json(memory.all()));
app.post('/api/memory', (req, res) => {
  const m = memory.add(String(req.body?.text ?? ''), String(req.body?.category ?? 'other'));
  m ? res.json(m) : res.status(400).json({ error: 'Empty memory' });
});
app.delete('/api/memory/:id', (req, res) => {
  memory.remove(req.params.id) ? res.json({ ok: true }) : res.status(404).json({ error: 'Not found' });
});

app.get('/api/system-info', async (_req, res) => res.json(await systemInfo()));

app.get('/api/reminders/due', (_req, res) => {
  const list = reminders.read();
  const now = Date.now();
  const due = list.filter(r => !r.done && r.dueAt <= now);
  if (due.length) {
    due.forEach(r => (r.done = true));
    reminders.write(list.filter(r => !r.done || r.dueAt > now - 86_400_000));
  }
  res.json(due);
});

// Production: serve the built UI from the same port.
const dist = path.resolve(process.cwd(), 'dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get('*', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
}

app.listen(PORT, '127.0.0.1', () => {
  console.log(`${NAME} server on http://127.0.0.1:${PORT}  (model: ${MODEL}, key: ${hasKey ? 'set' : 'MISSING'})`);
});
