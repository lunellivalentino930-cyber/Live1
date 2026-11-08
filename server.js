const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebcastPushConnection } = require('tiktok-live-connector');

const USER = (process.env.TIKTOK_USER || '').replace('@', '').trim();
const PORT = process.env.PORT || 3000;
const KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.MODEL || 'claude-haiku-5-5';
const PERSONA =
  'Você é o Pop, um personagem fofo, animado e engraçado que apresenta uma live no TikTok. ' +
  'Responda em português do Brasil, em no máximo 20 palavras, sem emojis, falando direto com o espectador. ' +
  'Responda só com a fala do Pop.';

const clients = new Set();
function send(ev) {
  const d = 'data: ' + JSON.stringify(ev) + '\n\n';
  for (const c of clients) c.write(d);
}

async function ai(prompt) {
  if (!KEY) return null;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 80,
        system: PERSONA,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const j = await r.json();
    const t = (j.content && j.content[0] && j.content[0].text) || '';
    return t.trim() || null;
  } catch (e) {
    console.log('IA falhou:', e.message);
    return null;
  }
}

http
  .createServer((req, res) => {
    if (req.url.startsWith('/events')) {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      });
      res.write(': ok\n\n');
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 20000);
      req.on('close', () => {
        clearInterval(ping);
        clients.delete(res);
      });
      return;
    }
    fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
      if (err) {
        res.writeHead(500);
        return res.end('index.html não encontrado');
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
  })
  .listen(PORT, () => console.log('Pop no ar na porta', PORT));

let lastChat = 0;
let lastLike = 0;

function connect() {
  if (!USER) {
    console.log('Falta a variável TIKTOK_USER (seu @, sem a senha).');
    return;
  }
  const c = new WebcastPushConnection(USER);
  c.connect()
    .then((s) => console.log('Conectado na live. Sala:', s.roomId))
    .catch((e) => {
      console.log('Não conectou (a live precisa estar ligada):', e.message || e);
      setTimeout(connect, 30000);
    });
  c.on('disconnected', () => setTimeout(connect, 15000));
  c.on('streamEnd', () => setTimeout(connect, 30000));
  c.on('error', (e) => console.log('Erro:', e && e.message));

  c.on('chat', async (d) => {
    const now = Date.now();
    if (now - lastChat < 4000) return;
    lastChat = now;
    const user = d.nickname || d.uniqueId;
    const text = d.comment || '';
    const say = await ai('O espectador ' + user + ' escreveu no chat: "' + text.slice(0, 200) + '"');
    send({ type: 'comment', user, text, say });
  });

  c.on('gift', async (d) => {
    if (d.giftType === 1 && !d.repeatEnd) return;
    const user = d.nickname || d.uniqueId;
    const count = d.repeatCount || 1;
    const total = (d.diamondCount || 1) * count;
    const tier = total < 5 ? 'Rosa' : total < 50 ? 'Coração' : total < 500 ? 'Leão' : 'Universo';
    const say = await ai(
      'O espectador ' + user + ' mandou ' + (count > 1 ? count + 'x ' : '') + 'o presente ' + d.giftName + '. Agradeça de forma empolgada.'
    );
    send({ type: 'gift', user, name: d.giftName, count, tier, say });
  });

  c.on('follow', async (d) => {
    const user = d.nickname || d.uniqueId;
    const say = await ai('O espectador ' + user + ' acabou de seguir o perfil. Agradeça de forma carinhosa e peça pra ele ficar na live.');
    send({ type: 'follow', user, say });
  });

  c.on('like', async (d) => {
    const now = Date.now();
    if (now - lastLike < 20000) return;
    lastLike = now;
    const user = d.nickname || d.uniqueId;
    const say = await ai('O espectador ' + user + ' curtiu a live. Agradeça de forma animada e peça mais curtidas.');
    send({ type: 'like', user, say });
  });
}
connect();
