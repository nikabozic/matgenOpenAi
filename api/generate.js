import fs from 'node:fs';

const providers = {
  openai: { name: 'OpenAI', key: 'OPENAI_API_KEY', model: 'OPENAI_MODEL' },
  gemini: { name: 'Gemini', key: 'GEMINI_API_KEY', model: 'GEMINI_MODEL' },
  claude: { name: 'Claude', key: 'ANTHROPIC_API_KEY', model: 'CLAUDE_MODEL' },
  grok: { name: 'Grok', key: 'XAI_API_KEY', model: 'GROK_MODEL' },
  deepseek: { name: 'DeepSeek', key: 'DEEPSEEK_API_KEY', model: 'DEEPSEEK_MODEL' }
};
const taskSchema = {
  type: 'object', additionalProperties: false,
  required: ['naslov', 'zadatak', 'opcije', 'tocan_odgovor', 'objasnjenje'],
  properties: {
    naslov: { type: 'string' }, zadatak: { type: 'string' },
    opcije: { type: 'array', items: { type: 'string' } },
    tocan_odgovor: { type: 'string' }, objasnjenje: { type: 'string' }
  }
};
const schema = { type: 'object', additionalProperties: false, required: ['zadaci'],
  properties: { zadaci: { type: 'array', items: taskSchema } } };

export function validateTasks(value, count) {
  const tasks = value?.zadaci;
  if (!Array.isArray(tasks) || tasks.length !== count) throw new Error('format');
  return tasks.map(t => {
    if (!t || !['naslov', 'zadatak', 'tocan_odgovor', 'objasnjenje'].every(k => typeof t[k] === 'string' && t[k].trim()) ||
        !Array.isArray(t.opcije) || t.opcije.length !== 4 ||
        !t.opcije.every(o => typeof o === 'string' && o.trim())) throw new Error('format');
    const options = t.opcije.map(o => o.trim());
    if (new Set(options).size !== 4) throw new Error('format');
    const answer = t.tocan_odgovor.trim();
    const index = options.indexOf(answer);
    if (index < 0) throw new Error('format');
    return { naslov: t.naslov.trim(), zadatak: t.zadatak.trim(), opcije: options,
      tocan_odgovor: answer, tocan_indeks: index, objasnjenje: t.objasnjenje.trim() };
  });
}

async function requestModel(provider, key, model, prompt) {
  let url, body, headers = { 'Content-Type': 'application/json' };
  if (provider === 'openai') {
    url = 'https://api.openai.com/v1/responses';
    headers.Authorization = `Bearer ${key}`;
    body = { model, input: prompt, store: false, max_output_tokens: 8000,
      text: { format: { type: 'json_schema', name: 'matematicki_zadaci', strict: true, schema } } };
  } else if (provider === 'gemini') {
    url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    headers['x-goog-api-key'] = key;
    body = { contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0.3 } };
  } else if (provider === 'claude') {
    url = 'https://api.anthropic.com/v1/messages';
    headers['x-api-key'] = key;
    headers['anthropic-version'] = '2023-06-01';
    body = { model, max_tokens: 8000, messages: [{ role: 'user', content: prompt }] };
  } else {
    url = provider === 'grok' ? 'https://api.x.ai/v1/chat/completions' : 'https://api.deepseek.com/chat/completions';
    headers.Authorization = `Bearer ${key}`;
    body = { model, messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' }, max_tokens: 8000 };
  }
  const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(50000) });
  if (!response.ok) {
    // Do not expose upstream error bodies or credentials to the browser.
    throw new Error(`upstream:${response.status}`);
  }
  const data = await response.json();
  let text;
  if (provider === 'openai') {
    if (data.status !== 'completed') throw new Error('incomplete');
    const content = (data.output || []).filter(i => i.type === 'message').flatMap(i => i.content || []);
    if (content.some(i => i.type === 'refusal')) throw new Error('refusal');
    text = content.filter(i => i.type === 'output_text').map(i => i.text).join('');
  } else if (provider === 'gemini') {
    const candidate = data.candidates?.[0];
    if (candidate?.finishReason !== 'STOP') throw new Error('incomplete');
    text = (candidate.content?.parts || []).filter(p => p.text && !p.thought).map(p => p.text).join('');
  } else if (provider === 'claude') {
    if (data.stop_reason !== 'end_turn') throw new Error('incomplete');
    text = (data.content || []).filter(p => p.type === 'text').map(p => p.text).join('');
  } else {
    if (data.choices?.[0]?.finish_reason !== 'stop') throw new Error('incomplete');
    text = data.choices[0].message?.content;
  }
  if (typeof text !== 'string') throw new Error('format');
  return JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ error: 'Koristi gumb za generiranje.' }); }
  if (process.env.ACCESS_PIN && req.headers['x-access-pin'] !== process.env.ACCESS_PIN)
    return res.status(403).json({ error: 'Pogrešan PIN.' });
  let b;
  try { b = typeof req.body === 'string' ? JSON.parse(req.body) : req.body; }
  catch { return res.status(400).json({ error: 'Neispravan zahtjev.' }); }
  const provider = b?.provider || 'gemini';
  if (!Object.hasOwn(providers, provider)) return res.status(400).json({ error: 'Nepoznat pružatelj.' });
  const config = providers[provider];
  const count = Number(b?.broj);
  if (!Number.isInteger(count) || count < 1 || count > 10) return res.status(400).json({ error: 'Odaberi od 1 do 10 zadataka.' });
  if (!['Lako', 'Srednje', 'Genijalac'].includes(b?.tezina)) return res.status(400).json({ error: 'Neispravna težina.' });
  const key = process.env[config.key]?.trim();
  const model = process.env[config.model]?.trim();
  if (!key || !model) return res.status(500).json({ error: `U Vercel postavkama dodaj ${!key ? config.key : config.model} i napravi Redeploy.` });
  try {
    const topics = JSON.parse(fs.readFileSync(new URL('../data/topics.json', import.meta.url), 'utf8'));
    const topic = topics.find(t => t.razred === String(b.razred) && t.tema === b.tema);
    if (!topic) return res.status(400).json({ error: 'Tema ne postoji.' });
    const prompt = `Ti si stručnjak za instrukcije matematike za osnovnu školu. Piši hrvatski.
Generiraj ${count} jasnih, jednoznačnih zadataka za ${topic.razred}. razred.
Tema: ${topic.tema}\nUputa: ${topic.prompt}\nPrimjene: ${topic.primjena}\nTežina: ${b.tezina}
Ne koristi HTML, Markdown, LaTeX ni znak dolara. Izraze piši običnim tekstom: ×, ÷, 10³, 3/4. Za novac koristi eure.
Vrati ISKLJUČIVO JSON objekt oblika {"zadaci":[{"naslov":"...","zadatak":"...","opcije":["...","...","...","..."],"tocan_odgovor":"...","objasnjenje":"..."}]}.
Svaki zadatak mora imati četiri različite opcije i točno jednu točnu. Prvo samostalno riješi zadatak pa oblikuj opcije.
Polje tocan_odgovor mora biti DOSLOVNA KOPIJA teksta točne opcije, uključujući jedinice. Ne vraćaj indeks.
Objašnjenje mora dati isti rezultat kao tocan_odgovor. Ne spominji broj, indeks ni položaj opcije.
Provjeri izračun, jedinice i logičnost konteksta. U zajedničkom radu zbrajaj brzine neovisnih radnika; pri punjenju i pražnjenju oduzimaj brzine. Potrošnja baterije ne ubrzava punjenje.
U objašnjenju navedi postupak i tipičnu pogrešku. Nemoj pitati podatak koji je već izravno zadan.`;
    const tasks = validateTasks(await requestModel(provider, key, model, prompt), count);
    // Raw text is rendered using textContent in the supplied index.html.
    return res.status(200).json(tasks);
  } catch (e) {
    const status = /^upstream:(\d+)$/.exec(e.message || '')?.[1];
    const message = e.name === 'TimeoutError' ? 'nije odgovorio na vrijeme. Pokušaj s jednim zadatkom.' :
      status ? `API je vratio HTTP ${status}. Provjeri ključ, model, dostupni saldo i ograničenja u računu pružatelja.` :
      'nije vratio potpun i ispravan format zadataka. Pokušaj ponovno s manje zadataka.';
    return res.status(502).json({ error: `${config.name} ${message}` });
  }
}
