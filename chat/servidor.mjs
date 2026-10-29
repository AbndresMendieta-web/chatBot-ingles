// servidor.mjs - Sirve la ventana de chat de FoodSena y pasa cada mensaje al flujo de n8n.
// Uso:  node chat/servidor.mjs
//       Luego abra http://localhost:3000 en el navegador.
// Variables opcionales: PUERTO (3000), N8N_URL (http://localhost:5678)
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

const PUERTO = Number(process.env.PUERTO || 3000);
const WEBHOOK = `${process.env.N8N_URL || 'http://localhost:5678'}/webhook/foodsena`;
const pagina = new URL('./index.html', import.meta.url);

const responder = (res, estado, cuerpo, tipo = 'application/json; charset=utf-8') => {
  res.writeHead(estado, { 'Content-Type': tipo });
  res.end(typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo));
};

createServer(async (req, res) => {
  if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
    // Se lee en cada visita para ver los cambios sin reiniciar el servidor.
    return responder(res, 200, readFileSync(pagina, 'utf8'), 'text/html; charset=utf-8');
  }
  if (req.method === 'POST' && req.url === '/api/mensaje') {
    let cuerpo = '';
    for await (const parte of req) {
      cuerpo += parte;
      if (cuerpo.length > 10000) return responder(res, 413, { error: 'Mensaje demasiado largo.' });
    }
    let mensaje = '';
    try { mensaje = String(JSON.parse(cuerpo).mensaje ?? '').trim(); } catch {}
    if (!mensaje) return responder(res, 400, { error: 'Escriba un mensaje.' });
    try {
      const r = await fetch(WEBHOOK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mensaje }),
        signal: AbortSignal.timeout(180000),
      });
      const d = await r.json();
      // Al navegador solo se le envia lo que necesita la ventana de chat.
      return responder(res, r.ok ? 200 : 502, {
        respuesta: d.respuesta ?? d.error ?? 'No se recibió respuesta.',
        avisar_humano: !!d.avisar_humano,
      });
    } catch (e) {
      console.log(`Sin respuesta de ${WEBHOOK}: ${e.cause?.code ?? e.message}`);
      return responder(res, 502, { respuesta: 'En este momento no puedo responderle. Intente de nuevo en un momento.' });
    }
  }
  responder(res, 404, { error: 'No encontrado' });
}).listen(PUERTO, () => {
  console.log(`Chat de FoodSena en http://localhost:${PUERTO}   (flujo: ${WEBHOOK})`);
  console.log('Para detenerlo: Ctrl+C');
});
