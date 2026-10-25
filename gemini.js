// Conexión con la API de Gemini (Google), que es la que "ve" el vídeo.
const BASE = 'https://generativelanguage.googleapis.com';
const TROZO = 16 * 1024 * 1024; // la subida se hace en trozos de 16 MB

const esperar = ms => new Promise(r => setTimeout(r, ms));

async function pedir(url, opciones, intentos = 4) {
  for (let i = 0; ; i++) {
    let res;
    try {
      res = await fetch(url, opciones);
    } catch (err) {
      if (i >= intentos) throw new Error('Sin conexión con Google: ' + err.message);
      await esperar(2000 * 2 ** i);
      continue;
    }
    if (res.ok) return res;
    // 429 = demasiadas peticiones seguidas, 5xx = error temporal de Google
    if ((res.status === 429 || res.status >= 500) && i < intentos) {
      await esperar(res.status === 429 ? 30000 * (i + 1) : 3000 * 2 ** i);
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
  });
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
