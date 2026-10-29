// Carga diaria (GitHub Actions, 07:00 hora de Madrid) de NBA, Liga Endesa (ACB) y Euroliga en Firestore.
//   NBA:      datos públicos de ESPN (calendario, clasificación por conferencias, plantillas y estadísticas por partido)
//   Euroliga: API pública oficial de la Euroliga (api-live.euroleague.net)
//   ACB:      calendario y resultados de acb.com
// Escribe con la cuenta «robot» (secretos ROBOT_EMAIL y ROBOT_PASSWORD). Node 20 o superior, sin dependencias.
// SOLO_PRUEBA=1 lee las fuentes y muestra un resumen sin escribir nada.

import { firestore, loadConfig } from "./importar-resultados.mjs";

const ESPN = "https://site.api.espn.com/apis/site/v2/sports/basketball/nba";
const ESPN2 = "https://site.api.espn.com/apis/v2/sports/basketball/nba";
const EL = "https://api-live.euroleague.net";
const ACB_URL = "https://acb.com/es/liga/calendario";
const UA = { "User-Agent": "CadeteB-app/2.0 (consulta diaria de resultados; uso personal)" };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function get(fetchFn, url, type = "json", tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetchFn(url, { headers: UA });
      if (!r.ok) throw new Error(`HTTP ${r.status} en ${url}`);
      return type === "json" ? await r.json() : await r.text();
    } catch (e) { last = e; await sleep(800 * (i + 1)); }
  }
  throw last;
}
const clean = s => String(s ?? "").replace(/\s+/g, " ").trim();
const num = v => { const n = typeof v === "object" && v !== null ? (v.value ?? v.displayValue) : v; return n === "" || n == null || isNaN(+n) ? null : +n; };

/* ======================= NBA (ESPN) ======================= */
export const nbaSeason = (now = new Date()) => now.getUTCMonth() + 1 >= 8 ? now.getUTCFullYear() + 1 : now.getUTCFullYear();

export function parseStandings(j) {
  const out = { E: [], W: [] }, conf = {};
  for (const ch of j.children || []) {
    const c = /east/i.test(ch.name || ch.abbreviation || "") ? "E" : /west/i.test(ch.name || ch.abbreviation || "") ? "W" : null;
    if (!c) continue;
    for (const e of (ch.standings && ch.standings.entries) || []) {
      const s = {}; for (const x of e.stats || []) s[x.name || x.type] = x;
      const v = k => s[k] ? (s[k].value ?? +s[k].displayValue) : null, dv = k => s[k] ? s[k].displayValue : "";
      const id = String(e.team.id); conf[id] = c;
      out[c].push({ id, seed: v("playoffSeed"), w: v("wins"), l: v("losses"), pct: dv("winPercent"), gb: dv("gamesBehind"),
        racha: dv("streak"), casa: dv("Home") || dv("home"), fuera: dv("Road") || dv("road"), u10: dv("Last Ten Games") || dv("lasttengames") });
    }
    out[c].sort((a, b) => (a.seed ?? 99) - (b.seed ?? 99));
  }
  return { standings: out, conf };
}

export function parseSchedule(j, games) {
  for (const e of j.events || []) {
    const comp = e.competitions && e.competitions[0]; if (!comp) continue;
    const h = comp.competitors.find(c => c.homeAway === "home"), a = comp.competitors.find(c => c.homeAway === "away");
    if (!h || !a) continue;
    const st = comp.status && comp.status.type || e.status && e.status.type || {};
    const fin = st.completed === true || st.state === "post" || /FINAL/.test(st.name || "");
    const sh = num(h.score), sa = num(a.score);
    const ty = (e.seasonType && (e.seasonType.type ?? +e.seasonType.id)) || (e.season && e.season.type) || 2;
    const nota = clean((comp.notes && comp.notes[0] && comp.notes[0].headline) || "");
    games[`e${e.id}`] = { d: e.date || "", ty: +ty || 2, h: String(h.team.id), a: String(a.team.id),
      s: fin && sh != null && sa != null ? [sh, sa] : null, st: fin ? "post" : (st.state || "pre"), ...(nota ? { nota } : {}) };
  }
  return games;
}

// Estadísticas de un partido: { idJugador: {n, t, linea:[pts, reb, tap, fal, min]} }
export function parseBox(j) {
  const out = {};
  for (const team of (j.boxscore && j.boxscore.players) || []) {
    const tid = String(team.team && team.team.id);
    for (const grp of team.statistics || []) {
      const lab = (grp.labels || grp.names || []).map(x => String(x).toUpperCase());
      const ix = k => lab.indexOf(k);
      for (const at of grp.athletes || []) {
        if (at.didNotPlay || !Array.isArray(at.stats) || !at.stats.length) continue;
        const g = k => { const i = ix(k); const n = i < 0 ? null : parseInt(at.stats[i], 10); return Number.isFinite(n) ? n : 0; };
        out[String(at.athlete.id)] = { n: clean(at.athlete.displayName), t: tid, linea: [g("PTS"), g("REB"), g("BLK"), g("PF"), g("MIN")] };
      }
    }
  }
  return out;
}

export function parseRoster(j) {
  return (j.athletes || []).map(a => ({ id: String(a.id), n: clean(a.displayName), num: clean(a.jersey || ""),
    pos: clean(a.position && a.position.abbreviation || ""), pais: clean((a.birthPlace && a.birthPlace.country) || a.citizenship || "") }));
}

export async function importNBA({ fetchFn = fetch, now = new Date(), prev = null, maxBox = 160, pausa = 150, log = console.log } = {}) {
  const season = nbaSeason(now);
  const tj = await get(fetchFn, `${ESPN}/teams`);
  const teams = tj.sports[0].leagues[0].teams.map(x => x.team).map(t => ({ id: String(t.id), ab: clean(t.abbreviation), n: clean(t.displayName), short: clean(t.shortDisplayName || t.name) }));
  const { standings, conf } = parseStandings(await get(fetchFn, `${ESPN2}/standings?season=${season}`));
  teams.forEach(t => { t.conf = conf[t.id] || ""; });
  // Calendario: temporada regular siempre; play-in y playoffs a partir de abril
  const games = {};
  const tipos = [2]; if (now.getUTCMonth() + 1 >= 4 && now.getUTCMonth() + 1 <= 7) tipos.push(5, 3);
  for (const t of teams) for (const ty of tipos) {
    try { parseSchedule(await get(fetchFn, `${ESPN}/teams/${t.id}/schedule?season=${season}&seasontype=${ty}`), games); }
    catch (e) { log(`  aviso: calendario ${t.ab} (${ty}): ${e.message}`); }
    await sleep(pausa);
  }
  // Estadísticas de los partidos terminados que aún no se habían leído
  const hechos = new Set(Object.entries((prev && prev.games) || {}).filter(([, g]) => g && g.b).map(([k]) => k));
  const pend = Object.entries(games).filter(([k, g]) => g.st === "post" && !hechos.has(k)).sort((a, b) => a[1].d.localeCompare(b[1].d)).slice(0, maxBox);
  const jugadores = {};
  for (const [k, g] of pend) {
    try {
      const box = parseBox(await get(fetchFn, `${ESPN}/summary?event=${k.slice(1)}`));
      for (const [pid, x] of Object.entries(box)) {
        const j = jugadores[pid] || (jugadores[pid] = { n: x.n, t: x.t, g: {} });
        j.g[k] = x.linea; j.t = x.t;
      }
      g.b = 1;
    } catch (e) { log(`  aviso: estadísticas del partido ${k}: ${e.message}`); }
    await sleep(pausa);
  }
  for (const [k, g] of Object.entries(games)) if (hechos.has(k)) g.b = 1;
  // Plantillas (para elegir jugadores franquicia y detectar españoles)
  const rosters = {}; const espanolesAuto = [];
  for (const t of teams) {
    try { rosters[t.id] = parseRoster(await get(fetchFn, `${ESPN}/teams/${t.id}/roster`));
      rosters[t.id].forEach(p => { if (/^(spain|españa)$/i.test(p.pais)) espanolesAuto.push(p.id); }); }
    catch (e) { log(`  aviso: plantilla ${t.ab}: ${e.message}`); }
    await sleep(pausa);
  }
  // Datos de plantilla en las fichas de los jugadores con partidos nuevos
  const info = {}; for (const [tid, list] of Object.entries(rosters)) for (const p of list) info[p.id] = { ...p, t: tid };
  for (const [pid, j] of Object.entries(jugadores)) { const r = info[pid]; if (r) Object.assign(j, { num: r.num, pos: r.pos, pais: r.pais, t: r.t }); }
  const nTerm = Object.values(games).filter(g => g.s).length;
  log(`NBA ${season - 1}-${String(season).slice(2)}: ${Object.keys(games).length} partidos (${nTerm} jugados), ${pend.length} estadísticas nuevas, ${Object.keys(jugadores).length} jugadores actualizados, ${espanolesAuto.length} españoles detectados.`);
  return { doc: { season, teams, games, standings }, rosters: { teams: rosters, espanolesAuto }, jugadores };
}

/* ======================= Euroliga (API oficial) ======================= */
export const elSeason = (now = new Date()) => "E" + (now.getUTCMonth() + 1 >= 8 ? now.getUTCFullYear() : now.getUTCFullYear() - 1);

export async function importEL({ fetchFn = fetch, now = new Date(), log = console.log } = {}) {
  const S = elSeason(now);
  const gj = await get(fetchFn, `${EL}/v2/competitions/E/seasons/${S}/games`);
  const list = gj.data || [];
  const teams = {}, games = {};
  for (const g of list) {
    for (const side of [g.local, g.road]) { const c = side && side.club; if (c && c.code) teams[c.code] = { id: c.code, n: clean(c.name), short: clean(c.abbreviatedName || c.editorialName || c.name), ab: clean(c.tvCode || c.code) }; }
    if (!g.local || !g.road) continue;
    const s = g.played ? [num(g.local.score), num(g.road.score)] : null;
    games[`g${g.gameCode}`] = { d: g.utcDate || g.date || "", r: String(g.round ?? ""), j: num(g.round), ph: clean(g.phaseType && g.phaseType.code || "RS"),
      h: g.local.club.code, a: g.road.club.code, s: s && s[0] != null && s[1] != null ? s : null };
  }
  // Clasificación oficial tras la última jornada jugada de la fase regular
  let standings = [];
  const jugadas = list.filter(g => g.played && (g.phaseType && g.phaseType.code || "RS") === "RS").map(g => +g.round).filter(Number.isFinite);
  if (jugadas.length) {
    const r = Math.max(...jugadas);
    try {
      const sj = await get(fetchFn, `${EL}/v3/competitions/E/seasons/${S}/rounds/${r}/basicstandings`);
      standings = (sj.teams || []).map(t => ({ id: t.club.code, pos: num(t.position), w: num(t.gamesWon), l: num(t.gamesLost), pf: num(t.pointsFor), pa: num(t.pointsAgainst) }));
    } catch (e) { log(`  aviso: clasificación de la Euroliga: ${e.message}`); }
  }
  log(`Euroliga ${S}: ${list.length} partidos (${list.filter(g => g.played).length} jugados), clasificación con ${standings.length} equipos.`);
  return { season: S, teams: Object.values(teams), games, standings };
}

/* ======================= ACB (acb.com) ======================= */
const decode = s => String(s).replace(/&amp;/g, "&").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n));
const MES = { enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12 };

export function parseACB(html) {
  const games = {}, teams = {};
  for (const sec of html.split('id="calendar-round-').slice(1)) {
    const titulo = clean(decode((sec.match(/^\d+"[^>]*>\s*<div[^>]*>([^<]+)</) || [])[1] || ""));
    if (!titulo || /XXX/.test(titulo)) continue;                    // bloques de «cargando»
    const jn = (titulo.match(/^Jornada (\d+)$/i) || [])[1];
    let fecha = "";
    for (const p of sec.split(/(?=<h3 class="heading heading--subhead DayTitle)|(?=<div class="RoundMatch-module-scss-module__[A-Za-z0-9_-]+__roundMatch")/)) {
      const dt = p.match(/DayTitle[^>]*>([^<]+)<\/h3>/);
      if (dt) { const m = decode(dt[1]).toLowerCase().match(/(\d{1,2}) de ([a-záéíóú]+) de (\d{4})/);
        if (m && MES[m[2]]) fecha = `${m[3]}-${String(MES[m[2]]).padStart(2, "0")}-${m[1].padStart(2, "0")}`; continue; }
      const eq = [...p.matchAll(/href="\/es\/liga\/equipos\/([a-z0-9-]+?)-(\d+)\?[^"]*"><p[^>]*><span[^>]*--fullName">([^<]+)<\/span><span[^>]*--shortName">([^<]+)<\/span>/g)];
      if (eq.length < 2) continue;
      const sc = [...p.matchAll(/roundMatch__teamScore[^"]*">(\d+)<\/p>/g)].map(m => +m[1]);
      const id = (p.match(/live\.acb\.com\/partidos\/[a-z0-9-]+-(\d+)\//) || [])[1];
      const [h, a] = eq.map(m => ({ id: m[2], n: clean(decode(m[3])), ab: clean(decode(m[4])) }));
      teams[h.id] = { id: h.id, n: h.n, short: h.n, ab: h.ab }; teams[a.id] = { id: a.id, n: a.n, short: a.n, ab: a.ab };
      const key = id ? `a${id}` : `a${titulo.replace(/\W+/g, "")}_${h.id}_${a.id}`;
      games[key] = { r: titulo, j: jn ? +jn : null, d: fecha, h: h.id, a: a.id, s: sc.length === 2 ? sc : null };
    }
  }
  return { teams: Object.values(teams), games };
}

export async function importACB({ fetchFn = fetch, log = console.log } = {}) {
  const r = parseACB(await get(fetchFn, ACB_URL, "text"));
  if (!r.teams.length) throw new Error("No se han encontrado partidos en acb.com (¿ha cambiado la página?).");
  log(`ACB: ${Object.keys(r.games).length} partidos (${Object.values(r.games).filter(g => g.s).length} jugados), ${r.teams.length} equipos.`);
  return r;
}

/* ======================= Programa principal ======================= */
export async function main({ env = process.env, fetchFn = fetch, cfg, log = console.log, now = new Date() } = {}) {
  const prueba = env.SOLO_PRUEBA === "1";
  if (!prueba && (!env.ROBOT_EMAIL || !env.ROBOT_PASSWORD)) throw new Error("Faltan los secretos ROBOT_EMAIL y ROBOT_PASSWORD.");
  let fs = null, prevNba = null;
  if (!prueba) { fs = firestore(cfg || loadConfig(), fetchFn); await fs.login(env.ROBOT_EMAIL, env.ROBOT_PASSWORD);
    try { prevNba = await fs.get("comp/nba"); } catch (e) { log("  aviso: no se ha podido leer comp/nba: " + e.message); } }
  const writes = [], errores = [], ahora = new Date();
  const run = async (nombre, fn) => { try { await fn(); } catch (e) { errores.push(`${nombre}: ${e.message}`); log(`ERROR ${nombre}: ${e.message}`); } };
  await run("NBA", async () => {
    const r = await importNBA({ fetchFn, now, prev: prevNba, log });
    writes.push({ path: "comp/nba", data: { ...r.doc, actualizado: ahora } });
    writes.push({ path: "comp/nba_rosters", data: { ...r.rosters, actualizado: ahora } });
    for (const [pid, j] of Object.entries(r.jugadores)) {
      const data = { n: j.n, t: j.t, num: j.num || "", pos: j.pos || "", pais: j.pais || "", g: j.g };
      writes.push({ path: `nbaj/${pid}`, data, mask: ["n", "t", "num", "pos", "pais", ...Object.keys(j.g).map(k => `g.${k}`)] });
    }
  });
  await run("Euroliga", async () => { const r = await importEL({ fetchFn, now, log }); writes.push({ path: "comp/euroliga", data: { ...r, actualizado: ahora } }); });
  await run("ACB", async () => { const r = await importACB({ fetchFn, log }); writes.push({ path: "comp/acb", data: { ...r, actualizado: ahora } }); });
  if (prueba) { log(`SOLO_PRUEBA=1: se escribirían ${writes.length} documentos.`); }
  else if (writes.length) { await fs.commit(writes); log(`Guardados ${writes.length} documentos en Firestore.`); }
  if (errores.length) throw new Error("Algunas competiciones no se han podido actualizar: " + errores.join(" | "));
  return { writes };
}

if (process.argv[1] && process.argv[1].endsWith("importar-profesional.mjs")) {
  main().catch(e => { console.error("ERROR: " + e.message); process.exit(1); });
}
