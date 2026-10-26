// Conexión con la API de Gemini (Google), que es la que "ve" el vídeo.
const BASE = 'https://generativelanguage.googleapis.com';
const TROZO = 16 * 1024 * 1024; // la subida se hace en trozos de 16 MB

const LIMITE_RESPUESTA = 6 * 60 * 1000; // un tramo normal tarda 1-3 minutos; más de 6 es que se ha colgado

const esperar = ms => new Promise(r => setTimeout(r, ms));

// Google explica en el error 429 qué límite se ha pasado (por minuto o por día) y cuánto esperar.
async function leerCuota(res) {
  let error = {};
  try { error = (await res.json()).error || {}; } catch {}
  const detalles = error.details || [];
  const ids = detalles.flatMap(d => d.violations || []).map(v => v.quotaId || '').join(' ');
  const retraso = detalles.find(d => d.retryDelay)?.retryDelay;
  return { porDia: /PerDay/i.test(ids), espera: retraso ? parseFloat(retraso) * 1000 : 0, ids };
}

const MENSAJE_DIA = 'Se ha acabado el uso gratuito de hoy para este modelo. Lo analizado queda guardado. ' +
  'Puedes: elegir otro modelo en Ajustes (cada uno tiene su propio límite) y pulsar "Reintentar / continuar"; ' +
  'esperar a mañana; o activar la facturación en Google AI Studio (un partido suele costar menos de 1 €).';

// limite: milisegundos que se espera cada intento antes de darlo por colgado y reintentar.
// onEstado recibe un texto para enseñar al usuario qué está pasando mientras se reintenta.
async function pedir(url, opciones, intentos = 4, { limite = 0, onEstado } = {}) {
  let esperas429 = 0;
  for (let i = 0; ; i++) {
    let res;
    const control = new AbortController();
    const reloj = limite ? setTimeout(() => control.abort(), limite) : null;
    try {
      res = await fetch(url, { ...opciones, signal: control.signal });
    } catch (err) {
      const colgado = control.signal.aborted;
      if (i >= intentos) {
        throw new Error(colgado
          ? 'Google no ha respondido después de varios intentos. Prueba otro modelo en Ajustes o tramos más cortos.'
          : 'Sin conexión con Google: ' + err.message);
      }
      onEstado?.(colgado ? `Google no responde, reintento (${i + 1} de ${intentos})...` : `Sin conexión, reintento (${i + 1} de ${intentos})...`);
      await esperar(2000 * 2 ** i);
      continue;
    } finally {
      clearTimeout(reloj);
    }
    if (res.ok) return res;
    // 429 = límite de uso. Si es el de cada minuto, se espera lo que diga Google y se sigue solo;
    // si es el del día, no sirve de nada esperar.
    if (res.status === 429) {
      const cuota = await leerCuota(res);
      if (cuota.porDia) throw new Error(MENSAJE_DIA);
      if (esperas429 < 30) {
        esperas429++;
        i--;
        const espera = Math.max(cuota.espera, 20000) + 5000;
        onEstado?.(`Google pide ir más despacio (límite por minuto de la clave gratuita). Espero ${Math.round(espera / 1000)} s y sigo solo...`);
        await esperar(espera);
        continue;
      }
      throw new Error('Google sigue limitando el uso de la clave gratuita' + (cuota.ids ? ` (${cuota.ids})` : '') + '. Espera un rato y pulsa "Reintentar / continuar".');
    }
    // 5xx = error temporal de Google
    if (res.status >= 500 && i < intentos) {
      onEstado?.(`Google ha dado un error temporal, reintento (${i + 1} de ${intentos})...`);
      await esperar(3000 * 2 ** i);
      continue;
    }
    let detalle = '';
    try { detalle = (await res.json()).error?.message || ''; } catch {}
    if (res.status === 400 && /API key/i.test(detalle)) throw new Error('La clave de Gemini no es válida. Revísala en Ajustes.');
    if (res.status === 403) throw new Error('La clave de Gemini no tiene permiso: ' + detalle);
    throw new Error(`Error de Gemini (${res.status}): ${detalle}`);
  }
}

export async function listarModelos(clave) {
  const res = await pedir(`${BASE}/v1beta/models?pageSize=1000`, { headers: { 'x-goog-api-key': clave } }, 1);
  const datos = await res.json();
  return (datos.models || [])
    .filter(m => m.supportedGenerationMethods?.includes('generateContent'))
    .map(m => m.name.replace('models/', ''))
    .filter(n => /^gemini-/.test(n) && !/(image|tts|audio|live|embedding|robotics|computer)/.test(n));
}

// Elige el modelo "flash" más reciente (rápido y con capa gratuita).
export function modeloRecomendado(modelos) {
  const version = n => (n.match(/gemini-(\d+(?:\.\d+)?)/) || [])[1] || '0';
  const candidatos = modelos.filter(n => /flash/.test(n) && !/lite/.test(n));
  const lista = (candidatos.length ? candidatos : modelos).slice().sort((a, b) =>
    parseFloat(version(b)) - parseFloat(version(a)) ||
    (/preview|exp/.test(a) - /preview|exp/.test(b)) ||
    a.length - b.length);
  return lista[0];
}

// Sube el vídeo a Google por trozos. onProgreso recibe un número de 0 a 1.
export async function subirVideo(clave, archivo, onProgreso) {
  const tipo = archivo.type || 'video/mp4';
  const inicio = await pedir(`${BASE}/upload/v1beta/files`, {
    method: 'POST',
    headers: {
      'x-goog-api-key': clave,
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(archivo.size),
      'X-Goog-Upload-Header-Content-Type': tipo,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ file: { display_name: archivo.name } }),
  });
  const urlSubida = inicio.headers.get('x-goog-upload-url');
  if (!urlSubida) throw new Error('Google no devolvió la dirección de subida.');

  let respuesta;
  for (let offset = 0; offset < archivo.size; offset += TROZO) {
    const fin = Math.min(offset + TROZO, archivo.size);
    const ultimo = fin >= archivo.size;
    const res = await pedir(urlSubida, {
      method: 'POST',
      headers: {
        'X-Goog-Upload-Offset': String(offset),
        'X-Goog-Upload-Command': ultimo ? 'upload, finalize' : 'upload',
      },
      body: archivo.slice(offset, fin),
    });
    onProgreso?.(fin / archivo.size);
    if (ultimo) respuesta = await res.json();
  }
  return respuesta.file;
}

// Google tarda un rato en procesar el vídeo antes de poder analizarlo.
export async function esperarVideoListo(clave, archivo, onEstado) {
  for (;;) {
    const res = await pedir(`${BASE}/v1beta/${archivo.name}`, { headers: { 'x-goog-api-key': clave } });
    const info = await res.json();
    if (info.state === 'ACTIVE') return info;
    if (info.state === 'FAILED') throw new Error('Google no pudo procesar el vídeo. Prueba a convertirlo a MP4.');
    onEstado?.(info.state);
    await esperar(5000);
  }
}

export async function infoVideo(clave, nombre) {
  try {
    const res = await fetch(`${BASE}/v1beta/${nombre}`, { headers: { 'x-goog-api-key': clave } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function generar(clave, modelo, partes, esquema, opciones = {}) {
  const generationConfig = { temperature: 0.2, responseMimeType: 'application/json', responseSchema: esquema };
  if (opciones.resolucion) generationConfig.mediaResolution = opciones.resolucion;
  const res = await pedir(`${BASE}/v1beta/models/${modelo}:generateContent`, {
    method: 'POST',
    headers: { 'x-goog-api-key': clave, 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ role: 'user', parts: partes }], generationConfig }),
  }, 3, { limite: LIMITE_RESPUESTA, onEstado: opciones.onEstado });
  const datos = await res.json();
  const texto = datos.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
  if (!texto) {
    const motivo = datos.candidates?.[0]?.finishReason || datos.promptFeedback?.blockReason || 'respuesta vacía';
    throw new Error('Gemini no devolvió resultado (' + motivo + ').');
  }
  try {
    return JSON.parse(texto);
  } catch {
    throw new Error('Gemini devolvió un resultado incompleto. Prueba con tramos más cortos.');
  }
}
