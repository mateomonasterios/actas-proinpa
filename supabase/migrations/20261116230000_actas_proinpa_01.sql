-- Actas PROINPA · esquema propio dentro del proyecto Disruptivo 360.
-- Nadie lee ni escribe directo desde el navegador: todo pasa por la función «actas-proinpa» (service_role).
create schema if not exists actas_proinpa;
revoke all on schema actas_proinpa from anon, authenticated;

-- Personas que pueden entrar a la app (usuario de Supabase Auth) y su rol.
create table actas_proinpa.miembros (
  user_id uuid primary key references auth.users(id) on delete cascade,
  nombre text not null,
  rol text not null default 'secretario' check (rol in ('admin','secretario','lector')),
  activo boolean not null default true,
  creado timestamptz not null default now()
);

-- Una reunión, asamblea, curso o taller con su grabación y su acta.
create table actas_proinpa.reuniones (
  id uuid primary key default gen_random_uuid(),
  area text not null default 'asambleas' check (area in ('directorio','asambleas','cursos')),
  estado text not null default 'borrador' check (estado in ('borrador','grabando','enviada')),
  meta jsonb not null default '{}'::jsonb,          -- tipo, entidad, fecha, hora, lugar, preside, secretario, convocatoria, total, regla
  asistentes jsonb not null default '[]'::jsonb,    -- [{n, c, p, d, l}]
  orden jsonb not null default '[]'::jsonb,         -- puntos del orden del día
  segmentos jsonb not null default '[]'::jsonb,     -- transcripción [{t, x, mark?}]
  duracion_ms bigint not null default 0,
  acta jsonb,                                        -- acta generada
  acta_html text,                                    -- acta con las correcciones a mano
  creado_por uuid references auth.users(id) on delete set null,
  creado timestamptz not null default now(),
  actualizado timestamptz not null default now(),
  enviado timestamptz
);
create index reuniones_area_idx on actas_proinpa.reuniones (area, creado desc);

-- Documentos de contexto (convocatoria, orden del día, lista de miembros…): se guarda su texto.
create table actas_proinpa.documentos (
  id uuid primary key default gen_random_uuid(),
  reunion_id uuid not null references actas_proinpa.reuniones(id) on delete cascade,
  nombre text not null,
  ext text not null default 'txt',
  paginas int not null default 0,
  texto text not null default '',
  creado timestamptz not null default now()
);
create index documentos_reunion_idx on actas_proinpa.documentos (reunion_id);

-- Tramos de audio grabados (cada uno es un archivo independiente en el bucket privado).
create table actas_proinpa.audios (
  reunion_id uuid not null references actas_proinpa.reuniones(id) on delete cascade,
  n int not null,
  path text not null,
  inicio_ms bigint not null default 0,
  dur_ms bigint not null default 0,
  bytes bigint not null default 0,
  transcrito boolean not null default false,
  creado timestamptz not null default now(),
  primary key (reunion_id, n)
);

alter table actas_proinpa.miembros enable row level security;
alter table actas_proinpa.reuniones enable row level security;
alter table actas_proinpa.documentos enable row level security;
alter table actas_proinpa.audios enable row level security;
-- Sin políticas: anon y authenticated no ven nada. Solo service_role (la función).
revoke all on all tables in schema actas_proinpa from anon, authenticated;
grant usage on schema actas_proinpa to service_role;
grant all on all tables in schema actas_proinpa to service_role;

-- Bucket privado para el audio (hasta 50 MB por tramo).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('actas-proinpa', 'actas-proinpa', false, 52428800, array['audio/webm','audio/ogg','audio/mp4','audio/mpeg','audio/wav','audio/x-m4a','audio/aac'])
on conflict (id) do nothing;

-- Primer administrador: el dueño (Mateo). Él crea las cuentas de los demás desde la app.
insert into actas_proinpa.miembros (user_id, nombre, rol)
select id, 'Mateo Monasterios', 'admin' from auth.users where lower(email) = 'mateomonasteriosempresario@gmail.com'
on conflict (user_id) do nothing;
