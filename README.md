# MidRound

![tests](https://github.com/z-ambient/MidRound/actions/workflows/test.yml/badge.svg)

**The tactical command center for Counter-Strike teams.**

A private tactical workspace for competitive CS2 teams: strategy library, opponent
scouting, match preparation, and a fast Match Mode built for the Steam browser.

## Run

```bash
npm install
npm start        # http://localhost:4310
```

Requires Node 24+ (uses the built-in `node:sqlite` module — no native deps).
Set `DATABASE_URL=postgres://...` to run against Postgres instead of the local
SQLite file (see `.env.example`). Run the security test suite with `npm test`.
The database (`midround.db`) is created and seeded automatically on first run.

## Demo accounts

All seeded accounts use password `demo1234`:

| Email | Role |
|---|---|
| `morgan@northlight.gg` | IGL (start here) |
| `casey@northlight.gg` | Organization Owner |
| `dana@northlight.gg` | Coach |
| `priya@northlight.gg` | Analyst |
| `riley@` / `alex@` / `sam@` / `jordan@northlight.gg` | Players |

Seeded content: the **Northlight Prime** team, two scouted opponents (Ironclad
Syndicate, Blue Harbor Esports) with player profiles and tendencies, ~15 strategies
(Mirage + Inferno, including the full **A Split** execute), and two upcoming BO3
matches with pinned calls and timeout notes.

## Structure

- `server.js` — Express API: cookie sessions (hashed tokens), role-based permissions,
  CRUD for strategies / opponents / matches / pins / invites, global search.
- `db.js` — SQLite schema + demo seed.
- `public/` — dependency-free SPA (ES modules, hash routing, dark theme).
  - `js/main.js` — router, shell, auth
  - `js/manage.js` — Management Mode (dashboard, strategy library + editor, scouting, matches, team)
  - `js/match.js` — Match Mode (single data load, instant tab switching, keyboard shortcuts
    1–6 + Esc, state persisted per match in localStorage)

## FACEIT sync

Team & access → **FACEIT sync** (admins only). You need:

1. A free **server-side Data API key** from [developers.faceit.com](https://developers.faceit.com)
   (App Studio → create an app → API keys).
2. Your **FACEIT team page URL** (or team id).

Once connected, MidRound imports the team's scheduled league/tournament matches
every 30 minutes (or via **Sync now**): matches appear in Matches and the dashboard
calendar, finished ones move to Played, and unknown opposing teams are created in
Opponents automatically. The API key is stored server-side in the database and is
never sent back to browsers. Set `FACEIT_API_BASE` to point the sync at a mock
server for testing.

## Roles

Owner and Team Admin manage everything; Coach edits strategies, matches, and scouting;
Analyst edits scouting; IGL edits strategies and matches and runs Match Mode;
Player and Read Only are view-only. New members join via one-time invite codes
(Team & access page) — no shared passwords.

To reset the demo data, stop the server and delete `midround.db*`.
