// cliente.mjs - Un solo cliente para hablar con el modelo local y con el de la nube.
// Los dos proveedores reciben la misma peticion; solo cambian la direccion, la llave y el modelo.
import { readFileSync, existsSync } from 'node:fs';

export const pausa = (ms) => new Promise((resolver) => setTimeout(resolver, ms));

// Lee el archivo .env de la carpeta actual y devuelve sus variables.
export function cargarEnv(ruta = '.env') {
  if (!existsSync(ruta)) {
    throw new Error(`No se encontro ${ruta}. Copie .env.ejemplo con el nombre .env y complete sus valores.`);
  }
  const env = {};
  for (const linea of readFileSync(ruta, 'utf8').split(/\r?\n/)) {
    const m = linea.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m) env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return env;
}

// Devuelve la configuracion de un proveedor: "local" o "nube".
export function proveedor(nombre, env = cargarEnv()) {
  const P = nombre.toUpperCase();
  if (!env[`${P}_URL`] || !env[`${P}_MODELO`]) {
    throw new Error(`Faltan ${P}_URL o ${P}_MODELO en el archivo .env`);
  }
  return {
    nombre,
    url: env[`${P}_URL`].replace(/\/+$/, ''),
    llave: env[`${P}_KEY`] || 'sin-llave',
    modelo: env[`${P}_MODELO`],
    formato: env[`${P}_FORMATO`] || 'json_schema',
    razonamiento: env[`${P}_RAZONAMIENTO`] || '',
    precioEntrada: Number(env[`${P}_PRECIO_ENTRADA`] || 0),
    precioSalida: Number(env[`${P}_PRECIO_SALIDA`] || 0),
  };
}

// Envia una conversacion al proveedor y devuelve la respuesta con sus metricas.
export async function chat(p, mensajes, opciones = {}) {
  const cuerpo = {
    model: p.modelo,
    messages: mensajes,
    temperature: opciones.temperatura ?? 0,
    max_tokens: opciones.maxTokens ?? 512,
  };
  // Respuesta estructurada: con json_schema el proveedor garantiza la estructura exacta;
  // con json_object solo garantiza que sea un JSON, y la estructura depende del prompt.
  if (opciones.esquema && p.formato === 'json_schema') {
    cuerpo.response_format = {
      type: 'json_schema',
      json_schema: { name: 'respuesta', strict: true, schema: opciones.esquema },
    };
  } else if (opciones.esquema && p.formato === 'json_object') {
    cuerpo.response_format = { type: 'json_object' };
  }
  if (p.razonamiento) cuerpo.reasoning_effort = p.razonamiento;

  let reintentos = 0;
  while (true) {
    const inicio = performance.now();
    let r;
    try {
      r = await fetch(`${p.url}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${p.llave}` },
        body: JSON.stringify(cuerpo),
        signal: AbortSignal.timeout(opciones.esperaMs ?? 120000),
      });
    } catch (e) {
      const causa = e.name === 'TimeoutError' ? 'se agoto el tiempo de espera' : e.cause?.code ?? e.cause?.errors?.[0]?.code ?? e.message;
      throw new Error(`Sin conexion con ${p.url} (${causa})`);
    }
    const texto = await r.text();
    const ms = Math.round(performance.now() - inicio);

    // 429 = se supero el limite de peticiones del proveedor: se espera y se reintenta.
    if (r.status === 429 && reintentos < 3) {
      reintentos++;
      const espera = Number(r.headers.get('retry-after')) || 5 * reintentos;
      await pausa((espera + 1) * 1000);
      continue;
    }
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${texto.slice(0, 300)}`);

    const d = JSON.parse(texto);
    const eleccion = d.choices?.[0] ?? {};
    const entrada = d.usage?.prompt_tokens ?? 0;
    const salida = d.usage?.completion_tokens ?? 0;
    return {
      texto: (eleccion.message?.content ?? '').trim(),
      motivoFin: eleccion.finish_reason ?? '',
      modelo: d.model ?? p.modelo,
      ms,
      tokensEntrada: entrada,
      tokensSalida: salida,
      costo: (entrada * p.precioEntrada + salida * p.precioSalida) / 1e6,
      reintentos,
    };
  }
}

// Prompts con preguntas de si/no (v5 en adelante): el modelo solo responde hechos
// y esta funcion decide la intencion y la urgencia con reglas fijas, que el mensaje no puede alterar.
// Si la respuesta ya trae "intencion", se usa tal cual.
export function derivarClasificacion(c) {
  if (!c || typeof c !== 'object' || 'intencion' in c) return c;
  const campos = ['reporta_falla', 'producto_agotado', 'tema_bodega', 'tema_comedor', 'afecta_servicio_hoy'];
  if (!campos.every((k) => typeof c[k] === 'boolean')) return null;
  const intencion = c.reporta_falla ? 'reclamo'
    : c.producto_agotado ? 'alerta'
    : c.tema_bodega ? 'inventario'
    : c.tema_comedor ? 'ingreso'
    : 'otro';
  // Solo una falla o un producto agotado pueden ser urgentes.
  const urgente = ['reclamo', 'alerta'].includes(intencion) && c.afecta_servicio_hoy;
  return { intencion, urgente };
}
