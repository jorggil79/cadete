// Carga los resultados oficiales de la Fundación Municipal de Deportes de Valladolid
// (deporteescolar.fmdva.org) en Firestore, documento liga/oficial.
// Lo ejecuta GitHub Actions los miércoles a las 14:00 (ver .github/workflows/resultados.yml).
// Requiere Node 20 o superior. Sin dependencias.
//
// Variables de entorno:
//   ROBOT_EMAIL, ROBOT_PASSWORD  cuenta «robot» de Firebase (secretos de GitHub)
//   DEPORTE, CATEGORIA, GRUPO    opcionales (por defecto Baloncesto / Cadete Masculino / Grupo B)
//   SOLO_PRUEBA=1                lee la web oficial y muestra lo que cargaría, sin escribir nada

import { readFileSync } from "node:fs";

export const CONF = {
  deporte: process.env.DEPORTE || "Baloncesto",
  categoria: process.env.CATEGORIA || "Cadete Masculino",
  grupo: process.env.GRUPO || "Grupo B",
};
const URL_RESULTADOS = d => "https://deporteescolar.fmdva.org/resultados.aspx?d=" + encodeURIComponent(d);
const PAUSA_MS = 800;   // pausa entre peticiones para no cargar la web oficial

/* ---------------- Lectura de la web oficial (ASP.NET WebForms) ---------------- */

const ENT = { amp:"&", lt:"<", gt:">", quot:'"', apos:"'", nbsp:" ", aacute:"á", eacute:"é", iacute:"í", oacute:"ó", uacute:"ú",
  Aacute:"Á", Eacute:"É", Iacute:"Í", Oacute:"Ó", Uacute:"Ú", ntilde:"ñ", Ntilde:"Ñ", uuml:"ü", Uuml:"Ü", ordf:"ª", ordm:"º" };
export const dec = s => String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) =>
  e[0] === "#" ? String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : +e.slice(1)) : (ENT[e] ?? m));

export const norm = s => String(s ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase()
  .replace(/\s*-\s*/g, " - ").replace(/\s+/g, " ").trim();

export function hiddenFields(html) {
  const o = {};
  for (const m of html.matchAll(/<input\b[^>]*type="hidden"[^>]*>/gi)) {
    const name = (m[0].match(/\bname="([^"]*)"/) || [])[1];
    const value = (m[0].match(/\bvalue="([^"]*)"/) || [, ""])[1];
    if (name) o[name] = dec(value);
  }
  return o;
}

// Enlaces de postback de un Repeater (categorías o jornadas)
export function postbackLinks(html, repeater) {
  const re = new RegExp(`__doPostBack\\('(ctl00\\$ContentPlaceHolder1\\$${repeater}\\$ctl\\d+\\$\\w+)',''\\)"[^>]*>([^<]+)</a>`, "g");
  return [...dec(html).matchAll(re)].map(m => ({ target: m[1], text: m[2].trim() }));
}

export const pageTitle = html => dec((html.match(/LBTitulo">([^<]*)</) || [, ""])[1]).trim();

// Grupos y partidos de la página de una jornada
export function parseGroups(html) {
  const out = [];
  for (const part of html.split(/<span id="ctl00_ContentPlaceHolder1_RepeaterGrupos_ctl\d+_LBGrupo">/).slice(1)) {
    const grupo = dec(part.slice(0, part.indexOf("<"))).trim();
    const rows = [];
    for (const tr of part.split(/<tr\b[^>]*>/i).slice(1)) {
      const g = k => { const m = tr.match(new RegExp(`_LB${k}"[^>]*>([^<]*)<`)); return m ? dec(m[1]).trim() : null; };
      if (g("Local") == null || g("Visitante") == null) continue;
      rows.push({ fecha: g("Fecha"), hora: g("Hora"), jornada: g("Jornada"), local: g("Local"),
        rl: g("ResultadoLocal"), rv: g("ResultadoVisitante"), visitante: g("Visitante") });
    }
    out.push({ grupo, rows });
  }
  return out;
}

const MESES = { ene:1, feb:2, mar:3, abr:4, may:5, jun:6, jul:7, ago:8, sep:9, sept:9, set:9, oct:10, nov:11, dic:12 };
export function isoDate(s) {   // "07 feb. 2026" → "2026-02-07"
  const m = String(s || "").toLowerCase().match(/(\d{1,2})\s+([a-zñ]+)\.?\s+(\d{4})/);
  if (!m || !MESES[m[2]]) return "";
  return `${m[3]}-${String(MESES[m[2]]).padStart(2, "0")}-${m[1].padStart(2, "0")}`;
}

function makeHttp() {
  const cookies = {};
  return async function http(url, opts = {}) {
    const headers = { "User-Agent": "CadeteB-resultados/1.0 (consulta semanal de resultados)", ...(opts.headers || {}) };
    const ck = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ");
    if (ck) headers.Cookie = ck;
    const res = await fetch(url, { ...opts, headers, redirect: "follow" });
    for (const c of (res.headers.getSetCookie ? res.headers.getSetCookie() : [])) {
      const kv = c.split(";")[0], i = kv.indexOf("=");
      if (i > 0) cookies[kv.slice(0, i).trim()] = kv.slice(i + 1);
    }
    if (!res.ok) throw new Error(`La web oficial respondió ${res.status} (${url})`);
    return res.text();
  };
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Recorre todas las jornadas publicadas y devuelve los partidos del grupo
export async function scrape({ http = makeHttp(), conf = CONF, pausa = PAUSA_MS } = {}) {
  const url = URL_RESULTADOS(conf.deporte);
  const post = (state, target) => http(url, { method: "POST",
    body: new URLSearchParams({ ...hiddenFields(state), __EVENTTARGET: target, __EVENTARGUMENT: "" }) });
  const inicio = await http(url);
  const cats = postbackLinks(inicio, "RepeaterCategorias");
  const cat = cats.find(c => norm(c.text) === norm(conf.categoria));
  if (!cat) return { rows: [], semanas: 0,
    aviso: `La categoría «${conf.categoria}» todavía no aparece en la web oficial (hay: ${cats.map(c => c.text).join(", ") || "ninguna"}).` };
  await sleep(pausa);
  const catPage = await post(inicio, cat.target);
  if (!norm(pageTitle(catPage)).includes(norm(conf.categoria))) throw new Error("No se ha podido seleccionar la categoría en la web oficial.");
  const semanas = postbackLinks(catPage, "RepeaterJornadas");
  const porPartido = new Map();
  for (const s of semanas) {
    await sleep(pausa);
    const page = await post(catPage, s.target);
    for (const g of parseGroups(page)) {
      if (norm(g.grupo) !== norm(conf.grupo)) continue;
      for (const r of g.rows) {
        const k = norm(r.local) + "|" + norm(r.visitante) + "|" + r.jornada;
        const conRes = /^\d+$/.test(r.rl || "") && /^\d+$/.test(r.rv || "");
        if (!porPartido.has(k) || conRes) porPartido.set(k, { ...r, semana: s.text });
      }
    }
  }
  return { rows: [...porPartido.values()], semanas: semanas.length };
}

/* ---------------- Emparejar con el calendario de la app ---------------- */

export function emparejar(rows, liga) {
  const porNombre = new Map((liga.teams || []).map(t => [norm(t.n), t.id]));
  const partidos = Object.entries(liga.matches || {}).map(([id, m]) => ({ id, ...m }));
  const updates = {}, avisos = [];
  // Solo partidos de esta temporada: la web oficial mantiene los de la anterior hasta que publica los nuevos
  const fechas = partidos.map(m => m.d).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d || "")).sort();
  const desde = fechas.length ? new Date(Date.parse(fechas[0]) - 45 * 864e5).toISOString().slice(0, 10) : "";
  let ignorados = 0;
  for (const r of rows) {
    if (!/^\d+$/.test(r.rl || "") || !/^\d+$/.test(r.rv || "")) continue;   // sin resultado todavía
    const fecha = isoDate(r.fecha);
    if (desde && (!fecha || fecha < desde)) { ignorados++; continue; }
    const hl = porNombre.get(norm(r.local)), hv = porNombre.get(norm(r.visitante));
    if (!hl || !hv) {
      for (const [n, id] of [[r.local, hl], [r.visitante, hv]]) if (!id) avisos.push(`Equipo no reconocido: «${n}»`);
      continue;
    }
    const cand = partidos.filter(m => (m.h === hl && m.a === hv) || (m.h === hv && m.a === hl));
    if (!cand.length) { avisos.push(`Partido no encontrado en el calendario: ${r.local} - ${r.visitante}`); continue; }
    const mismaJ = cand.find(x => String(x.j) === String(r.jornada));
    const m = mismaJ || cand[0];
    // Si el mismo partido aparece dos veces (p. ej. en otra fase), manda el de la misma jornada
    if (updates[m.id] && (!mismaJ || updates[m.id].j === +m.j)) continue;
    const a = +r.rl, b = +r.rv, igual = m.h === hl;
    updates[m.id] = { s: igual ? [a, b] : [b, a], d: fecha, h: r.hora || "",
      j: /^\d+$/.test(r.jornada || "") ? +r.jornada : null,
      posibleNP: (a === 20 && b === 0) || (a === 0 && b === 20) };
  }
  return { updates, avisos: [...new Set(avisos)].slice(0, 50), ignorados };
}

/* ---------------- Firebase (REST, con la cuenta robot) ---------------- */

export function loadConfig(path = new URL("./config.js", import.meta.url)) {
  const txt = readFileSync(path, "utf8").replace(/export\s+const\s+/g, "const ");
  return new Function(txt + "\nreturn { firebaseConfig };")().firebaseConfig;
}

export function toFs(x) {
  if (x === null || x === undefined) return { nullValue: null };
  if (typeof x === "string") return { stringValue: x };
  if (typeof x === "boolean") return { booleanValue: x };
  if (typeof x === "number") return Number.isInteger(x) ? { integerValue: String(x) } : { doubleValue: x };
  if (x instanceof Date) return { timestampValue: x.toISOString() };
  if (Array.isArray(x)) return { arrayValue: { values: x.map(toFs) } };
  return { mapValue: { fields: Object.fromEntries(Object.entries(x).map(([k, v]) => [k, toFs(v)])) } };
}
export function fromFs(v) {
  if (!v || "nullValue" in v) return null;
  if ("stringValue" in v) return v.stringValue;
  if ("integerValue" in v) return Number(v.integerValue);
  if ("doubleValue" in v) return v.doubleValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("timestampValue" in v) return v.timestampValue;
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(fromFs);
  if ("mapValue" in v) return Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, fromFs(x)]));
  return null;
}

export function firestore(cfg, fetchFn = fetch) {
  const base = `https://firestore.googleapis.com/v1/projects/${cfg.projectId}/databases/(default)/documents`;
  let token = null;
  return {
    async login(email, password) {
      const r = await fetchFn(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${cfg.apiKey}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password, returnSecureToken: true }) });
      const j = await r.json();
      if (!r.ok) throw new Error("No se ha podido iniciar sesión con la cuenta robot: " + (j.error?.message || r.status));
      token = j.idToken;
    },
    async get(path) {
      const r = await fetchFn(`${base}/${path}`, { headers: { Authorization: `Bearer ${token}` } });
      if (r.status === 404) return null;
      const j = await r.json();
      if (!r.ok) throw new Error(`No se ha podido leer ${path}: ${j.error?.message || r.status}`);
      return fromFs({ mapValue: { fields: j.fields || {} } });
    },
    // Escrituras en lote (máx. 500 por llamada). w = {path, data, mask?}; sin mask se reemplaza el documento entero.
    async commit(writes) {
      for (let i = 0; i < writes.length; i += 400) {
        const body = { writes: writes.slice(i, i + 400).map(w => ({
          update: { name: `projects/${cfg.projectId}/databases/(default)/documents/${w.path}`, fields: toFs(w.data).mapValue.fields },
          ...(w.mask ? { updateMask: { fieldPaths: w.mask } } : {}) })) };
        const r = await fetchFn(`${base}:commit`, { method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });
        if (!r.ok) throw new Error(`No se ha podido guardar el lote: ${r.status} ${await r.text()}`);
      }
    },
    async patch(path, data, fieldPaths) {
      const qs = fieldPaths.map(f => "updateMask.fieldPaths=" + encodeURIComponent(f)).join("&");
      const r = await fetchFn(`${base}/${path}?${qs}`, { method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ fields: toFs(data).mapValue.fields }) });
      if (!r.ok) throw new Error(`No se ha podido guardar ${path}: ${r.status} ${await r.text()}`);
    },
  };
}

/* ---------------- Programa principal ---------------- */

export async function main({ env = process.env, fetchFn = fetch, http, cfg, log = console.log } = {}) {
  const prueba = env.SOLO_PRUEBA === "1";
  if (!prueba && (!env.ROBOT_EMAIL || !env.ROBOT_PASSWORD)) throw new Error("Faltan los secretos ROBOT_EMAIL y ROBOT_PASSWORD (GitHub → Settings → Secrets and variables → Actions).");
  const res = await scrape({ http });
  log(`Web oficial: ${res.semanas} jornadas revisadas, ${res.rows.length} partidos de ${CONF.categoria} ${CONF.grupo}.`);
  if (res.aviso) log("Aviso: " + res.aviso);
  if (prueba && !env.ROBOT_EMAIL) { for (const r of res.rows) log(`  J${r.jornada} ${r.fecha} ${r.local} ${r.rl ?? ""}-${r.rv ?? ""} ${r.visitante}`); return { res }; }

  if (!env.ROBOT_EMAIL || !env.ROBOT_PASSWORD) throw new Error("Faltan los secretos ROBOT_EMAIL y ROBOT_PASSWORD.");
  const fs = firestore(cfg || loadConfig(), fetchFn);
  await fs.login(env.ROBOT_EMAIL, env.ROBOT_PASSWORD);
  const liga = await fs.get("liga/principal");
  if (!liga) throw new Error("La liga todavía no está creada en la app (entra como administrador y pulsa «Crear liga»).");
  const { updates, avisos, ignorados } = emparejar(res.rows, liga);
  if (res.aviso) avisos.unshift(res.aviso);
  const n = Object.keys(updates).length;
  if (ignorados) log(`Ignorados ${ignorados} partidos de una temporada anterior.`);
  log(`Resultados oficiales emparejados: ${n}.` + (avisos.length ? ` Avisos: ${avisos.length}.` : ""));
  avisos.forEach(a => log("  - " + a));
  if (prueba) { log("SOLO_PRUEBA=1: no se escribe nada."); return { res, updates, avisos }; }

  const data = { ...(n ? { matches: updates } : {}), avisos, fuente: URL_RESULTADOS(CONF.deporte),
    ejecucion: { fecha: new Date(), partidos: res.rows.length, cargados: n, semanas: res.semanas } };
  await fs.patch("liga/oficial", data, [...Object.keys(updates).map(id => `matches.${id}`), "avisos", "fuente", "ejecucion"]);
  log("Guardado en Firestore (liga/oficial).");
  return { res, updates, avisos };
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("importar-resultados.mjs")) {
  main().catch(e => { console.error("ERROR: " + e.message); process.exit(1); });
}
