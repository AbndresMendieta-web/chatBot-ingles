// evaluar.mjs - Banco de pruebas: corre los casos contra un modelo o contra el flujo y mide el resultado.
// Uso:  node banco/evaluar.mjs --proveedor local --prompt prompts/v1.txt
//       node banco/evaluar.mjs --proveedor nube  --prompt prompts/v2.txt --pausa 3000
//       node banco/evaluar.mjs --webhook http://localhost:5678/webhook/foodsena
//       node banco/evaluar.mjs --proveedor local --prompt prompts/v5.txt --esquema banco/esquema_v5.json
// Opciones: --casos archivo.json   --esquema archivo.json   --sin-esquema   --pausa milisegundos
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { basename } from 'node:path';
import { cargarEnv, proveedor, chat, pausa, derivarClasificacion } from './cliente.mjs';

// Si falta un archivo o una variable, se muestra el mensaje y se termina.
process.on('uncaughtException', (e) => { console.log(`ERROR: ${e.message}`); process.exit(1); });

// ---------- 1. Leer las opciones ----------
const args = process.argv.slice(2);
const opcion = (nombre, porDefecto) => {
  const i = args.indexOf(`--${nombre}`);
  return i >= 0 ? args[i + 1] : porDefecto;
};
const webhook = opcion('webhook', '');
const nombreProveedor = opcion('proveedor', 'local');
const rutaPrompt = opcion('prompt', 'prompts/v1.txt');
const rutaCasos = opcion('casos', 'banco/casos.json');
const pausaMs = Number(opcion('pausa', '0'));
const usarEsquema = !args.includes('--sin-esquema');

const casos = JSON.parse(readFileSync(rutaCasos, 'utf8'));
const esquema = JSON.parse(readFileSync(opcion('esquema', 'banco/esquema.json'), 'utf8'));

// ---------- 2. Preparar el destino: un modelo o el flujo ----------
let etiqueta, clasificar;
if (webhook) {
  etiqueta = 'flujo';
  clasificar = async (mensaje) => {
    const inicio = performance.now();
    const r = await fetch(webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mensaje }),
      signal: AbortSignal.timeout(180000),
    });
    const texto = await r.text();
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${texto.slice(0, 200)}`);
    const d = JSON.parse(texto);
    return {
      clasificacion: d.clasificacion,
      ms: Math.round(performance.now() - inicio),
      tokensEntrada: d.tokens_entrada ?? 0,
      tokensSalida: d.tokens_salida ?? 0,
      costo: d.costo_usd ?? 0,
      atendio: d.proveedor ?? '',
      respaldo: d.respaldo ?? false,
    };
  };
} else {
  const p = proveedor(nombreProveedor, cargarEnv());
  const [sistema, plantilla = '{{mensaje}}'] = readFileSync(rutaPrompt, 'utf8').split(/^=== USUARIO ===\s*$/m);
  etiqueta = `${nombreProveedor}_${basename(rutaPrompt).replace(/\.[^.]+$/, '')}`;
  console.log(`Modelo: ${p.modelo}   Prompt: ${rutaPrompt}   Esquema: ${usarEsquema ? 'si' : 'no'}`);
  clasificar = async (mensaje) => {
    const r = await chat(
      p,
      [
        { role: 'system', content: sistema.trim() },
        { role: 'user', content: plantilla.trim().replace('{{mensaje}}', () => mensaje) },
      ],
      { esquema: usarEsquema ? esquema : null },
    );
    let clasificacion = null;
    try {
      // Sin esquema, algunos modelos envuelven el JSON en texto: se toma lo que este entre llaves.
      // Con prompts de si/no (v5), la intencion y la urgencia se calculan con reglas fijas.
      clasificacion = derivarClasificacion(JSON.parse(r.texto.match(/\{[\s\S]*\}/)?.[0] ?? ''));
    } catch {}
    return { ...r, clasificacion, atendio: nombreProveedor, respaldo: false, crudo: r.texto };
  };
}

// ---------- 3. Correr los casos ----------
// Misma regla de enrutamiento del flujo: reclamos, "otro" y lo urgente van a la nube.
// Un error critico es un caso que debia ir a la nube y se quedo en el modelo local.
const ruta = (c) => (c.urgente || ['reclamo', 'otro'].includes(c.intencion) ? 'nube' : 'local');
const filas = [];
for (const caso of casos) {
  const fila = { id: caso.id, esperado: `${caso.intencion}/${caso.urgente}`, obtenido: '', jsonValido: false,
    okIntencion: false, okUrgente: false, ms: 0, tokensEntrada: 0, tokensSalida: 0, costo: 0, atendio: '',
    respaldo: false, rutaEsperada: '', ruta: '', error: '' };
  try {
    const r = await clasificar(caso.mensaje);
    const c = r.clasificacion;
    fila.jsonValido = !!c && typeof c.intencion === 'string' && typeof c.urgente === 'boolean';
    fila.obtenido = fila.jsonValido ? `${c.intencion}/${c.urgente}` : String(r.crudo ?? '(sin clasificacion)').replace(/\s+/g, ' ').slice(0, 40);
    fila.okIntencion = fila.jsonValido && c.intencion === caso.intencion;
    fila.okUrgente = fila.jsonValido && c.urgente === caso.urgente;
    fila.rutaEsperada = ruta(caso);
    fila.ruta = fila.jsonValido ? ruta(c) : 'nube';
    Object.assign(fila, { ms: r.ms, tokensEntrada: r.tokensEntrada, tokensSalida: r.tokensSalida,
      costo: r.costo, atendio: r.atendio, respaldo: r.respaldo });
  } catch (e) {
    fila.error = e.message.slice(0, 120);
  }
  const marca = fila.error ? 'ERROR' : fila.okIntencion && fila.okUrgente ? 'OK   ' : 'FALLA';
  const critico = !fila.error && fila.rutaEsperada === 'nube' && fila.ruta === 'local' ? '  << CRITICO: debia ir a la nube' : '';
  console.log(
    `${marca} #${String(caso.id).padStart(2)}  esperado ${fila.esperado.padEnd(14)} ` +
      `obtenido ${(fila.error || fila.obtenido).padEnd(14)} ${String(fila.ms).padStart(6)} ms${critico}` +
      (webhook ? `  ${fila.atendio}${fila.respaldo ? ' (respaldo)' : ''}` : ''),
  );
  filas.push(fila);
  if (pausaMs) await pausa(pausaMs);
}

// ---------- 4. Calcular el resumen ----------
const n = filas.length;
const pct = (f) => Math.round((100 * filas.filter(f).length) / n);
const suma = (campo) => filas.reduce((a, f) => a + f[campo], 0);
const tiempos = filas.filter((f) => !f.error).map((f) => f.ms).sort((a, b) => a - b);
const resumen = {
  fecha: new Date().toISOString().slice(0, 19),
  prueba: etiqueta,
  casos: n,
  json_valido_pct: pct((f) => f.jsonValido),
  intencion_pct: pct((f) => f.okIntencion),
  urgente_pct: pct((f) => f.okUrgente),
  ambos_pct: pct((f) => f.okIntencion && f.okUrgente),
  errores: filas.filter((f) => f.error).length,
  ms_promedio: tiempos.length ? Math.round(tiempos.reduce((a, b) => a + b, 0) / tiempos.length) : 0,
  ms_p95: tiempos.length ? tiempos[Math.min(tiempos.length - 1, Math.ceil(0.95 * tiempos.length) - 1)] : 0,
  tokens_entrada: suma('tokensEntrada'),
  tokens_salida: suma('tokensSalida'),
  costo_usd: Number(suma('costo').toFixed(6)),
};
console.log('\nRESUMEN');
for (const [clave, valor] of Object.entries(resumen)) console.log(`  ${clave.padEnd(16)} ${valor}`);
// Se muestran aparte para no cambiar las columnas de resumen.csv.
const validas = filas.filter((f) => !f.error);
console.log(`  ruta_ok_pct      ${Math.round((100 * validas.filter((f) => f.ruta === f.rutaEsperada).length) / (validas.length || 1))}`);
console.log(`  criticos         ${validas.filter((f) => f.rutaEsperada === 'nube' && f.ruta === 'local').length}   (debian ir a la nube y se quedaron en local)`);
if (webhook) {
  const porProveedor = {};
  for (const f of filas) porProveedor[f.atendio || 'error'] = (porProveedor[f.atendio || 'error'] ?? 0) + 1;
  console.log(`  atendidos por    ${JSON.stringify(porProveedor)}   con respaldo: ${filas.filter((f) => f.respaldo).length}`);
}

// ---------- 5. Guardar los resultados ----------
if (!existsSync('resultados')) mkdirSync('resultados');
const sello = resumen.fecha.replace(/[-:T]/g, '').slice(0, 14);
const columnas = Object.keys(filas[0]);
const csv = [columnas.join(';'), ...filas.map((f) => columnas.map((c) => String(f[c]).replace(/;/g, ',')).join(';'))];
writeFileSync(`resultados/${etiqueta}_${sello}.csv`, '﻿' + csv.join('\r\n'));
const rutaResumen = 'resultados/resumen.csv';
if (!existsSync(rutaResumen)) writeFileSync(rutaResumen, '﻿' + Object.keys(resumen).join(';') + '\r\n');
appendFileSync(rutaResumen, Object.values(resumen).join(';') + '\r\n');
console.log(`\nDetalle: resultados/${etiqueta}_${sello}.csv   Acumulado: ${rutaResumen}`);
