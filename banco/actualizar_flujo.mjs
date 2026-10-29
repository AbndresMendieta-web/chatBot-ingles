// actualizar_flujo.mjs - Pone los prompts de FoodSena y las defensas en un flujo exportado de n8n.
// Uso:  node banco/actualizar_flujo.mjs flujos/foodsena.json flujos/foodsena.json --clasificador prompts/v4.txt
// Despues se importa y publica:
//   docker cp flujos/foodsena.json n8n:/tmp/foodsena.json
//   docker exec n8n n8n import:workflow --input=/tmp/foodsena.json
//   docker exec n8n n8n publish:workflow --id=w0kJV9e7Fggwi99R
//   docker restart n8n
// (En Git Bash, antes: export MSYS_NO_PATHCONV=1)
// Cada nodo se escribe completo, asi que el script se puede correr varias veces sobre el mismo archivo.
import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const [entrada, salida] = args;
const i = args.indexOf('--clasificador');
const rutaClasificador = i >= 0 ? args[i + 1] : 'prompts/v4.txt';

const sinPlantilla = (ruta) => readFileSync(ruta, 'utf8').split(/^=== USUARIO ===\s*$/m)[0].trim();
const clasificador = sinPlantilla(rutaClasificador);
const asistente = sinPlantilla('prompts/foodsena.txt');
const esquema = JSON.parse(readFileSync('banco/esquema.json', 'utf8'));
// En n8n, `}}` cierra la expresion; ` y ${ rompen el texto del prompt.
for (const t of [clasificador, asistente]) if (/`|\$\{|\\|\}\}/.test(t)) throw new Error('El prompt tiene `, ${, \\ o }}, que rompen la expresion de n8n');

const w = JSON.parse(readFileSync(entrada, 'utf8'));
const nodo = (nombre) => {
  const n = w.nodes.find((x) => x.name === nombre);
  if (!n) throw new Error(`No existe el nodo "${nombre}"`);
  return n;
};
const asignar = (nombre, valor) => {
  const a = nodo('Config').parameters.assignments.assignments.find((x) => x.name === nombre);
  if (!a) throw new Error(`No existe el campo "${nombre}" en Config`);
  a.value = valor;
};

// 1. Entrada: se quitan < y > para que nadie cierre la etiqueta <mensaje> ni imite otras, y se limita el largo.
asignar('mensaje', "={{ String($json.body?.mensaje ?? '').replace(/[<>]/g, ' ').trim().slice(0, 1000) }}");
asignar('prompt_clasificador', '={{ `' + clasificador + '` }}');
asignar('prompt_asistente', '={{ `' + asistente + '` }}');

// 2. Clasificar: respuesta obligada a las cinco categorias.
nodo('Clasificar').parameters.jsonBody = `={{ JSON.stringify({
  model: $json.local_modelo,
  temperature: 0,
  max_tokens: 100,
  messages: [
    { role: 'system', content: $json.prompt_clasificador },
    { role: 'user', content: '<mensaje>' + $json.mensaje + '</mensaje>' }
  ],
  response_format: {
    type: 'json_schema',
    json_schema: { name: 'clasificacion', strict: true, schema: ${JSON.stringify(esquema, null, 2)} }
  }
}) }}`;

// 3. Interpretar: solo acepta valores validos; cualquier otra cosa se escala a la nube.
nodo('Interpretar').parameters.jsCode = `// Lee la clasificacion del modelo local y decide quien responde.
const cfg = $('Config').first().json;
const r = $input.first().json;
const INTENCIONES = ['ingreso', 'inventario', 'alerta', 'reclamo', 'otro'];

let clasificacion = { intencion: 'otro', urgente: false };
let clasificado = false;
try {
  const c = JSON.parse(r.choices[0].message.content);
  // Solo se aceptan las cinco categorias y un booleano; si no, el caso se escala.
  if (INTENCIONES.includes(c.intencion) && typeof c.urgente === 'boolean') {
    clasificacion = { intencion: c.intencion, urgente: c.urgente };
    clasificado = true;
  }
} catch (e) {
  // Si el modelo local no respondio o no entrego un JSON valido, el caso se escala.
}

// Regla de enrutamiento: lo rutinario se queda en el modelo local;
// los reclamos, lo urgente y lo que no se pudo clasificar van a la nube.
const delicado = clasificacion.urgente || ['reclamo', 'otro'].includes(clasificacion.intencion);
const ruta = !clasificado || delicado ? 'nube' : 'local';

return [{
  json: {
    ...cfg,
    clasificacion,
    clasificado,
    ruta,
    tokens_clasificar_entrada: r.usage?.prompt_tokens ?? 0,
    tokens_clasificar_salida: r.usage?.completion_tokens ?? 0,
  },
}];`;

// 4. Responder: el mensaje va entre etiquetas, como lo espera el prompt del asistente.
nodo('Responder nube').parameters.jsonBody = `={{ JSON.stringify({
  model: $json.nube_modelo,
  temperature: 0.2,
  max_tokens: 600,
  ...($json.nube_razonamiento ? { reasoning_effort: $json.nube_razonamiento } : {}),
  messages: [
    { role: 'system', content: $json.prompt_asistente },
    { role: 'user', content: '<mensaje>' + $json.mensaje + '</mensaje>' }
  ]
}) }}`;
nodo('Responder local').parameters.jsonBody = `={{ JSON.stringify({
  model: $('Interpretar').first().json.local_modelo,
  temperature: 0.2,
  max_tokens: 300,
  messages: [
    { role: 'system', content: $('Interpretar').first().json.prompt_asistente },
    { role: 'user', content: '<mensaje>' + $('Interpretar').first().json.mensaje + '</mensaje>' }
  ]
}) }}`;

// 5. Armar respuesta: control de salida antes de contestar.
nodo('Armar respuesta').parameters.jsCode = `// Unifica la respuesta, sin importar que modelo atendio, y calcula las metricas.
const cfg = $('Interpretar').first().json;
const r = $input.first().json;

const usoNube = $('Responder nube').isExecuted;
const usoLocal = $('Responder local').isExecuted;
let texto = (r.choices?.[0]?.message?.content ?? '').trim();

// Control de salida: si la respuesta copia frases de las reglas del prompt o es demasiado larga,
// se cambia por la respuesta fija. Asi una manipulacion que engane al modelo no llega al usuario.
const RECHAZO = 'Solo puedo ayudarle con FoodSena: el ingreso al comedor, el inventario de bodega y las alertas de productos. ¿En qué le puedo ayudar?';
const palabras = (t) => t.toLowerCase().normalize('NFD').replace(/[\\u0300-\\u036f]/g, '').match(/[a-z0-9]+/g) ?? [];
const tejas = (t, n = 6) => {
  const p = palabras(t);
  const s = new Set();
  for (let i = 0; i + n <= p.length; i++) s.add(p.slice(i, i + n).join(' '));
  return s;
};
const reglas = cfg.prompt_asistente.split(/^C[oó]mo responder:/m).pop().split(/^Ejemplos:/m)[0];
const deReglas = tejas(reglas);
const permitidas = tejas(RECHAZO);
const filtra = [...tejas(texto)].some((t) => deReglas.has(t) && !permitidas.has(t));
const bloqueada = !!texto && (filtra || texto.length > 700);
if (bloqueada) texto = RECHAZO;

const proveedor = !texto ? 'ninguno' : usoLocal ? 'local' : 'nube';
const entrada = r.usage?.prompt_tokens ?? 0;
const salida = r.usage?.completion_tokens ?? 0;
const costo = proveedor === 'nube'
  ? (entrada * cfg.precio_entrada + salida * cfg.precio_salida) / 1e6
  : 0;

return [{
  json: {
    respuesta: texto || 'En este momento no puedo responderle. Una persona lo atenderá en breve.',
    clasificacion: cfg.clasificacion,
    clasificado: cfg.clasificado,
    ruta: cfg.ruta,
    proveedor,
    modelo: proveedor === 'nube' ? cfg.nube_modelo : proveedor === 'local' ? cfg.local_modelo : '',
    respaldo: usoNube && usoLocal,
    bloqueada,
    avisar_humano: cfg.clasificacion.urgente || proveedor === 'ninguno',
    tokens_entrada: cfg.tokens_clasificar_entrada + entrada,
    tokens_salida: cfg.tokens_clasificar_salida + salida,
    costo_usd: Number(costo.toFixed(6)),
    ms: Date.now() - cfg.inicio,
  },
}];`;

nodo('Webhook').parameters.path = 'foodsena';

// Verificacion final: ninguna expresion puede tener `}}` antes de su cierre.
for (const n of w.nodes) {
  const valores = [n.parameters?.jsonBody, ...(n.parameters?.assignments?.assignments ?? []).map((a) => a.value)];
  for (const v of valores) {
    if (typeof v === 'string' && v.startsWith('={{') && v.slice(3, -2).includes('}}')) {
      throw new Error(`La expresion del nodo "${n.name}" tiene }} antes del final`);
    }
  }
}
w.name = 'Asistente FoodSena';
writeFileSync(salida, JSON.stringify(w, null, 2));
console.log(`Listo: ${salida}  (clasificador: ${rutaClasificador})`);
