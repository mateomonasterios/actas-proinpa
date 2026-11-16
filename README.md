# Libro de Actas · Fundación PROINPA

App para grabar reuniones, asambleas, cursos y talleres y generar el acta o el informe con IA. Preparada para el señor Cristian Aparicio (Fundación PROINPA).

- Sitio estático para Vercel (sin compilación ni variables).
- La base de datos vive en Supabase, proyecto **Disruptivo 360**, esquema propio `actas_proinpa`.
- El acceso es privado: solo entran las personas registradas en `actas_proinpa.miembros`, con correo y contraseña de Supabase Auth.

## Qué hace

| Parte | Qué hace |
|---|---|
| Ingreso | Pantalla con la línea gráfica de PROINPA (paleta azul de medianoche y logo). Correo y contraseña. |
| Crear reunión | Elige el área (Directorio, Asambleas, Cursos o talleres), sube la convocatoria en PDF o Word y la IA extrae orden del día, miembros y datos. |
| Grabar | Hasta 3 horas. El audio se graba en tramos de 2 minutos (Opus a 32 kbps, poca batería) y cada tramo se sube al servidor. Si se corta (bloqueo, llamada, cierre), lo grabado queda guardado y se reanuda en el mismo registro. |
| Transcripción | En vivo con el reconocimiento de voz del navegador. Si se configura `OPENAI_API_KEY`, el servidor transcribe cada tramo de audio, lo que funciona aunque el celular esté bloqueado. |
| Reunión | Asistentes, quórum (50%+1, 2/3, 1/3, totalidad) y orden del día. Detección automática desde la grabación. |
| Acta | Acta formal (o informe de curso), editable, descargable para Word e imprimible a PDF. Se envía al historial del área. |
| Usuarios | El administrador da o quita acceso desde la app. |

## Archivos

- `index.html`, `estilos.css`, `app.js`: la app.
- `vendor-supabase.js`: cliente de Supabase (UMD).
- `supabase/migrations/20261116230000_actas_proinpa_01.sql`: esquema `actas_proinpa` (miembros, reuniones, documentos, audios) y bucket privado `actas-proinpa`. Sin políticas: el navegador no lee ni escribe directo.
- `supabase/functions/actas-proinpa/index.ts`: la función que hace todo (datos, audio, IA y usuarios). Revisa que quien llama esté en `actas_proinpa.miembros`.

## Secretos de Supabase

- `ANTHROPIC_API_KEY` (ya existe): IA con Claude (`claude-opus-5-5`).
- `OPENAI_API_KEY` (opcional): transcripción del audio en el servidor (`gpt-4o-transcribe`, con `whisper-1` de respaldo). Sin esta clave, la transcripción es la del navegador en vivo y el audio queda guardado igual.

## Publicar en Vercel

1. En Vercel: **Add New → Project**, elige este repositorio.
2. Framework: **Other**. Sin comandos de compilación ni variables.
3. **Deploy**. Vercel publica cada vez que se sube un cambio a `main`.

## Primer ingreso

El primer administrador es Mateo (cuenta de Disruptivo 360). Entra a la app, toca **Usuarios** y da acceso a Cristian Aparicio con su correo y una contraseña inicial.

## Límites conocidos

- iPhone: Safari detiene el micrófono al bloquear la pantalla. Lo grabado queda guardado y se reanuda al volver.
- Android con Chrome: el audio sigue grabando con la pantalla bloqueada; el reconocimiento de voz en vivo se pausa, por eso conviene la transcripción en el servidor.
