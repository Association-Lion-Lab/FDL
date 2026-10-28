# FDL `catalogue` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Une personne invitée et connectée voit une vitrine de recettes publiées, cherche par texte et filtres (durée, régime, univers, saisons) et lit une page recette complète.

**Architecture:** Même processus Node que `acces`, pages HTML rendues côté serveur, routes à chemin exact (paramètres en requête : `/recette?id=…`). Une recette (`recipes`) pointe vers sa version publiée (`recipe_versions`, jamais modifiée après insertion). La recherche utilise la recherche plein texte PostgreSQL avec une configuration française + `unaccent`, calculée à l'insertion de la version. Pagination par curseur opaque (date de première publication, id).

**Tech Stack:** Node.js >= 22, PostgreSQL 18 via `pg`. Aucune nouvelle dépendance.

**Spec:** `docs/superpowers/specs/2026-10-27-fdl-cahier-des-charges-design.md` (sections 4, 5, 6, 13) et `docs/CONTRATS.md` (« Recette communautaire », « Projection compatible avec Manger! », « Pagination et recherche »). Décisions prises pour cette tranche (à revoir par le porteur) :
- licence du texte : `CC-BY-SA-4.0` seule valeur pour l'instant (piste de la question ouverte 2) ;
- pas de saisie de recette ici : `contributions` l'apportera. Les recettes de cette tranche viennent de `publishVersion` (tests, script de démonstration) ;
- hors tranche : photos, « Signaler », notes, « Importer dans Manger! », API JSON `/api/v1` (avec `integration-manger`), écran d'administration des univers, historique des versions affiché ;
- univers : table fermée, sans valeur initiale en production (Manger! n'est pas disponible pour reprendre ses valeurs) ; le script de démonstration en crée trois.

## Global Constraints

- Tout ce qui figure dans les Global Constraints des plans `socle` et `acces` reste valable (Node `>=22`, `node:test`, `npm run test:docker` comme référence, textes en français et noms anglais dans le code, tout texte venant d'une personne échappé, aucun script ni style tiers, `Origin` vérifié sur tout `POST`).
- Bêta fermée : aucune route de cette tranche n'entre dans `PUBLIC_PATHS` ; sans session complète, elles renvoient vers `/connexion` (déjà fait par `buildBefore`).
- Limites des champs : exactement celles du tableau « Projection compatible avec Manger! » de `docs/CONTRATS.md`, posées en contraintes `CHECK` de la base.
- Pagination : 20 par défaut, 50 au maximum ; curseur invalide → `400` avec le code stable `bad_cursor`. Aucun brouillon, recette privée ou recette d'un compte banni dans les résultats ni sur la page recette.
- Une liste de saisons absente ou vide signifie « non renseigné », jamais « toute l'année ».
- Travail sur la branche `feat/catalogue`, créée depuis `development` ; rien n'est poussé sans accord explicite.

## Review Focus

1. **Texte de recette contenant du HTML** (`<script>` dans un titre, un ingrédient, une étape, un nom d'auteur). Affiché échappé partout. Test dans la Tâche 2.
2. **Recherche avec une syntaxe bizarre** (`'`, `&|!(`, `"non fermé`, 500 caractères). Pas de 500 : résultats ou liste vide. Test dans la Tâche 1.
3. **Curseur trafiqué** (base64 aléatoire, JSON de mauvaise forme, id énorme). Page `400`, jamais `500`. Tests dans les Tâches 1 et 2.
4. **Auteur banni.** Ses recettes disparaissent de la recherche, de la vitrine, et sa page recette répond `404`. Tests dans les Tâches 1 et 2.
5. **Majuscules, accents et pluriels** : « POIREAUX » et « poireau » trouvent « Poireaux vinaigrette » ; « pates » trouve « Pâtes au pesto ». Test dans la Tâche 1.

---

### Tâche 0 : Schéma

**Files:**
- Create: `src/migrations/0003-catalogue.sql`
- Modify: `tests/migrate.test.js`

Configuration de recherche : `CREATE TEXT SEARCH CONFIGURATION fdl_fr (COPY = french)` puis `ALTER TEXT SEARCH CONFIGURATION fdl_fr ALTER MAPPING FOR hword, hword_part, word WITH unaccent, french_stem` (l'extension `unaccent` existe depuis `0001`).

| Table | Colonnes |
| --- | --- |
| `universes` | `slug text PK CHECK (slug ~ '^[a-z0-9-]{1,40}$')`, `label text NOT NULL` (1 à 40 caractères) |
| `recipes` | `id bigint identity PK`, `author_id bigint REFERENCES accounts ON DELETE SET NULL` (NULL = « Auteur anonyme »), `visibility text NOT NULL DEFAULT 'draft' CHECK (visibility IN ('draft','private','public'))`, `published_version integer`, `published_at timestamptz` (première publication, jamais changée ensuite), `created_at timestamptz NOT NULL DEFAULT now()` ; index `(published_at DESC, id DESC)` |
| `recipe_versions` | `recipe_id bigint REFERENCES recipes ON DELETE CASCADE`, `version integer CHECK (version > 0)`, PK `(recipe_id, version)` ; `title` (1 à 120), `minutes` (1 à 1 440), `servings` (1 à 100), `diet` (`vegan`, `vegetarian`, `pescetarian`, `omnivore`), `tags text[] NOT NULL DEFAULT '{}'` (20 au plus), `seasons text[] NOT NULL DEFAULT '{}'` (sous-ensemble de `spring`, `summer`, `autumn`, `winter`, via `<@`), `universe text REFERENCES universes`, `ingredients jsonb NOT NULL` (tableau, 1 à 100 éléments), `steps jsonb NOT NULL` (tableau, 1 à 50), `provenance text NOT NULL` (1 à 200), `source_url text` (`^https?://`, 2 000 au plus), `text_licence text NOT NULL DEFAULT 'CC-BY-SA-4.0' CHECK (text_licence IN ('CC-BY-SA-4.0'))`, `search tsvector NOT NULL`, `submitted_at timestamptz NOT NULL`, `published_at timestamptz NOT NULL` ; index GIN sur `search` |

La taille de chaque tag (40) et le contenu de chaque ingrédient et étape ne sont pas vérifiés en SQL : `publishVersion` (Tâche 1) le fait.

- [ ] **Step 1: Test en échec** dans `tests/migrate.test.js` : après `migrate`, les 3 tables existent ; `SELECT to_tsvector('fdl_fr', 'Pâtes aux poireaux') @@ websearch_to_tsquery('fdl_fr', 'pates poireau')` → `true` ; insérer une version avec `minutes = 0` → code `23514`.
- [ ] **Step 2:** Écrire la migration. **Step 3:** `npm run test:docker` → PASS. **Commit** `feat(catalogue): add recipe schema and French search`.

### Tâche 1 : Lecture et recherche des recettes

**Files:**
- Create: `src/recipes.js`, `tests/recipes.test.js`

**Interfaces:**
- Produces (dans `src/recipes.js`) :
  - `DIETS = ['vegan', 'vegetarian', 'pescetarian', 'omnivore']`, `SEASONS = ['spring', 'summer', 'autumn', 'winter']`.
  - `publishVersion(db, { recipeId = null, authorId = null, fields }) => Promise<{ id: number, version: number }>`. `fields` : `{ title, minutes, servings, diet, tags = [], seasons = [], universe = null, ingredients, steps, provenance, sourceUrl = null }`, avec un ingrédient `{ name, amount, unit, preparation }` et une étape `{ kind, instruction, minutes }` selon le tableau de `CONTRATS.md`. Sans `recipeId` : crée la recette. Sinon : version suivante, sous `SELECT … FOR UPDATE` sur la recette. Dans les deux cas : `visibility = 'public'`, `published_version` = la nouvelle version, `published_at` posé seulement s'il est NULL, `submitted_at = published_at = now()`. `search` = `setweight(to_tsvector('fdl_fr', title), 'A') || setweight(to_tsvector('fdl_fr', <noms d'ingrédients et tags joints par des espaces>), 'B')`. Un champ hors limites lève `Object.assign(new Error(<message français>), { code: 'invalid_recipe' })` sans rien écrire.
  - `getRecipe(db, id) => Promise<RecipeView | null>`. `RecipeView` : `{ id, version, title, minutes, servings, diet, tags, seasons, universe: { slug, label } | null, ingredients, steps, provenance, sourceUrl, licence, author: string | null, submittedAt: Date, publishedAt: Date }`. `null` si l'id est inconnu, si la recette n'est pas `public`, si elle n'a pas de version publiée, ou si son auteur est banni.
  - `searchRecipes(db, { q = '', maxMinutes = null, diet = null, universe = null, seasons = [] } = {}, { limit = 20, after = null } = {}) => Promise<{ items: Card[], next: string | null }>`. `Card` : `{ id, title, minutes, diet, author: string | null }`. Tri `recipes.published_at DESC, id DESC`, y compris avec un texte. `limit` ramené dans `[1, 50]`. `next` est le curseur de la page suivante, `null` s'il n'y en a pas.
  - `listUniverses(db) => Promise<{ slug, label }[]>`, triés par `label`.
  - `currentSeason(date = new Date()) => string` : mars à mai `spring`, juin à août `summer`, septembre à novembre `autumn`, sinon `winter` (mois UTC).
  - Un curseur invalide lève `Object.assign(new Error('Lien de page invalide.'), { code: 'bad_cursor' })`.

Sémantique des filtres (à recopier dans `CONTRATS.md` en Tâche 3) :
- `q` vide ou uniquement des espaces : pas de filtre texte ; sinon `search @@ websearch_to_tsquery('fdl_fr', q)`.
- `maxMinutes` : `minutes <= maxMinutes`.
- `diet` : « convient à ». `vegan` → `vegan` ; `vegetarian` → `vegan`, `vegetarian` ; `pescetarian` → les trois premiers ; `omnivore` → pas de filtre.
- `universe` : égalité stricte.
- `seasons` : au moins une saison commune (`&&`). Une recette sans saison ne sort jamais d'un filtre de saison.
- Curseur : `base64url(JSON.stringify({ t: <published_at ISO>, i: <id> }))` ; valide seulement si c'est un objet, `t` une date valide et `i` un entier positif sûr.

- [ ] **Step 1: Tests en échec** dans `tests/recipes.test.js` (base jetable, un compte créé en SQL comme dans `tests/admin.test.js`) :
  - `publishVersion` puis `getRecipe` → tous les champs relus, `version === 1`, `licence === 'CC-BY-SA-4.0'` ; une 2e `publishVersion` sur le même id → `version === 2`, `getRecipe` montre la 2e, `publishedAt` de la recette inchangé dans l'ordre de `searchRecipes`.
  - `title` de 121 caractères, `minutes: 0`, un tag de 41 caractères, aucune étape, `preparation: 'grilled'` → `invalid_recipe`, et aucune ligne dans `recipes`.
  - recette passée en `visibility = 'private'` ou `'draft'` par SQL → absente de `searchRecipes`, `getRecipe` → `null`.
  - auteur banni (`banned_at = now()`) → absent de `searchRecipes`, `getRecipe` → `null`.
  - auteur supprimé (`DELETE FROM accounts`) → recette toujours là, `author === null`.
  - « Poireaux vinaigrette » trouvé par `poireau`, `POIREAUX` ; « Pâtes au pesto » trouvé par `pates` ; `q` égal à `'`, `&|!(`, `"non fermé`, `'x'.repeat(500)` → aucune exception.
  - régime : une recette par régime ; `diet: 'vegetarian'` → exactement `vegan` et `vegetarian` ; `omnivore` → les quatre.
  - saisons : `seasons: ['winter']` trouve `['winter','autumn']`, pas `[]` ni `['summer']`.
  - `maxMinutes: 30` garde 30, exclut 31.
  - pagination : 25 recettes → page 1 de 20 avec `next`, page 2 de 5 avec `next === null`, aucun doublon ; `limit: 500` → 50 au plus.
  - `after` égal à `'zzz'`, `base64url('[]')`, `base64url('{"t":"x","i":1}')`, `base64url('{"t":"2026-01-01T00:00:00Z","i":1e30}')` → `bad_cursor`.
  - `currentSeason(new Date('2026-12-15T12:00:00Z')) === 'winter'`, `('2026-03-01T12:00:00Z') === 'spring'`.
- [ ] **Step 2:** Implémenter. **Step 3:** `npm run test:docker` → PASS. **Commit** `feat(catalogue): read, publish and search recipes`.

### Tâche 2 : Vitrine, recherche et page recette

**Files:**
- Create: `src/routes/catalogue.js`, `src/static/fdl-print.js`, `tests/catalogue.test.js`
- Modify: `src/server.js` (brancher `catalogueRoutes(pool)`), `src/routes/auth.js` (retirer l'ancien `GET /`), `src/static/fdl.css`

**Interfaces:**
- Consumes : `searchRecipes`, `getRecipe`, `listUniverses`, `currentSeason`, `DIETS`, `SEASONS` (Tâche 1) ; `html`, `sendPage` (`src/web.js`).
- Produces : `catalogueRoutes(pool) => routes` avec `GET /`, `GET /recherche`, `GET /recette`, `GET /static/fdl-print.js` (servi comme `fdl-copy.js` dans `src/routes/admin.js`).

Libellés : régimes `Végétalien`, `Végétarien`, `Pescétarien`, `Omnivore` ; saisons `Printemps`, `Été`, `Automne`, `Hiver` ; préparation `cru`, `cuit` (`unknown` n'affiche rien) ; étapes `Préparation`, `Cuisson`, `Repos`, `Service` ; auteur NULL → `Auteur anonyme` ; licence → `Texte sous licence CC BY-SA 4.0` avec un lien vers `https://creativecommons.org/licenses/by-sa/4.0/deed.fr`.

- **En-tête commun** à ces trois pages : lien `Faim de Lion` vers `/`, formulaire `GET /recherche` avec un champ `q` (libellé « Rechercher une recette »), lien `Sécurité du compte`, bouton `Me déconnecter` (formulaire `POST /deconnexion`, comme l'ancienne page d'accueil).
- **`GET /`** : rangées de 6 cartes au plus, dans cet ordre : « De saison » (`seasons: [currentSeason()]`), « Récemment ajoutées », « Rapides » (`maxMinutes: 30`), « Végétariennes » (`diet: 'vegetarian'`). Une rangée vide n'est pas affichée. Chaque rangée a un lien « Tout voir » vers `/recherche` avec le filtre correspondant. Catalogue vide : « Aucune recette publiée pour l'instant. »
- **Carte** : titre (lien `/recette?id=<id>`), durée (« 25 min »), régime, auteur.
- **`GET /recherche`** : paramètres `q`, `duree` (`15`, `30`, `60`), `regime` (`vegan`, `vegetarian`, `pescetarian`), `univers` (slug), `saison` (répétable, valeurs de `SEASONS`), `apres` (curseur). Une valeur inconnue de `duree`, `regime` ou `saison` est ignorée. Formulaire de filtres prérempli (le menu univers n'apparaît que si `listUniverses` n'est pas vide). Liste des cartes, « Aucune recette ne correspond. » si vide, lien « Page suivante » qui garde tous les paramètres et remplace `apres` par `next`. `bad_cursor` → page `400` « Lien de page invalide ».
- **`GET /recette?id=`** : id non composé uniquement de chiffres, au-delà de `9223372036854775807`, inconnu ou non visible → page `404` « Recette introuvable ». Sinon : titre, auteur, durée, portions, régime, saisons (rien si vide), univers, ingrédients (`amount unit name`, puis la préparation), étapes numérotées (type et durée si non nulle), provenance, lien source s'il existe, licence, « Version N, publiée le <date au format fr-FR> », bouton `Imprimer` (`id="print"`, `fdl-print.js` appelle `window.print()`). `@media print` masque l'en-tête et les boutons.

- [ ] **Step 1: Tests en échec** dans `tests/catalogue.test.js` (serveur et session comme `tests/admin.test.js`) :
  - sans session, `/`, `/recherche`, `/recette?id=1` → `303` vers `/connexion`.
  - un membre connecté voit sur `/` les titres publiés et le champ `name="q"` ; base vide → « Aucune recette publiée pour l'instant. ».
  - titre `<script>alert(1)</script>`, ingrédient `<b>sel</b>`, auteur nommé `<img src=x>` → la page recette et la recherche contiennent `&lt;script&gt;`, `&lt;b&gt;`, `&lt;img` et jamais la balise brute.
  - `/recette?id=abc`, `?id=99999999999999999999`, id inconnu, recette privée, auteur banni → `404` « Recette introuvable ».
  - auteur supprimé → « Auteur anonyme » ; la page montre « Version 1 », la licence et le lien CC.
  - `/recherche?apres=zzz` → `400` « Lien de page invalide ».
  - `/recherche?regime=vegetarian&duree=abc` → filtre régime appliqué, `duree` ignorée, statut `200`.
  - 25 recettes : `/recherche` affiche 20 cartes et un lien « Page suivante » ; le suivre affiche les 5 autres sans lien « Page suivante ».
- [ ] **Step 2:** Implémenter. **Step 3:** `npm run test:docker` → PASS. **Commit** `feat(catalogue): add showcase, search and recipe pages`.

### Tâche 3 : Données de démonstration, mesure, documentation

**Files:**
- Create: `scripts/seed-demo.js`
- Modify: `package.json` (`"seed:demo": "node scripts/seed-demo.js"`), `docs/CONTRATS.md`, `CAPABILITIES.md`, `README.md`

- `npm run seed:demo -- <nombre>` (défaut 30) : crée les univers `quotidien` (« Cuisine du quotidien »), `patisserie` (« Pâtisserie ») et `monde` (« Cuisine du monde ») avec `ON CONFLICT DO NOTHING`, puis `<nombre>` recettes variées via `publishVersion` (sans auteur, `provenance: 'Démonstration'`, régimes, durées, saisons et univers répartis, au moins une « Poireaux vinaigrette »). Il refuse de tourner (message français, code de sortie 1) si `NODE_ENV=production`. Il affiche le nombre de recettes créées.
- [ ] **Step 1:** Écrire le script. Le lancer sur une base jetable avec `5000`, puis mesurer depuis un script jetable hors du dépôt : 200 appels `searchRecipes` (texte, filtres, curseur), par 10 en parallèle. Noter le 95e centile.
- [ ] **Step 2:** `docs/CONTRATS.md` :
  - statut en tête : le catalogue HTML est implémenté ;
  - nouvelle section « Catalogue » : les trois routes, leurs paramètres, la sémantique des filtres de la Tâche 1, la licence, `bad_cursor` (`400`) ;
  - « Pagination et recherche » : remplacer le futur par l'état réel, préciser que l'API JSON arrive avec `integration-manger` ;
  - « Limites de la bêta à vérifier » : le 95e centile mesuré, avec la mention « mesuré en local, pas sur l'instance de test ».
- [ ] **Step 3:** `CAPABILITIES.md` : état « `catalogue` construit (sans photos, signalement, notes ni API) ». `README.md` : la commande `seed:demo`, réservée au développement.
- [ ] **Step 4:** `npm run test:docker` → PASS. **Commit** `docs(catalogue): document catalogue and add demo data`.
