// Libro de Actas · Fundación PROINPA
// App estática: la base de datos y la IA viven en Supabase (proyecto Disruptivo 360, esquema actas_proinpa),
// detrás de la función «actas-proinpa». Aquí solo hay interfaz, grabación y lectura de documentos.
(() => {
"use strict";
const SUPABASE_URL = "https://iukpczwjmihchpdrupty.supabase.co";
const SUPABASE_KEY = "sb_publishable_9hlGlsj4yIV5aJtN3dQ4Ow_7Gf-bIE5"; // clave pública (publishable)
const FN = SUPABASE_URL + "/functions/v1/actas-proinpa";
const BUCKET = "actas-proinpa";
const MAX_MS = 3 * 60 * 60 * 1000;   // 3 horas por reunión
const SEG_MS = 2 * 60 * 1000;        // tramos de audio de 2 minutos
const KEY = "actasP.actual.v2";
const AREAS = { directorio: "Reuniones de directorio", asambleas: "Reuniones de asambleas", cursos: "Cursos o talleres" };
const AREA_TIPO = { directorio: "Reunión de Directorio", asambleas: "Asamblea General Ordinaria", cursos: "Taller" };
const areaFromTipo = t => /directorio|socios/i.test(t || "") ? "directorio" : /curso|taller/i.test(t || "") ? "cursos" : "asambleas";

const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fmt = ms => { const s = Math.floor(ms / 1000); return [s / 3600 | 0, (s % 3600) / 60 | 0, s % 60].map(n => String(n).padStart(2, "0")).join(":"); };
const today = () => { const d = new Date(); return new Date(d - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10); };
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : "10000000-1000-4000-8000-100000000000".replace(/[018]/g, c => (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)));
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
};
function toast(msg) { const t = $("toast"); t.textContent = msg; t.classList.add("show"); clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove("show"), 2800); }
// Usuario simple (c.aparicio) → cuenta interna de la app (c.aparicio@actas-proinpa.app)
const DOMINIO = "actas-proinpa.app";
const aEmail = u => { u = String(u || "").trim().toLowerCase(); return !u ? "" : u.includes("@") ? u : u + "@" + DOMINIO; };
const aUsuario = e => String(e || "").endsWith("@" + DOMINIO) ? e.slice(0, -DOMINIO.length - 1) : e;
function longDate(iso) { if (!iso) return "No consta"; const d = new Date(iso + "T12:00:00"); return isNaN(d) ? iso : d.toLocaleDateString("es-BO", { weekday: "long", day: "numeric", month: "long", year: "numeric" }); }

/* =========================================================
   Sesión y servidor
   ========================================================= */
let sb = null, YO = null;
async function api(accion, body = {}) {
  const { data } = await sb.auth.getSession();
  const token = data?.session?.access_token;
  if (!token) { showLogin("Tu sesión venció. Vuelve a entrar."); throw new Error("sin sesión"); }
  const res = await fetch(FN, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + token, apikey: SUPABASE_KEY },
    body: JSON.stringify({ accion, ...body }),
  });
  let j = {}; try { j = await res.json(); } catch {}
  if (res.status === 401) { showLogin(j.error || "Tu sesión venció. Vuelve a entrar."); throw new Error(j.error || "sin acceso"); }
  if (!res.ok) throw new Error(j.error || "Error del servidor (" + res.status + ")");
  return j;
}
function showLogin(msg) {
  $("login").hidden = false; $("app").hidden = true;
  $("loginMsg").textContent = msg || ""; $("loginMsg").className = "msg" + (msg ? " err" : "");
  $("loginBtn").disabled = false;
}
async function enter() {
  try {
    YO = await api("yo");
  } catch (e) {
    await sb.auth.signOut().catch(() => {});
    showLogin(e.message === "sin sesión" ? "" : (e.message || "No tienes acceso a esta app."));
    return;
  }
  $("login").hidden = true; $("app").hidden = false;
  $("whoLine").textContent = YO.nombre + " · Fundación PROINPA";
  $("usersBtn").hidden = YO.rol !== "admin";
  if (!S.meta.preside) S.meta.preside = YO.nombre;
  renderAll(); loadHist(); syncSoon(500); drainQueue();
  if (S.recording) {
    showRecover("Se recuperó una grabación", `La app se cerró mientras grababas. Se recuperaron ${fmt(S.elapsed)} y ${S.segs.length} fragmentos. Toca Reanudar para seguir en el mismo registro.`);
    setState("paused", "Recuperado · en pausa");
  }
}
$("loginForm").addEventListener("submit", async e => {
  e.preventDefault();
  const email = aEmail($("l-email").value), password = $("l-pass").value;
  if (!email || !password) { $("loginMsg").textContent = "Escribe tu usuario y tu contraseña."; $("loginMsg").className = "msg err"; return; }
  $("loginBtn").disabled = true; $("loginMsg").className = "msg"; $("loginMsg").textContent = "Entrando…";
  const { error } = await sb.auth.signInWithPassword({ email, password });
  if (error) { showLogin(/invalid/i.test(error.message) ? "Usuario o contraseña incorrectos." : error.message); return; }
  $("l-pass").value = "";
  enter();
});
$("logoutBtn").onclick = async () => {
  if (live) { toast("Detén la grabación antes de salir."); return; }
  await flushSave(); await sb.auth.signOut().catch(() => {}); YO = null; showLogin("");
};

/* =========================================================
   Estado de la reunión (copia local + servidor)
   ========================================================= */
function blank() {
  return {
    id: uid(), area: "asambleas", estado: "borrador", created: false, recording: false,
    elapsed: 0, segs: [], acta: null, acta_html: null, docs: [], audioN: 0, audios: [],
    meta: { tipo: "Asamblea General Ordinaria", entidad: "", fecha: today(), hora: "", lugar: "", preside: YO ? YO.nombre : "", secretario: "", convocatoria: "Primera convocatoria", total: "", regla: "simple" },
    people: [], agenda: [],
  };
}
let S = store.get(KEY, null) || blank();
const isCurso = () => S.area === "cursos";
let dirty = false, saveTimer = null, saving = null;

function saveLocal() {
  const ok = store.set(KEY, S);
  if (!ok) setSaveState("No se pudo guardar en este celular", "var(--rec)");
}
function setSaveState(txt, col) { const el = $("saveState"); el.querySelector("span").textContent = txt; el.querySelector("i").style.background = col; }
function save(now) { saveLocal(); if (!S.created) return; dirty = true; syncSoon(now ? 0 : 4000); }
function syncSoon(ms) { clearTimeout(saveTimer); saveTimer = setTimeout(syncServer, ms); }
const payload = s => ({
  id: s.id, area: s.area, estado: s.estado, meta: s.meta, asistentes: s.people, orden: s.agenda,
  segmentos: s.segs, duracion_ms: Math.round(s.elapsed), acta: s.acta, acta_html: s.acta_html,
});
async function syncServer() {
  if (!YO || !S.created || !dirty) return;
  if (YO.rol === "lector") { dirty = false; return; }
  if (saving) { syncSoon(1500); return; }
  dirty = false;
  saving = api("guardar", { r: payload(S) }).then(() => {
    setSaveState("Guardado en el servidor " + new Date().toLocaleTimeString("es-BO", { hour: "2-digit", minute: "2-digit" }), "var(--ok)");
  }).catch(e => {
    dirty = true; setSaveState("Sin conexión · guardado en el celular", "var(--warn)"); syncSoon(15000);
    console.warn(e);
  }).finally(() => { saving = null; });
  await saving;
}
async function flushSave() { if (live) S.elapsed = curElapsed(); saveLocal(); if (S.created) { dirty = true; await syncServer(); } }
document.addEventListener("visibilitychange", () => { if (document.hidden) { flushSave(); } else if (live) { renderClock(); renderTranscript(); restartRecognition(); } });
window.addEventListener("pagehide", () => { if (live) S.elapsed = curElapsed(); saveLocal(); });
window.addEventListener("online", () => { syncSoon(500); drainQueue(); });

/* =========================================================
   Pestañas
   ========================================================= */
document.querySelectorAll("nav button").forEach(b => b.addEventListener("click", () => showTab(b.dataset.tab)));
function showTab(name) {
  document.querySelectorAll("nav button").forEach(b => b.setAttribute("aria-selected", b.dataset.tab === name));
  ["grabar", "reunion", "acta"].forEach(n => { const v = $("v-" + n); v.hidden = n !== name; v.style.display = n === name ? "grid" : "none"; });
  if (name === "acta") loadHist();
}

/* =========================================================
   Grabación: micrófono en tramos + reconocimiento de voz en vivo
   ========================================================= */
let live = false, userStop = false, startedAt = 0, partial = "", tick = null;
let stream = null, rec = null, segStart = 0, segTimer = null, recog = null;
const curElapsed = () => live ? S.elapsed + (Date.now() - startedAt) : S.elapsed;
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const canRecord = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);
function pickMime() {
  const c = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4;codecs=mp4a.40.2", "audio/mp4", "audio/ogg;codecs=opus"];
  return c.find(t => { try { return MediaRecorder.isTypeSupported(t); } catch { return false; } }) || "";
}

function renderClock() {
  const e = Math.min(curElapsed(), MAX_MS);
  $("clock").textContent = fmt(e);
  $("capBar").style.width = (e / MAX_MS * 100).toFixed(2) + "%";
  $("capText").textContent = "Restan " + fmt(MAX_MS - e) + " de 3:00:00";
  if (live && e >= MAX_MS) { stopRec(); toast("Se alcanzó el límite de 3 horas. Grabación guardada."); }
}
function setState(kind, label) {
  const c = $("stateChip"); c.className = "state " + (kind || ""); c.textContent = label;
  const b = $("recBtn"); b.classList.toggle("on", kind === "live");
  b.textContent = kind === "live" ? "DETENER" : (S.segs.length || S.audioN ? "REANUDAR" : "GRABAR");
  b.setAttribute("aria-label", kind === "live" ? "Detener grabación" : "Iniciar grabación");
  $("markBtn").disabled = kind !== "live";
}

async function startRec() {
  if (!canRecord) { $("micBanner").hidden = false; return; }
  if (YO && YO.rol === "lector") { toast("Tu cuenta es de solo lectura."); return; }
  if (S.elapsed >= MAX_MS) { toast("Esta reunión ya usó las 3 horas. Crea una nueva."); return; }
  userStop = false;
  setState("paused", "Conectando micrófono…");
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 } });
  } catch (e) {
    setState("", "Listo para grabar");
    toast(e && e.name === "NotAllowedError" ? "Sin permiso de micrófono. Actívalo en la configuración del navegador." : "No se pudo abrir el micrófono.");
    return;
  }
  stream.getAudioTracks().forEach(t => t.addEventListener("ended", () => { if (live) interrupted("El micrófono se desconectó (llamada u otra app)."); }));
  live = true; startedAt = Date.now(); S.recording = true; S.estado = "grabando";
  if (!S.created) { S.created = true; }
  save(true);
  $("recoverBanner").hidden = true;
  setState("live", "Grabando");
  startSegment();
  startRecognition();
  clearInterval(tick); tick = setInterval(() => { if (!document.hidden) renderClock(); else if (curElapsed() >= MAX_MS) renderClock(); }, 1000);
  renderAudioLine();
}
function startSegment() {
  if (!live || !stream) return;
  const mime = pickMime();
  try { rec = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 32000 } : { audioBitsPerSecond: 32000 }); }
  catch { rec = new MediaRecorder(stream); }
  const chunks = [], n = S.audioN++, inicio = Math.round(curElapsed()), t0 = Date.now(), reunion = S.id;
  segStart = t0;
  rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
  rec.onstop = () => {
    const blob = new Blob(chunks, { type: (rec && rec.mimeType) || mime || "audio/webm" });
    if (blob.size > 1000) enqueueAudio({ reunion, n, inicio, dur: Date.now() - t0, blob });
    save();
    if (live) startSegment();
  };
  rec.onerror = () => { if (live) interrupted("La grabadora del navegador se detuvo."); };
  rec.start(10000); // pide datos cada 10 s: si la app se cierra, se pierde como máximo eso
  clearTimeout(segTimer); segTimer = setTimeout(() => { try { if (rec && rec.state === "recording") rec.stop(); } catch {} }, SEG_MS);
}
function startRecognition() {
  if (!SR || recog) return;
  try {
    recog = new SR(); recog.lang = "es-BO"; recog.continuous = true; recog.interimResults = true;
    recog.onresult = ev => {
      let interim = "";
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const r = ev.results[i];
        if (r.isFinal) { partial = ""; if (!YO || !YO.stt) appendText(r[0].transcript); }
        else interim += r[0].transcript;
      }
      partial = interim; if (!document.hidden) renderTranscript();
    };
    recog.onerror = e => { if (e.error === "not-allowed" || e.error === "service-not-allowed") { recog = null; } };
    recog.onend = () => { recog = null; if (live && !document.hidden) setTimeout(startRecognition, 300); };
    recog.start();
  } catch { recog = null; }
}
function restartRecognition() { if (live && !recog) startRecognition(); }
function stopRecognition() { const r = recog; recog = null; if (r) { r.onend = null; try { r.stop(); } catch {} } }
function finishRun() {
  if (live) { S.elapsed = Math.min(curElapsed(), MAX_MS); live = false; }
  clearTimeout(segTimer);
  try { if (rec && rec.state !== "inactive") rec.stop(); } catch {}
  stopRecognition();
  if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
  if (partial.trim() && (!YO || !YO.stt)) appendText(partial);
  partial = "";
  clearInterval(tick); tick = null;
  renderClock(); renderTranscript();
}
async function stopRec() {
  userStop = true; finishRun();
  S.recording = false; S.estado = "borrador"; save(true);
  setState("", "Grabación detenida y guardada");
}
function interrupted(why) {
  if (!live) return;
  finishRun(); S.recording = true; save(true);
  showRecover("Grabación en pausa", why + " Lo grabado hasta " + fmt(S.elapsed) + " está guardado. Toca Reanudar para continuar en el mismo registro.");
  setState("paused", "En pausa · guardado");
}
function showRecover(title, text) { $("recoverTitle").textContent = title; $("recoverText").textContent = text; $("recoverBanner").hidden = false; }
function appendText(text, t) {
  text = String(text || "").trim(); if (!text) return;
  t = t ?? Math.min(curElapsed(), MAX_MS);
  const last = S.segs[S.segs.length - 1];
  if (last && !last.mark && last.a == null && t - last.t < 30000 && last.x.length < 600 && t >= last.t) last.x += " " + text;
  else S.segs.push({ t, x: text });
  save();
}
$("recBtn").addEventListener("click", () => {
  if (live) return stopRec();
  if (!S.created) return openCreate();
  startRec();
});
$("resumeBtn").addEventListener("click", () => { $("recoverBanner").hidden = true; startRec(); });
$("dismissRecover").addEventListener("click", () => { $("recoverBanner").hidden = true; S.recording = false; S.estado = "borrador"; save(); });
$("markBtn").addEventListener("click", () => {
  const n = S.segs.filter(s => s.mark && !s.imp).length + 1;
  const label = S.agenda[n - 1] ? "Punto " + n + ": " + S.agenda[n - 1] : "Punto " + n + " del orden del día";
  S.segs.push({ t: Math.round(curElapsed()), x: "— " + label + " —", mark: true }); save(); renderTranscript();
});

/* ---------- cola de audio: IndexedDB → servidor ---------- */
let idb = null;
function openIdb() {
  if (idb) return Promise.resolve(idb);
  return new Promise(res => {
    try {
      const r = indexedDB.open("actasP-audio", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("q", { keyPath: "k" });
      r.onsuccess = () => { idb = r.result; res(idb); };
      r.onerror = () => res(null);
    } catch { res(null); }
  });
}
async function idbDo(mode, fn) {
  const db = await openIdb(); if (!db) return null;
  return new Promise(res => { const tx = db.transaction("q", mode); const st = tx.objectStore("q"); const r = fn(st); tx.oncomplete = () => res(r && r.result); tx.onerror = () => res(null); });
}
const memQueue = [];
async function enqueueAudio(item) {
  item.k = item.reunion + ":" + item.n;
  const ok = await idbDo("readwrite", st => st.put(item));
  if (ok === null) memQueue.push(item);
  S.audios = S.audios || []; if (!S.audios.find(a => a.n === item.n)) S.audios.push({ n: item.n, inicio_ms: item.inicio, dur_ms: item.dur, transcrito: false, subido: false });
  renderAudioLine(); drainQueue();
}
let draining = false;
async function drainQueue() {
  if (draining || !YO || !navigator.onLine) return;
  draining = true;
  try {
    const items = (await idbDo("readonly", st => st.getAll())) || [];
    for (const it of [...items, ...memQueue.splice(0)]) {
      try {
        const u = await api("audio_url", { reunion_id: it.reunion, n: it.n, tipo: it.blob.type, inicio_ms: it.inicio, dur_ms: it.dur, bytes: it.blob.size });
        const { error } = await sb.storage.from(BUCKET).uploadToSignedUrl(u.path, u.token, it.blob, { contentType: (it.blob.type || "audio/webm").split(";")[0], upsert: true });
        if (error) throw error;
        await idbDo("readwrite", st => st.delete(it.k));
        if (it.reunion === S.id) { const a = (S.audios || []).find(x => x.n === it.n); if (a) a.subido = true; }
        if (YO.stt && it.reunion === S.id) await transcribeOne(it.n, it.inicio);
      } catch (e) { console.warn("audio pendiente", e); if (!idb) memQueue.push(it); break; }
    }
  } finally { draining = false; renderAudioLine(); }
}
async function transcribeOne(n, inicio) {
  try {
    const r = await api("transcribir", { reunion_id: S.id, n });
    if (r.stt && r.texto) {
      const t = r.inicio_ms ?? inicio;
      S.segs = S.segs.filter(s => s.a !== n);
      S.segs.push({ t, x: r.texto, a: n });
      S.segs.sort((x, y) => x.t - y.t);
      const a = (S.audios || []).find(x => x.n === n); if (a) a.transcrito = true;
      save(); if (!document.hidden) renderTranscript();
    }
  } catch (e) { console.warn("transcripción", e); }
}
async function renderAudioLine() {
  const pend = ((await idbDo("readonly", st => st.count())) || 0) + memQueue.length;
  const total = S.audioN || 0;
  $("audioLine").textContent = total ? `Audio: ${total} tramo${total === 1 ? "" : "s"} grabado${total === 1 ? "" : "s"}${pend ? ` · ${pend} esperando conexión para subir` : " · todo subido al servidor"}` : "";
  const sinTexto = (S.audios || []).filter(a => !a.transcrito).length;
  $("audioTools").hidden = !(YO && YO.stt && sinTexto && !live);
}
$("transcribeBtn").onclick = async () => {
  const p = $("sttProg"); p.hidden = false;
  const lista = (S.audios || []).filter(a => !a.transcrito);
  for (let i = 0; i < lista.length; i++) { p.textContent = `Transcribiendo tramo ${i + 1} de ${lista.length}…`; await transcribeOne(lista[i].n, lista[i].inicio_ms); }
  p.textContent = "Listo."; renderAudioLine();
};

/* =========================================================
   Transcripción e importación
   ========================================================= */
function renderTranscript() {
  const box = $("transcript");
  if (!S.segs.length && !partial) { box.innerHTML = '<div class="empty">Aún no hay nada grabado. Toca GRABAR o importa una transcripción.</div>'; $("wordCount").textContent = "0 palabras"; return; }
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  box.innerHTML = S.segs.map(s => `<div class="seg"><time>${fmt(s.t)}</time><p${s.mark ? ' style="font-weight:600;color:var(--seal)"' : ""}>${esc(s.x)}</p></div>`).join("")
    + (partial ? `<div class="seg"><time>${fmt(curElapsed())}</time><p class="partial">${esc(partial)}${YO && YO.stt ? " · vista previa" : ""}</p></div>` : "");
  if (atBottom || live) box.scrollTop = box.scrollHeight;
  const words = S.segs.reduce((n, s) => n + s.x.split(/\s+/).filter(Boolean).length, 0);
  $("wordCount").textContent = words.toLocaleString("es-BO") + " palabras";
}
function cleanSubs(txt) {
  return txt.replace(/^WEBVTT.*$/m, "").split(/\r?\n/)
    .filter(l => !/^\d+$/.test(l.trim()) && !/-->/.test(l) && !/^(NOTE|STYLE)/.test(l.trim()))
    .join(" ").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}
function importText(txt, label) {
  txt = cleanSubs(txt); if (!txt) { toast("El texto está vacío."); return; }
  if (!S.created) { toast("Primero crea la reunión."); openCreate(); return; }
  const t = Math.round(curElapsed());
  const parts = txt.match(/[^.!?]+[.!?]*\s*/g) || [txt]; let buf = "";
  S.segs.push({ t, x: "— Importado: " + label + " —", mark: true, imp: true });
  parts.forEach(p => { buf += p; if (buf.length > 500) { S.segs.push({ t, x: buf.trim() }); buf = ""; } });
  if (buf.trim()) S.segs.push({ t, x: buf.trim() });
  save(true); renderTranscript(); toast("Transcripción añadida al registro.");
}
$("fileIn").addEventListener("change", e => {
  const f = e.target.files[0]; if (!f) return;
  const r = new FileReader(); r.onload = () => importText(String(r.result), f.name); r.readAsText(f); e.target.value = "";
});
$("pasteBtn").addEventListener("click", () => { importText($("pasteIn").value, "texto pegado"); $("pasteIn").value = ""; });

/* =========================================================
   Datos de la reunión, quórum, asistentes, orden del día
   ========================================================= */
const metaFields = ["tipo", "entidad", "fecha", "hora", "lugar", "preside", "secretario", "convocatoria", "total", "regla"];
function renderMeta() {
  metaFields.forEach(f => { const el = $("m-" + f); if (el) el.value = S.meta[f] ?? ""; });
  $("m-area").value = S.area;
  $("quorumCard").hidden = isCurso();
  $("archBtn").textContent = "Enviar a " + AREAS[S.area];
  $("genBtn").textContent = isCurso() ? "Generar informe del curso o taller" : "Generar acta de la reunión";
}
metaFields.forEach(f => $("m-" + f).addEventListener("input", e => { S.meta[f] = e.target.value; save(); renderQuorum(); renderCtx(); }));
$("m-area").addEventListener("change", e => { S.area = e.target.value; save(true); renderMeta(); renderCtx(); toast("El historial irá a " + AREAS[S.area] + "."); });

function quorum() {
  const presentes = S.people.filter(p => p.p).length;
  const total = Number(S.meta.total) || S.people.length;
  const r = S.meta.regla;
  const req = !total ? 0 : r === "dos3" ? Math.ceil(total * 2 / 3) : r === "tercio" ? Math.ceil(total / 3) : r === "todos" ? total : Math.floor(total / 2) + 1;
  return { presentes, total, req, ok: total > 0 && presentes >= req, pct: total ? Math.round(presentes / total * 100) : 0 };
}
function renderQuorum() {
  const q = quorum(), col = q.ok ? "var(--ok)" : "var(--rec)";
  $("qRing").style.background = `conic-gradient(${col} ${q.pct * 3.6}deg, var(--line) 0)`;
  $("qRing").innerHTML = `<span style="background:var(--sheet);width:66px;height:66px;border-radius:50%;display:grid;place-items:center">${q.presentes}/${q.total}</span>`;
  const st = $("qStat"); st.className = "qstat " + (q.ok ? "ok" : "no"); st.textContent = q.ok ? "Quórum válido" : "Sin quórum";
  $("qText").textContent = q.total ? `${q.presentes} presentes de ${q.total} (${q.pct}%). Se requieren ${q.req}.` : "Registra asistentes para calcular.";
  $("attCount").textContent = q.presentes + " presentes";
}
function renderPeople() {
  $("people").innerHTML = S.people.length ? S.people.map((p, i) => `
    <div class="person">
      <input type="checkbox" id="pp${i}" ${p.p ? "checked" : ""} aria-label="Presente">
      <input id="pn${i}" value="${esc(p.n)}" aria-label="Nombre">
      <input id="pc${i}" class="cargo" value="${esc(p.c)}" placeholder="Cargo" aria-label="Cargo">
      <button class="x" data-i="${i}" aria-label="Quitar">×</button>
    </div>${p.d ? `<span class="hint" style="margin:-4px 0 0 28px">Detectado en la grabación<span class="tag">auto</span></span>` : p.l ? `<span class="hint" style="margin:-4px 0 0 28px">De la lista del documento<span class="tag">doc</span></span>` : ""}`).join("")
    : '<div class="empty">Sin asistentes todavía.</div>';
  S.people.forEach((p, i) => {
    $("pp" + i).onchange = e => { p.p = e.target.checked; save(); renderQuorum(); };
    $("pn" + i).oninput = e => { p.n = e.target.value; save(); };
    $("pc" + i).oninput = e => { p.c = e.target.value; save(); };
  });
  $("people").querySelectorAll(".x").forEach(b => b.onclick = () => { S.people.splice(+b.dataset.i, 1); save(); renderPeople(); renderQuorum(); });
}
$("addPerson").onclick = () => { const n = $("newName").value.trim(); if (!n) return; S.people.push({ n, c: $("newRole").value.trim(), p: true }); $("newName").value = $("newRole").value = ""; save(); renderPeople(); renderQuorum(); };
function renderAgenda() {
  $("agenda").innerHTML = S.agenda.length ? S.agenda.map((a, i) => `<div class="agenda"><span>${String(i + 1).padStart(2, "0")}</span><input id="ag${i}" value="${esc(a)}" aria-label="Punto ${i + 1}"><button class="x" data-i="${i}" aria-label="Quitar">×</button></div>`).join("") : '<div class="empty">Sin puntos todavía.</div>';
  S.agenda.forEach((a, i) => $("ag" + i).oninput = e => { S.agenda[i] = e.target.value; save(); });
  $("agenda").querySelectorAll(".x").forEach(b => b.onclick = () => { S.agenda.splice(+b.dataset.i, 1); save(); renderAgenda(); });
}
$("addPoint").onclick = () => { const v = $("newPoint").value.trim(); if (!v) return; S.agenda.push(v); $("newPoint").value = ""; save(); renderAgenda(); };

/* =========================================================
   Documentos de contexto (PDF, Word, texto)
   ========================================================= */
const MAX_DOC = 120000;
const extOf = n => (n.split(".").pop() || "").toLowerCase();
const toB64 = buf => { let s = ""; const b = new Uint8Array(buf); for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(s); };
async function readPdf(file, prog) {
  const lib = window.pdfjsLib;
  if (!lib) throw new Error("El lector de PDF aún no cargó. Intenta en unos segundos.");
  lib.GlobalWorkerOptions.workerSrc = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  const buf = await file.arrayBuffer();
  const pdf = await lib.getDocument({ data: new Uint8Array(buf.slice(0)) }).promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    prog(`Leyendo ${file.name}: página ${i} de ${pdf.numPages}…`);
    const tc = await (await pdf.getPage(i)).getTextContent();
    pages.push(tc.items.map(it => it.str + (it.hasEOL ? "\n" : " ")).join(""));
  }
  let text = pages.join("\n\n").replace(/[ \t]+/g, " ").trim();
  if (text.replace(/\s/g, "").length < 40 * Math.min(pdf.numPages, 3)) {
    if (buf.byteLength > 20 * 1024 * 1024) throw new Error("El PDF es escaneado y pesa más de 20 MB. Súbelo en Word o reducido.");
    prog(`${file.name} es escaneado. Leyendo el texto de las páginas…`);
    const r = await api("ia", { tarea: "ocr", nombre: file.name, pdf: toB64(buf) });
    text = r.r.texto || "";
  }
  return { text, pages: pdf.numPages };
}
async function readDocFile(file, prog) {
  const e = extOf(file.name);
  if (e === "pdf" || file.type === "application/pdf") return readPdf(file, prog);
  if (e === "docx") {
    if (!window.mammoth) throw new Error("El lector de Word aún no cargó. Intenta en unos segundos.");
    prog(`Leyendo ${file.name}…`);
    const r = await window.mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
    return { text: r.value.trim() };
  }
  if (e === "doc") throw new Error("El formato .doc antiguo no se puede leer. Guárdalo como .docx o PDF desde Word.");
  if (e === "txt" || (file.type || "").startsWith("text/")) return { text: (await file.text()).trim() };
  throw new Error(`${file.name}: formato no admitido. Usa PDF, Word (.docx) o .txt.`);
}
function docRow(d, i) {
  const kb = Math.max(1, Math.round(d.chars / 1000));
  return `<div class="doc"><span class="ext">${esc(d.ext)}</span><div>${esc(d.name)}<small>${d.pages ? d.pages + " pág. · " : ""}${kb}k caracteres leídos${d.cut ? " · recortado" : ""}</small></div><button class="x" data-i="${i}" aria-label="Quitar ${esc(d.name)}">×</button></div>`;
}
const docContext = (limit = 60000) => {
  if (!S.docs || !S.docs.length) return "";
  const per = Math.floor(limit / S.docs.length);
  return S.docs.map(d => `=== ${d.name} ===\n${String(d.text || "").slice(0, per)}`).join("\n\n");
};
async function uploadDoc(d) {
  try { const r = await api("doc_agregar", { reunion_id: S.id, nombre: d.name, ext: d.ext, paginas: d.pages, texto: d.text }); d.sid = r.id; saveLocal(); }
  catch (e) { console.warn("documento", e); }
}

/* ---------- crear reunión ---------- */
let pend = null, pendArea = "directorio";
function setPendArea(a, keepTipo) {
  pendArea = a;
  $("c-area").querySelectorAll("button").forEach(b => b.setAttribute("aria-pressed", b.dataset.area === a));
  if (!keepTipo) $("c-tipo").value = AREA_TIPO[a];
  $("startMeeting").textContent = a === "cursos" ? "Empezar grabación del curso" : "Empezar grabación";
}
$("c-area").querySelectorAll("button").forEach(b => b.onclick = () => setPendArea(b.dataset.area));
$("c-tipo").addEventListener("change", e => setPendArea(areaFromTipo(e.target.value), true));
function openCreate() {
  if (live) { toast("Detén la grabación antes de crear otra reunión."); return; }
  if (YO && YO.rol === "lector") { toast("Tu cuenta es de solo lectura."); return; }
  pend = { docs: [], ctx: null, busy: 0, startedId: null };
  setPendArea(S.created ? S.area : "directorio");
  $("c-entidad").value = ""; $("c-fecha").value = today(); $("c-hora").value = new Date().toTimeString().slice(0, 5);
  $("archNote").hidden = !(S.created && (S.segs.length || S.acta));
  $("pendProg").hidden = true; renderPend();
  $("createModal").hidden = false;
}
function renderPend() {
  $("pendDocs").innerHTML = pend.docs.map((d, i) => docRow(d, i)).join("");
  $("pendDocs").querySelectorAll(".x").forEach(b => b.onclick = () => { pend.docs.splice(+b.dataset.i, 1); renderPend(); });
  const c = pend.ctx;
  $("pendCtx").innerHTML = c ? `<div class="ctx"><strong>Contexto leído del documento</strong>
    ${c.resumen ? `<span>${esc(c.resumen)}</span>` : ""}
    ${(c.orden_del_dia || []).length ? `<span class="hint">Orden del día (${c.orden_del_dia.length} puntos):</span><ol>${c.orden_del_dia.map(o => `<li>${esc(o)}</li>`).join("")}</ol>` : ""}
    ${(c.miembros || []).length ? `<span class="hint">${c.miembros.length} miembros en la lista${c.total_miembros ? " · " + esc(c.total_miembros) + " habilitados" : ""}</span>` : ""}
  </div>` : "";
  $("startMeeting").disabled = pend.busy > 0; $("createOnly").disabled = pend.busy > 0;
}
async function addFiles(files, target) {
  const progEl = target === "pend" ? $("pendProg") : $("ctxProg");
  const prog = t => { progEl.hidden = false; progEl.style.color = ""; progEl.textContent = t; };
  const list = target === "pend" ? pend.docs : S.docs;
  const added = [];
  if (target === "pend") { pend.busy++; renderPend(); }
  for (const f of files) {
    try {
      const r = await readDocFile(f, prog);
      if (!r.text) throw new Error(`${f.name} no tiene texto legible.`);
      const d = { name: f.name, ext: extOf(f.name) || "txt", pages: r.pages || 0, text: r.text.slice(0, MAX_DOC), chars: Math.min(r.text.length, MAX_DOC), cut: r.text.length > MAX_DOC };
      list.push(d); added.push(d);
      if (target === "ctx") uploadDoc(d);
    } catch (e) { progEl.hidden = false; progEl.style.color = "var(--rec)"; progEl.textContent = e.message || "No se pudo leer el archivo."; }
  }
  if (target === "pend") { pend.busy--; renderPend(); } else { save(true); renderCtx(); }
  if (added.length) { progEl.style.color = ""; progEl.textContent = added.length === 1 ? "Documento leído." : added.length + " documentos leídos."; analyzeDocs(added, target); }
}
async function analyzeDocs(docs, target) {
  const progEl = target === "pend" ? $("pendProg") : $("ctxProg");
  progEl.hidden = false; progEl.textContent = "Extrayendo orden del día, miembros y datos de la convocatoria…";
  const p = pend;
  try {
    const { r: c } = await api("ia", { tarea: "contexto", docs: docs.map(d => ({ nombre: d.name, texto: d.text })) });
    if (target === "pend" && p && !p.startedId) {
      p.ctx = c;
      if (c.tipo && [...$("c-tipo").options].some(o => o.text === c.tipo)) { $("c-tipo").value = c.tipo; setPendArea(areaFromTipo(c.tipo), true); }
      if (c.entidad && !$("c-entidad").value) $("c-entidad").value = c.entidad;
      if (/^\d{4}-\d{2}-\d{2}$/.test(c.fecha || "")) $("c-fecha").value = c.fecha;
      if (/^\d{2}:\d{2}$/.test(c.hora || "")) $("c-hora").value = c.hora;
      renderPend();
    } else if ((target === "pend" && p && p.startedId === S.id) || target === "ctx") {
      applyCtx(c); save(true); renderAll(); toast("Contexto del documento aplicado a la reunión.");
    }
    progEl.textContent = "Contexto listo. La grabación y el acta usarán este documento.";
  } catch (e) { progEl.style.color = "var(--rec)"; progEl.textContent = "No se pudo analizar el documento: " + e.message; }
}
function applyCtx(c) {
  if (!c) return;
  const norm = s => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
  ["entidad", "lugar", "secretario", "hora"].forEach(k => { if (c[k] && !S.meta[k]) S.meta[k] = c[k]; });
  if (/Primera|Segunda/.test(c.convocatoria || "")) S.meta.convocatoria = c.convocatoria;
  if (c.total_miembros && !S.meta.total && Number(c.total_miembros)) S.meta.total = Number(c.total_miembros);
  (c.orden_del_dia || []).forEach(o => { if (o && !S.agenda.some(a => norm(a) === norm(o))) S.agenda.push(o); });
  (c.miembros || []).forEach(m => { if (m && m.nombre && !S.people.some(p => norm(p.n) === norm(m.nombre))) S.people.push({ n: m.nombre, c: m.cargo || "", p: false, l: true }); });
  if (!S.meta.total && (c.miembros || []).length) S.meta.total = c.miembros.length;
}
async function buildMeeting() {
  if (S.created) { const prev = S; saveLocal(); if (YO && YO.rol !== "lector") api("guardar", { r: payload(prev) }).catch(() => {}); }
  S = blank(); S.created = true; S.area = pendArea;
  S.meta.tipo = $("c-tipo").value; S.meta.entidad = $("c-entidad").value.trim();
  S.meta.fecha = $("c-fecha").value || today(); S.meta.hora = $("c-hora").value;
  S.docs = pend.docs.slice();
  applyCtx(pend.ctx);
  pend.startedId = S.id;
  dirty = true; saveLocal();
  $("createModal").hidden = true; renderAll(); showTab("grabar");
  await syncServer();                          // la reunión existe en el servidor antes de subir documentos y audio
  S.docs.forEach(uploadDoc);
  loadHist();
}
$("createBtn").onclick = openCreate;
$("createCancel").onclick = () => { $("createModal").hidden = true; pend = null; };
$("createOnly").onclick = async () => { await buildMeeting(); toast("Reunión creada. Toca GRABAR cuando empiece."); };
$("startMeeting").onclick = async () => { const p = buildMeeting(); startRec(); await p; };
$("docIn").onchange = e => { const f = [...e.target.files]; e.target.value = ""; if (f.length) addFiles(f, "pend"); };
$("docIn2").onchange = e => { const f = [...e.target.files]; e.target.value = ""; if (f.length) addFiles(f, "ctx"); };
const drop = $("drop");
["dragenter", "dragover"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add("over"); }));
["dragleave", "drop"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove("over"); }));
drop.addEventListener("drop", e => { const f = [...(e.dataTransfer?.files || [])]; if (f.length) addFiles(f, "pend"); });

function renderCtx() {
  const has = S.docs && S.docs.length;
  $("ctxCard").hidden = !S.created;
  $("ctxDocs").innerHTML = has ? S.docs.map((d, i) => docRow(d, i)).join("") : '<div class="empty" style="padding:8px">Sin documentos. Puedes añadir la convocatoria o el orden del día.</div>';
  $("ctxDocs").querySelectorAll(".x").forEach(b => b.onclick = () => {
    const d = S.docs.splice(+b.dataset.i, 1)[0];
    if (d && d.sid) api("doc_borrar", { id: d.sid }).catch(() => {});
    save(true); renderCtx();
  });
  const m = S.meta;
  $("meetTitle").textContent = S.created ? (m.tipo + (m.entidad ? " · " + m.entidad : "")) : "Sin reunión creada";
  $("meetSub").textContent = S.created
    ? `${AREAS[S.area]} · ${longDate(m.fecha)}${m.hora ? " · " + m.hora : ""} · ${S.agenda.length} puntos · ${(S.docs || []).length} documento${(S.docs || []).length === 1 ? "" : "s"} de contexto`
    : "Crea la reunión y carga la convocatoria antes de grabar.";
}

/* =========================================================
   IA: detectar asistentes y generar el acta
   ========================================================= */
const transcriptText = () => S.segs.map(s => `[${fmt(s.t)}] ${s.x}`).join("\n");
function aiErr(e, el) { el.hidden = false; el.style.color = "var(--rec)"; el.textContent = "No se pudo completar: " + (e.message || "revisa la conexión") + ". Intenta otra vez."; }
async function condensed(progEl) {
  const full = transcriptText();
  if (full.length <= 250000) return full;
  const chunks = []; for (let i = 0; i < full.length; i += 180000) chunks.push(full.slice(i, i + 180000));
  const notes = [];
  for (let i = 0; i < chunks.length; i++) {
    progEl.textContent = `Leyendo la grabación: bloque ${i + 1} de ${chunks.length}…`;
    const { r } = await api("ia", { tarea: "resumir", texto: chunks[i], i: i + 1, n: chunks.length });
    notes.push(`NOTAS DEL TRAMO ${i + 1}:\n${r.texto}`);
  }
  return notes.join("\n\n");
}
$("detectBtn").onclick = async () => {
  const prog = $("detectProg");
  if (!S.segs.length) { prog.hidden = false; prog.style.color = ""; prog.textContent = "Primero graba o importa la transcripción."; return; }
  prog.hidden = false; prog.style.color = ""; prog.textContent = "Analizando la grabación…"; $("detectBtn").disabled = true;
  try {
    const texto = await condensed(prog);
    prog.textContent = "Identificando asistentes, orden del día y quórum…";
    const { r } = await api("ia", { tarea: "detectar", texto, contexto: docContext() });
    const norm = s => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").trim();
    let added = 0;
    (r.asistentes || []).forEach(a => { if (!a.nombre) return; const ex = S.people.find(p => norm(p.n) === norm(a.nombre)); if (ex) { if (!ex.c && a.cargo) ex.c = a.cargo; ex.p = true; } else { S.people.push({ n: a.nombre, c: a.cargo || "", p: true, d: true }); added++; } });
    (r.ausentes || []).forEach(a => { if (!a.nombre) return; const ex = S.people.find(p => norm(p.n) === norm(a.nombre)); if (ex) ex.p = false; else S.people.push({ n: a.nombre, c: a.cargo || "", p: false, d: true }); });
    (r.orden_del_dia || []).forEach(o => { if (o && !S.agenda.some(a => norm(a) === norm(o))) S.agenda.push(o); });
    if (Number(r.total_miembros) && !S.meta.total) S.meta.total = Number(r.total_miembros);
    if (r.entidad && !S.meta.entidad) S.meta.entidad = r.entidad;
    if (r.lugar && !S.meta.lugar) S.meta.lugar = r.lugar;
    if (/^\d{2}:\d{2}$/.test(r.hora_inicio || "") && !S.meta.hora) S.meta.hora = r.hora_inicio;
    save(true); renderAll();
    prog.textContent = `Listo: ${added} asistentes nuevos y ${S.agenda.length} puntos en el orden del día. Revisa y corrige si hace falta.`;
  } catch (e) { aiErr(e, prog); }
  $("detectBtn").disabled = false;
};
$("genBtn").onclick = async () => {
  const prog = $("genProg");
  if (!S.segs.length) { prog.hidden = false; prog.style.color = ""; prog.textContent = "Primero graba o importa la transcripción."; return; }
  prog.hidden = false; prog.style.color = ""; prog.textContent = "Preparando…"; $("genBtn").disabled = true;
  try {
    const texto = await condensed(prog);
    const q = quorum();
    prog.textContent = "Redactando el documento… puede tardar uno o dos minutos.";
    const datos = {
      area: AREAS[S.area], ...S.meta, duracion_grabada: fmt(S.elapsed),
      asistentes: S.people.map(p => ({ nombre: p.n, cargo: p.c, presente: !!p.p })),
      orden_del_dia: S.agenda,
      quorum: isCurso() ? null : { presentes: q.presentes, total: q.total, requerido: q.req, valido: q.ok },
    };
    const { r: a } = await api("ia", { tarea: "acta", curso: isCurso(), datos, texto, contexto: docContext() });
    S.acta = { ...a, _area: S.area, _meta: { ...S.meta }, _people: S.people.map(p => ({ ...p })), _q: q, _at: Date.now() };
    S.acta_html = null;
    save(true); renderActa();
    prog.textContent = "Listo. Puedes corregir el texto tocándolo antes de descargar.";
  } catch (e) { aiErr(e, prog); }
  $("genBtn").disabled = false;
};

/* ---------- el acta ---------- */
function actaHTML(a) {
  const m = a._meta || S.meta, ppl = a._people || S.people, q = a._q || quorum();
  const cur = (a._area || S.area) === "cursos";
  const v = x => x == null || x === "" ? "—" : esc(x);
  return `
  <h2>${esc(a.titulo || ("ACTA DE " + m.tipo).toUpperCase())}</h2>
  <p class="sub">${a.numero ? esc(a.numero) + " · " : ""}${esc(m.entidad || "Fundación PROINPA")} · ${esc(longDate(m.fecha))}</p>
  <p>${esc(a.encabezado)}</p>
  <h3>I. ASISTENCIA</h3>
  <table><thead><tr><th>N°</th><th>Nombre</th><th>Cargo</th><th>Estado</th></tr></thead><tbody>
  ${ppl.map((p, i) => `<tr><td>${i + 1}</td><td>${esc(p.n)}</td><td>${esc(p.c || "—")}</td><td>${p.p ? (cur ? "Participó" : "Presente") : "Ausente"}</td></tr>`).join("")}
  </tbody></table>
  ${cur ? `<h3>II. PARTICIPACIÓN</h3><p><strong>${q.presentes} participantes registrados.</strong></p>` : `<h3>II. VERIFICACIÓN DEL QUÓRUM</h3>
  <p><strong>${q.presentes} presentes de ${q.total} miembros habilitados (${q.pct}%). Requerido: ${q.req}. ${q.ok ? "Quórum válido." : "Sin quórum reglamentario."}</strong></p>`}
  <p>${esc(a.quorum)}</p>
  <h3>III. ${cur ? "PROGRAMA" : "ORDEN DEL DÍA"}</h3>
  <ol>${(a.orden_del_dia || []).map(o => `<li>${esc(o)}</li>`).join("")}</ol>
  <h3>IV. ${cur ? "CONTENIDOS DESARROLLADOS" : "DESARROLLO DE LA SESIÓN"}</h3>
  ${(a.desarrollo || []).map((d, i) => `<p><strong>Punto ${i + 1}. ${esc(d.punto)}.</strong> ${esc(d.relato)}</p>
    ${d.acuerdo ? `<p><em>Acuerdo:</em> ${esc(d.acuerdo)}${d.resultado && d.resultado !== "Sin votación" ? ` <em>Votación:</em> a favor ${v(d.a_favor)}, en contra ${v(d.en_contra)}, abstenciones ${v(d.abstenciones)}. <strong>${esc(d.resultado)}</strong>.` : ""}</p>` : ""}`).join("")}
  <h3>V. ${cur ? "CONCLUSIONES" : "ACUERDOS Y RESOLUCIONES"}</h3>
  ${(a.acuerdos || []).length ? `<ol>${a.acuerdos.map(x => `<li>${esc(x)}</li>`).join("")}</ol>` : "<p>No se adoptaron resoluciones.</p>"}
  <h3>VI. ${cur ? "COMPROMISOS Y PENDIENTES" : "TAREAS Y RESPONSABLES"}</h3>
  ${(a.tareas || []).length ? `<table><thead><tr><th>Responsable</th><th>Tarea</th><th>Plazo</th></tr></thead><tbody>${a.tareas.map(t => `<tr><td>${esc(t.responsable)}</td><td>${esc(t.tarea)}</td><td>${esc(t.plazo || "—")}</td></tr>`).join("")}</tbody></table>` : "<p>No se asignaron tareas.</p>"}
  <h3>VII. CIERRE</h3>
  <p>${esc(a.cierre)}</p>
  ${a.observaciones ? `<p class="hint"><em>Observaciones de la transcripción:</em> ${esc(a.observaciones)}</p>` : ""}
  <div class="firmas"><div>${esc(m.preside || "Presidente")}<br>${cur ? "FACILITADOR(A)" : "PRESIDENTE"}</div><div>${esc(m.secretario || "Secretario(a)")}<br>${cur ? "COORDINACIÓN" : "SECRETARIO(A) DE ACTAS"}</div></div>`;
}
function renderActa() {
  const out = $("actaOut");
  if (!S.acta) { out.innerHTML = ""; $("actaActions").hidden = true; return; }
  out.innerHTML = `<article class="acta" id="actaDoc" contenteditable="${YO && YO.rol !== "lector"}">${S.acta_html || actaHTML(S.acta)}</article>`;
  $("actaDoc").addEventListener("input", () => { S.acta_html = $("actaDoc").innerHTML; save(); });
  $("actaActions").hidden = false;
}
$("copyBtn").onclick = async () => {
  try { await navigator.clipboard.writeText($("actaDoc").innerText); toast("Acta copiada."); }
  catch { toast("No se pudo copiar. Mantén presionado el texto para copiarlo."); }
};
$("dlBtn").onclick = () => {
  const doc = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Acta</title><style>body{font-family:Georgia,serif;font-size:12pt;line-height:1.5;max-width:17cm;margin:2cm auto}h2{text-align:center}h3{margin-top:18pt}table{width:100%;border-collapse:collapse}td,th{border:1px solid #999;padding:4pt}.sub{text-align:center}.firmas{display:flex;justify-content:space-between;margin-top:60pt;text-align:center}.firmas div{border-top:1px solid #000;width:40%;padding-top:4pt}</style></head><body>${$("actaDoc").innerHTML}</body></html>`;
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob(["﻿" + doc], { type: "application/msword" }));
  a.download = "Acta_" + (S.meta.fecha || today()) + "_" + AREAS[S.area].replace(/\s+/g, "_") + ".doc";
  document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
};
$("printBtn").onclick = () => window.print();
$("archBtn").onclick = async () => {
  if (!S.created) return;
  S.estado = "enviada"; dirty = true; saveLocal();
  await syncServer();
  toast("Enviado a " + AREAS[S.area] + "."); loadHist();
};

/* ---------- historial (servidor) ---------- */
let hist = [], histF = "todas";
$("histFilter").querySelectorAll("button").forEach(b => b.onclick = () => { histF = b.dataset.f; $("histFilter").querySelectorAll("button").forEach(x => x.setAttribute("aria-pressed", x === b)); renderHist(); });
$("histReload").onclick = loadHist;
async function loadHist() {
  if (!YO) return;
  try { hist = (await api("listar")).reuniones || []; } catch (e) { console.warn(e); }
  renderHist();
}
function renderHist() {
  $("histFilter").querySelectorAll("button").forEach(b => { const f = b.dataset.f; const n = f === "todas" ? hist.length : hist.filter(h => h.area === f).length; b.textContent = (f === "todas" ? "Todas" : f === "cursos" ? "Cursos o talleres" : f[0].toUpperCase() + f.slice(1)) + " · " + n; });
  const items = hist.filter(h => histF === "todas" || h.area === histF);
  $("hist").innerHTML = items.length ? items.map(h => {
    const m = h.meta || {}, est = h.estado === "enviada" ? "Enviada" : h.estado === "grabando" ? "Grabando" : "Borrador";
    return `<button data-id="${h.id}"><span><span class="atag">${esc(AREAS[h.area] || "")} · ${est}</span><br>${esc(h.titulo || ((m.tipo || "Reunión") + (m.entidad ? " · " + m.entidad : "")))}</span><small>${esc(m.fecha || "")} · ${fmt(h.duracion_ms || 0)}</small></button>`;
  }).join("") : `<div class="empty">${histF === "todas" ? "Las reuniones guardadas aparecerán aquí, separadas por área." : "Aún no hay nada en " + esc(AREAS[histF]) + "."}</div>`;
  $("hist").querySelectorAll("button").forEach(b => b.onclick = () => openMeeting(b.dataset.id));
}
async function openMeeting(id) {
  if (live) { toast("Detén la grabación antes de abrir otra reunión."); return; }
  if (id === S.id) { showTab("acta"); return; }
  try {
    await flushSave();
    const { reunion: r, documentos, audios } = await api("obtener", { id });
    S = {
      id: r.id, area: r.area, estado: r.estado === "grabando" ? "borrador" : r.estado, created: true, recording: false,
      elapsed: Number(r.duracion_ms) || 0, segs: r.segmentos || [], acta: r.acta, acta_html: r.acta_html,
      meta: { ...blank().meta, ...(r.meta || {}) }, people: r.asistentes || [], agenda: r.orden || [],
      docs: (documentos || []).map(d => ({ sid: d.id, name: d.nombre, ext: d.ext, pages: d.paginas, text: d.texto, chars: (d.texto || "").length })),
      audioN: (audios || []).reduce((m, a) => Math.max(m, a.n + 1), 0),
      audios: (audios || []).map(a => ({ n: a.n, inicio_ms: Number(a.inicio_ms), dur_ms: Number(a.dur_ms), transcrito: a.transcrito, subido: true })),
    };
    saveLocal(); renderAll(); showTab(S.acta ? "acta" : "grabar"); toast("Reunión abierta.");
  } catch (e) { toast("No se pudo abrir: " + e.message); }
}

/* =========================================================
   Usuarios (administrador)
   ========================================================= */
$("usersBtn").onclick = () => { $("usersModal").hidden = false; loadUsers(); };
$("usersClose").onclick = () => $("usersModal").hidden = true;
async function loadUsers() {
  const box = $("usersList"); box.innerHTML = '<div class="empty">Cargando…</div>';
  try {
    const { usuarios } = await api("usuarios_listar");
    const ROL = { admin: "Administrador", secretario: "Graba y redacta", lector: "Solo lectura" };
    box.innerHTML = usuarios.map(u => `<div class="user${u.activo ? "" : " off"}"><div>${esc(u.nombre)}<small>${esc(aUsuario(u.email))} · ${ROL[u.rol] || u.rol}${u.activo ? "" : " · sin acceso"}</small></div>
      ${u.user_id === YO.id ? "" : `<button class="lockbtn" data-u="${u.user_id}" data-a="${u.activo ? 0 : 1}">${u.activo ? "Quitar acceso" : "Devolver acceso"}</button>`}</div>`).join("");
    box.querySelectorAll("button").forEach(b => b.onclick = async () => {
      try { await api("usuario_estado", { user_id: b.dataset.u, activo: b.dataset.a === "1" }); loadUsers(); } catch (e) { toast(e.message); }
    });
  } catch (e) { box.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}
$("u-crear").onclick = async () => {
  const p = $("usersProg"); p.hidden = false; p.style.color = ""; p.textContent = "Creando acceso…";
  try {
    const r = await api("usuario_crear", { nombre: $("u-nombre").value, email: aEmail($("u-email").value), password: $("u-pass").value, rol: $("u-rol").value });
    p.textContent = r.existente ? "Listo. Esa persona ya tenía cuenta: entra con su misma contraseña." : "Listo. Comparte el usuario y la contraseña inicial con la persona.";
    $("u-nombre").value = $("u-email").value = $("u-pass").value = ""; loadUsers();
  } catch (e) { p.style.color = "var(--rec)"; p.textContent = e.message; }
};

/* =========================================================
   Cambiar mi contraseña
   ========================================================= */
$("passBtn").onclick = () => { $("passWho").textContent = "Usuario: " + (YO ? aUsuario(YO.email) : ""); $("p-new").value = $("p-new2").value = ""; $("passProg").hidden = true; $("passModal").hidden = false; };
$("passClose").onclick = () => $("passModal").hidden = true;
$("passSave").onclick = async () => {
  const p = $("passProg"), a = $("p-new").value, b = $("p-new2").value;
  p.hidden = false; p.style.color = "var(--rec)";
  if (a.length < 8) { p.textContent = "Debe tener al menos 8 caracteres."; return; }
  if (a !== b) { p.textContent = "Las dos contraseñas no coinciden."; return; }
  p.style.color = ""; p.textContent = "Guardando…";
  const { error } = await sb.auth.updateUser({ password: a });
  if (error) { p.style.color = "var(--rec)"; p.textContent = /same/i.test(error.message) ? "Es igual a la contraseña actual." : error.message; return; }
  p.textContent = "Listo. Desde ahora entra con la contraseña nueva."; $("p-new").value = $("p-new2").value = "";
};

/* =========================================================
   Arranque
   ========================================================= */
function renderAll() {
  renderMeta(); renderPeople(); renderAgenda(); renderQuorum(); renderTranscript(); renderClock(); renderActa(); renderHist(); renderCtx(); renderAudioLine();
  if (!live) setState("", S.segs.length ? "Registro guardado" : "Listo para grabar");
}
if (!canRecord) $("micBanner").hidden = false;
showTab("grabar");
(async () => {
  if (!window.supabase) { showLogin("No se pudo cargar la app. Revisa tu conexión y recarga."); return; }
  sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: true, autoRefreshToken: true, storageKey: "actasP.sesion" } });
  const { data } = await sb.auth.getSession();
  if (data?.session) enter(); else showLogin("");
})();
})();
