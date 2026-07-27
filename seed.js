// MidRound — demo seed data (Northlight Gaming org, 8 users, password demo1234).
const bcrypt = require('bcryptjs');
const { get, run, backfillTeamPlayers } = require('./db');

const now = () => new Date().toISOString();
const J = JSON.stringify;

// The demo sign-in the login page offers. Single source of truth: the page
// asks the server for this (GET /api/demo) instead of hard-coding it, so the
// hint can never advertise a login the seed does not actually create.
const DEMO_LOGIN = { email: 'morgan@northlight.gg', password: 'demo1234', role: 'the IGL' };

async function seedIfEmpty() {
  // Never seed the demo org (8 accounts, shared well-known password) into a
  // production database — the first real user registers their own org
  // instead. Set SEED_DEMO=1 to override for a staging environment.
  if (process.env.NODE_ENV === 'production' && process.env.SEED_DEMO !== '1') return;
  const count = (await get('SELECT COUNT(*) AS c FROM users')).c;
  if (count > 0) return;

  const t = now();
  const hash = bcrypt.hashSync(DEMO_LOGIN.password, 10);

  const users = {};
  for (const [key, email, name] of [
    ['owner',   'casey@northlight.gg',  'Casey Winter'],
    ['coach',   'dana@northlight.gg',   'Dana "Compass" Reyes'],
    ['analyst', 'priya@northlight.gg',  'Priya "Ledger" Anand'],
    ['igl',     'morgan@northlight.gg', 'Morgan "Vector" Hale'],
    ['p2',      'riley@northlight.gg',  'Riley "Sable" Fox'],
    ['p3',      'alex@northlight.gg',   'Alex "Quill" Novak'],
    ['p4',      'sam@northlight.gg',    'Sam "Drift" Aoki'],
    ['p5',      'jordan@northlight.gg', 'Jordan "Pillar" Reeve'],
  ]) {
    users[key] = (await run(
      'INSERT INTO users (email, name, password_hash, created_at) VALUES (?,?,?,?) RETURNING id',
      email, name, hash, t)).id;
  }

  const orgId = (await run('INSERT INTO organizations (name, created_at) VALUES (?,?) RETURNING id',
    'Northlight Gaming', t)).id;
  const teamId = (await run('INSERT INTO teams (org_id, name) VALUES (?,?) RETURNING id',
    orgId, 'Northlight Prime')).id;

  const member = (uid, role) =>
    run('INSERT INTO org_members (org_id, user_id, role) VALUES (?,?,?)', orgId, uid, role);
  await member(users.owner, 'owner');
  await member(users.coach, 'edit');
  await member(users.analyst, 'edit');
  await member(users.igl, 'edit');
  await member(users.p2, 'view');
  await member(users.p3, 'view');
  await member(users.p4, 'view');
  await member(users.p5, 'view');

  const tm = (uid, role, starter) =>
    run('INSERT INTO team_members (team_id, user_id, game_role, is_starter) VALUES (?,?,?,?)', teamId, uid, role, starter);
  await tm(users.igl, 'IGL / Rifler', 1);
  await tm(users.p2, 'Entry', 1);
  await tm(users.p3, 'Support', 1);
  await tm(users.p4, 'Lurk', 1);
  await tm(users.p5, 'AWP', 1);

  // Maps are not demo data — db.init() seeds the active-duty pool for every
  // install, including production, before this runs. Cache is the exception:
  // it is not in the CS2 active-duty pool, so it belongs to the demo rather
  // than to every install, and the demo playbook covers it.
  await run(`INSERT INTO maps (name, active) VALUES ('Cache', 1) ON CONFLICT DO NOTHING`);

  // ---- Opponents ----
  const insOpp = (...args) => run(`INSERT INTO opponents
    (team_id, name, org_name, playstyle, map_pool, preferred_picks, preferred_bans, econ_notes, notes, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?) RETURNING id`, ...args);
  const opp1 = (await insOpp(teamId, 'Ironclad Syndicate', 'Ironclad Org',
    'Structured, utility-heavy T sides with slow defaults into late executes. Disciplined CT sides but predictable rotations.',
    'Mirage, Inferno, Ancient, Nuke, Anubis, Dust2, Train',
    'Mirage, Ancient', 'Nuke, Train',
    'Frequently force buys after losing pistol. Rarely full-saves on CT side; expect scattered force buys with upgraded pistols.',
    'Scrimmed them twice in spring. They adapt slowly inside a map but prep hard between maps. Expect anti-strat if we repeat our A executes.',
    t, t)).id;
  const opp2 = (await insOpp(teamId, 'Blue Harbor Esports', 'Blue Harbor',
    'Loose, aim-driven style. Heavy early aggression for map control, thin utility discipline. Strong pistol rounds.',
    'Dust2, Mirage, Anubis, Inferno, Ancient',
    'Dust2, Anubis', 'Nuke, Ancient',
    'Ecos are full-save stacks on one site. They rarely force; when they do it is all-in with SMGs on one site.',
    'Beat them 2-0 in the winter qualifier, but their new AWPer changes their Dust2 and Mirage mid presence.',
    t, t)).id;

  const insOp = (...args) => run(`INSERT INTO opponent_players
    (opponent_id, name, role, positions, weapons, aggression, habits, weaknesses, notes)
    VALUES (?,?,?,?,?,?,?,?,?) RETURNING id`, ...args);
  const ir1 = (await insOp(opp1, 'fracture', 'AWP', 'Mirage: window, B short. Inferno: pit, arch.', 'AWP, Deagle on forces', 'passive',
    'Holds passive angles, repositions after one kill. Starts window on Mirage CT almost every gun round.',
    'Struggles when flashed off first angle; slow to re-peek.',
    'Do not dry-peek mid on Mirage. Trade around his first shot.')).id;
  const ir2 = (await insOp(opp1, 'Kestrel', 'Entry / Connector', 'Mirage: connector, short. Ancient: mid.', 'Rifles', 'aggressive',
    'Pushes underpass after losing mid control on Mirage CT. Wide-swings on retakes.',
    'Overextends without utility; first to die on bad rounds.',
    'Punish underpass push with a late lurker.')).id;
  await insOp(opp1, 'Bastion', 'IGL / Anchor', 'Mirage: B apps anchor. Inferno: B site.', 'Rifles, SMGs on anti-eco', 'passive',
    'Calls slow defaults. Anchors B with utility saved for retake.',
    'Predictable timeout calls: expects our A execute after their timeout.',
    'Their mid-round adjustments come from him; if he dies early their T rounds stall.');
  await insOp(opp1, 'Havoc', 'Support', 'Mirage: A site / jungle.', 'Rifles', 'balanced',
    'Throws set retake utility. Plays close corners on low-buy rounds.',
    'Weak in 1v1 clutches; tends to save instead of playing the round.',
    null);
  await insOp(opp1, 'Marrow', 'Lurk', 'Mirage: palace / apps on T. CT: flexes.', 'Rifles', 'balanced',
    'Late-round lurker; appears behind executes 30-40s in. Pushes apartments during low-buy rounds.',
    'Loses patience if the round goes past 1:00; starts free-peeking.',
    'Clear apps/palace late every round on our A hits.');

  await insOp(opp2, 'Meridian', 'AWP', 'Dust2: mid doors. Mirage: window / jungle.', 'AWP', 'aggressive',
    'Aggressive first-pick attempts in the opening 15 seconds.',
    'Overpeeks on eco rounds; can be baited with a shoulder peek.',
    'New addition; drives their fast mid takes.');
  await insOp(opp2, 'Cobble', 'Entry', 'Everywhere first', 'Rifles', 'aggressive',
    'Runs first through every choke. Buys flashes only.',
    'Predictable timing: entries at 1:35 almost every round.',
    null);

  const insT = (...args) => run(`INSERT INTO tendencies
    (opponent_id, opponent_player_id, map, side, site, round_type, category, text, severity, created_by, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`, ...args);
  await insT(opp1, ir2, 'Mirage', 'CT', null, null, 'Rotation',
    'On Mirage CT side, their connector player frequently pushes underpass after losing mid control.', 'high', users.analyst, t);
  await insT(opp1, null, 'Mirage', 'CT', 'B', 'low-buy', 'Aggression',
    'B apps player frequently pushes apartments during low-buy rounds.', 'high', users.analyst, t);
  await insT(opp1, null, 'Mirage', 'CT', null, null, 'Rotation',
    'Connector rotates early when A utility is shown — fake A smokes pull two defenders by 1:20.', 'high', users.analyst, t);
  await insT(opp1, ir1, 'Mirage', 'CT', 'Mid', 'full', 'AWP',
    'AWP commonly starts window every gun round; repositions to B short after first mid contact.', 'high', users.analyst, t);
  await insT(opp1, null, null, null, null, 'pistol', 'Economy',
    'Team frequently force buys after losing pistol — expect upgraded pistols + one SMG on round 2.', 'high', users.analyst, t);
  await insT(opp1, null, 'Mirage', 'T', null, 'full', 'Default',
    'Slow defaults until 1:10, then fast A ramp executes off double smoke. Very few B hits before round 6.', 'normal', users.analyst, t);
  await insT(opp1, null, 'Mirage', 'T', 'B', 'pistol', 'Pistol',
    'T pistol: 5-man B apps rush with two flashes, van plant. Seen in 3 of last 4 recorded pistols.', 'normal', users.analyst, t);
  await insT(opp1, null, 'Inferno', 'CT', 'Banana', null, 'Utility',
    'Banana control: molotov car at 1:50, then nade top banana. Utility exhausted by 1:20 — second banana take is cheap.', 'normal', users.analyst, t);
  await insT(opp1, null, null, null, null, null, 'Timeout',
    'After tactical timeouts they stack the site we hit most recently. Call the opposite site after their timeouts.', 'normal', users.coach, t);
  await insT(opp2, null, 'Mirage', 'T', 'Mid', 'full', 'Map control',
    'Fast mid takes behind AWP aggression at 1:50; underpass + top-mid pincer if AWP wins first duel.', 'high', users.analyst, t);
  await insT(opp2, null, null, null, null, 'eco', 'Economy',
    'Ecos are 5-man stacks on one site with full saves — never split saves.', 'normal', users.analyst, t);

  // ---- Strategies ----
  // Personal strategies (owned by their creator) designated into the team's
  // strategy bank via team_strategies — the same shape "Add to Team Strats"
  // produces in the app.
  const S = async (o) => {
    const by = o.by || users.coach;
    const id = (await run(`INSERT INTO strategies
      (name, map, side, category, buy_type, site, map_area, tags, difficulty, spawn_dependency, required_utility,
       objective, summary, steps, roles, timings, midround, reactions, backup, warnings, attachments, status, created_by, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
      o.name, o.map, o.side, o.category, o.buy || null, o.site || null, o.area || null,
      J(o.tags || []), o.difficulty || 'standard', o.spawn || null, o.util || null,
      o.objective || null, o.summary || null, J(o.steps || []), J(o.roles || []),
      J(o.timings || []), J(o.midround || []), J(o.reactions || []), o.backup || null,
      J(o.warnings || []), J(o.attachments || []), o.status || 'active', by, t, t
    )).id;
    await run('INSERT INTO team_strategies (strategy_id, team_id, added_by, created_at) VALUES (?,?,?,?)',
      id, teamId, by, t);
    return id;
  };

  const aSplit = await S({
    name: 'A Split', map: 'Mirage', side: 'T', category: 'Execute', buy: 'full', site: 'A', area: 'Mid / Palace / Ramp',
    tags: ['split', 'a-site', 'utility-heavy'], difficulty: 'standard',
    spawn: 'Needs at least one forward-mid spawn for the mid pair. If all spawns are back, delay first contact by 5 seconds.',
    util: '3 smokes (CT, jungle, stairs), 2 molotovs (sandwich, default plant), 4 flashes',
    objective: 'Take mid control early, then split A through palace and ramp with connector pressure.',
    summary: 'CALL: Mid pair takes top mid at 1:45. On "MID OK" — palace + ramp execute at 1:20. Smokes: CT, jungle, stairs. Plant default for sandwich molly.',
    steps: [
      'Mid pair (Sable + Vector) takes top mid control at 1:45 with one flash over top and a catwalk check.',
      'Quill takes palace control quietly — no noise past the palace entrance until the call.',
      'Drift and Pillar hold ramp and prepare execute utility. Pillar watches apps cross with AWP.',
      'On "MID OK": smokes go — CT from mid, jungle from ramp, stairs from palace.',
      'Palace flashes over site, Quill jumps down as first contact on site.',
      'Ramp pair walks out behind stairs smoke; Sable enters via connector for the sandwich squeeze.',
      'Plant default (safe for connector and palace). Molotov sandwich on plant.',
      'Post-plant: two connector/jungle, one palace, one ramp/site, Pillar holds mid re-take flank.'
    ],
    roles: [
      { slot: 'Player 1', assignee: 'Riley "Sable" Fox', role: 'Entry (mid pair)', duty: 'Take top mid, then enter via connector on the execute. First contact in connector.', utility: '1 flash over top mid, 1 flash for connector entry' },
      { slot: 'Player 2', assignee: 'Morgan "Vector" Hale', role: 'Second entry / caller (mid pair)', duty: 'Trade Sable in mid and connector. Makes the "MID OK" and execute calls.', utility: 'CT smoke from mid' },
      { slot: 'Player 3', assignee: 'Alex "Quill" Novak', role: 'Smoke & flash support (palace)', duty: 'Quiet palace control. Throws stairs smoke and both site flashes, then first onto site from palace.', utility: 'Stairs smoke, 2 pop flashes over A site' },
      { slot: 'Player 4', assignee: 'Sam "Drift" Aoki', role: 'Lurk / ramp', duty: 'Hold ramp with Pillar. Walks out behind stairs smoke, then clears sandwich/default with molotov.', utility: 'Jungle smoke from ramp, sandwich molotov' },
      { slot: 'Player 5', assignee: 'Jordan "Pillar" Reeve', role: 'AWP / late-round control', duty: 'Hold apps cross from ramp, enter last, hold mid flank post-plant.', utility: 'Default-plant molotov, 1 flash for ramp exit' }
    ],
    timings: [
      '1:45 — mid pair takes top mid.',
      '1:30 — palace control confirmed, ramp set.',
      '1:20 — "MID OK" → smokes out, execute begins.',
      '1:10 — plant should be down.',
      'If mid is contested past 1:15, rotate to backup call.'
    ],
    midround: [
      'If AWP wins mid duel early: collapse ramp pair to mid, take a fast connector split instead.',
      'If palace is molotoved: Quill drops to ramp, execute becomes ramp-heavy with connector flash support.',
      'If B stack is confirmed (3+): keep spacing, hit A slow off the same utility — no rush needed.'
    ],
    reactions: [
      'CT AWP (window start) usually falls back to jungle when mid smoke lands — pre-aim jungle from connector.',
      'Connector player wide-swings the CT smoke gap on many teams — one player holds it for 5 seconds after smokes.',
      'Expect a stairs or palace molotov ~10s after first contact; do not stack the palace drop.',
      'Fast B-player rotation through market once plant is down — sandwich molly delays this.'
    ],
    backup: 'Fallback: if mid control fails twice, run "Mid Default" and re-group into a connector control round. Backup B rotation: on "SWING B", palace player exits to mid, everyone regroups top mid and hits B via market + apps at 0:45.',
    warnings: [
      'Do not commit palace before the stairs smoke — palace drop is a free kill for a jungle player.',
      'Sandwich molotov is mandatory: their A support plays sandwich on full buys.',
      'If their AWP is alive and mid smoke fades, do not re-cross mid — rotate through apps.'
    ],
    attachments: [{ type: 'video', url: 'https://example.com/demos/a-split-scrim.mp4', label: 'Scrim demo — A Split vs practice partner' }],
    by: users.igl
  });

  const midDefault = await S({
    name: 'Mid Default', map: 'Mirage', side: 'T', category: 'Default', buy: 'full', site: null, area: 'Mid / Underpass',
    tags: ['default', 'map-control'], difficulty: 'basic',
    util: '1 top-mid smoke, 1 catwalk molotov, 2 flashes',
    objective: 'Establish mid + underpass control, gather information, keep utility for a late hit.',
    summary: 'CALL: 1-3-1. Top mid smoke at 1:50. Palace + apps presence for info only. Decide site at 1:10.',
    steps: [
      'Top-mid smoke at 1:50; mid trio holds top mid and underpass.',
      'Sable shadows apps for info — no commit.',
      'Quill holds palace presence, counts rotations.',
      'At 1:10 Vector calls the hit based on info: A ramp-heavy or B apps.',
      'Keep 2 flashes minimum for the late hit.'
    ],
    roles: [
      { slot: 'Player 1', assignee: 'Riley "Sable" Fox', role: 'Apps info', duty: 'Sound info in apps, fall back on contact.', utility: '1 flash' },
      { slot: 'Player 2', assignee: 'Morgan "Vector" Hale', role: 'Mid anchor / caller', duty: 'Hold top mid, read rotations, make the 1:10 call.', utility: 'Top-mid smoke' },
      { slot: 'Player 3', assignee: 'Alex "Quill" Novak', role: 'Palace presence', duty: 'Quiet palace, count A players.', utility: '—' },
      { slot: 'Player 4', assignee: 'Sam "Drift" Aoki', role: 'Underpass', duty: 'Control underpass, punish underpass pushes.', utility: 'Catwalk molotov' },
      { slot: 'Player 5', assignee: 'Jordan "Pillar" Reeve', role: 'AWP mid', duty: 'Hold mid cross behind smoke, peel for late hit.', utility: '—' }
    ],
    timings: ['1:50 — top-mid smoke.', '1:10 — site call.', '0:45 — latest commit time.'],
    midround: ['Underpass push punished → instant B apps hit while B is 1.', 'AWP shows window early → jiggle info, save flash for late window fight.'],
    reactions: ['vs Ironclad: Kestrel pushes underpass after losing mid — Drift holds the punish angle every round.'],
    backup: 'If nothing opens by 0:45, ramp-heavy A hit with remaining utility.',
    warnings: ['Do not burn both flashes before the 1:10 call.'],
    by: users.igl
  });

  const fastB = await S({
    name: 'Fast B Apps', map: 'Mirage', side: 'T', category: 'Rush', buy: 'semi', site: 'B', area: 'Apartments',
    tags: ['rush', 'b-site', 'force'], difficulty: 'basic',
    spawn: 'Best with 2+ forward spawns; otherwise expect contact at bench.',
    util: '2 flashes into apps, 1 van smoke, 1 site molotov',
    objective: 'Hit B before rotations set, van plant, play post-plant crossfires.',
    summary: 'CALL: 5-man apps at full speed. Double flash bench, van smoke, plant van. Post-plant: market door + apps crossfire.',
    steps: [
      'Full team apps immediately, Sable first.',
      'Double flash over bench/apps exit.',
      'Van smoke on exit; molotov site close-left.',
      'Sable + Quill clear site, Drift plants van.',
      'Post-plant: two market/window watch, two apps, Pillar kitchen flank.'
    ],
    roles: [
      { slot: 'Player 1', assignee: 'Riley "Sable" Fox', role: 'Entry', duty: 'First out apps, clear van/site left.', utility: '—' },
      { slot: 'Player 2', assignee: 'Alex "Quill" Novak', role: 'Second entry', duty: 'Trade Sable, clear back site.', utility: 'Site molotov' },
      { slot: 'Player 3', assignee: 'Morgan "Vector" Hale', role: 'Support / caller', duty: 'Throws both bench flashes, watches market on exit.', utility: '2 flashes' },
      { slot: 'Player 4', assignee: 'Sam "Drift" Aoki', role: 'Planter', duty: 'Van smoke, van plant.', utility: 'Van smoke' },
      { slot: 'Player 5', assignee: 'Jordan "Pillar" Reeve', role: 'Trailer / flank', duty: 'Watch kitchen/mid flank during plant.', utility: '—' }
    ],
    timings: ['First contact ~1:47 at bench.', 'Plant target: before 1:30.'],
    midround: ['If apps molotoved at bench: wait it out 8s behind first flash, re-hit — do NOT re-route mid.'],
    reactions: ['B anchor plays van or site boxes on forces; short player rotates through window at first noise — window smoke stops this if you have a 5th nade.'],
    backup: 'If plant is impossible by 1:15, exit apps toward mid and save.',
    warnings: ['vs Ironclad low-buys their apps player pushes early — first flash must go BEFORE bench.'],
    by: users.igl
  });

  const contactA = await S({
    name: 'Contact A', map: 'Mirage', side: 'T', category: 'Contact play', buy: 'full', site: 'A', area: 'Ramp / Palace',
    tags: ['contact', 'a-site', 'anti-utility'], difficulty: 'advanced',
    util: 'No pre-set utility — everything reactive. Each player carries own flash.',
    objective: 'Walk A quietly and hit off first contact before CT utility is set. Best vs utility-heavy CT sides.',
    summary: 'CALL: silent walk ramp + palace, no util until contact. On first shot: all-in, reactive flashes only.',
    steps: [
      'All five walk: three ramp, two palace. No mid presence.',
      'Hold just outside site until first contact or 1:05.',
      'On contact: everyone commits, reactive flashes over the fight.',
      'Plant default; keep one player watching connector.'
    ],
    roles: [
      { slot: 'Player 1', assignee: 'Riley "Sable" Fox', role: 'Entry (ramp)', duty: 'First through ramp on contact.', utility: 'Own flash' },
      { slot: 'Player 2', assignee: 'Alex "Quill" Novak', role: 'Entry (palace)', duty: 'First out palace on contact.', utility: 'Own flash' },
      { slot: 'Player 3', assignee: 'Morgan "Vector" Hale', role: 'Caller (ramp)', duty: 'Times the commit; trades ramp.', utility: 'Own flash' },
      { slot: 'Player 4', assignee: 'Sam "Drift" Aoki', role: 'Support (palace)', duty: 'Trades palace, clears sandwich.', utility: 'Own flash' },
      { slot: 'Player 5', assignee: 'Jordan "Pillar" Reeve', role: 'Trailer (ramp)', duty: 'Watches apps cross, connector after plant.', utility: 'Own flash' }
    ],
    timings: ['In position by 1:25.', 'Commit no later than 1:05 even without contact.'],
    midround: ['If spotted early on ramp, convert to normal ramp execute with whatever utility is alive.'],
    reactions: ['Utility-heavy CTs burn their nades on empty space by 1:15 — that is the window.', 'Expect a connector rotation ~5s after first contact.'],
    backup: 'On failed hit, survivors exit palace-side and save.',
    warnings: ['Dead silence is the whole strat — one footstep at 1:40 kills it.', 'Do not use vs heavy-info CT sides that hold ramp with an AWP.'],
    by: users.coach
  });

  const tPistol = await S({
    name: 'T Pistol — B Apps Squeeze', map: 'Mirage', side: 'T', category: 'Pistol', buy: 'pistol', site: 'B', area: 'Apartments / Underpass',
    tags: ['pistol', 'b-site'], difficulty: 'basic',
    util: '2 flashes (armor players carry none)',
    objective: 'Squeeze B from apps and underpass-kitchen before CT utility matters.',
    summary: 'CALL: 4 apps + 1 underpass-kitchen. Flash bench at 1:48. Van plant. Underpass player cuts market.',
    steps: [
      'Four players apps, Drift alone underpass → kitchen.',
      'Flash over bench at 1:48, apps four commit.',
      'Drift cuts through kitchen into market as site contact starts.',
      'Van plant, post-plant market + apps crossfire.'
    ],
    roles: [
      { slot: 'Players 1-4', assignee: 'Sable, Quill, Vector, Pillar', role: 'Apps hit', duty: 'Standard apps clear, trade in pairs.', utility: '2 flashes' },
      { slot: 'Player 5', assignee: 'Sam "Drift" Aoki', role: 'Kitchen cut', duty: 'Silent underpass, kitchen timing on first contact.', utility: '—' }
    ],
    timings: ['1:48 — bench flash.', '1:40 — site contact.', '1:30 — plant down.'],
    midround: ['If apps is stacked (3+ pistols heard), pull back and re-hit through underpass + short together.'],
    reactions: ['vs Ironclad pistol: they play 2 apps aggressively — first flash wins or loses this round.'],
    backup: 'On a failed hit with 3+ alive, save pistols for round 3 force.',
    warnings: ['Their round-2 force is guaranteed — plan round 2 as anti-force, not anti-eco.'],
    by: users.igl
  });

  await S({
    name: 'Anti-eco — Slow A Spread', map: 'Mirage', side: 'T', category: 'Anti-eco', buy: 'full', site: 'A',
    tags: ['anti-eco', 'a-site'], difficulty: 'basic',
    util: '1 sandwich molotov only — save the rest',
    objective: 'Take A slowly with max spacing against stacked-close eco defenders. No hero peeks, no util dumping.',
    summary: 'CALL: slow ramp + palace at 1:20, huge spacing, clear every close corner with the molotov. SAVE UTILITY.',
    steps: [
      'Spread wide: 2 ramp, 2 palace, 1 top mid watching connector.',
      'Move in at 1:20 — slow, checking every close corner.',
      'Molotov sandwich; never two players in one doorway.',
      'Plant open for connector, play far post-plant angles.'
    ],
    roles: [
      { slot: 'All', assignee: 'Team', role: 'Spread hit', duty: 'Max spacing, no doubles through chokes, no upgrades picked up before plant.', utility: 'Sandwich molotov (Drift)' }
    ],
    timings: ['1:20 — move in together.'],
    midround: ['If they push out ramp with pistols, back off and kill them in the open — do not fight close.'],
    reactions: ['Eco stacks hide in pairs: sandwich + firebox, or palace drop + default boxes.'],
    backup: '—',
    warnings: ['Losing two players to an eco is a round loss even if you win it — spacing is the entire strat.', 'vs Blue Harbor: ecos are 5-stacks on one site; if A is empty, B is loaded — plant fast and hold.'],
    by: users.coach
  });

  const ctDefault = await S({
    name: 'CT Default 2-1-2', map: 'Mirage', side: 'CT', category: 'Default', buy: 'full', site: null,
    tags: ['ct', 'default'], difficulty: 'standard',
    util: 'Standard: jungle smoke for retake (Quill), apps molotov (Sable), top-mid smoke (Pillar)',
    objective: 'Standard 2-1-2 with AWP mid. Stable info positions, utility held for retakes.',
    summary: 'CALL: 2A (Quill+Drift), Pillar AWP window, Vector connector, Sable B apps + Vector supports B on hit.',
    steps: [
      'A: Quill jungle/stairs, Drift ramp/site.',
      'Mid: Pillar AWP window, falls to jungle or B short after first contact.',
      'Vector connector — flexes both ways, supports B on hit.',
      'Sable B apps with molotov for the 1:45 apps timing.',
      'Rotations only on confirmed info, not first noise.'
    ],
    roles: [
      { slot: 'Player 1', assignee: 'Alex "Quill" Novak', role: 'A jungle', duty: 'Hold stairs/palace cross, keep retake smoke.', utility: 'Jungle retake smoke' },
      { slot: 'Player 2', assignee: 'Sam "Drift" Aoki', role: 'A ramp', duty: 'Ramp contact, fall to site boxes.', utility: 'Ramp molotov' },
      { slot: 'Player 3', assignee: 'Jordan "Pillar" Reeve', role: 'AWP mid', duty: 'Window control, reposition after first pick.', utility: 'Top-mid smoke' },
      { slot: 'Player 4', assignee: 'Morgan "Vector" Hale', role: 'Connector flex / caller', duty: 'Read the round, early rotate calls.', utility: 'Connector flash' },
      { slot: 'Player 5', assignee: 'Riley "Sable" Fox', role: 'B apps', duty: 'Apps molotov at 1:45, fall back to van on contact.', utility: 'Apps molotov' }
    ],
    timings: ['1:45 — apps molotov.', '1:40 — window presence established.'],
    midround: ['A-heavy read → Vector pre-rotates connector→A, Sable holds B alone with util.', 'Mid control lost → Pillar to B short, NEVER re-peek window dry.'],
    reactions: ['Expect underpass + palace pincer if we show too much mid presence.'],
    backup: 'Retake protocol: regroup CT spawn, jungle smoke + flash together, trade on site.',
    warnings: ['Do not chase apps kills through the molotov — that is how B opens up.'],
    by: users.coach
  });

  const ctPistol = await S({
    name: 'CT Pistol — 3A Standard', map: 'Mirage', side: 'CT', category: 'Pistol', buy: 'pistol', site: 'A',
    tags: ['pistol', 'ct'], difficulty: 'basic',
    util: '2 flashes A-side, 1 smoke B van',
    objective: 'Slight A lean vs their apps-heavy pistol stats, with fast B collapse through market.',
    summary: 'CALL: 3A (ramp close, site, jungle), Pillar window, Sable B van behind smoke. On B hit: everyone collapses market/window.',
    steps: [
      'Quill ramp close-left, Drift site boxes, Vector jungle.',
      'Pillar window with util for mid.',
      'Sable holds B van behind early smoke — delay only.',
      'On B contact: Pillar window→market instantly, A players collapse via connector.'
    ],
    roles: [
      { slot: 'Player 1', assignee: 'Alex "Quill" Novak', role: 'Ramp close', duty: 'Close-left surprise on ramp rushers.', utility: '1 flash' },
      { slot: 'Player 2', assignee: 'Sam "Drift" Aoki', role: 'A site', duty: 'Site boxes, trades ramp.', utility: '—' },
      { slot: 'Player 3', assignee: 'Morgan "Vector" Hale', role: 'Jungle / caller', duty: 'Holds palace + connector, calls collapse.', utility: '1 flash' },
      { slot: 'Player 4', assignee: 'Jordan "Pillar" Reeve', role: 'Window', duty: 'Mid info, first B rotator through market.', utility: 'B van smoke (thrown early)' },
      { slot: 'Player 5', assignee: 'Riley "Sable" Fox', role: 'B delay', duty: 'Van smoke delay, fall back — do not die.', utility: '—' }
    ],
    timings: ['1:50 — van smoke down.', 'B contact → collapse arrives within 12s.'],
    midround: ['Apps rush confirmed by 1:47 → Sable falls to market instantly, fight 5v5 on retake spacing.'],
    reactions: ['Ironclad runs 5-man B apps pistol most games — this setup is built to retake B, not hold it.'],
    backup: 'Lost pistol → full eco round 2, stack A close together, exit-frag round 3 gear.',
    warnings: ['Sable must NOT take a 1v5 apps fight — the delay is the job, not the kill.'],
    by: users.coach
  });

  await S({
    name: 'CT Force — Double B Stack', map: 'Mirage', side: 'CT', category: 'Force buy', buy: 'semi', site: 'B',
    tags: ['force', 'ct', 'stack'], difficulty: 'standard',
    util: 'Whatever is affordable: priority apps molotov + van smoke',
    objective: 'Upgraded-pistol force with a 3-B stack against their apps-heavy low-buy pattern.',
    summary: 'CALL: 3B close (apps door, van, site), 1 connector, 1 A ramp with molly. Fight close, trade everything.',
    steps: [
      'Sable + Quill + Drift stack B: apps door close, van, back site.',
      'Vector connector, shading B through window.',
      'Pillar solo A ramp with molotov — delay, do not die, call it.',
      'Fight close-range where pistols/SMGs trade with rifles.'
    ],
    roles: [
      { slot: 'B stack', assignee: 'Sable, Quill, Drift', role: 'Close trio', duty: 'Layered close positions, trade on first contact.', utility: 'Apps molotov' },
      { slot: 'Mid', assignee: 'Morgan "Vector" Hale', role: 'Connector', duty: 'Cut mid, support B via window.', utility: 'Van smoke' },
      { slot: 'A', assignee: 'Jordan "Pillar" Reeve', role: 'A delay', duty: 'Ramp molotov delay, fall to jungle, survive.', utility: 'Ramp molotov' }
    ],
    timings: ['Stack set by 1:50 — their low-buy apps timing is 1:45.'],
    midround: ['A hit instead → Pillar delays with molly, B trio rotates market/connector — do not sprint through open mid.'],
    reactions: ['Their apps player free-pushes on our low buys (high-severity tendency) — apps-door close player gets the opening kill.'],
    backup: 'If round is lost early, save upgraded pistols behind van smoke.',
    warnings: ['This is an all-in read on their B apps habit. If they went A twice already, use normal force spread instead.'],
    by: users.igl
  });

  await S({
    name: 'A Retake Protocol', map: 'Mirage', side: 'CT', category: 'Retake', buy: 'full', site: 'A',
    tags: ['retake', 'a-site'], difficulty: 'standard',
    util: 'Jungle smoke, CT smoke, 2 flashes, 1 molotov (default plant)',
    objective: 'Coordinated 3-4 player A retake from connector + stairs with synchronized utility.',
    summary: 'CALL: group connector + stairs. Smokes: CT + jungle-to-site gap. Flash over site, molly default, trade in pairs.',
    steps: [
      'Regroup: connector pair + stairs pair. AWP holds mid flank cut.',
      'Smoke CT-to-site and jungle gap simultaneously.',
      'Flash over site from stairs; connector pair swings first.',
      'Molotov default plant spot as the swing happens.',
      'Trade in pairs — nobody swings alone. Defuse behind second flash.'
    ],
    roles: [
      { slot: 'Pair 1', assignee: 'Connector pair', role: 'First swing', duty: 'Swing site off the flash, clear firebox/boxes.', utility: 'CT smoke, 1 flash' },
      { slot: 'Pair 2', assignee: 'Stairs pair', role: 'Trade + defuse', duty: 'Flash for pair 1, trade, stick the defuse.', utility: 'Jungle smoke, 1 flash, default molotov' },
      { slot: 'AWP', assignee: 'Jordan "Pillar" Reeve', role: 'Flank cut', duty: 'Hold mid/palace flank during retake.', utility: '—' }
    ],
    timings: ['Retake begins with 25+ seconds on bomb — earlier is a fight, not a retake.'],
    midround: ['Only 2 alive → default molly + double swing same angle, accept the coin flip.'],
    reactions: ['Post-plant Ts favor palace + connector on this site — clear palace with the first flash.'],
    backup: 'Under 20s on arrival: save weapons, do not force the site.',
    warnings: ['Never molly the bomb site before knowing plant location — you can burn your own defuse window.'],
    by: users.coach
  });

  await S({
    name: 'Emergency — Reset Default', map: 'Mirage', side: 'T', category: 'Emergency call', buy: 'full',
    tags: ['emergency'], difficulty: 'basic',
    objective: 'Panic button when a round plan collapses: regroup and run the simplest structure.',
    summary: 'CALL: "RESET" — everyone drops current plan, regroups top mid + ramp, runs basic 1-3-1, hit A ramp at 0:50 with whatever utility is left.',
    steps: [
      'Call "RESET" loudly once. No debate mid-round.',
      'Alive players regroup: mid trio + ramp pair shape (fill nearest slot).',
      'At 0:50, ramp-heavy A hit. Any smoke goes CT, any flash goes over site.',
      'No plant = exit palace side and save.'
    ],
    roles: [{ slot: 'All', assignee: 'Team', role: 'Regroup', duty: 'Fill nearest slot in the 1-3-1, no solo plays.', utility: 'Whatever remains' }],
    timings: ['Call before 1:10 or play the save instead.'],
    warnings: ['If "RESET" is called after 1:00, the correct call is usually SAVE, not a hit.'],
    by: users.igl
  });

  await S({
    name: 'Emergency — Full Save', map: 'Mirage', side: 'T', category: 'Emergency call', buy: 'save',
    tags: ['emergency', 'save'], difficulty: 'basic',
    objective: 'Preserve guns when the round is unwinnable.',
    summary: 'CALL: "SAVE SAVE SAVE" — break contact, T spawn / palace corners, no peeks, no hero plays. Guns > pride.',
    steps: [
      'Break contact immediately — do not trade into a lost fight.',
      'Default save spots: palace corner, T ramp boxes, apps back rooms.',
      'If they push the save, split directions — two guns saved beats one hero kill.'
    ],
    roles: [{ slot: 'All', assignee: 'Team', role: 'Save', duty: 'Live with the gun. Nothing else.', utility: '—' }],
    warnings: ['A saved AWP is next round\'s opening pick — Pillar saves first, always.'],
    by: users.igl
  });

  await S({
    name: 'B Execute — Market Split', map: 'Mirage', side: 'T', category: 'Split', buy: 'full', site: 'B', area: 'Apps / Market / Underpass',
    tags: ['split', 'b-site'], difficulty: 'advanced',
    util: '3 smokes (window, market door inside, short), 2 flashes, 1 van molotov',
    objective: 'Split B through apps and underpass-market with window smoked off.',
    summary: 'CALL: 3 apps + 2 underpass. Window + short smokes at 1:25, market pair cuts inside, apps flashes in. Van molly, open plant.',
    steps: [
      'Trio apps quiet by 1:35; pair takes underpass.',
      '1:25 — window smoke + short smoke from underpass, market pair enters market.',
      'Apps flashes over bench, trio commits as market pair clears market/window doors.',
      'Van molotov, open plant for market.',
      'Post-plant: market inside, apps, one short/window watch.'
    ],
    roles: [
      { slot: 'Apps trio', assignee: 'Sable, Quill, Vector', role: 'Main hit', duty: 'Standard apps clear on the flash.', utility: '2 flashes, van molotov' },
      { slot: 'Underpass pair', assignee: 'Drift, Pillar', role: 'Market cut', duty: 'Smokes, market clear, deny window rotation.', utility: 'Window + short smokes' }
    ],
    timings: ['1:25 — smokes.', '1:18 — synchronized contact.'],
    midround: ['Market pair heard early → convert to full apps hit, smokes still deny the rotation.'],
    reactions: ['Window smoke forces their AWP to short or connector — short smoke covers the cross.'],
    backup: 'Failed hit → survivors regroup underpass, save or late A ramp with nothing shown.',
    warnings: ['The two halves MUST hit within 3 seconds of each other or each gets killed 3v2.'],
    by: users.coach
  });

  await S({
    name: 'Banana Control Default', map: 'Inferno', side: 'T', category: 'Default', buy: 'full', site: null, area: 'Banana / Mid',
    tags: ['default', 'map-control'], difficulty: 'standard',
    util: '1 car molotov, 1 top-banana smoke, 2 flashes',
    objective: 'Win banana control cheaply, then decide B or split A based on rotations.',
    summary: 'CALL: banana pair takes top banana after their car molly burns (their util is gone by 1:20 — see tendency). Mid trio defaults. Decide at 1:05.',
    steps: [
      'Banana pair waits out their 1:50 car molotov, then takes top banana with smoke + flash.',
      'Mid trio: apps presence + mid control, no commit.',
      'At 1:05 call: B off banana control, or A split apps/arch.'
    ],
    roles: [
      { slot: 'Banana pair', assignee: 'Sable, Drift', role: 'Banana control', duty: 'Take and hold top banana.', utility: 'Smoke, flash' },
      { slot: 'Mid trio', assignee: 'Vector, Quill, Pillar', role: 'Default', duty: 'Mid + apps info.', utility: 'Car molotov, flash' }
    ],
    timings: ['1:50 — their car molly (book it).', '1:20 — their banana util exhausted.', '1:05 — call.'],
    reactions: ['Ironclad burns all banana utility by 1:20 — second banana take is nearly free.'],
    backup: 'Banana lost twice → full A split through apps + arch at 0:55.',
    warnings: ['Do not fight the first car molotov — it is a free burn for them.'],
    by: users.coach
  });

  await S({
    name: 'CT A Setup — Pit Anchor', map: 'Inferno', side: 'CT', category: 'Default', buy: 'full', site: 'A',
    tags: ['ct', 'a-site'], difficulty: 'standard',
    util: 'Retake smokes held, apps molotov at 1:45',
    objective: 'Standard A hold: pit anchor + arch flex vs apps pressure.',
    summary: 'CALL: pit anchor deep, arch flex supports mid or site, apps molly at 1:45. Rotate only on confirmed B commit.',
    steps: [
      'Pit player holds deep, never re-peeks same angle twice.',
      'Arch flex plays library/arch, cuts mid support.',
      'Apps molotov at 1:45 for their default apps timing.',
      'B commit confirmed → arch rotates first, pit holds site alone until second confirm.'
    ],
    roles: [
      { slot: 'Pit', assignee: 'Jordan "Pillar" Reeve', role: 'Anchor', duty: 'Deep pit, info + delay.', utility: 'Retake smoke' },
      { slot: 'Arch', assignee: 'Alex "Quill" Novak', role: 'Flex', duty: 'Arch/library, first rotator.', utility: 'Apps molotov' }
    ],
    timings: ['1:45 — apps molotov.'],
    midround: ['Apps 3+ confirmed → both hold site, call for mid support.'],
    backup: 'Site lost → standard arch + graveyard retake with saved smokes.',
    warnings: ['Pit is isolated — never take a 1v3 fight there, fall to graveyard.'],
    by: users.coach
  });

  await S({
    name: 'A Ramp Slow Take', map: 'Mirage', side: 'T', category: 'Execute', buy: 'full', site: 'A', area: 'Ramp',
    tags: ['a-site', 'wip'], difficulty: 'standard',
    objective: 'Ramp-only slow execute — still needs utility assignments from scrim review.',
    summary: 'WIP: slow ramp take behind triple smoke. Utility lineup owners not yet assigned.',
    steps: ['Draft — needs scrim validation before it enters the rotation.'],
    status: 'draft',
    by: users.igl
  });

  await S({
    name: 'Old Window Rush (2025)', map: 'Mirage', side: 'T', category: 'Rush', buy: 'semi', site: 'Mid',
    tags: ['deprecated'], difficulty: 'basic',
    objective: 'Legacy mid rush from the 2025 playbook.',
    summary: 'Retired: window boost rush — patched boost, keep for reference only.',
    steps: ['Archived — do not call.'],
    status: 'archived',
    by: users.coach
  });

  // ---- Match ----
  const matchDate = new Date(Date.now() + 3 * 24 * 3600 * 1000);
  matchDate.setHours(19, 0, 0, 0);
  const matchId = (await run(`INSERT INTO matches
    (team_id, opponent_id, scheduled_at, event, format, expected_maps, veto_notes, starting_side, roster, subs, status, created_by, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`,
    teamId, opp1, matchDate.toISOString(), 'Meridian League — Playoffs R1', 'BO3',
    J(['Mirage', 'Inferno', 'Ancient']),
    'Ban Nuke first (their comfort ban too — expect Train ban back). Pick Mirage. They likely pick Ancient. Decider probably Inferno.',
    'CT',
    J([users.igl, users.p2, users.p3, users.p4, users.p5]),
    J([]),
    'upcoming', users.coach, t)).id;

  const match2Date = new Date(Date.now() + 10 * 24 * 3600 * 1000);
  match2Date.setHours(20, 0, 0, 0);
  await run(`INSERT INTO matches
    (team_id, opponent_id, scheduled_at, event, format, expected_maps, veto_notes, starting_side, roster, subs, status, created_by, created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    teamId, opp2, match2Date.toISOString(), 'Meridian League — Playoffs R2', 'BO3',
    J(['Mirage', 'Anubis']),
    'They ban Nuke and Ancient every series. Expect Dust2 pick — we ban it, pick Mirage.',
    null,
    J([users.igl, users.p2, users.p3, users.p4, users.p5]),
    J([]),
    'upcoming', users.coach, t);

  const pins = [aSplit, fastB, midDefault, contactA, ctDefault, ctPistol];
  for (let i = 0; i < pins.length; i++) {
    await run('INSERT INTO match_pins (match_id, strategy_id, sort) VALUES (?,?,?)', matchId, pins[i], i);
  }

  const notes = [
    'Round 2 after losing pistol: they ALWAYS force — buy armor + utility accordingly, do not anti-eco.',
    'Vector calls "MID OK" only after catwalk is checked — A Split fails without true mid control.',
    'Pillar: fracture (their AWP) starts window every gun round. Never dry-cross mid.',
  ];
  for (let i = 0; i < notes.length; i++) {
    await run('INSERT INTO match_notes (match_id, kind, text, sort) VALUES (?,?,?,?)', matchId, 'reminder', notes[i], i);
  }

  // The Inferno and Cache playbooks live in seed-data/playbooks.json rather
  // than inline: they are long, and data of that size is easier to read and
  // regenerate as data than as source. Authorship alternates between the two
  // staff accounts so the library does not look written by one person.
  const playbookAuthors = [users.igl, users.coach];
  for (const [i, o] of require('./seed-data/playbooks.json').entries()) {
    await S({ ...o, buy: o.buy_type, area: o.map_area, util: o.required_utility, by: playbookAuthors[i % 2] });
  }

  await backfillTeamPlayers();
  console.log(`[midround] seeded demo data (org: Northlight Gaming, 8 users, password: ${DEMO_LOGIN.password})`);
}

module.exports = { seedIfEmpty, DEMO_LOGIN };
