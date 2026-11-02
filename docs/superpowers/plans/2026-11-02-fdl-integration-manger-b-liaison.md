# Intégration Manger!, partie B : liaison de compte par OAuth 2.0 avec PKCE

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Un serveur Manger! obtient, par un parcours « Se connecter avec FDL » (OAuth 2.0, code d'autorisation + PKCE S256), un jeton qui lui ouvre l'API `/api/v1` au nom d'un compte FDL, révocable depuis la page Sécurité du compte.

**Architecture:** Un module `src/oauth.js` (codes, jetons, vérification PKCE) et un fichier de routes `src/routes/oauth.js` (`/oauth/autoriser`, `/oauth/jeton`). La barrière `buildBefore` lit `Authorization: Bearer` sur `/api/` et remplit `request.session` : les routes de la partie A ne changent pas. Limites de débit par adresse et par instance dans la barrière.

**Tech Stack:** Node.js >= 22 (modules ES), PostgreSQL 18 via `pg`, `node:test`, `node:crypto`. Aucune nouvelle dépendance.

**Spec:** `docs/superpowers/specs/2026-10-27-fdl-cahier-des-charges-design.md` (section 8 : « Se connecter avec FDL », OAuth 2.0 avec PKCE, révocable depuis le compte FDL, jamais de mot de passe FDL dans Manger!, limites de débit par instance reliée et par adresse) et `docs/CONTRATS.md` (« API Manger! »).

Décisions prises pour ce plan (choix Claude, à écrire dans `CONTRATS.md`) :

- **Pas d'enregistrement de client.** Les instances Manger! sont inconnues et auto-hébergées : le `client_id` est l'origine de l'instance (`https://manger.exemple.fr`, `http://192.168.1.10:3000`), comme IndieAuth. Le `redirect_uri` doit avoir exactement cette origine. `http` est accepté (instances de foyer sur le réseau local) : PKCE protège le code, et la page de consentement affiche l'adresse.
- **Client public, PKCE obligatoire, `S256` seulement.** Pas de secret client.
- **Un jeton d'accès sans expiration, sans jeton de rafraîchissement**, révocable depuis `/compte/securite`. Une seule liaison par compte et par instance : relier à nouveau remplace l'ancien jeton. Le bannissement ou la suppression du compte coupe le jeton.
- **Portée unique** : lecture de l'API `/api/v1` (pas de paramètre `scope`). Le jeton n'ouvre jamais le site (pages HTML, formulaires).
- **Code d'autorisation** : 32 octets aléatoires, stocké haché, valable 5 minutes, à usage unique (consommé même si l'échange échoue).
- **Limites** : un compteur en mémoire de 300 requêtes par 15 minutes, une clé par adresse (`api-ip:`) sur `/api/` et `/oauth/jeton`, une clé par instance (`api-client:`) pour les requêtes portant un jeton. Dépassement : `429` `rate_limited`.
- **Retour après connexion** : une personne non connectée qui ouvre `/oauth/autoriser` revient sur la page de consentement après sa connexion (cookie `fdl_suite`, 10 minutes).
- Hors plan : métadonnées de découverte (RFC 8414 : les chemins sont fixes et documentés), révocation à distance par Manger! (RFC 7009), date de dernière utilisation d'un jeton, révocation des jetons au changement de mot de passe.

## Global Constraints

- Mode ponytail : le plus petit diff qui marche ; réutiliser `hashToken` (`src/accounts.js`), `createLimiter` (`src/ratelimit.js`), `clientIp` (`src/routes/auth.js`), `readBody`, `redirect`, `parseCookies`, `html`, `sendPage` (`src/web.js`), `sendJson`, `sendError` (`src/http.js`).
- Pas de nouvelle dépendance. Une migration : `src/migrations/0007-oauth.sql`.
- Routeur à chemins exacts : les paramètres passent par la chaîne de requête ou le corps, jamais dans le chemin.
- Noms des paramètres OAuth exactement ceux de la RFC 6749 / 7636 : `response_type=code`, `client_id`, `redirect_uri`, `state`, `code_challenge`, `code_challenge_method=S256`, `grant_type=authorization_code`, `code`, `code_verifier`. Réponse du jeton : `{ "access_token": "...", "token_type": "Bearer" }`. Erreurs de `/oauth/jeton` au format RFC 6749 : `400 { "error": "invalid_request" | "invalid_grant" | "unsupported_grant_type" }` (avec `error_description` en français).
- Erreurs renvoyées au client par redirection : `?error=invalid_request|unsupported_response_type|access_denied`, plus `state` s'il était fourni.
- Les autres refus suivent le format FDL `{ error: { code, message } }` : messages en français, codes en anglais (`unauthorized`, `rate_limited`).
- Pas d'emoji ni de tiret cadratin dans le code et la doc.
- Tests : `npm run test:docker` (Docker Desktop doit tourner). Fichiers en LF (`git ls-files --eol` doit montrer `i/lf`) ; écrire les fichiers avec Write/Edit, jamais par heredoc ni script.

## Review Focus

1. `redirect_uri` sur une autre origine que `client_id` (ou `client_id` qui n'est pas une origine nue) : page d'erreur FDL, **jamais** de redirection (sinon FDL devient un redirecteur ouvert).
2. Un code utilisé deux fois, par une autre instance, avec un autre `redirect_uri`, après 5 minutes ou avec un mauvais `code_verifier` : `invalid_grant`, et le code ne sert plus.
3. Un jeton envoyé sur une page du site (`/compte/securite`, `/`) sans cookie : redirection vers `/connexion`, le jeton n'ouvre rien hors de `/api/`.
4. Le jeton d'un compte banni, d'une liaison retirée ou inconnu : `401` JSON.
5. Le cookie `fdl_suite` ne renvoie jamais ailleurs que sur `/oauth/autoriser?...` (pas de redirection ouverte après connexion).

---

### Task 1: Codes et jetons

**Files:**
- Create: `src/migrations/0007-oauth.sql`
- Create: `src/oauth.js`
- Test: `tests/oauth.test.js`

**Interfaces:**
- Consumes: `hashToken(token: string) -> Buffer` de `src/accounts.js`.
- Produces (tous dans `src/oauth.js`) :
  - `parseAuthorization(params: URLSearchParams) -> { ok: true, clientId, redirectUri, challenge, state } | { ok: false, redirectUri: string|null, error: string, state }` : `redirectUri` est `null` quand `client_id` ou `redirect_uri` est invalide (ne jamais rediriger) ; sinon `error` vaut `unsupported_response_type` (`response_type` différent de `code`) ou `invalid_request` (défi absent ou mal formé, méthode différente de `S256`, `state` de plus de 500 caractères). `state` vaut `null` s'il est absent.
  - `createCode(db, { accountId, clientId, redirectUri, challenge }) -> Promise<string>`
  - `exchangeCode(db, { code, clientId, redirectUri, verifier }) -> Promise<string|null>` : le jeton d'accès, ou `null` (`invalid_grant`).
  - `loadToken(db, token: string) -> Promise<{ accountId, role, displayName, mfaOk: true, clientId } | null>`
  - `listLinks(db, accountId) -> Promise<{ clientId: string, createdAt: Date }[]>` (plus ancien d'abord)
  - `revokeLink(db, accountId, clientId) -> Promise<void>`

Schéma (`0007-oauth.sql`) :

```sql
CREATE TABLE oauth_codes (
  code_hash bytea PRIMARY KEY,
  account_id bigint NOT NULL REFERENCES accounts ON DELETE CASCADE,
  client_id text NOT NULL,
  redirect_uri text NOT NULL,
  challenge text NOT NULL,
  expires_at timestamptz NOT NULL
);

CREATE TABLE oauth_tokens (
  token_hash bytea PRIMARY KEY,
  account_id bigint NOT NULL REFERENCES accounts ON DELETE CASCADE,
  client_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, client_id)
);
```

Règles :

- `client_id` valide : se lit avec `new URL()`, protocole `http:` ou `https:`, chemin `/`, ni requête, ni fragment, ni identifiants, et `url.origin === client_id` (donc sans `/` final).
- `redirect_uri` valide : se lit avec `new URL()`, `url.origin === client_id`, pas de fragment, 2000 caractères au plus.
- Défi : `/^[A-Za-z0-9_-]{43}$/`. Vérificateur : `/^[A-Za-z0-9._~-]{43,128}$/`, et `createHash('sha256').update(verifier).digest('base64url') === challenge`.
- Codes et jetons : `randomBytes(32).toString('base64url')`, stockés par `hashToken`. Code valable 5 minutes ; `createCode` supprime au passage les codes expirés.
- `exchangeCode` consomme le code en premier (`DELETE ... RETURNING`), puis vérifie expiration, `client_id`, `redirect_uri`, PKCE et compte non banni ; en cas de succès, remplace le jeton de la paire (compte, instance) (`INSERT ... ON CONFLICT (account_id, client_id) DO UPDATE SET token_hash = EXCLUDED.token_hash, created_at = now()`).
- `loadToken` refuse une chaîne vide ou non chaîne, et un compte banni (`null`).

- [ ] **Step 1: Write the failing tests** (`tests/oauth.test.js`, même installation de base que `tests/api.test.js` : `createTestDatabase`, `migrate`, un compte par `INSERT INTO accounts`)

```js
const client = 'https://manger.exemple.fr';
const verifier = 'v'.repeat(43);
const challenge = createHash('sha256').update(verifier).digest('base64url');
const query = (fields) => new URLSearchParams({ response_type: 'code', client_id: client, redirect_uri: `${client}/fdl/retour`, code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz', ...fields });

describe('parseAuthorization', () => {
  it('accepts a well-formed request, http included', () => {
    assert.deepEqual(parseAuthorization(query()), { ok: true, clientId: client, redirectUri: `${client}/fdl/retour`, challenge, state: 'xyz' });
    assert.equal(parseAuthorization(query({ client_id: 'http://192.168.1.10:3000', redirect_uri: 'http://192.168.1.10:3000/r' })).ok, true);
  });
  it('never redirects on a bad client or redirect_uri', () => {
    for (const fields of [
      { client_id: 'https://manger.exemple.fr/' }, { client_id: 'https://manger.exemple.fr/x' }, { client_id: 'ftp://a.b' },
      { client_id: 'nimporte' }, { redirect_uri: 'https://evil.example/r' }, { redirect_uri: `${client}/r#f` },
      { redirect_uri: '/r' }, { client_id: '' },
    ]) assert.deepEqual(parseAuthorization(query(fields)).redirectUri, null, JSON.stringify(fields));
  });
  it('redirects the other errors with state', () => {
    assert.deepEqual(parseAuthorization(query({ response_type: 'token' })), { ok: false, redirectUri: `${client}/fdl/retour`, error: 'unsupported_response_type', state: 'xyz' });
    for (const fields of [{ code_challenge_method: 'plain' }, { code_challenge: 'court' }, { state: 's'.repeat(501) }]) {
      assert.equal(parseAuthorization(query(fields)).error, 'invalid_request');
    }
  });
});

describe('exchangeCode', () => {
  const grant = (code, fields = {}) => exchangeCode(pool, { code, clientId: client, redirectUri: `${client}/fdl/retour`, verifier, ...fields });
  const code = () => createCode(pool, { accountId: me, clientId: client, redirectUri: `${client}/fdl/retour`, challenge });

  it('gives a token once, which loads the account', async () => {
    const c = await code();
    const token = await grant(c);
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(await grant(c), null);
    assert.deepEqual(await loadToken(pool, token), { accountId: me, role: 'member', displayName: 'Membre', mfaOk: true, clientId: client });
  });
  it('refuses and burns the code on a wrong verifier, client, redirect_uri or expiry', async () => {
    for (const fields of [{ verifier: 'w'.repeat(43) }, { clientId: 'https://autre.fr' }, { redirectUri: `${client}/autre` }]) {
      const c = await code();
      assert.equal(await grant(c, fields), null);
      assert.equal(await grant(c), null);
    }
    const old = await code();
    await pool.query("UPDATE oauth_codes SET expires_at = now() - interval '1 second'");
    assert.equal(await grant(old), null);
  });
  it('replaces the token of a relinked instance and lists, revokes, cuts banned accounts', async () => {
    const first = await grant(await code());
    const second = await grant(await code());
    assert.equal(await loadToken(pool, first), null);
    assert.deepEqual((await listLinks(pool, me)).map((l) => l.clientId), [client]);
    await pool.query('UPDATE accounts SET banned_at = now() WHERE id = $1', [me]);
    assert.equal(await loadToken(pool, second), null);
    await pool.query('UPDATE accounts SET banned_at = NULL WHERE id = $1', [me]);
    await revokeLink(pool, me, client);
    assert.equal(await loadToken(pool, second), null);
    assert.deepEqual(await listLinks(pool, me), []);
    assert.equal(await loadToken(pool, ''), null);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm run test:docker`
Expected: FAIL, `src/oauth.js` introuvable.

- [ ] **Step 3: Write `0007-oauth.sql` and implement the six functions of `src/oauth.js`** with the rules above.

- [ ] **Step 4: Run to verify they pass**

Run: `npm run test:docker`
Expected: toute la suite PASS (341 tests de la partie A + les nouveaux).

- [ ] **Step 5: Commit**

```bash
git add src/migrations/0007-oauth.sql src/oauth.js tests/oauth.test.js
git commit -m "feat(oauth): codes PKCE et jetons de liaison Manger!"
```

---

### Task 2: Parcours d'autorisation, jeton et barrière

**Files:**
- Create: `src/routes/oauth.js`
- Modify: `src/server.js` (`PUBLIC_PATHS`, `buildBefore`, `buildRoutes`)
- Test: `tests/oauth.test.js` (HTTP, même serveur de test que `tests/api.test.js`)

**Interfaces:**
- Consumes: tout `src/oauth.js` (Task 1) ; `clientIp(request)` de `src/routes/auth.js` ; `createLimiter({ max })` de `src/ratelimit.js`.
- Produces:
  - `oauthRoutes(pool, config) -> routes` : `GET /oauth/autoriser`, `POST /oauth/autoriser`, `POST /oauth/jeton`.
  - `buildBefore(pool, config, { limiter = createLimiter({ max: 300 }) } = {})` : troisième argument optionnel ; les appels existants à deux arguments restent valides.
  - Cookie `fdl_suite` posé par la barrière (lu en Task 3).

Routes :

- `GET /oauth/autoriser` : `parseAuthorization(searchParams)`. `redirectUri` nul → `sendPage` `400`, titre « Demande de liaison invalide », texte « Cette demande de liaison Manger! est invalide. Revenez dans Manger! et recommencez. ». `ok: false` → `redirect` vers `redirectUri` avec `error` (et `state` s'il existe). Sinon page « Relier Manger! » :
  - « L'instance Manger! à l'adresse <strong>{clientId}</strong> demande à lire les recettes de FDL avec votre compte, y compris vos recettes privées. »
  - « Vous pourrez retirer cet accès à tout moment depuis la page Sécurité du compte. »
  - un formulaire `POST /oauth/autoriser` qui renvoie les 6 paramètres en champs cachés, avec deux boutons `name="decision"` : `value="autoriser"` « Autoriser » et `value="refuser"` « Refuser ».
  - La réponse efface `fdl_suite` (`Max-Age=0`, mêmes attributs qu'à la pose).
- `POST /oauth/autoriser` : `readBody` puis le même `parseAuthorization` sur le corps (mêmes réponses d'erreur). `decision` différent de `autoriser` → redirection `error=access_denied`. Sinon `createCode` avec `request.session.accountId` → redirection `303` vers `redirectUri` avec `code` (et `state`). Construire l'adresse avec `new URL(redirectUri)` et `searchParams.set`.
- `POST /oauth/jeton` : corps urlencodé seulement (`readBody` doit rendre un `URLSearchParams`, sinon `invalid_request`). `grant_type` différent de `authorization_code` → `unsupported_grant_type` ; `code`, `client_id`, `redirect_uri` ou `code_verifier` absent → `invalid_request` ; `exchangeCode` nul → `invalid_grant`. Succès : `200 { access_token, token_type: 'Bearer' }`. Toutes ses réponses portent `cache-control: no-store`.

Barrière (`buildBefore`), dans cet ordre :

1. Calculer `pathname` avant le contrôle d'origine. `POST /oauth/jeton` est exempté du contrôle `Origin` (appel de serveur à serveur) ; tout autre POST le garde, `POST /oauth/autoriser` compris.
2. Ajouter `/oauth/jeton` à `PUBLIC_PATHS`.
3. Sur `/api/` et `/oauth/jeton` : `limiter.hit('api-ip:' + clientIp(request))` vrai → `429` `rate_limited` « Trop de requêtes. Réessayez plus tard. ».
4. Sur `/api/` avec un en-tête `authorization` qui commence par `Bearer ` : `request.session = await loadToken(pool, reste)` et le cookie est ignoré ; puis, si la session existe, `limiter.hit('api-client:' + clientId)` vrai → même `429`. Hors `/api/`, l'en-tête est ignoré.
5. Le `401` de `/api/` porte en plus `www-authenticate: Bearer`.
6. Quand la barrière redirige une requête `GET /oauth/autoriser` sans session complète, elle pose `fdl_suite=<encodeURIComponent(request.url)>; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=600` sur cette redirection.

- [ ] **Step 1: Write the failing HTTP tests**

```js
it('links an instance end to end, then the token reads the API', async () => {
  const page = await get(`/oauth/autoriser?${query()}`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /https:\/\/manger\.exemple\.fr/);
  const answer = await post('/oauth/autoriser', { ...Object.fromEntries(query()), decision: 'autoriser' });
  assert.equal(answer.status, 303);
  const back = new URL(answer.headers.get('location'));
  assert.equal(back.origin + back.pathname, `${client}/fdl/retour`);
  assert.equal(back.searchParams.get('state'), 'xyz');
  const token = await fetch(`${base}/oauth/jeton`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: back.searchParams.get('code'), client_id: client, redirect_uri: `${client}/fdl/retour`, code_verifier: verifier }) });
  assert.equal(token.status, 200);
  assert.equal(token.headers.get('cache-control'), 'no-store');
  const { access_token, token_type } = await token.json();
  assert.equal(token_type, 'Bearer');
  const mine = await fetch(`${base}/api/v1/mes-recettes`, { headers: { authorization: `Bearer ${access_token}` } });
  assert.equal(mine.status, 200);
  const site = await fetch(`${base}/compte/securite`, { redirect: 'manual', headers: { authorization: `Bearer ${access_token}` } });
  assert.equal(site.status, 303);
});

it('shows an error page instead of redirecting to a foreign origin', async () => {
  const response = await get(`/oauth/autoriser?${query({ redirect_uri: 'https://evil.example/r' })}`);
  assert.equal(response.status, 400);
  assert.equal(response.headers.get('location'), null);
});

it('redirects a refusal with access_denied', async () => {
  const answer = await post('/oauth/autoriser', { ...Object.fromEntries(query()), decision: 'refuser' });
  assert.equal(new URL(answer.headers.get('location')).searchParams.get('error'), 'access_denied');
});

it('answers RFC errors on /oauth/jeton without an Origin check', async () => {
  const send = (fields) => fetch(`${base}/oauth/jeton`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://manger.exemple.fr' }, body: new URLSearchParams(fields) });
  assert.equal((await (await send({ grant_type: 'password' })).json()).error, 'unsupported_grant_type');
  assert.equal((await (await send({ grant_type: 'authorization_code' })).json()).error, 'invalid_request');
  const bad = await send({ grant_type: 'authorization_code', code: 'x', client_id: client, redirect_uri: `${client}/fdl/retour`, code_verifier: verifier });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error, 'invalid_grant');
});

it('refuses an unknown token with 401 and www-authenticate', async () => {
  const response = await fetch(`${base}/api/v1/mes-recettes`, { headers: { authorization: 'Bearer inconnu' } });
  assert.equal(response.status, 401);
  assert.equal(response.headers.get('www-authenticate'), 'Bearer');
});

it('remembers the authorization page for an anonymous visitor', async () => {
  const response = await get(`/oauth/autoriser?${query()}`, null);
  assert.equal(response.headers.get('location'), '/connexion');
  assert.match(response.headers.get('set-cookie'), /^fdl_suite=%2Foauth%2Fautoriser%3F/);
});

it('limits by address and by instance', async () => {
  // Serveur de test avec buildBefore(pool, config, { limiter: createLimiter({ max: 2 }) }).
  // 3e requête /api/v1/mes-recettes depuis la même adresse : 429 rate_limited.
  // Puis, avec un limiteur neuf : deux jetons de deux comptes pour la même instance, la 3e requête cumulée : 429.
});
```

`post(path, fields)` envoie un formulaire urlencodé avec `origin: 'http://localhost'` et le cookie de session. Le dernier test est décrit en commentaires : l'écrire avec un second serveur de test, sur le modèle de `beforeEach`.

- [ ] **Step 2: Run to verify they fail**

Run: `npm run test:docker`
Expected: FAIL, routes `/oauth/*` en 404 / redirection.

- [ ] **Step 3: Implement `src/routes/oauth.js` and the `src/server.js` changes** described above; add `...oauthRoutes(pool, config)` to `buildRoutes`.

- [ ] **Step 4: Run to verify they pass**

Run: `npm run test:docker`
Expected: toute la suite PASS.

- [ ] **Step 5: Commit**

```bash
git add src/routes/oauth.js src/server.js tests/oauth.test.js
git commit -m "feat(oauth): parcours d'autorisation, jeton et barriere Bearer"
```

---

### Task 3: Retour après connexion, révocation et documentation

**Files:**
- Modify: `src/web.js` (ajouter `landing`)
- Modify: `src/routes/auth.js` (redirections finales de `POST /connexion` et `POST /connexion/verification`)
- Modify: `src/passkeys.js` (`POST /cles/connexion/verification`) et `src/static/fdl-passkeys.js` (bouton `passkey-login`)
- Modify: `src/routes/security.js` (section et route de retrait)
- Modify: `docs/CONTRATS.md`, `docs/ARCHITECTURE.md`, `CAPABILITIES.md`
- Test: `tests/oauth.test.js`

**Interfaces:**
- Consumes: `listLinks`, `revokeLink` (Task 1) ; cookie `fdl_suite` (Task 2).
- Produces: `landing(request) -> string` dans `src/web.js` : la valeur décodée de `fdl_suite` si elle commence par `/oauth/autoriser?`, sinon `'/'` (cookie absent, mal encodé ou autre chemin).

Changements :

- `POST /connexion` (session complète d'emblée) et `POST /connexion/verification` redirigent vers `landing(request)` au lieu de `'/'`. La redirection vers `/connexion/verification` ne change pas.
- `POST /cles/connexion/verification` répond `{ ok: true, suite: landing(request) }` ; le bouton `passkey-login` de `fdl-passkeys.js` va à `suite` (repli `'/'`).
- `/compte/securite` : section `<h2>Instances Manger! reliées</h2>` après « Clés d'accès ». Liste : l'adresse de l'instance, « reliée le » date `toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris' })`, et un formulaire `POST /compte/securite/manger/retrait` (champ caché `client_id`, bouton « Retirer l'accès »). Liste vide : « Aucune instance reliée. ».
- `POST /compte/securite/manger/retrait` : `revokeLink` puis la page avec la notice « Accès retiré. ». Sans élévation (retirer un accès ne l'étend pas).
- Doc :
  - `CONTRATS.md` : nouvelle section « Liaison Manger! (OAuth 2.0 + PKCE) » avec les deux routes, les paramètres, les erreurs et les décisions du haut de ce plan ; dans « API Manger! », l'accès devient « session complète ou `Authorization: Bearer <jeton>` », plus `429` `rate_limited` (300 requêtes par 15 minutes, par adresse et par instance) et `www-authenticate: Bearer` sur le `401`.
  - `ARCHITECTURE.md` et `CAPABILITIES.md` : une ligne chacun pour la liaison.

- [ ] **Step 1: Write the failing tests**

```js
it('lands on the authorization page after signing in, never elsewhere', () => {
  const req = (cookie) => ({ headers: { cookie } });
  assert.equal(landing(req(`fdl_suite=${encodeURIComponent('/oauth/autoriser?client_id=x')}`)), '/oauth/autoriser?client_id=x');
  for (const cookie of [undefined, 'fdl_suite=%2Fadmin', `fdl_suite=${encodeURIComponent('https://evil.example/oauth/autoriser?')}`, 'fdl_suite=%E0%A4%A']) {
    assert.equal(landing(req(cookie)), '/', cookie);
  }
});

it('sends a password sign-in back to the authorization page', async () => {
  // Compte avec mot de passe connu (hashPassword), POST /connexion avec origin et le cookie fdl_suite :
  // 303, location = '/oauth/autoriser?...' encodé dans le cookie.
});

it('lists and revokes a linked instance from /compte/securite', async () => {
  // Lier une instance (createCode + exchangeCode), GET /compte/securite contient 'https://manger.exemple.fr' et 'Retirer l'accès' ;
  // POST /compte/securite/manger/retrait { client_id } : 200, 'Accès retiré.', et le jeton répond 401 sur /api/v1/mes-recettes.
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npm run test:docker`
Expected: FAIL, `landing` introuvable.

- [ ] **Step 3: Implement the changes above and update the three docs.**

- [ ] **Step 4: Run to verify they pass**

Run: `npm run test:docker`
Expected: toute la suite PASS.

- [ ] **Step 5: Commit**

```bash
git add src/web.js src/routes/auth.js src/passkeys.js src/static/fdl-passkeys.js src/routes/security.js tests/oauth.test.js docs/CONTRATS.md docs/ARCHITECTURE.md CAPABILITIES.md
git commit -m "feat(oauth): retour apres connexion, retrait de liaison et contrat"
```
