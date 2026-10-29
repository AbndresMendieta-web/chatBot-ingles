// preguntar.mjs - Hace la misma pregunta al modelo local, al de la nube o a los dos.
// Uso:  node banco/preguntar.mjs local "¿Cómo registro una salida de bodega?"
//       node banco/preguntar.mjs nube  "¿Cómo registro una salida de bodega?"
//       node banco/preguntar.mjs ambos "¿Cómo registro una salida de bodega?"
import { readFileSync } from 'node:fs';
import { cargarEnv, proveedor, chat } from './cliente.mjs';

// Si falta el archivo .env o una variable, se muestra el mensaje y se termina.
process.on('uncaughtException', (e) => { console.log(`ERROR: ${e.message}`); process.exit(1); });

const [destino, pregunta] = process.argv.slice(2);
if (!['local', 'nube', 'ambos'].includes(destino) || !pregunta) {
  console.log('Uso: node banco/preguntar.mjs local|nube|ambos "su pregunta"');
  process.exit(1);
}

const env = cargarEnv();
// El prompt trae la parte del sistema y, despues de "=== USUARIO ===", la plantilla del mensaje.
const [sistema, plantilla = '{{mensaje}}'] = readFileSync('prompts/foodsena.txt', 'utf8').split(/^=== USUARIO ===\s*$/m);
const mensajes = [
  { role: 'system', content: sistema.trim() },
  { role: 'user', content: plantilla.trim().replace('{{mensaje}}', () => pregunta) },
];

for (const nombre of destino === 'ambos' ? ['local', 'nube'] : [destino]) {
  const p = proveedor(nombre, env);
  console.log(`\n--- ${nombre.toUpperCase()} (${p.modelo}) ---`);
  try {
    const r = await chat(p, mensajes, { temperatura: 0.2 });
    console.log(r.texto || `(respuesta vacia; motivo de fin: ${r.motivoFin})`);
    console.log(
      `[${r.ms} ms | ${r.tokensEntrada} tokens de entrada | ${r.tokensSalida} de salida | ` +
        `costo estimado: US$ ${r.costo.toFixed(6)}]`,
    );
  } catch (e) {
    console.log(`ERROR: ${e.message}`);
  }
}
