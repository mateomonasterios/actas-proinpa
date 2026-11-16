// actas-proinpa — servidor de la app «Libro de Actas» (Fundación PROINPA · Cristian Aparicio).
// Todo pasa por aquí: el navegador nunca lee ni escribe la base directo.
//   POST { accion, ... }  con el token de sesión de Supabase Auth en Authorization.
// Acciones:
//   yo · listar · obtener · guardar · borrar
//   doc_agregar · doc_borrar
//   audio_url (enlace firmado para subir un tramo) · audio_ver · transcribir
//   ia { tarea: contexto | ocr | detectar | resumir | acta }
//   usuarios_listar · usuario_crear · usuario_estado   (solo admin)
// Secretos: ANTHROPIC_API_KEY (ya existe en el proyecto). Para transcribir el audio en el servidor
// (sirve aunque el celular esté bloqueado) hace falta UNA de estas claves: OPENAI_API_KEY, GROQ_API_KEY,
// ELEVENLABS_API_KEY, DEEPGRAM_API_KEY o GEMINI_API_KEY.
import Anthropic from "npm:@anthropic-ai/sdk@1.3.0";
import postgres from "npm:postgres@3.4.5";
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

const sql = postgres(Deno.env.get("SUPABASE_DB_URL")!, { prepare: false, max: 1, idle_timeout: 5, max_lifetime: 60, connect_timeout: 10 });
const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false, autoRefreshToken: false } });
const BUCKET = "actas-proinpa";
const MODELO = "claude-opus-5-5";
const BETAS = ["server-side-fallback-2026-07-01"];
const env = (k: string) => (Deno.env.get(k) || "").trim();
// Transcripción del audio: se usa el primer proveedor que tenga clave en los secretos de Supabase.
const STT = env("OPENAI_API_KEY") ? "openai" : env("GROQ_API_KEY") ? "groq" : env("ELEVENLABS_API_KEY") ? "elevenlabs"
  : env("DEEPGRAM_API_KEY") ? "deepgram" : (env("GEMINI_API_KEY") || env("GOOGLE_API_KEY")) ? "gemini" : "";
const claude = new Anthropic();

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, authorization, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (d: unknown, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const fail = (error: string, s = 400) => json({ error }, s);
const uuid = (v: unknown) => typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v);

type Yo = { id: string; email: string; nombre: string; rol: string };
async function quien(req: Request): Promise<Yo | null> {
  const jwt = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  if (!jwt) return null;
  const { data, error } = await sb.auth.getUser(jwt);
  if (error || !data?.user) return null;
  const r = await sql`select nombre, rol from actas_proinpa.miembros where user_id = ${data.user.id} and activo limit 1`;
  if (!r.length) return null;
  return { id: data.user.id, email: data.user.email || "", nombre: r[0].nombre, rol: r[0].rol };
}

// ---------- IA ----------
type S = Record<string, unknown>;
const str: S = { type: "string" };
const arr = (items: S): S => ({ type: "array", items });
const obj = (p: Record<string, S>): S => ({ type: "object", properties: p, required: Object.keys(p), additionalProperties: false });
const persona = obj({ nombre: str, cargo: str });

const ESQ_CONTEXTO = obj({
  tipo: str, entidad: str, fecha: str, hora: str, lugar: str, preside: str, secretario: str, convocatoria: str,
  orden_del_dia: arr(str), miembros: arr(persona), total_miembros: str, resumen: str,
});
const ESQ_DETECTAR = obj({
  asistentes: arr(persona), ausentes: arr(persona), orden_del_dia: arr(str),
  total_miembros: str, entidad: str, lugar: str, hora_inicio: str,
});
const ESQ_ACTA = obj({
  titulo: str, numero: str, encabezado: str, quorum: str, orden_del_dia: arr(str),
  desarrollo: arr(obj({ punto: str, relato: str, acuerdo: str, a_favor: str, en_contra: str, abstenciones: str, resultado: str })),
  acuerdos: arr(str), tareas: arr(obj({ responsable: str, tarea: str, plazo: str })), cierre: str, observaciones: str,
});

async function pedir(system: string, content: Anthropic.Beta.Messages.BetaContentBlockParam[], schema?: S, maxTokens = 16000, effort = "medium") {
  const stream = claude.beta.messages.stream({
    model: MODELO, max_tokens: maxTokens, betas: BETAS, fallbacks: "default", system,
    messages: [{ role: "user", content }],
    output_config: schema ? { effort, format: { type: "json_schema", schema } } : { effort },
  } as never);
  const m = await stream.finalMessage();
  if (m.stop_reason === "refusal") throw new Error("La IA no pudo completar la tarea.");
  const t = m.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("");
  return schema ? JSON.parse(t) : t;
}

const BASE = "Eres el secretario de actas de la Fundación PROINPA (Bolivia), que trabaja en agricultura sostenible y regenerativa. " +
  "Escribes en español formal, claro, en tercera persona y tiempo pasado. Nunca inventas nombres, cifras ni acuerdos: si algo no consta, escribes una cadena vacía o \"No consta\". " +
  "La transcripción viene de reconocimiento de voz y puede tener errores: corrige nombres con la lista de miembros y los documentos cuando sea evidente.";

async function ia(b: S) {
  const tarea = String(b.tarea || "");
  const ctx = String(b.contexto || "").slice(0, 120000);
  if (tarea === "contexto") {
    const docs = (Array.isArray(b.docs) ? b.docs : []).slice(0, 6) as { nombre: string; texto: string }[];
    const txt = docs.map((d) => `=== ${d.nombre} ===\n${String(d.texto || "").slice(0, 60000)}`).join("\n\n");
    return await pedir(BASE, [{ type: "text", text:
      `Lee estos documentos preparatorios (convocatoria, orden del día, lista de miembros, acta anterior) y extrae los datos de la sesión. Lo que no conste va vacío.
tipo: uno de «Asamblea General Ordinaria», «Asamblea General Extraordinaria», «Reunión de Directorio», «Junta de Socios», «Reunión de Trabajo», «Curso», «Taller» o vacío.
fecha AAAA-MM-DD, hora HH:MM, convocatoria «Primera convocatoria» o «Segunda convocatoria», total_miembros como número en texto.
resumen: una o dos frases sobre el propósito.

${txt}` }], ESQ_CONTEXTO, 8000, "low");
  }
  if (tarea === "ocr") {
    const data = String(b.pdf || "");
    if (!data || data.length > 30_000_000) throw new Error("El PDF es muy grande para leerlo (máximo unos 20 MB).");
    return { texto: await pedir("Transcribes documentos con fidelidad.", [
      { type: "document", source: { type: "base64", media_type: "application/pdf", data }, title: String(b.nombre || "documento.pdf") },
      { type: "text", text: "Transcribe todo el texto de este documento, en orden, sin comentarios. Conserva listas, numeraciones y tablas en texto." },
    ], undefined, 32000, "low") };
  }
  if (tarea === "detectar") {
    return await pedir(BASE, [{ type: "text", text:
      `Analiza la transcripción de una reunión. Identifica:
- asistentes: presentes en la reunión grabada (por pase de lista, porque hablan o porque se los nombra como presentes), con cargo si se menciona.
- ausentes: nombrados como ausentes o con licencia.
- orden_del_dia: puntos en orden; si no se leyó formalmente, dedúcelos de los temas tratados.
- total_miembros (número en texto), entidad, lugar, hora_inicio (HH:MM) si se mencionan.
${ctx ? `\nDOCUMENTOS Y DATOS DE CONTEXTO:\n${ctx}\n` : ""}
TRANSCRIPCIÓN:
${String(b.texto || "").slice(0, 300000)}` }], ESQ_DETECTAR, 8000, "low");
  }
  if (tarea === "resumir") {
    return { texto: await pedir(BASE, [{ type: "text", text:
      `Resume este tramo (${b.i}/${b.n}) de la transcripción de una reunión en notas detalladas: quién habla (nombre y cargo), temas, cifras exactas, propuestas, votaciones con resultados, acuerdos, responsables y plazos. Conserva las marcas de tiempo relevantes. No inventes nada.

${String(b.texto || "").slice(0, 200000)}` }], undefined, 8000, "low") };
  }
  if (tarea === "acta") {
    const curso = !!b.curso;
    const guia = curso
      ? `Es un CURSO o TALLER: redacta un INFORME DEL CURSO/TALLER. titulo «INFORME DEL CURSO/TALLER: <tema>». encabezado: tema, facilitador, fecha, lugar, duración. quorum: describe la participación (no hay quórum). orden_del_dia: programa o módulos. desarrollo: contenidos por módulo con preguntas y aportes; resultado «Sin votación». acuerdos: conclusiones y aprendizajes. tareas: compromisos o pendientes.`
      : `Redacta el ACTA formal. desarrollo: un elemento por punto tratado, con relato de las intervenciones relevantes (con nombre), el acuerdo del punto y la votación (a_favor, en_contra, abstenciones como números en texto, resultado «Aprobado», «Rechazado» o «Sin votación»). acuerdos: lista consolidada de resoluciones. cierre: hora de conclusión si consta.`;
    return await pedir(BASE, [{ type: "text", text:
      `${guia}
Los DATOS DE LA SESIÓN prevalecen sobre la transcripción para nombres, asistencia y quórum. Respeta exactamente las cifras dichas.

DATOS DE LA SESIÓN:
${JSON.stringify(b.datos || {}, null, 1)}
${ctx ? `\nDOCUMENTOS DE CONTEXTO (antecedentes; lo dicho en la reunión prevalece):\n${ctx}\n` : ""}
TRANSCRIPCIÓN O NOTAS:
${String(b.texto || "").slice(0, 300000)}` }], ESQ_ACTA, 24000, "medium");
  }
  throw new Error("Tarea desconocida.");
}

// ---------- transcripción del audio ----------
async function sttTexto(data: Blob, ext: string, mime: string, prompt: string): Promise<string> {
  const file = () => new File([data], `tramo.${ext}`, { type: mime });
  const err = async (r: Response, q: string) => { throw new Error(`Transcripción (${q}) ${r.status}: ${(await r.text()).slice(0, 200)}`); };
  if (STT === "openai" || STT === "groq") {
    const url = STT === "openai" ? "https://api.openai.com/v1/audio/transcriptions" : "https://api.groq.com/openai/v1/audio/transcriptions";
    const key = env(STT === "openai" ? "OPENAI_API_KEY" : "GROQ_API_KEY");
    const modelos = STT === "openai" ? ["gpt-4o-transcribe", "whisper-1"] : ["whisper-large-v3"];
    let ultimo: unknown;
    for (const modelo of modelos) {
      const fd = new FormData();
      fd.append("file", file()); fd.append("model", modelo); fd.append("language", "es"); fd.append("prompt", prompt.slice(0, 800));
      const r = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: fd });
      if (r.ok) return ((await r.json()).text || "") as string;
      try { await err(r, STT); } catch (e) { ultimo = e; }
    }
    throw ultimo;
  }
  if (STT === "elevenlabs") {
    const fd = new FormData();
    fd.append("file", file()); fd.append("model_id", "scribe_v1"); fd.append("language_code", "spa"); fd.append("diarize", "true");
    const r = await fetch("https://api.elevenlabs.io/v1/speech-to-text", { method: "POST", headers: { "xi-api-key": env("ELEVENLABS_API_KEY") }, body: fd });
    if (!r.ok) await err(r, "elevenlabs");
    const j = await r.json();
    // con diarización: separa por hablante
    const words = (j.words || []) as { text: string; speaker_id?: string; type?: string }[];
    if (words.some((w) => w.speaker_id)) {
      let out = "", sp = "";
      for (const w of words) {
        if (w.speaker_id && w.speaker_id !== sp) { sp = w.speaker_id; out += `\n[Hablante ${sp.replace(/\D/g, "") || sp}] `; }
        out += w.text;
      }
      return out.trim();
    }
    return (j.text || "") as string;
  }
  if (STT === "deepgram") {
    const r = await fetch("https://api.deepgram.com/v1/listen?model=nova-2&language=es&smart_format=true&punctuate=true&diarize=true", {
      method: "POST", headers: { Authorization: `Token ${env("DEEPGRAM_API_KEY")}`, "Content-Type": mime }, body: data,
    });
    if (!r.ok) await err(r, "deepgram");
    const j = await r.json();
    return (j?.results?.channels?.[0]?.alternatives?.[0]?.transcript || "") as string;
  }
  if (STT === "gemini") {
    const buf = new Uint8Array(await data.arrayBuffer());
    let bin = ""; for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    const key = env("GEMINI_API_KEY") || env("GOOGLE_API_KEY");
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [
        { inline_data: { mime_type: mime, data: btoa(bin) } },
        { text: `Transcribe fielmente este audio en español, sin resumir ni comentar. Si hay varias voces, separa por hablante. Contexto: ${prompt}` },
      ] }] }),
    });
    if (!r.ok) await err(r, "gemini");
    const j = await r.json();
    return (j?.candidates?.[0]?.content?.parts || []).map((p: { text?: string }) => p.text || "").join("");
  }
  return "";
}
async function transcribir(reunion: string, n: number) {
  if (!STT) return { stt: false };
  const a = await sql`select path, inicio_ms from actas_proinpa.audios where reunion_id = ${reunion} and n = ${n}`;
  if (!a.length) throw new Error("Ese tramo de audio no existe.");
  const { data, error } = await sb.storage.from(BUCKET).download(a[0].path);
  if (error || !data) throw new Error("No se pudo leer el audio guardado.");
  const r = await sql`select meta, asistentes from actas_proinpa.reuniones where id = ${reunion}`;
  const nombres = ((r[0]?.asistentes || []) as { n: string }[]).map((p) => p.n).filter(Boolean).slice(0, 60).join(", ");
  const ext = a[0].path.split(".").pop() || "webm";
  const mime = ext === "m4a" ? "audio/mp4" : ext === "ogg" ? "audio/ogg" : "audio/webm";
  const prompt = `Reunión de la Fundación PROINPA, Bolivia. ${r[0]?.meta?.entidad || ""}. Participantes: ${nombres}`;
  const texto = (await sttTexto(data, ext, mime, prompt)).trim();
  await sql`update actas_proinpa.audios set transcrito = true where reunion_id = ${reunion} and n = ${n}`;
  return { stt: true, texto, inicio_ms: Number(a[0].inicio_ms) };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return fail("Método no permitido", 405);
  let b: S = {};
  try { b = await req.json(); } catch { return fail("Pedido inválido"); }
  try {
    // estado público mínimo: solo dice si la transcripción del audio está activa
    if (b.accion === "estado") return json({ stt: !!STT, proveedor: STT || null });
    const yo = await quien(req);
    if (!yo) return fail("No tienes acceso o tu sesión venció. Vuelve a entrar.", 401);
    const escribe = yo.rol !== "lector";
    const accion = String(b.accion || "");

    if (accion === "yo") return json({ nombre: yo.nombre, rol: yo.rol, email: yo.email, stt: !!STT });

    if (accion === "listar") {
      const area = ["directorio", "asambleas", "cursos"].includes(String(b.area)) ? String(b.area) : null;
      const rows = await sql`
        select id, area, estado, meta, duracion_ms, creado, actualizado, enviado, acta->>'titulo' as titulo
        from actas_proinpa.reuniones
        where (${area}::text is null or area = ${area})
        order by coalesce(enviado, creado) desc limit 200`;
      return json({ reuniones: rows });
    }

    if (accion === "obtener") {
      if (!uuid(b.id)) return fail("Reunión inválida.");
      const r = await sql`select * from actas_proinpa.reuniones where id = ${b.id as string}`;
      if (!r.length) return fail("No se encontró la reunión.", 404);
      const docs = await sql`select id, nombre, ext, paginas, texto from actas_proinpa.documentos where reunion_id = ${b.id as string} order by creado`;
      const audios = await sql`select n, inicio_ms, dur_ms, bytes, transcrito from actas_proinpa.audios where reunion_id = ${b.id as string} order by n`;
      return json({ reunion: r[0], documentos: docs, audios });
    }

    if (accion === "guardar") {
      if (!escribe) return fail("Tu cuenta es de solo lectura.", 403);
      const r = (b.r || {}) as S;
      const area = ["directorio", "asambleas", "cursos"].includes(String(r.area)) ? String(r.area) : "asambleas";
      const estado = ["borrador", "grabando", "enviada"].includes(String(r.estado)) ? String(r.estado) : "borrador";
      const vals = {
        area, estado,
        meta: sql.json((r.meta || {}) as never), asistentes: sql.json((r.asistentes || []) as never),
        orden: sql.json((r.orden || []) as never), segmentos: sql.json((r.segmentos || []) as never),
        duracion_ms: Math.max(0, Math.min(4 * 3600_000, Number(r.duracion_ms) || 0)),
        acta: r.acta ? sql.json(r.acta as never) : null, acta_html: r.acta_html ? String(r.acta_html).slice(0, 2_000_000) : null,
      };
      if (uuid(r.id)) {
        const u = await sql`
          update actas_proinpa.reuniones set area = ${vals.area}, estado = ${vals.estado}, meta = ${vals.meta}, asistentes = ${vals.asistentes},
            orden = ${vals.orden}, segmentos = ${vals.segmentos}, duracion_ms = ${vals.duracion_ms}, acta = ${vals.acta}, acta_html = ${vals.acta_html},
            actualizado = now(), enviado = case when ${estado} = 'enviada' then coalesce(enviado, now()) else enviado end
          where id = ${r.id as string} returning id, actualizado, enviado`;
        if (u.length) return json(u[0]);
      }
      const i = await sql`
        insert into actas_proinpa.reuniones (id, area, estado, meta, asistentes, orden, segmentos, duracion_ms, acta, acta_html, creado_por, enviado)
        values (${uuid(r.id) ? (r.id as string) : sql`gen_random_uuid()`}, ${vals.area}, ${vals.estado}, ${vals.meta}, ${vals.asistentes}, ${vals.orden}, ${vals.segmentos},
          ${vals.duracion_ms}, ${vals.acta}, ${vals.acta_html}, ${yo.id}, ${estado === "enviada" ? sql`now()` : null})
        returning id, actualizado, enviado`;
      return json(i[0]);
    }

    if (accion === "borrar") {
      if (yo.rol !== "admin") return fail("Solo un administrador puede borrar.", 403);
      if (!uuid(b.id)) return fail("Reunión inválida.");
      const au = await sql`select path from actas_proinpa.audios where reunion_id = ${b.id as string}`;
      if (au.length) await sb.storage.from(BUCKET).remove(au.map((x) => x.path as string));
      await sql`delete from actas_proinpa.reuniones where id = ${b.id as string}`;
      return json({ ok: true });
    }

    if (accion === "doc_agregar") {
      if (!escribe) return fail("Tu cuenta es de solo lectura.", 403);
      if (!uuid(b.reunion_id)) return fail("Reunión inválida.");
      const d = await sql`
        insert into actas_proinpa.documentos (reunion_id, nombre, ext, paginas, texto)
        values (${b.reunion_id as string}, ${String(b.nombre || "documento").slice(0, 200)}, ${String(b.ext || "txt").slice(0, 10)},
          ${Number(b.paginas) || 0}, ${String(b.texto || "").slice(0, 400000)})
        returning id`;
      return json({ id: d[0].id });
    }
    if (accion === "doc_borrar") {
      if (!escribe) return fail("Tu cuenta es de solo lectura.", 403);
      if (!uuid(b.id)) return fail("Documento inválido.");
      await sql`delete from actas_proinpa.documentos where id = ${b.id as string}`;
      return json({ ok: true });
    }

    if (accion === "audio_url") {
      if (!escribe) return fail("Tu cuenta es de solo lectura.", 403);
      if (!uuid(b.reunion_id)) return fail("Reunión inválida.");
      const n = Math.max(0, Math.floor(Number(b.n) || 0));
      const tipo = String(b.tipo || "audio/webm");
      const ext = /mp4|m4a|aac/.test(tipo) ? "m4a" : /ogg/.test(tipo) ? "ogg" : "webm";
      const path = `reuniones/${b.reunion_id}/${String(n).padStart(4, "0")}.${ext}`;
      const { data, error } = await sb.storage.from(BUCKET).createSignedUploadUrl(path, { upsert: true });
      if (error || !data) return fail("No se pudo preparar la subida del audio.", 500);
      await sql`
        insert into actas_proinpa.audios (reunion_id, n, path, inicio_ms, dur_ms, bytes)
        values (${b.reunion_id as string}, ${n}, ${path}, ${Number(b.inicio_ms) || 0}, ${Number(b.dur_ms) || 0}, ${Number(b.bytes) || 0})
        on conflict (reunion_id, n) do update set path = excluded.path, inicio_ms = excluded.inicio_ms, dur_ms = excluded.dur_ms, bytes = excluded.bytes`;
      return json({ path, token: data.token, url: data.signedUrl });
    }
    if (accion === "audio_ver") {
      if (!uuid(b.reunion_id)) return fail("Reunión inválida.");
      const a = await sql`select path from actas_proinpa.audios where reunion_id = ${b.reunion_id as string} and n = ${Number(b.n) || 0}`;
      if (!a.length) return fail("No existe ese tramo.", 404);
      const { data, error } = await sb.storage.from(BUCKET).createSignedUrl(a[0].path, 3 * 3600);
      if (error || !data) return fail("No se pudo abrir el audio.", 500);
      return json({ url: data.signedUrl });
    }
    if (accion === "transcribir") {
      if (!escribe) return fail("Tu cuenta es de solo lectura.", 403);
      if (!uuid(b.reunion_id)) return fail("Reunión inválida.");
      return json(await transcribir(b.reunion_id as string, Number(b.n) || 0));
    }

    if (accion === "ia") {
      if (!escribe) return fail("Tu cuenta es de solo lectura.", 403);
      return json({ r: await ia(b) });
    }

    // ---------- usuarios (solo admin) ----------
    if (accion.startsWith("usuario")) {
      if (yo.rol !== "admin") return fail("Solo un administrador gestiona usuarios.", 403);
      if (accion === "usuarios_listar") {
        const u = await sql`select m.user_id, m.nombre, m.rol, m.activo, u.email from actas_proinpa.miembros m join auth.users u on u.id = m.user_id order by m.creado`;
        return json({ usuarios: u });
      }
      if (accion === "usuario_crear") {
        const email = String(b.email || "").trim().toLowerCase(), nombre = String(b.nombre || "").trim();
        const rol = ["admin", "secretario", "lector"].includes(String(b.rol)) ? String(b.rol) : "secretario";
        const pass = String(b.password || "");
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !nombre) return fail("Escribe un correo válido y el nombre.");
        let uid: string | null = null;
        const ex = await sql`select id from auth.users where lower(email) = ${email} limit 1`;
        if (ex.length) {
          uid = ex[0].id; // ya tenía cuenta en otro sistema: se le da acceso con su misma contraseña
        } else {
          if (pass.length < 8) return fail("La contraseña debe tener al menos 8 caracteres.");
          const { data, error } = await sb.auth.admin.createUser({ email, password: pass, email_confirm: true, user_metadata: { nombre } });
          if (error || !data?.user) return fail(error?.message || "No se pudo crear la cuenta.");
          uid = data.user.id;
        }
        await sql`insert into actas_proinpa.miembros (user_id, nombre, rol) values (${uid}, ${nombre}, ${rol})
          on conflict (user_id) do update set nombre = excluded.nombre, rol = excluded.rol, activo = true`;
        return json({ ok: true, existente: ex.length > 0 });
      }
      if (accion === "usuario_estado") {
        if (!uuid(b.user_id)) return fail("Usuario inválido.");
        if (b.user_id === yo.id) return fail("No puedes desactivar tu propia cuenta.");
        await sql`update actas_proinpa.miembros set activo = ${!!b.activo} where user_id = ${b.user_id as string}`;
        return json({ ok: true });
      }
    }
    return fail("Acción desconocida.");
  } catch (e) {
    console.error(e);
    return fail(String((e as Error)?.message || e), 500);
  }
});
