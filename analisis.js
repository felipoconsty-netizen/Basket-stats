// Cómo se le pide a la IA que analice el partido, tramo a tramo.
import { generar } from './gemini.js';
import { TIPOS, calcular, formatoTiempo } from './stats.js';

const ESQUEMA_TRAMO = {
  type: 'OBJECT',
  properties: {
    eventos: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          tiempo: { type: 'STRING', description: 'Momento del vídeo completo en formato MM:SS o H:MM:SS' },
          equipo: { type: 'STRING', enum: ['nuestro', 'rival'] },
          dorsal: { type: 'STRING', nullable: true, description: 'Número de camiseta del jugador, o null si no se ve' },
          tipo: { type: 'STRING', enum: Object.keys(TIPOS) },
          descripcion: { type: 'STRING' },
          confianza: { type: 'STRING', enum: ['alta', 'media', 'baja'] },
        },
        required: ['tiempo', 'equipo', 'tipo', 'descripcion', 'confianza'],
      },
    },
    momentos: {
      type: 'ARRAY',
      description: 'Momentos destacados del tramo (rachas, jugadas espectaculares, cambios de dinámica, tiempos muertos, lesiones, técnicas...)',
      items: {
        type: 'OBJECT',
        properties: {
          tiempo: { type: 'STRING' },
          descripcion: { type: 'STRING' },
        },
        required: ['tiempo', 'descripcion'],
      },
    },
    marcador_visible: { type: 'STRING', nullable: true, description: 'Marcador si se ve en pantalla al final del tramo, p. ej. "34-30"' },
    resumen_tramo: { type: 'STRING', description: 'Qué ha pasado en este tramo, 2-4 frases' },
  },
  required: ['eventos', 'momentos', 'resumen_tramo'],
};

const ESQUEMA_RESUMEN = {
  type: 'OBJECT',
  properties: {
    resumen: { type: 'STRING', description: 'Crónica del partido en 3-5 párrafos separados por líneas en blanco' },
    puntos_fuertes: { type: 'ARRAY', items: { type: 'STRING' } },
    a_mejorar: { type: 'ARRAY', items: { type: 'STRING' } },
    jugador_destacado: { type: 'STRING' },
  },
  required: ['resumen', 'puntos_fuertes', 'a_mejorar', 'jugador_destacado'],
};

function describirEquipos(partido) {
  const plantilla = partido.plantilla?.trim()
    ? `\nPlantilla de nuestro equipo (dorsal - nombre):\n${partido.plantilla.trim()}`
    : '';
  return `- "nuestro": ${partido.nuestro.nombre || 'nuestro equipo'}, con camiseta ${partido.nuestro.color || '(color no indicado)'}.
- "rival": ${partido.rival.nombre || 'el rival'}, con camiseta ${partido.rival.color || '(color no indicado)'}.${plantilla}`;
}

function promptTramo(partido, inicio, fin) {
  return `Eres un estadístico profesional de baloncesto. Estás viendo un tramo de la grabación de un partido completo.
Este tramo va del minuto ${formatoTiempo(inicio)} al ${formatoTiempo(fin)} del vídeo completo.

Equipos:
${describirEquipos(partido)}
${partido.notas?.trim() ? `\nNotas del usuario: ${partido.notas.trim()}\n` : ''}
Apunta TODAS las acciones estadísticas del tramo, de los dos equipos, como haría un anotador oficial:
- tiro2_anotado / tiro2_fallado, tiro3_anotado / tiro3_fallado (triple solo si se tira desde fuera de la línea de 3), tl_anotado / tl_fallado (cada tiro libre es un evento).
- rebote_ofensivo (lo coge el mismo equipo que falló) / rebote_defensivo (lo coge el equipo que defendía).
- asistencia: solo el pase que lleva DIRECTAMENTE a una canasta anotada. El evento es para el pasador.
- robo: el defensor quita el balón (el equipo que lo pierde tiene además una "perdida").
- tapon: el defensor bloquea un tiro (el tiro bloqueado también es un tiro fallado del atacante).
- perdida: pase malo, pasos, dobles, campo atrás, fuera de banda, falta en ataque, etc.
- falta: falta personal, para quien la comete.

Reglas:
- "tiempo" es el momento en el vídeo COMPLETO (entre ${formatoTiempo(inicio)} y ${formatoTiempo(fin)}), no desde el inicio del tramo.
- "dorsal": solo si lees el número con claridad; si no, null. No te lo inventes.
- Ignora repeticiones a cámara lenta, descansos y tiempo muerto: no cuentes la misma jugada dos veces.
- Si la cámara no deja ver bien una acción, apúntala con confianza "baja".
- Escribe las descripciones en español, cortas (p. ej. "Entrada por la izquierda tras robo").`;
}

// Algunos modelos devuelven el tiempo relativo al tramo: lo corregimos.
function tiempoAbsoluto(segs, inicio, fin) {
  const ok = segs.filter(t => t != null);
  if (!ok.length || inicio === 0) return segs;
  const dentro = ok.filter(t => t >= inicio - 5 && t <= fin + 5).length;
  const relativos = ok.filter(t => t <= fin - inicio + 5).length;
  if (dentro < ok.length / 2 && relativos >= ok.length / 2) return segs.map(t => t == null ? t : t + inicio);
  return segs;
}

function aSegundos(txt) {
  const partes = String(txt || '').trim().split(':').map(Number);
  if (!partes.length || partes.some(isNaN)) return null;
  return partes.reduce((acc, n) => acc * 60 + n, 0);
}

export function crearTramos(duracion, minutos) {
  const largo = minutos * 60;
  const tramos = [];
  for (let t = 0; t < duracion; t += largo) {
    tramos.push({ inicio: t, fin: Math.min(t + largo, duracion), estado: 'pendiente' });
  }
  // Un último trocito de pocos segundos se une al anterior.
  if (tramos.length > 1 && tramos.at(-1).fin - tramos.at(-1).inicio < 60) {
    tramos.at(-2).fin = tramos.pop().fin;
  }
  return tramos;
}

let siguienteId = 1;
export const nuevoId = () => `e${Date.now().toString(36)}${(siguienteId++).toString(36)}`;

export async function analizarTramo(ajustes, partido, archivo, tramo) {
  const partes = [
    {
      fileData: { mimeType: archivo.mimeType || 'video/mp4', fileUri: archivo.uri },
      videoMetadata: {
        startOffset: `${Math.floor(tramo.inicio)}s`,
        endOffset: `${Math.ceil(tramo.fin)}s`,
        ...(ajustes.fps && ajustes.fps !== 1 ? { fps: ajustes.fps } : {}),
      },
    },
    { text: promptTramo(partido, tramo.inicio, tramo.fin) },
  ];
  const r = await generar(ajustes.clave, ajustes.modelo, partes, ESQUEMA_TRAMO, { resolucion: ajustes.resolucion });

  const eventos = r.eventos || [];
  const momentos = r.momentos || [];
  const tEv = tiempoAbsoluto(eventos.map(e => aSegundos(e.tiempo)), tramo.inicio, tramo.fin);
  const tMo = tiempoAbsoluto(momentos.map(m => aSegundos(m.tiempo)), tramo.inicio, tramo.fin);
  return {
    eventos: eventos.map((e, i) => ({
      id: nuevoId(),
      t: tEv[i] ?? tramo.inicio,
      equipo: e.equipo === 'rival' ? 'rival' : 'nuestro',
      dorsal: e.dorsal ? String(e.dorsal).replace(/[^0-9]/g, '') || null : null,
      tipo: e.tipo,
      descripcion: e.descripcion || '',
      confianza: e.confianza || 'media',
    })).filter(e => TIPOS[e.tipo]),
    momentos: momentos.map((m, i) => ({ id: nuevoId(), t: tMo[i] ?? tramo.inicio, descripcion: m.descripcion })),
    resumen: r.resumen_tramo || '',
    marcador: r.marcador_visible || null,
  };
}

export async function generarResumen(ajustes, partido, eventos, momentos, tramos) {
  const est = calcular(eventos);
  const n = partido.nuestro.nombre || 'Nuestro equipo';
  const r = partido.rival.nombre || 'Rival';
  const linea = s => `PTS ${s.pts}, T2 ${s.t2}, T3 ${s.t3}, TL ${s.tl}, REB ${s.reb} (RO ${s.ro}), AST ${s.ast}, ROB ${s.rob}, TAP ${s.tap}, PER ${s.per}, FAL ${s.fal}`;
  const jugadores = est.jugadores.nuestro.map(j => `#${j.dorsal}: ${linea(j)}, VAL ${j.val}`).join('\n');
  const cronica = tramos.filter(t => t.resumen).map(t => `[${formatoTiempo(t.inicio)}-${formatoTiempo(t.fin)}] ${t.resumen}${t.marcador ? ` (marcador en pantalla: ${t.marcador})` : ''}`).join('\n');
  const destacados = momentos.map(m => `[${formatoTiempo(m.t)}] ${m.descripcion}`).join('\n');

  const prompt = `Eres el entrenador asistente de ${n}. Escribe en español el informe del partido contra ${r} para el equipo.

Estadísticas (detectadas automáticamente del vídeo, pueden tener algún error):
${n}: ${linea(est.equipos.nuestro)}
${r}: ${linea(est.equipos.rival)}

Por jugador de ${n}:
${jugadores || '(sin dorsales identificados)'}
${partido.plantilla?.trim() ? `\nPlantilla (dorsal - nombre):\n${partido.plantilla.trim()}\n` : ''}
Lo que pasó en cada tramo:
${cronica}

Momentos destacados:
${destacados}

Escribe:
- "resumen": una crónica clara del partido (cómo empezó, rachas, momentos decisivos, cómo terminó), usando los nombres de los jugadores si los conoces.
- "puntos_fuertes": 3-5 cosas que el equipo hizo bien, apoyadas en los números.
- "a_mejorar": 3-5 cosas concretas para trabajar en los entrenamientos.
- "jugador_destacado": quién destacó y por qué, en una frase.`;

  return generar(ajustes.clave, ajustes.modelo, [{ text: prompt }], ESQUEMA_RESUMEN);
}

// Partido inventado para ver cómo queda el informe sin vídeo ni clave.
export function partidoDemo() {
  let semilla = 7;
  const azar = () => (semilla = (semilla * 16807) % 2147483647) / 2147483647;
  const elegir = lista => lista[Math.floor(azar() * lista.length)];
  const dorsales = { nuestro: ['4', '7', '8', '10', '11', '14', '23'], rival: ['5', '6', '9', '12', '15', '21'] };
  const eventos = [];
  const momentos = [];
  const duracion = 80 * 60;
  const ev = (t, equipo, tipo, descripcion, dorsal = elegir(dorsales[equipo])) =>
    eventos.push({ id: nuevoId(), t: Math.round(t), equipo, dorsal, tipo, descripcion, confianza: azar() < 0.8 ? 'alta' : azar() < 0.5 ? 'media' : 'baja' });

  let t = 20;
  let ataque = 'nuestro';
  while (t < duracion - 30) {
    const def = ataque === 'nuestro' ? 'rival' : 'nuestro';
    const ventaja = ataque === 'nuestro' ? 0.04 : 0;
    const x = azar();
    if (x < 0.13) {
      ev(t, ataque, 'perdida', elegir(['Pase interceptado', 'Pasos', 'Balón fuera']));
      if (azar() < 0.55) ev(t, def, 'robo', 'Robo en la línea de pase');
    } else if (x < 0.22) {
      ev(t, def, 'falta', 'Falta en el tiro');
      const tirador = elegir(dorsales[ataque]);
      for (let k = 0; k < 2; k++) ev(t + 20 + k * 8, ataque, azar() < 0.68 ? 'tl_anotado' : 'tl_fallado', 'Tiro libre', tirador);
    } else {
      const triple = azar() < 0.33;
      const entra = azar() < (triple ? 0.31 : 0.47) + ventaja;
      const tirador = elegir(dorsales[ataque]);
      if (azar() < 0.08) ev(t - 1, def, 'tapon', 'Tapón');
      ev(t, ataque, `${triple ? 'tiro3' : 'tiro2'}_${entra ? 'anotado' : 'fallado'}`, triple ? 'Triple desde la esquina' : elegir(['Entrada', 'Tiro a media distancia', 'Canasta bajo el aro']), tirador);
      if (entra && azar() < 0.55) ev(t - 2, ataque, 'asistencia', 'Pase para la canasta', elegir(dorsales[ataque].filter(d => d !== tirador)));
      if (!entra) {
        const ofensivo = azar() < 0.27 + ventaja;
        ev(t + 2, ofensivo ? ataque : def, ofensivo ? 'rebote_ofensivo' : 'rebote_defensivo', 'Rebote');
        if (ofensivo) { t += 8; continue; }
      }
    }
    ataque = def;
    t += 12 + azar() * 20;
  }
  momentos.push(
    { id: nuevoId(), t: 9 * 60, descripcion: 'Parcial de 8-0 tras dos robos seguidos.' },
    { id: nuevoId(), t: 31 * 60, descripcion: 'Tiempo muerto del rival para cortar la racha.' },
    { id: nuevoId(), t: 58 * 60, descripcion: 'Triple del #10 que pone por delante al equipo.' },
    { id: nuevoId(), t: 77 * 60, descripcion: 'Dos tiros libres decisivos en el último minuto.' },
  );
  return {
    partido: {
      nuestro: { nombre: 'Mi equipo', color: 'blanca' },
      rival: { nombre: 'CB Rival', color: 'azul' },
      plantilla: '4 - Marc\n7 - Pol\n8 - Àlex\n10 - Jan\n11 - Biel\n14 - Nil\n23 - Hugo',
      notas: '',
      fecha: new Date().toISOString().slice(0, 10),
    },
    duracion,
    eventos,
    momentos,
    tramos: [],
    resumen: {
      resumen: 'Este es un partido de EJEMPLO con datos inventados, para que veas cómo será el informe.\n\nCuando analices un vídeo real, aquí aparecerá la crónica del partido: cómo empezó, las rachas de cada equipo, los momentos decisivos y cómo terminó.',
      puntos_fuertes: ['Buena presión en la línea de pase: muchos robos.', 'Más rebotes ofensivos que el rival.'],
      a_mejorar: ['Demasiadas pérdidas por pases forzados.', 'Porcentaje de tiros libres mejorable.'],
      jugador_destacado: 'Ejemplo: el #10, por su anotación y el triple decisivo.',
    },
    demo: true,
  };
}
