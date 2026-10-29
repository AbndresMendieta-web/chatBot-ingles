// mensaje.mjs - Envia un mensaje al flujo de n8n y muestra la respuesta resumida.
// Uso:  node banco/mensaje.mjs "¿Cómo funciona el reconocimiento facial?"
//       node banco/mensaje.mjs "El sistema no me deja entrar al comedor" --falla-nube   (simula que la nube no responde)
//       node banco/mensaje.mjs "¿Cómo funciona el reconocimiento facial?" --prueba        (usa la URL de prueba del editor)
const args = process.argv.slice(2);
const texto = args.find((a) => !a.startsWith('--')) ?? '';
const base = process.env.N8N_URL || 'http://localhost:5678';
const url = `${base}/${args.includes('--prueba') ? 'webhook-test' : 'webhook'}/foodsena`;

const cuerpo = { mensaje: texto };
if (args.includes('--falla-nube')) cuerpo.simular_falla_nube = true;

try {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cuerpo),
    signal: AbortSignal.timeout(180000),
  });
  const crudo = await r.text();
  console.log(`HTTP ${r.status}  ${url}`);
  let d;
  try { d = JSON.parse(crudo); } catch { d = null; }
  if (!d) {
    console.log(crudo || '(respuesta vacia: el recorrido del flujo no llego al nodo que responde)');
  } else {
    // Se muestran primero los campos que interesan; los textos largos se omiten.
    const orden = ['error', 'message', 'respuesta', 'clasificacion', 'clasificado', 'ruta', 'proveedor', 'modelo',
      'respaldo', 'avisar_humano', 'tokens_entrada', 'tokens_salida', 'costo_usd', 'ms'];
    for (const k of orden) if (k in d) console.log(`  ${k.padEnd(15)} ${typeof d[k] === 'object' ? JSON.stringify(d[k]) : d[k]}`);
  }
} catch (e) {
  console.log(`ERROR: sin conexion con ${url} (${e.cause?.code ?? e.cause?.errors?.[0]?.code ?? e.message})`);
}
