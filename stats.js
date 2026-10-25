// Tipos de jugada que la IA puede detectar y cómo cuentan en las estadísticas.
export const TIPOS = {
  tiro2_anotado: { label: 'Canasta de 2', pts: 2 },
  tiro2_fallado: { label: 'Tiro de 2 fallado', pts: 0 },
  tiro3_anotado: { label: 'Triple anotado', pts: 3 },
  tiro3_fallado: { label: 'Triple fallado', pts: 0 },
  tl_anotado: { label: 'Tiro libre anotado', pts: 1 },
  tl_fallado: { label: 'Tiro libre fallado', pts: 0 },
  rebote_ofensivo: { label: 'Rebote ofensivo', pts: 0 },
  rebote_defensivo: { label: 'Rebote defensivo', pts: 0 },
  asistencia: { label: 'Asistencia', pts: 0 },
  robo: { label: 'Robo', pts: 0 },
  tapon: { label: 'Tapón', pts: 0 },
  perdida: { label: 'Pérdida', pts: 0 },
  falta: { label: 'Falta personal', pts: 0 },
};

// Columnas de la tabla de estadísticas, con su explicación.
export const COLUMNAS = [
  { id: 'pts', label: 'PTS', nombre: 'Puntos', expl: 'Puntos anotados (canastas de 2, triples y tiros libres).' },
  { id: 't2', label: 'T2', nombre: 'Tiros de 2', expl: 'Canastas de 2 anotadas / intentadas.' },
  { id: 't3', label: 'T3', nombre: 'Triples', expl: 'Triples anotados / intentados.' },
  { id: 'tl', label: 'TL', nombre: 'Tiros libres', expl: 'Tiros libres anotados / intentados.' },
  { id: 'tc_pct', label: 'TC%', nombre: 'Acierto en tiros de campo', expl: 'Porcentaje de acierto sumando tiros de 2 y triples. Por encima del 45% es muy bueno.' },
  { id: 'ro', label: 'RO', nombre: 'Rebotes ofensivos', expl: 'Rebotes cogidos tras un fallo propio: dan una segunda oportunidad de anotar.' },
  { id: 'rd', label: 'RD', nombre: 'Rebotes defensivos', expl: 'Rebotes cogidos tras un fallo del rival: terminan su ataque.' },
  { id: 'reb', label: 'REB', nombre: 'Rebotes totales', expl: 'Rebotes ofensivos + defensivos.' },
  { id: 'ast', label: 'AST', nombre: 'Asistencias', expl: 'Pases que acaban directamente en canasta de un compañero.' },
  { id: 'rob', label: 'ROB', nombre: 'Robos', expl: 'Balones quitados al rival (interceptar un pase o robar el bote).' },
  { id: 'tap', label: 'TAP', nombre: 'Tapones', expl: 'Tiros del rival bloqueados.' },
  { id: 'per', label: 'PER', nombre: 'Pérdidas', expl: 'Balones perdidos sin tirar: pase malo, pasos, dobles, fuera, etc.' },
  { id: 'fal', label: 'FAL', nombre: 'Faltas', expl: 'Faltas personales cometidas.' },
  { id: 'val', label: 'VAL', nombre: 'Valoración', expl: 'Resumen de la aportación: puntos + rebotes + asistencias + robos + tapones − tiros fallados − pérdidas − faltas.' },
];

function vacio() {
  return { pts: 0, t2a: 0, t2i: 0, t3a: 0, t3i: 0, tla: 0, tli: 0, ro: 0, rd: 0, ast: 0, rob: 0, tap: 0, per: 0, fal: 0 };
}

function sumar(s, tipo) {
  switch (tipo) {
    case 'tiro2_anotado': s.t2a++; s.t2i++; s.pts += 2; break;
    case 'tiro2_fallado': s.t2i++; break;
    case 'tiro3_anotado': s.t3a++; s.t3i++; s.pts += 3; break;
    case 'tiro3_fallado': s.t3i++; break;
    case 'tl_anotado': s.tla++; s.tli++; s.pts += 1; break;
    case 'tl_fallado': s.tli++; break;
    case 'rebote_ofensivo': s.ro++; break;
    case 'rebote_defensivo': s.rd++; break;
    case 'asistencia': s.ast++; break;
    case 'robo': s.rob++; break;
    case 'tapon': s.tap++; break;
    case 'perdida': s.per++; break;
    case 'falta': s.fal++; break;
  }
}

function pct(a, i) {
  return i ? Math.round((a / i) * 100) : null;
}

// Añade los campos derivados (rebotes totales, porcentajes, valoración).
function completar(s) {
  const fallados = (s.t2i - s.t2a) + (s.t3i - s.t3a) + (s.tli - s.tla);
  return {
    ...s,
    reb: s.ro + s.rd,
    t2: `${s.t2a}/${s.t2i}`,
    t3: `${s.t3a}/${s.t3i}`,
    tl: `${s.tla}/${s.tli}`,
    t2_pct: pct(s.t2a, s.t2i),
    t3_pct: pct(s.t3a, s.t3i),
    tl_pct: pct(s.tla, s.tli),
    tc_pct: pct(s.t2a + s.t3a, s.t2i + s.t3i),
    val: s.pts + s.ro + s.rd + s.ast + s.rob + s.tap - fallados - s.per - s.fal,
  };
}

// Calcula estadísticas por equipo y por jugador a partir de la lista de eventos.
export function calcular(eventos) {
  const equipos = { nuestro: vacio(), rival: vacio() };
  const jugadores = { nuestro: {}, rival: {} };
  const marcador = [{ t: 0, nuestro: 0, rival: 0 }];
  let pn = 0, pr = 0;

  const ordenados = [...eventos].filter(e => TIPOS[e.tipo]).sort((a, b) => a.t - b.t);
  for (const e of ordenados) {
    const eq = e.equipo === 'rival' ? 'rival' : 'nuestro';
    sumar(equipos[eq], e.tipo);
    const dorsal = (e.dorsal ?? '').toString().trim() || '?';
    jugadores[eq][dorsal] ??= vacio();
    sumar(jugadores[eq][dorsal], e.tipo);
    const pts = TIPOS[e.tipo].pts;
    if (pts) {
      if (eq === 'nuestro') pn += pts; else pr += pts;
      marcador.push({ t: e.t, nuestro: pn, rival: pr });
    }
  }

  const lista = eq => Object.entries(jugadores[eq])
    .map(([dorsal, s]) => ({ dorsal, ...completar(s) }))
    .sort((a, b) => (a.dorsal === '?') - (b.dorsal === '?') || b.pts - a.pts || b.val - a.val);

  return {
    equipos: { nuestro: completar(equipos.nuestro), rival: completar(equipos.rival) },
    jugadores: { nuestro: lista('nuestro'), rival: lista('rival') },
    marcador,
  };
}

export function formatoTiempo(seg) {
  seg = Math.max(0, Math.round(seg || 0));
  const h = Math.floor(seg / 3600);
  const m = Math.floor((seg % 3600) / 60);
  const s = seg % 60;
  const mm = String(m).padStart(h ? 2 : 1, '0');
  return `${h ? h + ':' : ''}${mm}:${String(s).padStart(2, '0')}`;
}

export function leerTiempo(txt) {
  const partes = String(txt).trim().split(':').map(Number);
  if (partes.some(isNaN)) return null;
  return partes.reduce((acc, n) => acc * 60 + n, 0);
}
