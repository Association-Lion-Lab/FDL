class Raw {
  constructor(value) {
    this.value = value;
  }

  toString() {
    return this.value;
  }
}

export const raw = (value) => new Raw(String(value));

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escape = (value) => String(value).replace(/[&<>"']/g, (c) => ESCAPES[c]);

function render(value) {
  if (value instanceof Raw) return value.value;
  if (Array.isArray(value)) return value.map(render).join('');
  if (value === null || value === undefined || value === false) return '';
  return escape(value);
}

export function html(strings, ...values) {
  return raw(strings.reduce((out, s, i) => out + s + (i < values.length ? render(values[i]) : ''), ''));
}

export function sendPage(response, status, title, body) {
  response.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'self'; frame-ancestors 'none'",
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'same-origin',
  });
  response.end(String(html`<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<link rel="stylesheet" href="/static/fdl.css">
</head>
<body>
<main>
${body}
</main>
</body>
</html>
`));
}

// Errors flagged `expose` are turned into JSON error responses (with their message) by createApp.
function httpError(status, code, message) {
  return Object.assign(new Error(message), { status, code, expose: true });
}

export async function readBody(request, { max = 16 * 1024 } = {}) {
  const type = (request.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/x-www-form-urlencoded' && type !== 'application/json') {
    throw httpError(400, 'bad_request', 'Type de contenu non pris en charge.');
  }
  const declared = Number(request.headers['content-length']);
  if (declared > max) throw httpError(413, 'payload_too_large', 'Requête trop volumineuse.');
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > max) throw httpError(413, 'payload_too_large', 'Requête trop volumineuse.');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  // PostgreSQL text cannot hold NUL: refuse it here rather than fail with a 500 in a query.
  const nul = () => httpError(400, 'bad_request', 'Requête invalide.');
  if (type === 'application/x-www-form-urlencoded') {
    const params = new URLSearchParams(text);
    if ([...params].some(([key, value]) => key.includes('\0') || value.includes('\0'))) throw nul();
    return params;
  }
  if (text.trim() === '') return {};
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw httpError(400, 'bad_request', 'Requête invalide.');
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw httpError(400, 'bad_request', 'Requête invalide.');
  }
  // JSON.stringify writes any NUL, in a key or a value, back as \u0000.
  if (JSON.stringify(data).includes('\\u0000')) throw nul();
  return data;
}

// `cookies` is an optional Set-Cookie string or array of them.
export function redirect(response, location, cookies = []) {
  const headers = { location };
  if ([cookies].flat().length) headers['set-cookie'] = cookies;
  response.writeHead(303, headers);
  response.end();
}

export function parseCookies(request) {
  const out = {};
  for (const part of (request.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
