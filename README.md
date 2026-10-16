# Rem Desktop

A voice-controlled AI butler with lifetime memory, a dry British wit, and an arc-reactor hologram.
Runs on your own PC: a Node server (Claude for the brain, your computer for the hands) plus a React/Three.js UI.

## Run it

1. Install Node 20+.
2. `npm install`
3. Copy `.env.example` to `.env` and paste your `ANTHROPIC_API_KEY`.
4. `npm run dev`, then open http://localhost:5173 in **Chrome or Edge** (needed for speech recognition).
5. Click "Talk to Rem", allow the microphone, and say hello.

For a single-port build: `npm run build && npm start`, then open http://localhost:3001.

## What it does

- **Personality:** loyal butler and trusted partner in the Jarvis tradition, formal British manners, dry sarcasm, honest pushback.
  Edit `server/persona.ts` to tune him. Change how he addresses you with `JARVIS_ADDRESS` in `.env`.
- **Lifetime memory:** Claude decides what is worth remembering and saves it to `data/memory.json`
  (survives browser clears and restarts). Open the Memory panel to read, add or delete anything.
  Conversation history persists in `data/history.json`. Back up the `data` folder to keep him forever.
- **Desktop control:** open approved apps, search the web, system status, notes, reminders.
  Allowed apps are the whitelist in `server/tools.ts`; Rem cannot run arbitrary commands.
- **Voice:** browser speech recognition and a British voice (deeper pitch). "Wake word on" makes him
  respond only when you say "Rem".
- **Avatar:** arc reactor by default. Put a `.vrm` file at `public/models/avatar.vrm` for a character.

## Safety

The server listens on 127.0.0.1 only and rejects requests from other websites' origins.
Do not expose port 3001 to a network.
