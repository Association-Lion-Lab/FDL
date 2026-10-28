const MAX_BODY = 16 * 1024;

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

// Errors carrying `status` are turned into JSON error responses by createApp.
function httpError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}

export async function readBody(request) {
  const type = (request.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/x-www-form-urlencoded' && type !== 'application/json') {
    throw httpError(400, 'bad_request', 'Type de contenu non pris en charge.');
  }
  const declared = Number(request.headers['content-length']);
  if (declared > MAX_BODY) throw httpError(413, 'payload_too_large', 'Requête trop volumineuse.');
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY) throw httpError(413, 'payload_too_large', 'Requête trop volumineuse.');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (type === 'application/x-www-form-urlencoded') return new URLSearchParams(text);
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
