# Intégration Manger!, partie A : API de lecture FDL

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Une API JSON en lecture seule sous `/api/v1` qui permet à un serveur Manger! de chercher, lire et vérifier l'état d'une recette FDL.

**Architecture:** Un module `src/api.js` (état et projection d'une recette) et un fichier de routes `src/routes/api.js`. L'API passe par la même barrière que le site : en partie A, l'identité vient de la session (cookie). La partie B (liaison OAuth) ajoutera un jeton `Authorization: Bearer` qui remplit `request.session` ; rien d'autre de l'API ne changera.

**Tech Stack:** Node.js >= 22 (modules ES), PostgreSQL 18 via `pg`, `node:test`. Aucune nouvelle dépendance.

**Spec:** `docs/superpowers/specs/2026-10-27-fdl-cahier-des-charges-design.md` (sections 8 et 13) et `docs/CONTRATS.md` (« Projection compatible avec Manger! », « Pagination et recherche »).

Décisions du porteur (2026-11-02), à écrire dans `CONTRATS.md` :

- la tranche `integration-manger` est découpée en 3 plans : A (cette API), B (liaison de compte par un vrai OAuth 2.0 avec PKCE), C (côté Manger! : import, vérification des versions, suppression) ;
- pendant la bêta, l'API exige une identité (session en A, jeton en B) ; l'import sans compte s'ouvrira avec le public ;
- question ouverte 3 : quand l'**auteur** supprime lui-même sa recette (ou son compte supprime ses recettes privées), les copies Manger! **restent** ; c'est l'état `not_found`. Seul `removed` supprime une copie.

Décisions prises pour ce plan (choix Claude) :

- FDL ne masque pas une recette signalée (décision de la tranche `contributions`). L'état `hidden` de la spec 13 est donc réservé dans le contrat mais jamais produit ; Manger! traitera tout état inconnu comme « garder la copie ».
- Un auteur banni vaut retrait de ses recettes publiées (spec 13) : `removed`.
- Hors plan : limites de débit par instance (partie B, l'instance n'existe qu'avec le jeton), bouton « Importer dans Manger! » (partie C, il dépend de l'adresse de l'instance du foyer), photos (spec 13 : pas copiées en première version).

## Global Constraints

- Mode ponytail : le plus petit diff qui marche ; réutiliser `searchRecipes`, `readFilters`, `listMine`, `sendJson`, `sendError`.
- Pas de nouvelle dépendance, pas de migration.
- Routeur à chemins exacts : les paramètres passent par la chaîne de requête (`?id=`), jamais dans le chemin.
- Toute réponse de l'API est du JSON (`sendJson` / `sendError` de `src/http.js`), y compris le refus d'accès.
- Identifiant de recette accepté : `/^\d{1,19}$/` et `<= 9223372036854775807` (même règle que `parseId` de `src/routes/moderation.js`) ; sinon `404 not_found` pour `/recette`, `400 bad_request` pour `/etat`.
- Messages d'erreur en français, codes en anglais (`not_found`, `removed`, `bad_request`, `bad_cursor`, `unauthorized`).
- Pas d'emoji ni de tiret cadratin dans le code et la doc.
- Tests : `npm run test:docker` (Docker Desktop doit tourner). Fichiers en LF (`git ls-files --eol` doit montrer `i/lf`) ; écrire les fichiers avec Write/Edit, jamais par heredoc ni script.

## Review Focus

1. Une recette publiée avec une nouvelle version en attente : l'API sert la version publiée, jamais la version en attente.
2. La recette privée d'un autre compte : `not_found`, exactement comme un identifiant inconnu (aucune fuite d'existence).
3. Un auteur banni : ses recettes publiées sont `removed`, pas `not_found` (sinon Manger! garderait les copies).
4. `ids` malformé (lettres, vide, doublons, plus de 100, nombre plus grand qu'un bigint) : `400`, jamais `500`.
5. Une requête sans session sur `/api/...` : `401` JSON, pas une redirection HTML `303` vers `/connexion`.

---

### Task 1: État et projection d'une recette

**Files:**
- Create: `src/api.js`
- Test: `tests/api.test.js`

**Interfaces:**
- Consumes: `VISIBLE` n'est pas réutilisé (il exclut justement les cas à distinguer) ; table `recipes` (`visibility`, `published_version`, `removed_at`, `author_id`), `recipe_versions` (`status`), `accounts.banned_at`.
- Produces:
  - `recipeStates(db, ids: string[], accountId: number|null) -> Promise<Map<number, { state: 'published'|'private'|'removed'|'not_found', version?: number }>>` : une entrée par identifiant demandé ; `version` seulement pour `published` et `private`.
  - `apiRecipe(db, id: string, accountId: number|null, origin: string) -> Promise<{ state, recipe? }>` : `recipe` présent seulement pour `published` et `private`.

Règles de `state`, dans cet ordre (une seule requête SQL pour `recipeStates`, `id = ANY($1::bigint[])`) :

1. `removed` : `r.removed_at IS NOT NULL`, ou auteur banni (`a.banned_at IS NOT NULL`) et `r.published_version IS NOT NULL`.
2. `published` : `r.visibility = 'public'` ; `version = r.published_version`.
3. `private` : `r.visibility = 'private'` et `r.author_id = accountId` ; `version` = la plus grande version de statut `private`.
4. sinon `not_found` (inconnue, brouillon, privée d'un autre, privée d'un compte banni pour un autre lecteur).

Projection `recipe` (lue dans `recipe_versions` pour `(id, version)`, auteur joint) :

```js
{ id, version, visibility: 'public'|'private', title, minutes, servings, diet, tags, seasons,
  ingredients, steps, provenance, sourceUrl, licence, author, publishedAt, url }
```

`author` : `display_name` ou `null` (compte supprimé). `publishedAt` : `recipes.published_at` en ISO, `null` pour une privée. `url` : `${origin}/recette?id=${id}`. `ingredients` et `steps` tels que stockés (ils respectent déjà le tableau « Projection compatible avec Manger! »). Ni photo, ni note, ni commentaire.

- [ ] **Step 1: Write the failing tests** dans `tests/api.test.js` (même mise en place que `tests/catalogue.test.js` : base de test, `account()`, `publishVersion`, `saveDraft` + `submitVersion` pour les privées et les versions en attente)

```js
describe('recipeStates', () => {
  it('gives each id its state and version', async () => {
    // pub publiée v1 ; priv privée de `me` ; other privée d'un autre ; gone retirée ; 999999 inconnu
    const states = await recipeStates(pool, [pub, priv, other, gone, '999999'], me);
    assert.deepEqual(states.get(Number(pub)), { state: 'published', version: 1 });
    assert.deepEqual(states.get(Number(priv)), { state: 'private', version: 1 });
    assert.deepEqual(states.get(Number(other)), { state: 'not_found' });
    assert.deepEqual(states.get(Number(gone)), { state: 'removed' });
    assert.deepEqual(states.get(999999), { state: 'not_found' });
  });
  it('keeps the published version while a newer one waits', async () => { /* v2 pending -> { published, 1 } */ });
  it('counts a banned author as removal', async () => { /* UPDATE accounts SET banned_at = now() -> removed */ });
});

describe('apiRecipe', () => {
  it('projects a published recipe without photo, rating or comment', async () => {
    const { state, recipe } = await apiRecipe(pool, pub, null, 'https://fdl.example');
    assert.equal(state, 'published');
    assert.equal(recipe.url, `https://fdl.example/recette?id=${pub}`);
    assert.equal(recipe.visibility, 'public');
    for (const key of ['photo', 'rating', 'comments']) assert.ok(!(key in recipe), key);
  });
  it('shows a private recipe to its author only', async () => { /* me -> private ; autre -> not_found, pas de recipe */ });
});
```

- [ ] **Step 2: Run** `npm run test:docker` : les nouveaux tests échouent (module absent).
- [ ] **Step 3: Implement** `recipeStates` et `apiRecipe` dans `src/api.js`. `apiRecipe` appelle `recipeStates(db, [id], accountId)` puis lit la version.
- [ ] **Step 4: Run** `npm run test:docker` : tout passe.
- [ ] **Step 5: Commit** `feat(api): etat et projection d'une recette pour Manger!`

### Task 2: Routes `/api/v1` et barrière JSON

**Files:**
- Create: `src/routes/api.js`
- Modify: `src/server.js` (`buildBefore` : refus JSON pour `/api/` ; `buildRoutes` : `...apiRoutes(pool, config)`)
- Modify: `src/routes/catalogue.js` (exporter `readFilters`, rien d'autre)
- Modify: `docs/CONTRATS.md`, `docs/ARCHITECTURE.md`, `CAPABILITIES.md` (racine), spec section 12
- Test: `tests/api.test.js`

**Interfaces:**
- Consumes: Task 1 (`recipeStates`, `apiRecipe`), `searchRecipes(db, filters, { limit, after })`, `readFilters(params)`, `listMine(db, authorId)`, `config.origin`.
- Produces: `apiRoutes(pool, config) -> routes` ; les 4 routes ci-dessous, que la partie C appellera.

| Route | Réponse |
| --- | --- |
| `GET /api/v1/recettes` (mêmes paramètres que `/recherche`, plus `limite` 1 à 50, défaut 20) | `200 { items: [{ id, title, minutes, diet, author }], next }` ; curseur invalide : `400 bad_cursor` |
| `GET /api/v1/recette?id=` | `200` projection ; `404 not_found` « Recette introuvable. » ; `410 removed` « Recette retirée par la modération. » |
| `GET /api/v1/etat?ids=1,2,3` (1 à 100 identifiants distincts) | `200 { "1": { "state": "published", "version": 3 }, "2": { "state": "removed" } }` ; malformé : `400 bad_request` |
| `GET /api/v1/mes-recettes` | `200 { items: [{ id, title, state, version }] }` : recettes du compte en `published` ou `private` (`published_pending` compte comme `published`), version donnée par `recipeStates` |

Barrière : dans `buildBefore`, si la requête n'a pas de session `mfaOk` et que le chemin commence par `/api/`, répondre `sendError(response, 401, 'unauthorized', 'Connexion requise.')` au lieu de rediriger. `PUBLIC_PATHS` ne change pas. Réponses de l'API : en-tête `cache-control: no-store` (elles dépendent du compte).

- [ ] **Step 1: Write the failing tests** (Review Focus 4 et 5 inclus)

```js
it('answers 401 JSON without a session', async () => {
  const response = await get('/api/v1/recettes', null);
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, 'unauthorized');
});
it('searches with the site filters and a page size', async () => { /* 3 publiées, limite=2 -> 2 items + next ; apres=next -> 1 item ; apres=xx -> 400 bad_cursor */ });
it('serves a recipe, 404 for unknown or foreign private, 410 once removed', async () => { /* id=abc et id=99999999999999999999 -> 404 */ });
it('reports states in one call', async () => { /* ids=pub,gone,999 -> 3 états */ });
it('refuses malformed ids', async () => {
  for (const ids of ['', 'a', '1,,2', '1,1', Array.from({ length: 101 }, (_, i) => i + 1).join(','), '99999999999999999999']) {
    assert.equal((await get(`/api/v1/etat?ids=${ids}`)).status, 400, ids);
  }
});
it('lists my published and private recipes, not my drafts', async () => {});
```

- [ ] **Step 2: Run** `npm run test:docker` : les nouveaux tests échouent.
- [ ] **Step 3: Implement** `src/routes/api.js`, la barrière et l'enregistrement dans `buildRoutes`.
- [ ] **Step 4: Docs**
  - `CONTRATS.md` : nouvelle section « API Manger! (`/api/v1`) » : les 4 routes, les états (`published`, `private`, `removed`, `not_found`, `hidden` réservé), la projection, « seul `removed` supprime une copie », les 3 décisions du porteur ci-dessus ; dans « Pagination et recherche », remplacer « L'API JSON (`/api/v1`) arrivera avec `integration-manger` » par un renvoi vers cette section. Dans la spec, section 12, ajouter à la question ouverte 3 : « Tranché par l.user le 2026-11-02 : les copies restent. »
  - `docs/ARCHITECTURE.md` et `CAPABILITIES.md` : une ligne chacun (`integration-manger` partie A construite ; B et C à venir).
- [ ] **Step 5: Run** `npm run test:docker` : tout passe ; `git ls-files --eol src tests docs CAPABILITIES.md` : `i/lf`.
- [ ] **Step 6: Commit** `feat(api): routes /api/v1 de lecture pour Manger!`
