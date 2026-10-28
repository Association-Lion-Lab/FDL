# FDL `contributions` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Un invité connecté écrit une recette (brouillon, privée ou publique), la soumet, et les modérateurs la valident, la refusent ou la retirent avec un motif que l'auteur voit. Chacun peut signaler une recette et noter les recettes des autres.

**Architecture:** Même processus Node, pages HTML sans JavaScript (le formulaire ajoute des lignes d'ingrédients ou d'étapes en renvoyant la page). Une recette garde un brouillon libre (`recipes.draft`, JSON) et des versions validées, chacune avec un statut (`private`, `pending`, `published`, `rejected`). Le catalogue public lit toujours `published_version`. La modération vit sous `/moderation`, ouverte aux rôles `moderator` et `admin`, et chaque décision est écrite dans `moderation_decisions` et dans `admin_log`.

**Tech Stack:** Node.js >= 22, PostgreSQL 18 via `pg`. Aucune nouvelle dépendance.

**Spec:** `docs/superpowers/specs/2026-10-27-fdl-cahier-des-charges-design.md` (sections 5, 6, 6 bis, 7, 9, 13) et `docs/CONTRATS.md`. Décisions prises pour cette tranche (à revoir par le porteur) :
- pas d'e-mail (fournisseur non choisi) : l'auteur voit l'état de chaque recette et le motif de la dernière décision sur `/mes-recettes`. C'est ainsi qu'il « en est informé » (DSA) ;
- photos : tranche séparée juste après celle-ci (téléversement, suppression des métadonnées EXIF, sauvegarde). Les commentaires restent une tranche à part (spec 6 bis) ;
- un signalement ne masque pas la recette : il entre dans la file, et le modérateur la garde ou la retire. L'état « masquée temporairement » de la spec 13 arrive avec `integration-manger`, qui en a besoin ;
- une décision de modération ne demande pas de reconfirmation : la session d'un modérateur est déjà courte (12 h) et exige une clé d'accès. Bannir reste réservé aux administrateurs, avec reconfirmation (déjà en place) ;
- mots interdits : fichier `<FDL_DATA_DIR>/mots-interdits.txt`, un mot par ligne, absent = aucun. Il est donc inclus dans la sauvegarde.

## Global Constraints

- Tout ce qui figure dans les Global Constraints des plans `socle`, `acces` et `catalogue` reste valable (tests `node:test` via `npm run test:docker`, textes en français et noms anglais dans le code, tout texte d'une personne échappé, `Origin` vérifié sur tout `POST`, bêta fermée : aucune nouvelle route dans `PUBLIC_PATHS`).
- Limites des champs : celles de `checkFields` dans `src/recipes.js` (tableau « Projection compatible avec Manger! » de `CONTRATS.md`). Un brouillon n'est pas validé, mais il est limité à 256 Kio.
- Confiance progressive : tant que l'auteur a moins de **3** recettes ayant au moins une version publiée, chaque version publique passe par un modérateur. Ensuite, elle est publiée directement, sauf si un filtre automatique la signale.
- Une recette publiée ne redevient jamais privée. Pendant qu'une nouvelle version attend, la version précédente reste publique.
- Chaque décision de modération a un motif (1 à 500 caractères), visible par l'auteur.
- Travail sur la branche `feat/contributions`, créée depuis `development` ; rien n'est poussé sans accord explicite.

## Review Focus

1. **Une personne modifie la recette d'une autre** (`POST` avec un `id` qui n'est pas le sien, ou d'une recette retirée). Refusé `404`, rien d'écrit. Tests dans la Tâche 2.
2. **Double envoi de « Publier »** (deux requêtes identiques). Une seule version en attente. Test dans la Tâche 1.
3. **Deux modérateurs décident en même temps sur la même version.** La première décision gagne, la seconde reçoit « Déjà traitée ». Test dans la Tâche 3.
4. **Texte HTML dans un motif, un signalement ou un brouillon**, affiché au modérateur ou à l'auteur. Échappé. Tests dans les Tâches 2 et 3.
5. **Note sur sa propre recette, ou sur une recette non visible.** Refusée. Test dans la Tâche 5.

---

### Tâche 0 : Schéma et catalogue qui ignore les recettes retirées

**Files:**
- Create: `src/migrations/0004-contributions.sql`
- Modify: `src/recipes.js` (`publishVersion`, clause `VISIBLE`), `tests/migrate.test.js`, `tests/recipes.test.js`

Changements :
- `recipe_versions` : `status text NOT NULL DEFAULT 'published' CHECK (status IN ('private','pending','published','rejected'))`, `published_at` devient nullable avec `CHECK ((status = 'published') = (published_at IS NOT NULL))`, `flags text[] NOT NULL DEFAULT '{}'` (raisons des filtres automatiques : `link`, `banned_word`, `duplicate`).
- `recipes` : `draft jsonb` (`CHECK (pg_column_size(draft) <= 262144)`), `removed_at timestamptz`, `removed_reason text`.
- `moderation_decisions` : `id bigint identity PK`, `recipe_id bigint NOT NULL REFERENCES recipes ON DELETE CASCADE`, `version integer` (NULL pour une décision sur la recette entière), `moderator_id bigint` (sans clé étrangère, comme `admin_log.actor_id`), `decision text NOT NULL CHECK (decision IN ('accepted','rejected','removed','report_dismissed'))`, `reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 500)`, `at timestamptz NOT NULL DEFAULT now()`.
- `reports` : `id bigint identity PK`, `recipe_id bigint NOT NULL REFERENCES recipes ON DELETE CASCADE`, `reporter_id bigint REFERENCES accounts ON DELETE SET NULL`, `category text NOT NULL CHECK (category IN ('illegal','copyright','off_topic','spam','other'))`, `detail text NOT NULL DEFAULT '' CHECK (char_length(detail) <= 1000)`, `created_at timestamptz NOT NULL DEFAULT now()`, `closed_at timestamptz`, `decision_id bigint REFERENCES moderation_decisions` ; index unique partiel `(recipe_id, reporter_id) WHERE closed_at IS NULL`.
- `ratings` : `recipe_id bigint REFERENCES recipes ON DELETE CASCADE`, `account_id bigint REFERENCES accounts ON DELETE CASCADE`, `stars smallint NOT NULL CHECK (stars BETWEEN 1 AND 5)`, `updated_at timestamptz NOT NULL DEFAULT now()`, PK `(recipe_id, account_id)`.

Dans `src/recipes.js` : `publishVersion` écrit `status = 'published'` ; `VISIBLE` ajoute `AND r.removed_at IS NULL` ; `checkFields` est exporté (Tâche 1 l'utilise).

- [ ] **Step 1: Tests en échec** :
  - `tests/migrate.test.js` : les 3 nouvelles tables existent ; une version `status = 'pending'` avec `published_at` non nul → `23514`.
  - `tests/recipes.test.js` : une recette publiée puis `UPDATE recipes SET removed_at = now()` → absente de `searchRecipes`, `getRecipe` → `null`.
- [ ] **Step 2:** Implémenter. **Step 3:** `npm run test:docker` → PASS. **Commit** `feat(contributions): add moderation, report and rating schema`.

### Tâche 1 : Brouillons, soumission, filtres et confiance

**Files:**
- Create: `src/contributions.js`, `tests/contributions.test.js`

**Interfaces:**
- Consumes : `checkFields(fields) => fields normalisés` (lève `invalid_recipe`), `getRecipe` (Tâche 0).
- Produces (dans `src/contributions.js`) :
  - `TRUST_THRESHOLD = 3`.
  - `saveDraft(db, { recipeId = null, authorId, draft }) => Promise<{ id: number }>` : crée la recette (`visibility = 'draft'`) ou remplace son brouillon. Recette d'un autre auteur, ou retirée → `Object.assign(new Error('Recette introuvable.'), { code: 'not_found' })`.
  - `submitVersion(db, { recipeId, authorId, mode, dataDir }) => Promise<{ version: number, status: 'private' | 'pending' | 'published', flags: string[] }>`. Valide `recipes.draft` avec `checkFields`, puis insère une version, sous `SELECT … FOR UPDATE` sur la recette :
    - `mode: 'private'` → statut `private`, `visibility = 'private'`. Refusé (`code: 'already_public'`) si la recette a déjà une `published_version`.
    - `mode: 'public'` → filtres d'abord. `pending` si l'auteur n'a pas la confiance ou si un filtre a tiré, sinon `published` (`published_version` et `published_at` comme `publishVersion`). Une version déjà `pending` pour cette recette est remplacée (son statut passe à `rejected` avec le motif automatique « Remplacée par une version plus récente. » dans `moderation_decisions`, `moderator_id` NULL), pour qu'il n'y en ait jamais deux.
    - `search` et les colonnes sont remplies comme dans `publishVersion` (factoriser l'insertion plutôt que la recopier).
  - `isTrusted(db, authorId) => Promise<boolean>` : au moins `TRUST_THRESHOLD` recettes de l'auteur avec une `published_version`.
  - `autoFlags(db, fields, { recipeId, dataDir }) => Promise<string[]>` :
    - `link` : `/https?:\/\/|www\./i` dans le titre, un nom d'ingrédient, une instruction ou la provenance (`sourceUrl` est permis) ;
    - `banned_word` : un mot de `mots-interdits.txt` apparaît comme mot entier, en ignorant casse et accents (comparer après `normalize('NFD')` sans diacritiques et en minuscules) ;
    - `duplicate` : une autre recette visible a le même titre une fois normalisé de la même façon.
  - `listMine(db, authorId) => Promise<MyRecipe[]>`. `MyRecipe` : `{ id, title, state, lastDecision: { decision, reason, at } | null }`. `title` vient de la dernière version, sinon du brouillon, sinon « Sans titre ». `state` est l'un de `draft`, `private`, `pending`, `published`, `published_pending` (publiée, nouvelle version en attente), `rejected`, `removed`.
  - `getOwnRecipe(db, { recipeId, authorId }) => Promise<{ id, draft, latest: RecipeView-like | null, state } | null>` : `null` si la recette n'est pas à cet auteur.

- [ ] **Step 1: Tests en échec** dans `tests/contributions.test.js` (base jetable, `dataDir` temporaire comme `tests/admin.test.js`, `recipe()` de `tests/helpers/recipes.js` comme brouillon) :
  - `saveDraft` accepte un brouillon incomplet (`{ title: '' }`) ; `submitVersion` dessus → `invalid_recipe`, aucune version.
  - un nouvel auteur publie → `pending`, absent de `searchRecipes` ; trois recettes passées en `published` (via `publishVersion` avec son `authorId`) → la suivante est `published` directement.
  - un auteur de confiance dont le titre contient `www.exemple.fr`, ou un mot listé dans `mots-interdits.txt` (`Arnaque`, trouvé dans « arnaque »), ou un titre identique à une recette visible (« Pâtes au pesto » contre « pates au PESTO ») → `pending` avec le bon `flags`.
  - deux `submitVersion` publics lancés en parallèle (`Promise.all`) sur la même recette → une seule version `pending` à la fin.
  - recette publiée, puis nouvelle version `pending` → `getRecipe` montre toujours l'ancienne version ; `listMine` donne `published_pending`.
  - `mode: 'private'` sur une recette déjà publiée → `already_public`.
  - `saveDraft` avec le `recipeId` d'un autre auteur → `not_found`, brouillon inchangé.
- [ ] **Step 2:** Implémenter. **Step 3:** `npm run test:docker` → PASS. **Commit** `feat(contributions): drafts, submission, filters and trust`.

### Tâche 2 : Pages de l'auteur

**Files:**
- Create: `src/routes/contributions.js`, `tests/contribute-pages.test.js`
- Modify: `src/web.js` (`readBody(request, { max = 16 * 1024 } = {})`), `src/server.js`, `src/routes/catalogue.js` (lien « Mes recettes » dans l'en-tête ; l'auteur voit sa recette non publique), `tests/web.test.js`

**Interfaces:**
- Consumes : Tâche 1 ; `html`, `sendPage`, `readBody`, `redirect` ; `field` (`src/routes/auth.js`).
- Produces : `contributionRoutes(pool, config) => routes`.

Routes :
- `GET /mes-recettes` : liste de `listMine` avec un libellé par état (`Brouillon`, `Privée`, `En attente de modération`, `Publiée`, `Publiée, nouvelle version en attente`, `Refusée`, `Retirée`) et, s'il existe, le motif de la dernière décision. Lien « Écrire une recette ».
- `GET /mes-recettes/edition?id=` (sans `id` : nouvelle recette) : formulaire prérempli depuis le brouillon, sinon depuis la dernière version. Champs : titre, durée, portions, régime (menu), saisons (cases), univers (menu si la liste n'est pas vide), étiquettes (une ligne, séparées par des virgules), provenance, lien source. Ingrédients en lignes répétées `ingredient_name`, `ingredient_amount`, `ingredient_unit`, `ingredient_preparation`, étapes en lignes `step_kind`, `step_instruction`, `step_minutes`. Au moins 5 lignes vides d'ingrédients et 3 d'étapes.
- `POST /mes-recettes/edition` (`readBody` avec `max: 256 * 1024`) : champ `action` parmi :
  - `lignes` : enregistre le brouillon et réaffiche le formulaire avec 5 lignes d'ingrédients et 3 d'étapes de plus ;
  - `brouillon` : enregistre, puis `303` vers `/mes-recettes` ;
  - `privee` / `publier` : enregistre, puis `submitVersion`. `publier` exige la case `atteste_texte` (la case de la photo arrivera avec les photos) (« Je suis l'auteur de ce texte ou j'ai le droit de le publier sous licence CC BY-SA 4.0 »). Une erreur `invalid_recipe` réaffiche le formulaire (statut `400`) avec le message et les valeurs saisies. Succès : `303` vers `/mes-recettes`.
  - Les lignes entièrement vides sont ignorées. Les nombres sont lus avec `Number` après remplacement de la virgule par un point. Une valeur illisible reste telle quelle dans le brouillon, et c'est `checkFields` qui la refuse.
- `GET /recette?id=` : pour l'auteur, une recette non publique (ou sa nouvelle version en attente) s'affiche avec un bandeau d'état. Tous les autres continuent de recevoir `404`.
- `id` d'une recette d'un autre auteur, inconnue ou retirée sur ces routes → page `404` « Recette introuvable ».

- [ ] **Step 1: Tests en échec** :
  - `tests/web.test.js` : `readBody` avec `max: 256 * 1024` accepte 100 Kio ; sans option, toujours `413` au-delà de 16 Kio.
  - `tests/contribute-pages.test.js` : un membre crée une recette complète par `POST` (`action=publier`, case `atteste_texte` cochée) → `303`, `/mes-recettes` affiche « En attente de modération ».
  - `action=publier` sans `atteste_texte` → `400` et le message, aucune version.
  - `action=lignes` → le formulaire revient avec 10 lignes d'ingrédients.
  - champ invalide (`minutes=abc`) → `400`, les autres valeurs restent dans le formulaire.
  - `POST` sur la recette d'un autre membre → `404`, rien d'écrit ; `GET /mes-recettes/edition?id=<autre>` → `404`.
  - l'auteur voit sa recette privée sur `/recette?id=` ; un autre membre reçoit `404`.
  - titre de brouillon `<script>x</script>` → échappé sur `/mes-recettes` et dans le formulaire.
- [ ] **Step 2:** Implémenter. **Step 3:** `npm run test:docker` → PASS. **Commit** `feat(contributions): add author pages`.

### Tâche 3 : File de modération

**Files:**
- Create: `src/moderation.js`, `src/routes/moderation.js`, `tests/moderation.test.js`
- Modify: `src/server.js`, `src/routes/admin.js` (lien « Modération » dans le menu `/admin`)

**Interfaces:**
- Produces (dans `src/moderation.js`) :
  - `listQueue(db) => Promise<{ pending: PendingItem[], reports: ReportItem[] }>` : versions `pending` (plus anciennes d'abord) avec titre, auteur, `flags` ; signalements ouverts avec catégorie, détail, recette et auteur du signalement.
  - `decide(db, { moderatorId, kind, recipeId, version = null, reportId = null, reason }) => Promise<{ ok: true } | { error: 'already_done' | 'not_found' | 'bad_reason' }>`, où `kind` vaut `accept`, `reject`, `remove` ou `dismiss`. Tout se fait dans une transaction, sous `FOR UPDATE` sur la recette :
    - `accept` : la version `pending` passe `published` (`published_version`, `published_at` comme `publishVersion`) ;
    - `reject` : elle passe `rejected` ;
    - `remove` : `removed_at`, `removed_reason` posés, et tous les signalements ouverts de la recette sont fermés avec cette décision ;
    - `dismiss` : le signalement est fermé.
    Chaque appel insère une ligne `moderation_decisions` et une ligne `admin_log` (`action` : `recipe_accepted`, `recipe_rejected`, `recipe_removed`, `report_dismissed` ; `detail` : `{ recipeId, version, reason }`). Une version qui n'est plus `pending`, une recette déjà retirée ou un signalement déjà fermé → `already_done`.

Routes (`moderator` et `admin` seulement ; les autres reçoivent `403` « Accès refusé ») :
- `GET /moderation` : les deux listes. Chaque élément a un lien vers la version concernée (`/moderation/version?id=&version=`, même rendu que la page recette) et des formulaires de décision avec un champ `motif` obligatoire.
- `GET /moderation/version?id=&version=` : affiche n'importe quelle version, retirée comprise.
- `POST /moderation/decision` : champs `kind`, `id`, `version`, `report`, `motif`. Succès → `303` vers `/moderation`. `already_done` → page `409` « Déjà traitée ». `bad_reason` → `400`.

- [ ] **Step 1: Tests en échec** dans `tests/moderation.test.js` (comptes et sessions comme `tests/admin.test.js`, clé d'accès insérée pour le modérateur) :
  - un membre → `403` sur les trois routes ; un modérateur et un admin → `200` sur `/moderation`.
  - accepter → la version est publique ; l'auteur voit « Publiée » et le motif sur `/mes-recettes` ; une ligne `admin_log` `recipe_accepted`.
  - refuser sans motif → `400`, rien ne change ; avec motif `<b>non</b>` → l'auteur le voit échappé.
  - retirer une recette publiée et signalée → absente du catalogue, `404` pour les membres, signalement fermé, l'auteur voit « Retirée » et le motif.
  - deux `decide` en parallèle sur la même version (`accept` et `reject`) → un `ok`, un `already_done`.
  - l'auteur ne peut ni modifier ni resoumettre une recette retirée (`404`).
- [ ] **Step 2:** Implémenter. **Step 3:** `npm run test:docker` → PASS. **Commit** `feat(contributions): add moderation queue`.

### Tâche 4 : Signalements

**Files:**
- Modify: `src/routes/catalogue.js` (bouton « Signaler » sur la page recette), `src/routes/moderation.js` ou `src/routes/contributions.js` (routes), `tests/moderation.test.js`

Routes :
- `GET /recette/signaler?id=` : formulaire avec la catégorie (`illegal` « Contenu illégal », `copyright` « Atteinte aux droits d'auteur », `off_topic` « Hors sujet », `spam` « Publicité ou spam », `other` « Autre ») et un détail facultatif (1 000 caractères au plus).
- `POST /recette/signaler` : enregistre le signalement, puis montre « Merci, votre signalement sera examiné. ». Un second signalement ouvert du même compte sur la même recette affiche le même message sans créer de ligne. Limite : 10 signalements par quart d'heure par compte (limiteur existant, clé `report:<accountId>`). Recette non visible → `404`.

- [ ] **Step 1: Tests en échec** : un membre signale → une ligne `reports` et l'élément apparaît sur `/moderation` ; second signalement identique → toujours une seule ligne ouverte ; catégorie inconnue → `400` ; détail de 1 001 caractères → `400` ; 11e signalement dans le quart d'heure → `429`.
- [ ] **Step 2:** Implémenter. **Step 3:** `npm run test:docker` → PASS. **Commit** `feat(contributions): add reports`.

### Tâche 5 : Notes

**Files:**
- Modify: `src/recipes.js` (`Card` et `RecipeView` reçoivent `rating: { average: number, count: number } | null`), `src/routes/catalogue.js`, `tests/recipes.test.js`, `tests/catalogue.test.js`

- `POST /recette/note` : champs `id`, `etoiles` (1 à 5). Upsert dans `ratings`. Refusé (page `403` « Vous ne pouvez pas noter votre propre recette. ») pour l'auteur ; recette non visible → `404` ; valeur hors 1 à 5 → `400`. Succès → `303` vers la page recette.
- Page recette : moyenne arrondie à une décimale et nombre de notes (« 4,5 / 5 (12 notes) »), ou « Pas encore de note » ; formulaire de note avec la note actuelle de la personne présélectionnée, absent pour l'auteur.
- Cartes : la moyenne et le nombre, s'il y a des notes.
- Vitrine : rangée « Les mieux notées » après « Récemment ajoutées », avec les recettes ayant au moins 3 notes, triées par moyenne puis par nombre, 6 au plus, sans lien « Tout voir ». Fonction `topRated(db, { limit = 6 }) => Promise<Card[]>` dans `src/recipes.js`.

- [ ] **Step 1: Tests en échec** :
  - `tests/recipes.test.js` : 3 notes (5, 4, 4) → `rating` `{ average: 4.33…, count: 3 }` (comparer avec une tolérance) ; `topRated` ignore une recette à 2 notes et les recettes d'un auteur banni.
  - `tests/catalogue.test.js` : l'auteur qui note sa recette → `403`, aucune ligne ; `etoiles=6` → `400` ; une deuxième note du même membre remplace la première ; la page affiche « 4,3 / 5 (3 notes) ».
- [ ] **Step 2:** Implémenter. **Step 3:** `npm run test:docker` → PASS. **Commit** `feat(contributions): add ratings`.

### Tâche 6 : Univers, documentation

**Files:**
- Modify: `src/routes/admin.js` (`GET`/`POST /admin/univers`), `tests/admin.test.js`, `docs/CONTRATS.md`, `docs/EXPLOITATION.md`, `CAPABILITIES.md`, `README.md`

- `GET /admin/univers` : liste et formulaire d'ajout (`slug` selon la contrainte de la base, `label` de 1 à 40 caractères). `POST /admin/univers` : ajoute, ou renomme si le `slug` existe ; une ligne `admin_log` `universe_saved`. Pas de suppression (une version peut y faire référence). Admin seulement, sans reconfirmation.
- [ ] **Step 1: Tests en échec** : un admin ajoute `monde` / « Cuisine du monde » → il apparaît dans le filtre de `/recherche` ; slug `Monde !` → `400` ; un modérateur → `403`.
- [ ] **Step 2:** Implémenter.
- [ ] **Step 3:** Documentation :
  - `docs/CONTRATS.md` : routes de l'auteur, de la modération, des signalements et des notes ; états d'une recette ; règle de confiance (3) ; filtres automatiques ; motif obligatoire ; nouvelles actions de `admin_log`.
  - `docs/EXPLOITATION.md` : le fichier `mots-interdits.txt` (emplacement, format, pris en compte sans redémarrage).
  - `CAPABILITIES.md` : `contributions` construit, sans photos ni commentaires. `README.md` : état.
- [ ] **Step 4:** `npm run test:docker` → PASS. **Commit** `feat(contributions): add universes admin and document contributions`.
