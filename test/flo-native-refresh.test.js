'use strict';
// Execute the shipped browser seams with a real WorldModel, Pipeline,
// Workstreams, Save and CloudSave. DOM painting alone is replaced by a tiny
// deterministic surface; no live station, browser or model is used.
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const WorldModel = require('../frontend/app/worldmodel.js'), Pipeline = require('../frontend/app/pipeline.js');
const Workstreams = require('../frontend/app/workstreams.js'), Personas = require('../frontend/app/personas.js');
const source = name => fs.readFileSync(path.join(__dirname, '../frontend/app/' + name + '.js'), 'utf8');
const app = source('app'), world = source('world');
function between(text, begin, end) {
  const start = text.indexOf(begin), stop = text.indexOf(end, start + begin.length);
  assert.ok(start >= 0 && stop > start, 'real source extraction markers exist: ' + begin);
  return text.slice(start, stop);
}
const refresh = between(app, '  /* NATIVE-REFRESH-BEGIN', '  /* NATIVE-REFRESH-END');
const roster = between(app, '  function rehydrateRoster(', '  /* ---------- THE RECRUITMENT BAY');
const loader = between(world, '  function loadStation(', '  function rederive(');
const compile = between(world, '  function compileRouting(', '  /* PLAN-POSTER-BEGIN');
const routing = between(world, '  function postRoutingPlan(', '  // junction props');
const posterBlock = between(world, '  function makePlanPoster(', '  /* PLAN-POSTER-END');
const tick = () => new Promise(resolve => setImmediate(resolve));
const copy = value => JSON.parse(JSON.stringify(value));

function harness() {
  const cache = new Map(), nodes = new Map(), fields = [], handlers = new Map(), timers = new Map();
  const telemetry = { posts: [], loads: [], spawns: [], rosterPaints: 0, readOnlyDossier: 0, pulls: 0 };
  let timerId = 0, heldPull = null;
  const original = WorldModel.create(); original.ensureWorkstation('agent');
  const hero = { id: 'agent', name: 'CHIEF OF STAFF', role: 'orchestrator', provider: 'codex', model: 'gpt-5.6-sol',
    docs: { identity: 'Original identity', purpose: 'Commerce', context: 'Owner context', manual: 'Original manual' } };
  const old = { schema: 'starnet.save', version: 6, _saveRevision: 1, updatedAt: 1, agent: copy(hero), agents: [copy(hero)],
    station: original.serialize(), activeId: 'general', generalId: 'general', workstreams: [{ id: 'general', agentId: 'agent', kind: 'chat', lane: 'active',
      history: [{ role: 'user', content: 'Keep the conversation open' }], title: null }] };
  const nextFloor = WorldModel.deserialize(old.station); nextFloor.ensureWorkstation('designer');
  assert.equal(nextFloor.addRoom({ kind: 'factory', name: 'Native artifact room', rect: { x1: 25, y1: 0, x2: 39, y2: 12 } }).ok, true);
  const remote = { ...copy(old), _saveRevision: 4, updatedAt: 4, station: nextFloor.serialize(), dossier: { native: true } };
  remote.agents.push({ ...copy(hero), id: 'designer', name: 'DESIGNER', role: 'specialist', personaId: 'composed' });
  remote.workstreams.push({ id: 'native-task', title: 'Prepare prototype', agentId: 'designer', kind: 'task', lane: 'todo', history: [] });
  const composer = { id: 'chat-input', value: 'An unsent owner prompt', attachments: ['staged-original.png'], offsetParent: {} };
  function element() {
    return { id: '', className: '', style: {}, children: [], textContent: '', setAttribute() {},
      append(...children) { this.children.push(...children); for (const child of children) if (child.id) nodes.set(child.id, child); },
      remove() { nodes.delete(this.id); }, querySelector(selector) { return this.children.find(c => selector === '.' + c.className) || null; } };
  }
  const body = element(), document = { body, activeElement: composer, createElement: element,
    getElementById: id => nodes.get(id) || null, querySelectorAll: () => fields };
  const context = vm.createContext({ console, module: { exports: {} }, require: name => {
    if (name === './cloudsavecore.js') return require('../frontend/app/cloudsavecore.js'); throw new Error('unexpected require');
  }, Date, Promise, Map, Set, AbortController, document, WorldModel, Pipeline, Workstreams, Personas,
    localStorage: { getItem: k => cache.get(k) || null, setItem: (k, v) => cache.set(k, v), removeItem: k => cache.delete(k) },
    setTimeout: fn => { const id = ++timerId; timers.set(id, fn); return id; }, clearTimeout: id => timers.delete(id),
    fetch: async (url, options) => {
      if (options && options.method === 'POST') { telemetry.posts.push({ url, body: options.body }); throw new Error('No write is allowed during read-back'); }
      telemetry.pulls++; if (heldPull) await heldPull;
      return { ok: true, json: async () => ({ save: copy(remote) }) };
    },
    U: { bus: { on: (name, fn) => handlers.set(name, fn) } },
    agents: new Map([['agent', hero]]), agent: hero, station: original, stationSaveQueued: false,
    Build: { isOpen: () => context.editorOpen }, Channels: { busyCount: () => context.runBusy ? 1 : 0 },
    Chat: { isBusy: () => false, beatBusy: () => false, setSystem: text => { context.chatSystem = text; },
      refreshAgentIdentity() {}, load() { throw new Error('COMMS history must not be reloaded'); } },
    StationUI: { setRoster: list => { telemetry.rosterPaints++; telemetry.visibleCrew = list.map(a => a.id); }, refreshBoard() {} },
    DossierStore: { init: opts => { assert.equal(opts.readOnly, true); telemetry.readOnlyDossier++; } },
    el: id => document.getElementById(id), liveAgents: () => [...context.agents.values()],
    executionProfileOf: a => a.executionProfile || 'trusted-project', DATA: { DEFAULT_SKIN: 'o' },
    agentDocs: a => a.docs, composeSystemPrompt: a => a.docs.identity + '\n' + a.docs.manual,
    registerAgent() {}, watchStationSave() {}, renderRail() {}, persist() { throw new Error('Read-back cannot save'); },
    pushRoster() { throw new Error('Read-back cannot write a browser roster'); },
    readingHostStation: false, unsub: null, geo: null, cache: null, geoDirty: true, bakeDirty: false, fitNeeded: false,
    novelty: [], seenProps: null, seenBelts: null, beltWatch: null, clearDeferredShips() {}, dockLineWork: new Map(), activeDock: new Set(),
    watch: null, lineStats: null, hoverBay: null, hoverCrate: null, propFoot: new Map(), pendingMourn: null, agentDecor: [], ownPlaced: new Set(), placeCd: 0,
    crew: [], seizeFromIdle() {}, routingPlan: null, beltLiveSet: null, beltTileSet: null, routeTagCache: null,
    hoverBeltTile: null, selectedRoutingTile: null, routingNags: null, buildRoutingNags: () => [], lineStatsSoon() {}
  });
  vm.runInContext(source('save'), context);
  vm.runInContext(source('cloudsave'), context);
  const cloud = context.module.exports;
  vm.runInContext(posterBlock + '\nthis.planPoster = makePlanPoster({post: () => { throw new Error("Read-back cannot POST routing"); }, warn() {}, delay: setTimeout, cancel: clearTimeout});', context);
  vm.runInContext(routing + compile + loader, context);
  context.rederive = () => { context.geo = context.station.projectGeometry({}); context.compileRouting(); };
  context.World = { loadStation: (station, options) => { telemetry.loads.push(options); context.loadStation(station, options); },
    spawnAgent: agent => telemetry.spawns.push(agent.id) };
  vm.runInContext(roster + refresh + '\nthis.refreshNow = refreshNativeStation;', context);
  return { context, old, remote, cloud, cache, fields, composer, telemetry, timers,
    initialize: async () => { cache.set('starnet.save', JSON.stringify(old));
      const held = copy(remote); Object.assign(remote, copy(old)); await cloud.reconcile(old); Object.assign(remote, held);
      Workstreams.init(copy(old)); },
    event: () => handlers.get('station.native.changed')({ revision: remote._saveRevision }),
    hold: () => { let release; heldPull = new Promise(resolve => { release = resolve; }); return () => { heldPull = null; release(); }; },
    fireTimer: async () => { const timer = [...timers.entries()].find(([id]) => id);
      if (timer) { timers.delete(timer[0]); timer[1](); await tick(); } }
  };
}

(async () => {
  let h = harness(); await h.initialize();
  const stream = Workstreams.active(), history = stream.history, focused = h.context.agent;
  h.event(); await tick();
  assert.equal(h.context.station.rooms().some(r => r.name === 'Native artifact room'), true, 'actual event paints canonical native rooms');
  assert.equal(h.context.agents.has('designer'), true, 'actual native roster is rehydrated through the existing crew engine');
  assert.deepEqual(h.telemetry.visibleCrew, ['agent', 'designer']); assert.ok(h.telemetry.spawns.includes('designer'));
  assert.equal(h.context.routingPlan.hash, Pipeline.compileRoutingPlan(h.context.geo).hash);
  assert.equal(h.telemetry.loads[0].readOnlyHost, true); assert.equal(h.telemetry.posts.length, 0);
  assert.equal(h.cloud.revision(), 4); assert.equal(JSON.parse(h.cache.get('starnet.save'))._saveDirty, false);
  assert.equal(h.context.agent, focused); assert.equal(Workstreams.active(), stream); assert.equal(stream.history, history);
  assert.equal(h.composer.value, 'An unsent owner prompt'); assert.deepEqual(h.composer.attachments, ['staged-original.png']);
  assert.equal(Workstreams.activeId(), 'general'); assert.ok(Workstreams.get('native-task'));
  assert.equal(h.telemetry.readOnlyDossier, 1);
  // A later explicit owner roster edit sends the adopted canonical revision;
  // the refresh itself above never called this browser mutation seam.
  h.context.lastRosterPush = null; h.context.rosterPushFailed = false;
  h.context.stationDefaultWire = () => ({ provider: 'codex' });
  h.context.rosterRole = () => 'commerce specialist'; h.context.rosterTrack = () => '';
  h.context.fetch = async (url, options) => { h.telemetry.posts.push({ url, body: JSON.parse(options.body) }); return { ok: true, json: async () => ({ ok: true }) }; };
  vm.runInContext(between(app, '  function pushRoster(', '  // BACKEND-INITIATED SUMMON'), h.context);
  await h.context.pushRoster();
  assert.equal(h.telemetry.posts[0].url, '/api/roster'); assert.equal(h.telemetry.posts[0].body.floBaseSaveRevision, 4);
  assert.ok(h.telemetry.posts[0].body.agents.some(a => a.agentId === 'designer'));

  h = harness(); await h.initialize(); h.context.editorOpen = true; h.event(); await tick();
  assert.equal(h.telemetry.loads.length, 0); assert.equal(h.context.agents.has('designer'), false);
  const notice = h.context.document.getElementById('native-station-refresh');
  assert.ok(notice); assert.equal(notice.children[1].textContent, 'Refresh station');
  h.context.editorOpen = false; await h.context.refreshNow();
  assert.equal(h.context.agents.has('designer'), true); assert.equal(h.telemetry.posts.length, 0);

  h = harness(); await h.initialize();
  h.fields.push({ id: 'manual-editor', value: 'Do not discard my own edit', dataset: { dirty: '1' }, offsetParent: {} });
  h.event(); await tick(); assert.equal(h.telemetry.loads.length, 0); assert.equal(h.fields[0].value, 'Do not discard my own edit');
  h.fields.length = 0; await h.context.refreshNow(); assert.equal(h.telemetry.loads.length, 1);

  h = harness(); await h.initialize(); const release = h.hold(); h.event(); await tick();
  const edited = copy(h.old); edited._saveDirty = true; edited.agent.name = 'Owner edit while read was in flight';
  h.cache.set('starnet.save', JSON.stringify(edited)); h.cloud.push(edited); release(); await tick();
  assert.equal(h.telemetry.loads.length, 0); assert.equal(h.context.agents.has('designer'), false);
  assert.equal(h.cloud.localSnapshot().agent.name, edited.agent.name); assert.equal(h.cloud.revision(), 1);
  assert.ok(h.context.document.getElementById('native-station-refresh'));

  h = harness(); await h.initialize(); const marker = h.cloud.readMarker();
  const raw = h.cache.get('starnet.save'); h.remote.version = 999;
  assert.throws(() => h.cloud.adoptReadback(h.remote, marker), /safely/); assert.equal(h.cache.get('starnet.save'), raw);
  h.remote.version = 6; h.remote._saveRevision = 0;
  assert.throws(() => h.cloud.adoptReadback(h.remote, marker), /safely/); assert.equal(h.cloud.revision(), 1);

  // Exercise the actual plan-poster's read-back supersession: no retry or late
  // answer can revive an old renderer plan after adopting the durable floor.
  let postResolve, sends = 0, cancelled = 0;
  const makePoster = vm.runInNewContext('(function(){' + posterBlock + ';return makePlanPoster;})()');
  const poster = makePoster({ post: () => { sends++; return new Promise(resolve => { postResolve = resolve; }); },
    warn() {}, delay: () => 1, cancel: () => { cancelled++; } });
  poster.offer({}, 'old-floor'); const waiter = poster.flush(); poster.acceptReadback('native-floor');
  assert.equal((await waiter).lastHash, 'native-floor'); postResolve({ ok: true }); await tick();
  assert.equal(poster.state().lastHash, 'native-floor'); assert.equal(sends, 1); assert.equal(poster.offer({}, 'native-floor'), false);
  console.log('flo-native-refresh: actual event/crew/floor read-back, quiet native routing, draft/focus/history preservation, editor deferral and cache races passed');
})().catch(e => { console.error(e); process.exitCode = 1; });
