import { listarModelos, modeloRecomendado, subirVideo, esperarVideoListo, infoVideo } from './gemini.js';
import { crearTramos, analizarTramo, generarResumen, partidoDemo, nuevoId } from './analisis.js';
import { TIPOS, COLUMNAS, calcular, formatoTiempo, leerTiempo } from './stats.js';

const $ = sel => document.querySelector(sel);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------- Estado guardado en el navegador ----------
function cargar(clave, porDefecto) {
  try { return JSON.parse(localStorage.getItem(clave)) ?? porDefecto; } catch { return porDefecto; }
}
function guardar(clave, valor) {
  try { localStorage.setItem(clave, JSON.stringify(valor)); } catch {}
}

const ajustes = Object.assign(
  { clave: '', modelo: 'gemini-3.8-flash', minutosTramo: 5, fps: 1, resolucion: '' },
  cargar('basket-ajustes', {}),
);
// Los análisis antiguos tenían un solo vídeo: los pasamos al formato con varias partes.
function adaptar(a) {
  if (a && !a.videos && a.video) {
    a.videos = [{ ...a.video, duracion: a.duracion, offset: 0, archivo: a.archivo || null }];
    delete a.video;
    delete a.archivo;
  }
  a?.tramos?.forEach(t => { t.video ??= 0; });
  return a;
}

let analisis = adaptar(cargar('basket-analisis', null));
let videosLocales = []; // los archivos de vídeo elegidos, en orden (no se pueden guardar en el navegador)
let urlsVideo = [];
let videoActual = -1; // qué parte está cargada en el reproductor
const LIMITE_GOOGLE = 2 * 1024 ** 3; // Google no acepta archivos de más de 2 GB
let parar = false;
let trabajando = false;

const guardarAjustes = () => guardar('basket-ajustes', ajustes);
const guardarAnalisis = () => guardar('basket-analisis', analisis);

// ---------- Avisos ----------
let temporizadorAviso;
function avisar(texto, error = false) {
  const el = $('#aviso');
  el.textContent = texto;
  el.className = 'toast' + (error ? ' error' : '');
  el.hidden = false;
  clearTimeout(temporizadorAviso);
  temporizadorAviso = setTimeout(() => (el.hidden = true), error ? 8000 : 3500);
}

// ---------- Pestañas ----------
function irA(vista) {
  document.querySelectorAll('.vista').forEach(v => v.classList.toggle('activa', v.id === 'vista-' + vista));
  document.querySelectorAll('.pestanas button').forEach(b => b.classList.toggle('activa', b.dataset.vista === vista));
  if (vista === 'revisar') pintarEventos();
  if (vista === 'informe') pintarInforme();
  window.scrollTo({ top: 0 });
}
document.querySelectorAll('.pestanas button').forEach(b => b.addEventListener('click', () => irA(b.dataset.vista)));
document.addEventListener('click', e => {
  const enlace = e.target.closest('[data-ir]');
  if (enlace) { e.preventDefault(); irA(enlace.dataset.ir); }
});

// ---------- Ajustes ----------
function pintarAjustes() {
  $('#clave').value = ajustes.clave;
  $('#minutos-tramo').value = String(ajustes.minutosTramo);
  $('#fps').value = String(ajustes.fps);
  $('#resolucion').value = ajustes.resolucion;
  const sel = $('#modelo');
  if (![...sel.options].some(o => o.value === ajustes.modelo)) sel.add(new Option(ajustes.modelo, ajustes.modelo));
  sel.value = ajustes.modelo;
  $('#aviso-clave').hidden = !!ajustes.clave;
}

async function cargarModelos(elegirRecomendado) {
  const modelos = await listarModelos(ajustes.clave);
  if (!modelos.length) return;
  const sel = $('#modelo');
  sel.innerHTML = '';
  modelos.forEach(m => sel.add(new Option(m, m)));
  if (elegirRecomendado || !modelos.includes(ajustes.modelo)) {
    ajustes.modelo = modeloRecomendado(modelos);
    guardarAjustes();
  }
  sel.value = ajustes.modelo;
}

$('#btn-guardar-clave').addEventListener('click', async () => {
  ajustes.clave = $('#clave').value.trim();
  guardarAjustes();
  pintarAjustes();
  const estado = $('#estado-clave');
  if (!ajustes.clave) { estado.textContent = ''; return; }
  estado.textContent = 'Comprobando...';
  try {
    await cargarModelos(true);
    estado.textContent = '✅ Clave correcta. Modelo elegido: ' + ajustes.modelo;
  } catch (err) {
    estado.textContent = '❌ ' + err.message;
  }
});
$('#modelo').addEventListener('change', e => { ajustes.modelo = e.target.value; guardarAjustes(); });
$('#minutos-tramo').addEventListener('change', e => { ajustes.minutosTramo = Number(e.target.value); guardarAjustes(); });
$('#fps').addEventListener('change', e => { ajustes.fps = Number(e.target.value); guardarAjustes(); });
$('#resolucion').addEventListener('change', e => { ajustes.resolucion = e.target.value; guardarAjustes(); });

// ---------- Partido ----------
const CAMPOS = ['nuestro-nombre', 'nuestro-color', 'rival-nombre', 'rival-color', 'plantilla', 'notas', 'fecha'];
let borrador = cargar('basket-borrador', {});
CAMPOS.forEach(id => {
  const el = $('#' + id);
  el.value = borrador[id] ?? (id === 'fecha' ? new Date().toISOString().slice(0, 10) : '');
  el.addEventListener('input', () => { borrador[id] = el.value; guardar('basket-borrador', borrador); });
});

function leerPartido() {
  return {
    nuestro: { nombre: $('#nuestro-nombre').value.trim(), color: $('#nuestro-color').value.trim() },
    rival: { nombre: $('#rival-nombre').value.trim(), color: $('#rival-color').value.trim() },
    plantilla: $('#plantilla').value,
    notas: $('#notas').value,
    fecha: $('#fecha').value,
  };
}

// Si el partido está en varios vídeos, se pueden elegir de golpe o de uno en uno, y se ordenan
// por el nombre del archivo (parte1, parte2... o la fecha que pone el móvil).
function ponerVideos(archivos) {
  videosLocales = [...archivos].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  if (!videosLocales.length) return quitarVideos();
  urlsVideo.forEach(u => URL.revokeObjectURL(u));
  urlsVideo = videosLocales.map(f => URL.createObjectURL(f));
  videoActual = -1;
  cargarEnReproductor(0);
  $('#previa').src = urlsVideo[0];
  $('#previa').hidden = false;
  $('#reproductor').hidden = false;
  $('#sin-video').hidden = true;
  $('#zona-video').classList.add('con-video');
  const mb = f => (f.size / 1024 / 1024).toFixed(0);
  $('#texto-video').innerHTML = videosLocales.length === 1
    ? `✅ ${esc(videosLocales[0].name)} (${mb(videosLocales[0])} MB) — toca para cambiarlo`
    : `✅ Partido en ${videosLocales.length} partes, en este orden:<br>` +
      videosLocales.map((f, i) => `${i + 1}. ${esc(f.name)} (${mb(f)} MB)`).join('<br>') +
      '<br><small>Se ordenan por el nombre del archivo.</small>';
  if (videosLocales.length === 1) $('#texto-video').innerHTML += '<br><small>Si el partido tiene más partes, toca otra vez para añadirlas.</small>';
  else $('#texto-video').innerHTML += '<br><small>Toca otra vez para añadir otra parte.</small>';
  $('#btn-quitar-videos').hidden = false;
}

function quitarVideos() {
  videosLocales = [];
  urlsVideo.forEach(u => URL.revokeObjectURL(u));
  urlsVideo = [];
  videoActual = -1;
  for (const id of ['#previa', '#reproductor']) { $(id).removeAttribute('src'); $(id).hidden = true; }
  $('#zona-video').classList.remove('con-video');
  $('#texto-video').innerHTML = 'Toca aquí para elegir el vídeo (MP4, MOV...).<br>Si el partido está en varias partes, añádelas todas (de golpe o de una en una).';
  $('#btn-quitar-videos').hidden = true;
}

// Cada vez que se eligen vídeos se añaden a los que ya había (sin repetir el mismo archivo).
$('#archivo-video').addEventListener('change', e => {
  const nuevos = [...e.target.files].filter(f => !videosLocales.some(v => v.name === f.name && v.size === f.size));
  if (nuevos.length) ponerVideos([...videosLocales, ...nuevos]);
  e.target.value = '';
});
$('#btn-quitar-videos').addEventListener('click', quitarVideos);

function cargarEnReproductor(i) {
  if (i === videoActual || !urlsVideo[i]) return;
  videoActual = i;
  $('#reproductor').src = urlsVideo[i];
}

function duracionDe(url) {
  return new Promise((ok, mal) => {
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.addEventListener('loadedmetadata', () => ok(v.duration), { once: true });
    v.addEventListener('error', () => mal(new Error('El navegador no puede leer uno de los vídeos. Prueba a convertirlo a MP4.')), { once: true });
    v.src = url;
  });
}

const mismosVideos = () => analisis?.videos?.length === videosLocales.length &&
  analisis.videos.every((v, i) => v.nombre === videosLocales[i].name && v.tamano === videosLocales[i].size);

// Lleva el reproductor al momento t del partido, cambiando de parte si hace falta.
function verEnVideo(t) {
  if (!videosLocales.length) return false;
  const vids = mismosVideos() ? analisis.videos : [];
  let i = 0;
  vids.forEach((v, k) => { if (t >= v.offset) i = k; });
  cargarEnReproductor(i);
  const v = $('#reproductor');
  const ir = () => { v.currentTime = Math.max(0, t - (vids[i]?.offset || 0) - 4); v.play(); };
  if (v.readyState >= 1) ir(); else v.addEventListener('loadedmetadata', ir, { once: true });
  return true;
}

$('#btn-analizar').addEventListener('click', async () => {
  if (trabajando) { irA('analizar'); return; }
  if (!ajustes.clave) { avisar('Primero pon tu clave de Gemini en Ajustes.', true); irA('ajustes'); return; }
  if (!videosLocales.length) { avisar('Elige el vídeo del partido.', true); return; }
  const grande = videosLocales.find(f => f.size > LIMITE_GOOGLE);
  if (grande) {
    avisar(`"${grande.name}" pesa más de 2 GB, el máximo que acepta Google. Usa el partido en varias partes más pequeñas.`, true);
    return;
  }
  const partido = leerPartido();
  if (!partido.nuestro.color || !partido.rival.color) { avisar('Indica el color de camiseta de los dos equipos.', true); return; }

  const pendiente = analisis && !analisis.demo && mismosVideos() && analisis.tramos?.some(t => t.estado !== 'hecho');
  if (pendiente && confirm('Ya hay un análisis a medias de este vídeo. ¿Quieres continuarlo? (Cancelar = empezar de cero)')) {
    analisis.partido = partido;
    guardarAnalisis();
    irA('analizar');
    return continuar();
  }
  if (analisis && !analisis.demo && analisis.eventos?.length &&
      !confirm('Se va a sustituir el análisis anterior. Si lo quieres conservar, cancela y guárdalo desde el Informe. ¿Seguir?')) return;

  let duraciones;
  try { duraciones = await Promise.all(urlsVideo.map(duracionDe)); } catch (err) { avisar(err.message, true); return; }
  // Cada parte empieza donde acaba la anterior: los tiempos son del partido entero.
  let offset = 0;
  const videos = videosLocales.map((f, i) => {
    const v = { nombre: f.name, tamano: f.size, tipo: f.type || 'video/mp4', duracion: duraciones[i], offset, archivo: null };
    offset += duraciones[i];
    return v;
  });
  analisis = {
    partido,
    duracion: offset,
    videos,
    tramos: videos.flatMap((v, i) => crearTramos(v.duracion, ajustes.minutosTramo)
      .map(t => ({ ...t, video: i, inicio: t.inicio + v.offset, fin: t.fin + v.offset }))),
    eventos: [],
    momentos: [],
    resumen: null,
  };
  guardarAnalisis();
  irA('analizar');
  continuar();
});

$('#btn-demo').addEventListener('click', verDemo);
$('#demo-informe').addEventListener('click', e => { e.preventDefault(); verDemo(); });
function verDemo() {
  if (analisis && !analisis.demo && analisis.eventos?.length &&
      !confirm('Se va a sustituir el análisis actual por el ejemplo. Si lo quieres conservar, guárdalo antes desde el Informe. ¿Seguir?')) return;
  analisis = partidoDemo();
  guardarAnalisis();
  irA('informe');
}

$('#abrir-json').addEventListener('change', async e => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const datos = JSON.parse(await f.text());
    if (!Array.isArray(datos.eventos)) throw new Error();
    analisis = adaptar(datos);
    guardarAnalisis();
    avisar('Partido cargado.');
    irA('informe');
  } catch {
    avisar('Ese archivo no es un partido guardado por esta app.', true);
  }
  e.target.value = '';
});

// ---------- Análisis ----------
function pintarProgreso(mensaje) {
  if (mensaje) $('#estado-analisis').textContent = mensaje;
  const tramos = analisis?.tramos || [];
  const hechos = tramos.filter(t => t.estado === 'hecho').length;
  $('#barra-progreso').style.width = tramos.length ? `${(hechos / tramos.length) * 100}%` : '0';
  $('#lista-tramos').innerHTML = tramos.map(t => {
    const icono = { hecho: '✅', analizando: '⏳', error: '⚠️', pendiente: '·' }[t.estado] || '·';
    const n = t.estado === 'hecho' ? ` · ${t.nEventos ?? 0} jugadas` : '';
    const parte = analisis.videos?.length > 1 ? `P${t.video + 1} · ` : '';
    return `<li class="${t.estado}" title="${esc(t.error || '')}">${icono} ${parte}${formatoTiempo(t.inicio)}–${formatoTiempo(t.fin)}${n}</li>`;
  }).join('');
  $('#btn-continuar').hidden = trabajando || !tramos.length || (hechos === tramos.length && analisis.resumen);
  $('#btn-cancelar').hidden = !trabajando;
}

const textoParte = i => analisis.videos.length > 1 ? `parte ${i + 1} de ${analisis.videos.length}` : '';

async function asegurarArchivoEnGoogle(i) {
  const video = analisis.videos[i];
  if (video.archivo) {
    const info = await infoVideo(ajustes.clave, video.archivo.name);
    if (info?.state === 'ACTIVE') return;
    video.archivo = null; // Google borra los vídeos a las 48 horas
  }
  const local = videosLocales[i];
  if (!local || local.name !== video.nombre || local.size !== video.tamano) {
    throw new Error(analisis.videos.length > 1
      ? 'Elige otra vez los mismos vídeos en la pestaña Partido para continuar.'
      : 'Elige otra vez el mismo vídeo en la pestaña Partido para continuar.');
  }
  const cual = textoParte(i) ? ` (${textoParte(i)})` : '';
  pintarProgreso(`Subiendo el vídeo${cual} a Google... 0%`);
  const archivo = await subirVideo(ajustes.clave, local, p => pintarProgreso(`Subiendo el vídeo${cual} a Google... ${Math.round(p * 100)}%`));
  pintarProgreso(`Google está preparando el vídeo${cual} (puede tardar unos minutos)...`);
  const listo = await esperarVideoListo(ajustes.clave, archivo);
  video.archivo = { name: listo.name, uri: listo.uri, mimeType: listo.mimeType || video.tipo };
  guardarAnalisis();
}

async function continuar() {
  if (trabajando || !analisis || analisis.demo) return;
  trabajando = true;
  parar = false;
  pintarProgreso();
  try {
    const tramos = analisis.tramos;
    const subidos = new Set();
    for (const tramo of tramos) {
      if (tramo.estado === 'hecho') continue;
      if (parar) throw new Error('Análisis en pausa.');
      if (!subidos.has(tramo.video)) {
        await asegurarArchivoEnGoogle(tramo.video);
        subidos.add(tramo.video);
      }
      tramo.estado = 'analizando';
      const num = tramos.indexOf(tramo) + 1;
      const base = `Analizando tramo ${num} de ${tramos.length} (${formatoTiempo(tramo.inicio)}–${formatoTiempo(tramo.fin)})`;
      // Cada tramo tarda un par de minutos: enseñamos el tiempo que lleva para que se vea que sigue vivo.
      const empezo = Date.now();
      let nota = 'normalmente tarda 1-3 minutos';
      const pintarTramo = () => pintarProgreso(`${base}... lleva ${formatoTiempo((Date.now() - empezo) / 1000)} (${nota})`);
      pintarTramo();
      const cronometro = setInterval(pintarTramo, 1000);
      try {
        const video = analisis.videos[tramo.video];
        const r = await analizarTramo(ajustes, analisis.partido, video.archivo, tramo, video.offset, textoParte(tramo.video),
          texto => { nota = texto; pintarTramo(); });
        analisis.eventos = analisis.eventos.filter(e => e.tramo !== tramo.inicio)
          .concat(r.eventos.map(e => ({ ...e, tramo: tramo.inicio })));
        analisis.momentos = analisis.momentos.filter(m => m.tramo !== tramo.inicio)
          .concat(r.momentos.map(m => ({ ...m, tramo: tramo.inicio })));
        Object.assign(tramo, { estado: 'hecho', resumen: r.resumen, marcador: r.marcador, nEventos: r.eventos.length, error: null });
      } catch (err) {
        Object.assign(tramo, { estado: 'error', error: err.message });
        guardarAnalisis();
        throw err;
      } finally {
        clearInterval(cronometro);
      }
      guardarAnalisis();
    }
    pintarProgreso('Escribiendo el resumen del partido...');
    analisis.resumen = await generarResumen(ajustes, analisis.partido, analisis.eventos, analisis.momentos, analisis.tramos);
    guardarAnalisis();
    trabajando = false;
    pintarProgreso('✅ ¡Análisis terminado! Revisa las jugadas o mira el informe.');
    avisar('¡Análisis terminado!');
    irA('informe');
  } catch (err) {
    trabajando = false;
    pintarProgreso('⚠️ ' + err.message + ' Pulsa "Reintentar / continuar" cuando quieras.');
    if (!parar) avisar(err.message, true);
  }
}
$('#btn-continuar').addEventListener('click', () => {
  analisis?.tramos?.forEach(t => { if (t.estado !== 'hecho') t.estado = 'pendiente'; });
  continuar();
});
$('#btn-cancelar').addEventListener('click', () => {
  parar = true;
  pintarProgreso('Se pausará al terminar el tramo actual...');
});

// ---------- Revisar jugadas ----------
const filtroTipo = $('#filtro-tipo');
Object.entries(TIPOS).forEach(([id, t]) => filtroTipo.add(new Option(t.label, id)));
['#filtro-equipo', '#filtro-tipo', '#filtro-dudosas'].forEach(s => $(s).addEventListener('change', pintarEventos));

function nombreEquipo(eq) {
  const p = analisis?.partido;
  return eq === 'rival' ? (p?.rival.nombre || 'Rival') : (p?.nuestro.nombre || 'Mi equipo');
}

function pintarEventos() {
  const cuerpo = $('#cuerpo-eventos');
  if (!analisis?.eventos?.length) {
    cuerpo.innerHTML = '<tr><td colspan="6" class="ayuda">No hay jugadas todavía.</td></tr>';
    $('#contador-eventos').textContent = '';
    return;
  }
  if (!videosLocales.length) { $('#sin-video').hidden = false; }
  const eq = $('#filtro-equipo').value, tipo = filtroTipo.value, dudosas = $('#filtro-dudosas').checked;
  const lista = analisis.eventos
    .filter(e => (!eq || e.equipo === eq) && (!tipo || e.tipo === tipo) && (!dudosas || e.confianza !== 'alta'))
    .sort((a, b) => a.t - b.t);
  const opcionesTipo = sel => Object.entries(TIPOS).map(([id, t]) => `<option value="${id}"${id === sel ? ' selected' : ''}>${t.label}</option>`).join('');
  cuerpo.innerHTML = lista.map(e => `
    <tr data-id="${e.id}" class="${e.confianza}" title="${e.confianza === 'alta' ? '' : 'La IA no está segura de esta jugada'}">
      <td><button class="tiempo" data-t="${e.t}">${formatoTiempo(e.t)}</button></td>
      <td><select data-campo="equipo">
        <option value="nuestro"${e.equipo === 'nuestro' ? ' selected' : ''}>${esc(nombreEquipo('nuestro'))}</option>
        <option value="rival"${e.equipo === 'rival' ? ' selected' : ''}>${esc(nombreEquipo('rival'))}</option>
      </select></td>
      <td class="dorsal"><input data-campo="dorsal" value="${esc(e.dorsal ?? '')}" inputmode="numeric" placeholder="?"></td>
      <td><select data-campo="tipo">${opcionesTipo(e.tipo)}</select></td>
      <td><input data-campo="descripcion" value="${esc(e.descripcion)}"></td>
      <td><button class="borrar" title="Borrar jugada">✕</button></td>
    </tr>`).join('');
  const dudosasTotal = analisis.eventos.filter(e => e.confianza !== 'alta').length;
  $('#contador-eventos').textContent = `${lista.length} de ${analisis.eventos.length} jugadas · ${dudosasTotal} dudosas (marcadas en amarillo)`;
}

$('#cuerpo-eventos').addEventListener('change', e => {
  const fila = e.target.closest('tr');
  const ev = analisis?.eventos.find(x => x.id === fila?.dataset.id);
  const campo = e.target.dataset.campo;
  if (!ev || !campo) return;
  ev[campo] = campo === 'dorsal' ? (e.target.value.replace(/[^0-9]/g, '') || null) : e.target.value;
  ev.confianza = 'alta'; // revisada a mano
  fila.className = 'alta';
  guardarAnalisis();
});
$('#cuerpo-eventos').addEventListener('click', e => {
  const fila = e.target.closest('tr');
  if (e.target.classList.contains('tiempo')) {
    if (!verEnVideo(Number(e.target.dataset.t))) { avisar('Elige el vídeo en la pestaña Partido para ver la jugada.', true); return; }
    $('#reproductor').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  if (e.target.classList.contains('borrar')) {
    analisis.eventos = analisis.eventos.filter(x => x.id !== fila.dataset.id);
    guardarAnalisis();
    pintarEventos();
  }
});
$('#btn-anadir').addEventListener('click', () => {
  if (!analisis) { avisar('Primero analiza un partido.', true); return; }
  const v = $('#reproductor');
  const offset = mismosVideos() ? analisis.videos[videoActual]?.offset || 0 : 0;
  const sugerido = videosLocales.length ? formatoTiempo(offset + v.currentTime) : '0:00';
  const txt = prompt('¿En qué momento del vídeo? (minutos:segundos)', sugerido);
  if (txt == null) return;
  const t = leerTiempo(txt);
  if (t == null) { avisar('Escribe el tiempo como 12:34', true); return; }
  analisis.eventos.push({ id: nuevoId(), t, equipo: 'nuestro', dorsal: null, tipo: 'tiro2_anotado', descripcion: 'Añadida a mano', confianza: 'alta' });
  guardarAnalisis();
  $('#filtro-equipo').value = ''; filtroTipo.value = ''; $('#filtro-dudosas').checked = false;
  pintarEventos();
  avisar('Jugada añadida: cambia el tipo y el dorsal en la tabla.');
});

// ---------- Informe ----------
function nombresPlantilla() {
  const mapa = {};
  (analisis?.partido?.plantilla || '').split('\n').forEach(l => {
    const m = l.match(/^\s*#?(\d+)\s*[-–:.]?\s*(.+?)\s*$/);
    if (m) mapa[m[1]] = m[2];
  });
  return mapa;
}

function filaBox(nombre, s, clase = '') {
  const celdas = COLUMNAS.map(c => {
    let v = s[c.id];
    if (c.id === 'tc_pct') v = v == null ? '–' : v + '%';
    return `<td>${esc(v)}</td>`;
  }).join('');
  return `<tr class="${clase}"><td>${nombre}</td>${celdas}</tr>`;
}

function tablaBox(eq, est, nombres) {
  const cab = COLUMNAS.map(c => `<th><abbr title="${esc(c.nombre + ': ' + c.expl)}">${c.label}</abbr></th>`).join('');
  const filas = est.jugadores[eq].map(j => {
    const nombre = j.dorsal === '?' ? '<i>Sin dorsal identificado</i>' : `#${esc(j.dorsal)}${nombres[j.dorsal] && eq === 'nuestro' ? ' ' + esc(nombres[j.dorsal]) : ''}`;
    return filaBox(nombre, j);
  }).join('');
  return `<div class="tabla-scroll"><table class="box"><thead><tr><th>Jugador</th>${cab}</tr></thead>
    <tbody>${filas}${filaBox('Total equipo', est.equipos[eq], 'total')}</tbody></table></div>`;
}

function comparativa(est) {
  const n = est.equipos.nuestro, r = est.equipos.rival;
  const filas = [
    ['Puntos', n.pts, r.pts],
    ['% tiros de campo', n.tc_pct ?? 0, r.tc_pct ?? 0, '%'],
    ['Triples anotados', n.t3a, r.t3a],
    ['% tiros libres', n.tl_pct ?? 0, r.tl_pct ?? 0, '%'],
    ['Rebotes', n.reb, r.reb],
    ['Rebotes ofensivos', n.ro, r.ro],
    ['Asistencias', n.ast, r.ast],
    ['Robos', n.rob, r.rob],
    ['Tapones', n.tap, r.tap],
    ['Pérdidas', n.per, r.per],
    ['Faltas', n.fal, r.fal],
  ];
  return `<table class="comparativa">${filas.map(([nom, a, b, suf = '']) => {
    const total = a + b || 1;
    return `<tr><td class="num" style="color:var(--nuestro)">${a}${suf}</td>
      <td class="barra-celda"><div class="nombre-stat">${nom}</div>
        <div class="duelo"><div class="n" style="width:${(a / total) * 100}%"></div><div class="r" style="width:${(b / total) * 100}%"></div></div></td>
      <td class="num" style="color:var(--rival)">${b}${suf}</td></tr>`;
  }).join('')}</table>`;
}

function grafico(est, duracion) {
  const puntos = est.marcador;
  const fin = Math.max(duracion || 0, puntos.at(-1)?.t || 1);
  const max = Math.max(10, ...puntos.map(p => Math.max(p.nuestro, p.rival)));
  const W = 600, H = 220, pad = 30;
  const x = t => pad + (t / fin) * (W - pad - 10);
  const y = v => H - pad - (v / max) * (H - pad - 10);
  const linea = eq => {
    let d = `M${x(0)},${y(0)}`;
    let prev = 0;
    for (const p of puntos) { d += ` L${x(p.t)},${y(prev)} L${x(p.t)},${y(p[eq])}`; prev = p[eq]; }
    return d + ` L${x(fin)},${y(prev)}`;
  };
  const marcasY = [0, Math.round(max / 2), max];
  const marcasX = [0, fin / 4, fin / 2, (fin * 3) / 4, fin];
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Evolución del marcador">
    ${marcasY.map(v => `<line x1="${pad}" x2="${W - 10}" y1="${y(v)}" y2="${y(v)}" stroke="var(--borde)"/><text x="${pad - 6}" y="${y(v) + 4}" font-size="11" text-anchor="end" fill="var(--suave)">${v}</text>`).join('')}
    ${marcasX.map(t => `<text x="${x(t)}" y="${H - 10}" font-size="11" text-anchor="middle" fill="var(--suave)">${formatoTiempo(t)}</text>`).join('')}
    <path d="${linea('rival')}" fill="none" stroke="var(--rival)" stroke-width="2.5"/>
    <path d="${linea('nuestro')}" fill="none" stroke="var(--nuestro)" stroke-width="2.5"/>
  </svg>`;
}

function pintarInforme() {
  const caja = $('#informe');
  if (!analisis?.eventos?.length) {
    caja.innerHTML = `<div class="tarjeta"><p class="ayuda">Aún no hay informe. Analiza un partido o mira el <a href="#" id="demo-informe2">ejemplo</a>.</p></div>`;
    $('#demo-informe2').addEventListener('click', e => { e.preventDefault(); verDemo(); });
    return;
  }
  const est = calcular(analisis.eventos);
  const p = analisis.partido;
  const nombres = nombresPlantilla();
  const N = esc(nombreEquipo('nuestro')), R = esc(nombreEquipo('rival'));
  const res = analisis.resumen;
  const incompleto = analisis.tramos?.some(t => t.estado !== 'hecho');
  const momentos = [...(analisis.momentos || [])].sort((a, b) => a.t - b.t);
  const glosario = COLUMNAS.map(c => `<div><dt>${c.label} · ${c.nombre}</dt><dd>${c.expl}</dd></div>`).join('');
  const dudosas = analisis.eventos.filter(e => e.confianza !== 'alta').length;

  caja.innerHTML = `
    <div class="tarjeta">
      ${analisis.demo ? '<div class="aviso-demo">👀 Esto es un <b>ejemplo con datos inventados</b> para que veas cómo queda el informe.</div>' : ''}
      ${incompleto ? '<div class="aviso-demo">⚠️ El análisis no ha terminado: faltan tramos por analizar. Ve a <a href="#" data-ir="analizar">Analizar</a> para continuar.</div>' : ''}
      <div class="marcador">
        <div class="nuestro"><div class="equipo">${N}</div><div class="puntos">${est.equipos.nuestro.pts}</div></div>
        <div class="guion">–</div>
        <div class="rival"><div class="equipo">${R}</div><div class="puntos">${est.equipos.rival.pts}</div></div>
      </div>
      <p class="ayuda" style="text-align:center">${esc(p.fecha || '')} · ${analisis.eventos.length} jugadas detectadas${dudosas ? ` · ${dudosas} dudosas sin revisar` : ''}</p>
      <div class="acciones no-imprimir">
        <button id="btn-imprimir">🖨️ Imprimir / PDF</button>
        <button id="btn-csv">📊 Descargar tabla (Excel)</button>
        <button id="btn-json">💾 Guardar partido</button>
        ${!analisis.demo && ajustes.clave ? '<button id="btn-resumen">✍️ Rehacer resumen con las correcciones</button>' : ''}
      </div>
    </div>

    ${res ? `<div class="tarjeta">
      <h2>Resumen del partido</h2>
      ${String(res.resumen || '').split(/\n\s*\n/).map(par => `<p>${esc(par)}</p>`).join('')}
      <p><b>⭐ Jugador destacado:</b> ${esc(res.jugador_destacado || '')}</p>
      <div class="listas">
        <div><h3>👍 Lo que hicimos bien</h3><ul>${(res.puntos_fuertes || []).map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>
        <div><h3>🎯 A mejorar</h3><ul>${(res.a_mejorar || []).map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>
      </div>
    </div>` : ''}

    <div class="tarjeta">
      <h2>Equipo contra equipo</h2>
      <div class="leyenda"><span class="n">${N}</span><span class="r">${R}</span></div>
      ${comparativa(est)}
    </div>

    <div class="tarjeta">
      <h2>Estadísticas de ${N}</h2>
      ${tablaBox('nuestro', est, nombres)}
      <h3>Estadísticas de ${R}</h3>
      ${tablaBox('rival', est, {})}
    </div>

    <div class="tarjeta">
      <h2>¿Qué significa cada número?</h2>
      <dl class="glosario">${glosario}</dl>
    </div>

    <div class="tarjeta grafico">
      <h2>Evolución del marcador</h2>
      <div class="leyenda"><span class="n">${N}</span><span class="r">${R}</span></div>
      ${grafico(est, analisis.duracion)}
      <p class="ayuda">El eje de abajo es el tiempo del vídeo (incluye pausas y descansos).</p>
    </div>

    ${momentos.length ? `<div class="tarjeta">
      <h2>Momentos clave</h2>
      <ul class="momentos">${momentos.map(m => `<li><button class="tiempo" data-t="${m.t}">${formatoTiempo(m.t)}</button><span>${esc(m.descripcion)}</span></li>`).join('')}</ul>
    </div>` : ''}
  `;

  $('#btn-imprimir').addEventListener('click', () => window.print());
  $('#btn-csv').addEventListener('click', () => descargarCSV(est, nombres));
  $('#btn-json').addEventListener('click', descargarJSON);
  $('#btn-resumen')?.addEventListener('click', rehacerResumen);
  caja.querySelectorAll('.momentos .tiempo').forEach(b => b.addEventListener('click', () => {
    if (!videosLocales.length) { avisar('Elige el vídeo en la pestaña Partido para ver este momento.', true); return; }
    irA('revisar');
    verEnVideo(Number(b.dataset.t));
  }));
}

function nombreArchivo(ext) {
  const p = analisis.partido;
  const base = `${p.fecha || 'partido'} ${p.nuestro.nombre || 'mi-equipo'} vs ${p.rival.nombre || 'rival'}`;
  return base.replace(/[^\w\-áéíóúàèòïüñç ]+/gi, '').trim().replace(/\s+/g, '_') + '.' + ext;
}

function descargar(nombre, contenido, tipo) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([contenido], { type: tipo }));
  a.download = nombre;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function descargarCSV(est, nombres) {
  const cols = COLUMNAS.map(c => c.id);
  const lineas = [['Equipo', 'Jugador', ...COLUMNAS.map(c => c.nombre)]];
  for (const eq of ['nuestro', 'rival']) {
    for (const j of est.jugadores[eq]) {
      const quien = j.dorsal === '?' ? 'Sin dorsal' : `#${j.dorsal}${eq === 'nuestro' && nombres[j.dorsal] ? ' ' + nombres[j.dorsal] : ''}`;
      lineas.push([nombreEquipo(eq), quien, ...cols.map(c => j[c] ?? '')]);
    }
    lineas.push([nombreEquipo(eq), 'TOTAL', ...cols.map(c => est.equipos[eq][c] ?? '')]);
  }
  // Punto y coma: así Excel en español lo abre bien en columnas.
  const csv = lineas.map(l => l.map(v => `"${String(v).replace(/"/g, '""')}"`).join(';')).join('\r\n');
  descargar(nombreArchivo('csv'), '﻿' + csv, 'text/csv;charset=utf-8');
}

function descargarJSON() {
  const datos = { ...analisis, videos: analisis.videos?.map(({ archivo, ...v }) => v) };
  descargar(nombreArchivo('json'), JSON.stringify(datos, null, 1), 'application/json');
  avisar('Partido guardado en tu carpeta de descargas. Puedes abrirlo luego desde "Partido".');
}

async function rehacerResumen() {
  const b = $('#btn-resumen');
  b.disabled = true;
  b.textContent = 'Escribiendo...';
  try {
    analisis.resumen = await generarResumen(ajustes, analisis.partido, analisis.eventos, analisis.momentos, analisis.tramos || []);
    guardarAnalisis();
    pintarInforme();
    avisar('Resumen actualizado.');
  } catch (err) {
    avisar(err.message, true);
    b.disabled = false;
    b.textContent = '✍️ Rehacer resumen con las correcciones';
  }
}

// ---------- Inicio ----------
pintarAjustes();
if (ajustes.clave) cargarModelos(false).catch(() => {});
if (analisis?.tramos?.length && !analisis.demo) {
  // Si la página se cerró a media análisis, los tramos "analizando" vuelven a pendientes.
  analisis.tramos.forEach(t => { if (t.estado === 'analizando') t.estado = 'pendiente'; });
  pintarProgreso(analisis.tramos.every(t => t.estado === 'hecho')
    ? 'Último análisis terminado.'
    : 'Hay un análisis a medias. Elige los mismos vídeos en Partido y pulsa "Reintentar / continuar".');
}
window.addEventListener('beforeunload', e => { if (trabajando) { e.preventDefault(); e.returnValue = ''; } });
