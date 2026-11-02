# FDL `commentaires` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Un membre connecté commente une recette visible. Il peut modifier ou supprimer son commentaire. N'importe qui peut signaler un commentaire, et les modérateurs acceptent, refusent ou retirent les commentaires avec un motif que l'auteur voit.

**Architecture:** Une table `comments` attachée à une recette. Un commentaire a un statut `pending`, `published`, `rejected` ou `removed`, et un motif quand il est refusé ou retiré. La logique vit dans `src/comments.js`. Les pages restent sans JavaScript : la section « Commentaires » est placée sous la page recette, avec trois petites routes pour écrire, modifier et supprimer. Les signalements réutilisent la table `reports`, avec une colonne `comment_id`. La file `/moderation` gagne deux listes : les commentaires en attente et les signalements de commentaires. Les décisions passent par `decideComment`, distincte de `decide`, qui verrouille une recette.

**Tech Stack:** Node.js >= 22, PostgreSQL 18 via `pg`. Aucune nouvelle dépendance.

**Spec:** `docs/superpowers/specs/2026-10-27-fdl-cahier-des-charges-design.md` section 6 bis : « texte simple, sans lien cliquable ni image. Chaque commentaire a un bouton « Signaler ». Son auteur peut le modifier ou le supprimer. Les commentaires suivent la même confiance progressive que les recettes, et un bannissement masque aussi les commentaires du compte » ; « Ni les notes ni les commentaires ne sont transmis à Manger! » ; « Réservés aux utilisateurs connectés ». Section 7 : décisions motivées, auteur informé. Décisions prises pour cette tranche (à revoir par le porteur) :
- **Texte de 1 à 1 000 caractères**, espaces de début et de fin retirés. Les retours à la ligne sont gardés à l'affichage (`white-space: pre-line`). Une adresse reste du texte échappé, jamais un lien.
- **Confiance progressive** : un compte publie directement s'il a au moins **3** commentaires publiés, ou s'il a déjà la confiance pour les recettes (`isTrusted`). Sinon, son commentaire attend un modérateur. Ainsi, un lecteur qui ne publie jamais de recette peut quand même gagner la confiance.
- **Filtres automatiques** : `link` (`http://`, `https://`, `www.`) et `banned_word` (même fichier `mots-interdits.txt`, même comparaison sans accents ni casse). Un commentaire signalé par un filtre attend toujours un modérateur. Pas de filtre de doublon.
- **Modifier** un commentaire refait le calcul du statut (publié directement ou en attente) et note `edited_at`. On ne modifie pas un commentaire retiré. **Supprimer** efface la ligne, et ses signalements partent avec elle.
- **L'auteur est informé** sur la page recette : il voit tous ses commentaires sur cette recette, avec leur état et le motif de la décision. Il n'y a pas de page « mes commentaires » dans cette tranche.
- Le retrait d'une recette (`remove`) ferme déjà tous ses signalements ouverts, y compris ceux de ses commentaires. Ses commentaires disparaissent avec la page.
- Réponses du porteur du 2026-11-02, consignées dans `CONTRATS.md` à la Tâche 0 : un modérateur peut décider sur sa propre recette (et donc sur son propre commentaire), et les notes d'un compte banni comptent encore dans les moyennes.

## Global Constraints

- Tout ce qui figure dans les Global Constraints des plans précédents reste valable (tests `node:test` via `npm run test:docker`, textes en français et noms anglais dans le code, tout texte d'une personne échappé, `Origin` vérifié sur tout `POST`, bêta fermée : aucune nouvelle route dans `PUBLIC_PATHS`, pages sans JavaScript).
- Toute requête existante qui lit `moderation_decisions` pour une **recette** doit ignorer les décisions de commentaire (`comment_id IS NULL`). Sinon, `/mes-recettes` afficherait le motif d'un commentaire comme dernière décision de la recette.
- Limites : texte de 1 à 1 000 caractères ; motif de 1 à 500 ; 10 écritures (ajout ou modification) par compte et par quart d'heure (limiteur existant, clé `comment:<accountId>`). Un dépassement → `tooMany` (`429`).
- Messages exacts : `COMMENT_INVALID = 'Le commentaire doit faire de 1 à 1 000 caractères.'` ; libellés d'état pour l'auteur : `pending` « En attente de modération », `published` « Publié », `rejected` « Refusé », `removed` « Retiré ».
- Fins de ligne LF, aucun octet NUL écrit à la main ; vérifier `git ls-files --eol` avant chaque commit ; les sous-agents écrivent avec Write/Edit, jamais avec des scripts shell.
- Travail sur la branche `feat/commentaires`, créée depuis `development` ; rien n'est poussé sans accord explicite.

## Review Focus

1. **Commentaire contenant du HTML ou une adresse** (`<script>`, `<a href>`, `https://…`). Affiché échappé, jamais cliquable. Avec une adresse, il attend un modérateur. Tests dans les Tâches 1 et 2.
2. **Quelqu'un modifie, supprime ou signale le commentaire d'un autre**, ou un commentaire en attente, refusé ou retiré. `404`, rien d'écrit. Tests dans les Tâches 2 et 3.
3. **Auteur banni.** Ses commentaires disparaissent de la page recette pour les autres et ne peuvent plus être signalés. Ils restent visibles des modérateurs dans la file, comme ses recettes. Test dans la Tâche 2.
4. **Décision de commentaire visible comme motif de recette** sur `/mes-recettes`. Ne doit pas arriver. Test dans la Tâche 3.
5. **Deux décisions concurrentes sur le même commentaire** (accepter et refuser en même temps). Une seule passe, l'autre reçoit `409` « Déjà traitée ». Test dans la Tâche 3.

---

### Task 0: Branche et réponses du porteur

- [ ] **Step 1:** `git switch development && git pull --ff-only && git switch -c feat/commentaires`
- [ ] **Step 2:** `npm run test:docker` → 276 tests, 0 échec.
- [ ] **Step 3:** Dans `docs/CONTRATS.md`, section « Contributions », ajouter une phrase après le paragraphe sur les motifs : « Un modérateur peut décider sur sa propre recette. Les notes d'un compte banni restent comptées dans les moyennes (décisions du porteur, 2026-11-02). »
- [ ] **Step 4:** Commit `docs(contributions): record owner decisions` (vérifier `git ls-files --eol`).

---

### Task 1: Modèle et logique des commentaires

**Files:**
- Create: `src/migrations/0006-comments.sql`
- Create: `src/comments.js`
- Modify: `src/contributions.js` (exporter `bannedWords` et `fold` ; `OWN` : la dernière décision ignore `comment_id IS NOT NULL`)
- Test: `tests/comments.test.js`

**Interfaces:**
- Consumes: `isTrusted(db, authorId)`, `bannedWords(dataDir)`, `fold(text)` (`src/contributions.js`) ; `VISIBLE` (`src/recipes.js`).
- Produces (`src/comments.js`) :
  - `COMMENT_INVALID` (texte exact ci-dessus), `COMMENT_TRUST = 3`.
  - `addComment(db, { recipeId, authorId, body, dataDir }) -> Promise<{ id: number, status }>` ; recette non visible → erreur `code: 'not_found'` ; texte invalide → erreur `code: 'invalid_comment'`, `message: COMMENT_INVALID`.
  - `editComment(db, { commentId, authorId, body, dataDir }) -> Promise<{ status }>` ; commentaire d'un autre, inconnu, retiré, ou recette plus visible → `not_found` ; texte invalide → `invalid_comment`.
  - `deleteComment(db, { commentId, authorId }) -> Promise<boolean>` (false si ce n'est pas le sien).
  - `listComments(db, { recipeId, viewerId }) -> Promise<Array<{ id, author, body, status, reason, createdAt, editedAt, mine }>>`, du plus ancien au plus récent : les commentaires `published` des comptes non bannis, plus **tous** ceux du lecteur, quel que soit leur statut.
  - `visibleComment(db, commentId) -> Promise<{ id, recipeId } | null>` : commentaire `published`, auteur non banni, recette visible (sert au signalement).

- [ ] **Step 1: Migration `0006-comments.sql`**

```sql
-- A comment belongs to one recipe; reason is the latest moderation reason shown to its author.
CREATE TABLE comments (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  recipe_id bigint NOT NULL REFERENCES recipes ON DELETE CASCADE,
  author_id bigint NOT NULL REFERENCES accounts ON DELETE CASCADE,
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 1000),
  status text NOT NULL CHECK (status IN ('pending', 'published', 'rejected', 'removed')),
  flags text[] NOT NULL DEFAULT '{}',
  reason text CHECK (char_length(reason) BETWEEN 1 AND 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  edited_at timestamptz
);
CREATE INDEX comments_recipe_idx ON comments (recipe_id, id);

-- A report or a decision with comment_id targets that comment of recipe_id.
ALTER TABLE reports ADD COLUMN comment_id bigint REFERENCES comments ON DELETE CASCADE;
DROP INDEX reports_open_idx;
CREATE UNIQUE INDEX reports_open_idx ON reports (recipe_id, coalesce(comment_id, 0), reporter_id) WHERE closed_at IS NULL;
ALTER TABLE moderation_decisions ADD COLUMN comment_id bigint REFERENCES comments ON DELETE SET NULL;
```

- [ ] **Step 2: Tests qui échouent** (`tests/comments.test.js`, base de test comme `tests/contributions.test.js`, `dataDir` `mkdtemp`)
- `addComment` d'un compte neuf → `status: 'pending'`. Le même compte avec 3 commentaires déjà `published` → `published`. Un compte qui a la confiance des recettes (3 recettes publiées) → `published`.
- Texte `'  '`, texte de 1 001 caractères, `body` non textuel → `code: 'invalid_comment'`, message `COMMENT_INVALID`, aucune ligne. Texte de 1 000 caractères → accepté. `'  Bon  '` est stocké `'Bon'`.
- Compte de confiance : un texte avec `https://x.fr` → `pending`, `flags` égal à `['link']` ; avec un mot de `mots-interdits.txt` (`Pâté` dans le fichier, `pate` dans le texte) → `pending`, `['banned_word']`.
- Recette privée, en brouillon, retirée, ou d'un auteur banni → `not_found`.
- `editComment` par l'auteur → nouveau texte, `edited_at` non nul, statut recalculé (un compte de confiance qui ajoute un lien repasse en `pending`). Par un autre compte, ou sur un commentaire `removed` → `not_found`, rien de changé.
- `deleteComment` par un autre → `false`, ligne présente ; par l'auteur → `true`, ligne absente, et un signalement ouvert sur ce commentaire est effacé.
- `listComments` : un lecteur tiers voit seulement les `published`, du plus ancien au plus récent, sans ceux d'un auteur banni. L'auteur voit aussi ses `pending`, `rejected` et `removed`, avec `reason` et `mine: true`.
- `visibleComment` : `null` pour un commentaire `pending`, celui d'un auteur banni, ou celui d'une recette retirée.
- `listMine` (`src/contributions.js`) : une décision insérée avec `comment_id` sur une recette n'apparaît pas comme `lastDecision` de cette recette.

- [ ] **Step 3: Lancer** `npm run test:docker` → les nouveaux tests échouent, les autres passent.

- [ ] **Step 4: Implémenter.** Le statut à l'écriture vaut `'published'` si aucun filtre ne se déclenche et que `isCommentTrusted` est vrai, sinon `'pending'`. `isCommentTrusted` = au moins `COMMENT_TRUST` commentaires `published` de ce compte, ou `isTrusted(db, accountId)`. La visibilité de la recette se teste avec `SELECT 1 ${VISIBLE} AND r.id = $1`.

- [ ] **Step 5: Lancer** `npm run test:docker` → tout passe ; `tests/migrate.test.js` voit le schéma 6.

- [ ] **Step 6: Commit** `feat(comments): add comments model` (vérifier `git ls-files --eol`).

---

### Task 2: Pages des commentaires

**Files:**
- Modify: `src/routes/catalogue.js` (section « Commentaires » de `GET /recette`)
- Create: `src/routes/comments.js` (`commentRoutes(pool, config, { limiter })`)
- Modify: `src/server.js` (`buildRoutes` ajoute `commentRoutes`)
- Modify: `src/routes/contributions.js` (`GET`/`POST /recette/signaler` acceptent `commentaire`)
- Modify: `src/static/fdl.css` (`.comment p { white-space: pre-line; }`)
- Test: `tests/comment-pages.test.js`

**Interfaces:**
- Consumes: tout `src/comments.js` (Tâche 1) ; `field`, `tooMany`, `clientIp` (`src/routes/auth.js`) ; `show` (`src/routes/catalogue.js`) ; `readBody`, `redirect`, `html` (`src/web.js`).
- Produces: routes `POST /recette/commentaire`, `GET /recette/commentaire/modifier?id=`, `POST /recette/commentaire/modifier`, `POST /recette/commentaire/supprimer` ; le signalement d'un commentaire écrit `reports.comment_id`.

- [ ] **Step 1: Tests qui échouent** (montage comme `tests/contribute-pages.test.js`, en-tête `origin` sur chaque `POST`)
- `GET /recette?id=` d'une recette visible contient `<h2>Commentaires</h2>` et un formulaire `action="/recette/commentaire"` avec `<textarea name="texte"`. La page d'une recette non publique vue par son auteur (bandeau d'état) n'a pas ce formulaire.
- `POST /recette/commentaire` (`id`, `texte`) → `303` vers `/recette?id=<id>#commentaires`. Le commentaire d'un compte neuf apparaît chez son auteur avec « En attente de modération », et pas chez un autre membre.
- Un commentaire publié contenant `<script>alert(1)</script> https://x.fr` est rendu échappé (`&lt;script&gt;`) et la page ne contient aucun `<a href="https://x.fr`.
- Texte vide → `400` avec `COMMENT_INVALID` ; recette inconnue ou privée → `404` ; 11e écriture dans le quart d'heure → `429`.
- Commentaire publié par un compte ensuite banni → absent de la page pour un autre membre.
- Un commentaire publié d'un autre affiche le nom de son auteur, la date (`Europe/Paris`), « (modifié) » s'il a été modifié, et un lien `/recette/signaler?id=<recette>&commentaire=<id>`. Ses propres commentaires n'ont pas ce lien, mais un lien « Modifier » et un formulaire « Supprimer ».
- `GET /recette/commentaire/modifier?id=` : formulaire prérempli pour l'auteur ; `404` pour un autre compte, un commentaire retiré ou un identifiant invalide. `POST /recette/commentaire/modifier` met à jour et renvoie `303` ; un autre compte → `404`.
- `POST /recette/commentaire/supprimer` : l'auteur → `303`, commentaire absent ; un autre compte → `404`, commentaire présent.
- Un motif de refus s'affiche sous le commentaire de son auteur : « Refusé. Motif : … ».
- `GET /recette/signaler?id=<recette>&commentaire=<id>` → formulaire avec le champ caché `commentaire`. `POST` → ligne `reports` avec `comment_id`. Un commentaire `pending`, celui d'un auteur banni, ou un commentaire d'une autre recette → `404`. Un second signalement ouvert du même compte sur le même commentaire donne la même page de remerciement sans nouvelle ligne. Signaler la recette puis un de ses commentaires donne 2 lignes.

- [ ] **Step 2: Lancer** → FAIL.

- [ ] **Step 3: Implémenter.** Les identifiants (`id` de recette, `id` de commentaire, `commentaire`) passent par le même contrôle que `parseId` (`/^\d{1,19}$/` et ≤ 2^63-1). Une erreur `invalid_comment` renvoie la page recette, ou le formulaire de modification, en `400` avec le message et le texte saisi ; `not_found` donne la page 404 existante. Le limiteur est compté avant l'écriture, seulement pour l'ajout et la modification. La section est rendue par une fonction `commentsSection(comments, { recipeId, canWrite })`, avec `id="commentaires"`, la liste dans `<ul>`, et chaque élément `class="comment"`.

- [ ] **Step 4: Lancer** `npm run test:docker` → tout passe.

- [ ] **Step 5: Commit** `feat(comments): write, edit, delete and report comments` (vérifier `git ls-files --eol`).

---

### Task 3: Modération des commentaires et documentation

**Files:**
- Modify: `src/comments.js` (`decideComment`)
- Modify: `src/moderation.js` (`listQueue` renvoie aussi `pendingComments` ; ses `reports` gardent seulement les signalements de recette, et une liste `commentReports` s'ajoute)
- Modify: `src/routes/moderation.js` (deux sections, `kind` `comment_accept`, `comment_reject`, `comment_remove`, champ `commentaire`)
- Modify: `docs/CONTRATS.md`, `CAPABILITIES.md`, `README.md`, `docs/ARCHITECTURE.md`
- Test: `tests/comments.test.js`, `tests/moderation.test.js`

**Interfaces:**
- Consumes: Tâches 1–2.
- Produces: `decideComment(db, { moderatorId, kind: 'accept' | 'reject' | 'remove', commentId, reason }) -> Promise<{ ok: true } | { error: 'bad_reason' | 'not_found' | 'already_done' }>`.

- [ ] **Step 1: Tests qui échouent**

`tests/comments.test.js` :
- `accept` sur un `pending` → `published`, `reason` reste nul ; `reject` → `rejected`, `reason` = motif ; `remove` sur un `published` → `removed`, `reason` = motif, et ses signalements ouverts sont fermés avec `decision_id`.
- `accept` ou `reject` sur un commentaire qui n'est pas `pending`, ou `remove` sur un commentaire qui n'est pas `published` → `already_done` ; identifiant inconnu → `not_found` ; motif vide ou de 501 caractères → `bad_reason`, rien d'écrit.
- Chaque décision écrit `moderation_decisions` (`recipe_id` du commentaire, `comment_id`, `decision` `accepted`/`rejected`/`removed`) et `admin_log` (`comment_accepted`, `comment_rejected`, `comment_removed`, cible = identifiant du commentaire, détail = recette, commentaire, motif).
- Deux `decideComment` lancés en même temps (`accept` et `reject`) sur le même `pending` → un `ok`, un `already_done`. Verrou : `SELECT … FROM comments WHERE id = $1 FOR UPDATE`.

`tests/moderation.test.js` :
- `GET /moderation` montre une section « Commentaires en attente » (texte échappé, lien vers la recette, filtres, formulaires Accepter/Refuser) et une section « Signalements de commentaires » (texte, catégorie, formulaires « Retirer le commentaire » et « Classer le signalement »). Un signalement de commentaire n'apparaît pas dans la liste des signalements de recette.
- `POST /moderation/decision` avec `kind=comment_reject`, `commentaire=<id>`, `motif` → `303`. L'auteur voit ensuite « Refusé. Motif : … » sur la page recette. Sur `/mes-recettes`, l'auteur de la **recette** ne voit pas ce motif.
- `kind=dismiss` sur un signalement de commentaire classe ce signalement (chemin existant), et le commentaire reste publié.
- `kind=comment_accept` sans `commentaire` → `404` ; déjà décidé → `409`.

- [ ] **Step 2: Lancer** → FAIL.

- [ ] **Step 3: Implémenter** `decideComment` sur le modèle de `decide` : transaction, verrou sur la ligne, contrôle d'état, insertion des décisions, puis `admin_log`. La route de décision choisit `decideComment` quand `kind` commence par `comment_`, avec `commentaire` comme identifiant.

- [ ] **Step 4: Documentation**
- `CONTRATS.md`, section « Contributions » : les 4 routes de commentaire, le signalement avec `commentaire`, les nouveaux `kind`, les limites, la confiance (3 commentaires publiés, ou confiance des recettes), les filtres, les états vus par l'auteur, les actions `admin_log`, la mention « jamais transmis à Manger! ».
- `CAPABILITIES.md`, `README.md`, `ARCHITECTURE.md` : les commentaires sont construits.

- [ ] **Step 5: Lancer** `npm run test:docker` → tout passe ; noter le total.

- [ ] **Step 6: Commit** `feat(comments): moderate comments` (vérifier `git ls-files --eol`).
