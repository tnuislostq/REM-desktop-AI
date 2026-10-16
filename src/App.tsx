import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Hologram, type Mode } from './hologram';
import { voice } from './voice';
import { api, type Action, type Boot, type MemoryItem, type Msg, type Stats } from './api';

export default function App() {
  const stage = useRef<HTMLDivElement>(null);
  const modeRef = useRef<Mode>('idle');

  const [boot, setBoot] = useState<Boot | null>(null);
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [thinking, setThinking] = useState(false);
  const [, force] = useState(0);
  const [interim, setInterim] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [stats, setStats] = useState<Stats | null>(null);
  const [panel, setPanel] = useState<null | 'memory' | 'log'>(null);
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [newMemory, setNewMemory] = useState('');
  const busy = useRef(false);

  const mode: Mode = voice.speaking ? 'speaking' : thinking ? 'thinking' : voice.listening ? 'listening' : 'idle';
  modeRef.current = mode;

  // Hologram lives outside React's render cycle; it reads the latest mode + level each frame.
  useEffect(() => {
    if (!stage.current) return;
    const h = new Hologram(stage.current, () => ({ mode: modeRef.current, level: voice.level() }));
    return () => h.dispose();
  }, []);

  const send = useCallback(async (text: string, event = false) => {
    if (busy.current) return;
    busy.current = true;
    setError(null);
    voice.shutUp();
    if (!event) setMsgs(m => [...m, { role: 'user', text }]);
    setThinking(true);
    try {
      const r = await api.chat(text, event);
      setMsgs(m => [...m, { role: 'assistant', text: r.reply, actions: r.actions }]);
      setThinking(false);
      if (r.actions.some(a => a.tool === 'remember' || a.tool === 'forget' || a.tool === 'update_memory')) refreshMemories();
      await voice.speak(r.reply);
    } catch (e) {
      setThinking(false);
      setError((e as Error).message);
    } finally {
      busy.current = false;
      force(n => n + 1);
    }
  }, []);

  const refreshMemories = () => api.memories().then(setMemories).catch(() => {});

  // Boot: load history, greet on first ever run
  useEffect(() => {
    api.bootstrap().then(b => {
      setBoot(b);
      setMsgs(b.history.map(t => ({ role: t.role, text: t.content })));
      if (b.hasKey && b.history.length === 0 && b.memoryCount === 0) send('First activation. Introduce yourself.', true);
    }).catch(() => setError('The Rem server is not running. Start it with npm run dev.'));
    refreshMemories();
  }, [send]);

  // Voice wiring
  useEffect(() => {
    voice.setHandlers({
      onFinal: t => send(t),
      onInterim: setInterim,
      onChange: () => force(n => n + 1),
      onError: setError,
    });
  }, [send]);

  // System stats + reminders
  useEffect(() => {
    const tick = () => api.stats().then(setStats).catch(() => {});
    tick();
    const a = setInterval(tick, 5000);
    const b = setInterval(async () => {
      if (busy.current) return;
      const due = await api.dueReminders().catch(() => []);
      for (const r of due) await send(`Reminder due now: ${r.text}`, true);
    }, 10000);
    return () => { clearInterval(a); clearInterval(b); };
  }, [send]);

  const last = useMemo(() => [...msgs].reverse().find(m => m.role === 'assistant'), [msgs]);
  const lastActions: Action[] = last?.actions ?? [];
  const address = boot?.address ?? "ma'am";
  const name = boot?.name ?? 'Rem';
  voice.wakeName = name;
  useEffect(() => { document.title = name; }, [name]);

  const status =
    mode === 'speaking' ? 'Speaking' :
    mode === 'thinking' ? 'Thinking' :
    mode === 'listening' ? (voice.wakeWord ? `Listening for "${name}"` : 'Listening') :
    'Standing by';

  return (
    <div className={`app mode-${mode}`}>
      <div className="stage" ref={stage} />

      <header className="top">
        <div className="brand">
          <h1>{name}</h1>
          <span className="status"><i className="dot" />{status}</span>
        </div>
        <div className="tools">
          {stats && (
            <span className="vitals" title={`${stats.platform} · up ${stats.uptimeHours}h`}>
              CPU {stats.cpuPercent}% &nbsp; Memory {stats.memoryPercent}%
            </span>
          )}
          <button className={panel === 'memory' ? 'on' : ''} onClick={() => { setPanel(panel === 'memory' ? null : 'memory'); refreshMemories(); }}>
            Memory{boot ? ` (${memories.length})` : ''}
          </button>
          <button className={panel === 'log' ? 'on' : ''} onClick={() => setPanel(panel === 'log' ? null : 'log')}>Log</button>
          <button className={voice.wakeWord ? 'on' : ''} onClick={() => { voice.wakeWord = !voice.wakeWord; force(n => n + 1); }}>
            {voice.wakeWord ? 'Wake word on' : 'Wake word off'}
          </button>
          <button className={voice.muted ? 'on' : ''} onClick={() => { voice.muted = !voice.muted; if (voice.muted) voice.shutUp(); force(n => n + 1); }}>
            {voice.muted ? 'Unmute' : 'Mute'}
          </button>
        </div>
      </header>

      {boot && !boot.hasKey && (
        <div className="banner">No API key found. Add ANTHROPIC_API_KEY to the .env file and restart the server, {address}.</div>
      )}
      {error && <div className="banner err" role="alert">{error}</div>}

      <main className="bottom">
        {lastActions.length > 0 && (
          <ul className="actions">
            {lastActions.map((a, i) => <li key={i} className={a.ok ? '' : 'bad'}>{a.summary}</li>)}
          </ul>
        )}
        <p className="caption" aria-live="polite">
          {interim || (thinking ? '' : last?.text) || (boot?.hasKey === false ? '' : `At your service, ${address}.`)}
        </p>

        <form className="bar" onSubmit={e => { e.preventDefault(); if (draft.trim()) { send(draft.trim()); setDraft(''); } }}>
          <button type="button" className={`mic ${voice.active ? 'live' : ''}`} onClick={() => voice.toggle()} aria-pressed={voice.active}>
            {voice.active ? 'Stop listening' : `Talk to ${name}`}
          </button>
          <input value={draft} onChange={e => setDraft(e.target.value)} placeholder={`Or type here, ${address}`} aria-label="Message" />
          <button type="submit" disabled={!draft.trim()}>Send</button>
        </form>
      </main>

      {panel && (
        <aside className="drawer">
          {panel === 'memory' ? (
            <>
              <h2>What I know about you</h2>
              <form className="add" onSubmit={async e => { e.preventDefault(); if (!newMemory.trim()) return; await api.addMemory(newMemory.trim()); setNewMemory(''); refreshMemories(); }}>
                <input value={newMemory} onChange={e => setNewMemory(e.target.value)} placeholder="Teach me something" aria-label="New memory" />
                <button type="submit">Add</button>
              </form>
              {memories.length === 0 && <p className="empty">Nothing yet. Tell me about yourself and I will keep it.</p>}
              <ul className="mem">
                {memories.map(m => (
                  <li key={m.id}>
                    <span>{m.text}</span>
                    <button onClick={async () => { await api.deleteMemory(m.id); refreshMemories(); }} aria-label={`Delete memory: ${m.text}`}>Delete</button>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <>
              <h2>Conversation</h2>
              <ul className="log">
                {msgs.map((m, i) => <li key={i} className={m.role}><b>{m.role === 'user' ? 'You' : name}</b>{m.text}</li>)}
              </ul>
            </>
          )}
        </aside>
      )}
    </div>
  );
}
