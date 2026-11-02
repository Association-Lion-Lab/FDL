# FDL `photos` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Un auteur joint une photo à sa recette depuis le formulaire d'écriture. Le serveur en retire toutes les métadonnées (EXIF, donc la position GPS), la stocke dans le dossier de données, et la page recette l'affiche avec son auteur. Les photos suivent la sauvegarde et la restauration.

**Architecture:** Le formulaire `/mes-recettes/edition` passe en `multipart/form-data`, lu par l'analyseur natif de Node (`Request.formData()`), sans dépendance. Seul le JPEG est accepté. Le serveur ne décode pas l'image : il parcourt les segments JPEG et ne garde que ceux nécessaires à l'affichage (tous les `APPn` et `COM` sont retirés). Le fichier est nommé par son empreinte SHA-256 (`<dataDir>/photos/<sha256>.jpg`). Le brouillon garde `photo: { file, credit }`. Chaque version garde `photo` et `photo_credit`, et une nouvelle photo crée donc une nouvelle version, modérée comme le texte. Un petit script facultatif (`fdl-photo.js`) réduit l'image à 1 600 px dans le navigateur et la convertit en JPEG. Ce script applique au passage l'orientation de l'appareil. Sans JavaScript, tout fonctionne avec un JPEG.

**Tech Stack:** Node.js >= 22, PostgreSQL 18 via `pg`. Aucune nouvelle dépendance.

**Spec:** `docs/superpowers/specs/2026-10-27-fdl-cahier-des-charges-design.md` (sections 4 « Page recette : photo avec son auteur », 6 « atteste ... séparément, de la photo », 13 « Photos ») et `docs/CONTRATS.md` (« Les droits et la provenance de la photo sont séparés de ceux du texte »). Décisions prises pour cette tranche (à revoir par le porteur) :
- **Compression automatique dans le navigateur, JPEG seulement côté serveur, 1 Mio et 8 000 px de côté au plus.** Le script convertit et réduit toute image (PNG, WebP, HEIC sur iPhone, photo de téléphone de 5 Mo) en JPEG de 1 600 px au plus, qualité 0,8 : environ 200 à 400 Kio, sans rien demander à la personne. Sans JavaScript, une photo de plus de 1 Mio est refusée avec un message, et le texte du brouillon est quand même enregistré. Pas de recompression côté serveur : elle demanderait une dépendance native (`sharp`) qui décoderait des images envoyées par les membres.
- **Sans JavaScript, une photo de téléphone peut s'afficher couchée** : l'orientation est une métadonnée EXIF, et le serveur la retire avec le reste. L'auteur le voit dans l'aperçu de son brouillon, et le script, présent dans tous les navigateurs actuels, évite le problème.
- **Les segments `APP0` à `APP15` sont tous retirés**, dont les profils de couleur (`APP2`) et le segment Adobe (`APP14`). Les couleurs d'une photo grand gamut peuvent donc légèrement changer, et un rare JPEG CMJN peut s'afficher faux. Le script, qui réencode en sRGB, évite les deux cas.
- **Une photo par recette.** Changer ou retirer la photo crée une nouvelle version à la publication suivante, soumise aux mêmes règles que le texte.
- **L'auteur de la photo** est un texte libre de 1 à 80 caractères (« Photo : … »), obligatoire dès qu'il y a une photo. La publication demande une seconde case : « J'ai pris cette photo ou j'ai le droit de la publier ».
- **Accès à une photo** : tout le monde (connecté, bêta fermée) voit celle de la version publiée d'une recette visible. L'auteur voit celles de ses brouillons et de ses versions. Le staff voit celles de toutes les versions. Rien d'autre, même avec l'empreinte.
- **Nettoyage** : une photo qu'aucun brouillon ni aucune version d'une recette non retirée ne cite est effacée du disque après 10 minutes. Le nettoyage tourne au démarrage, après chaque envoi de photo et après chaque retrait de recette par la modération. Une recette retirée perd donc ses photos, comme l'exige un contenu illicite.
- Pas de photo sur les cartes de la vitrine dans cette tranche : page recette, aperçu de modération et formulaire seulement.

## Global Constraints

- Tout ce qui figure dans les Global Constraints des plans `socle`, `acces`, `catalogue` et `contributions` reste valable (tests `node:test` via `npm run test:docker`, textes en français et noms anglais dans le code, tout texte d'une personne échappé, `Origin` vérifié sur tout `POST`, aucun script ni style tiers, bêta fermée : aucune nouvelle route dans `PUBLIC_PATHS`).
- Fichiers : `<dataDir>/photos/<64 hex minuscules>.jpg`, écrits d'abord dans `<dataDir>/tmp/` puis renommés (le dossier `tmp/` est déjà exclu de la sauvegarde).
- Limites : corps de `POST /mes-recettes/edition` de 256 Kio + 8 Mio au plus ; photo de 1 Mio et 8 000 px de côté au plus ; `photo_credit` de 1 à 80 caractères ; 10 envois de photo par compte et par quart d'heure (limiteur existant, clé `photo:<accountId>`).
- Réponse `GET /photo` : `content-type: image/jpeg`, `x-content-type-options: nosniff`, `cache-control: private, max-age=86400`. Jamais de nom de fichier venant de la personne.
- Fins de ligne LF et aucun octet NUL écrit à la main dans un fichier de test. Vérifier `git ls-files --eol` avant chaque commit. Les sous-agents écrivent avec l'outil Edit, pas avec des scripts.
- Travail sur la branche `feat/photos`, créée depuis `development` ; rien n'est poussé sans accord explicite.

## Review Focus

1. **Photo de téléphone avec position GPS.** Le fichier stocké ne contient plus la chaîne `Exif` ni les octets GPS, et il reste un JPEG lisible (SOI, SOF, SOS, EOI). Tests dans la Tâche 1, vérification réelle dans la Tâche 5.
2. **Fichier qui se dit JPEG sans en être un** (PNG renommé, JPEG tronqué, HTML avec `content-type: image/jpeg`, longueur de segment qui dépasse le fichier). Refusé avec un message `400`, rien sur le disque, le brouillon texte est quand même enregistré. Tests dans les Tâches 1 et 3.
3. **Photo d'une recette privée, d'un brouillon ou d'une recette retirée demandée par quelqu'un d'autre** avec la bonne empreinte. `404`. Tests dans la Tâche 4.
4. **Formulaire multipart avec 20 000 lignes vides** (même attaque que le correctif `e2df4c5`, nouveau chemin d'analyse). Réponse en moins de 3 s. Test dans la Tâche 3.
5. **Brouillon enregistré sans nouvelle photo** (« Enregistrer », « Ajouter des lignes »). La photo précédente est gardée. Un champ caché ne peut pas désigner l'empreinte de quelqu'un d'autre : la photo gardée vient toujours de la base. Tests dans la Tâche 3.

---

### Task 0: Branche

- [ ] **Step 1:** `git switch development && git pull --ff-only && git switch -c feat/photos`
- [ ] **Step 2:** `npm run test:docker` → 234 tests, 0 échec (point de départ).

---

### Task 1: Retirer les métadonnées d'un JPEG

**Files:**
- Create: `src/photos.js`
- Create: `tests/helpers/photos.js`
- Test: `tests/photos.test.js`

**Interfaces:**
- Produces: `stripJpeg(buffer: Buffer) -> Buffer | null` dans `src/photos.js` (null = pas un JPEG accepté). `jpeg({ exif = true, width = 2, height = 2, trailer = false, progressive = false } = {}) -> Buffer` dans `tests/helpers/photos.js`.

- [ ] **Step 1: Écrire l'aide de test `jpeg()`**

Elle assemble un JPEG synthétique (non décodable, structurellement valide), octet par octet avec `Buffer.from([...])` et `Buffer.concat`, jamais de NUL littéral dans le source :
`FFD8` ; `FFE0` JFIF ; si `exif`, un `FFE1` contenant `Exif\0\0` puis la chaîne ASCII `GPSLatitude48.8566` ; un `FFFE` commentaire `secret` ; `FFDB` (DQT, 67 octets de contenu quelconque) ; `FFC0` (ou `FFC2` si `progressive`) de longueur 17 avec précision 8, `height`, `width` sur 2 octets chacun, 3 composantes ; `FFC4` (DHT, contenu quelconque) ; `FFDA` de longueur 12 ; des données compressées contenant `FF 00` et `FF D0` ; si `progressive`, un second `FFC4` puis un second `FFDA` et des données ; `FFD9` ; si `trailer`, la chaîne `SAMSUNG-GPS-TRAILER` après `FFD9`.

- [ ] **Step 2: Écrire les tests qui échouent**

```js
describe('stripJpeg', () => {
  it('retire APPn et COM, garde le reste', () => {
    const out = stripJpeg(jpeg());
    assert.ok(out);
    assert.equal(out.indexOf('Exif'), -1);
    assert.equal(out.indexOf('GPSLatitude'), -1);
    assert.equal(out.indexOf('JFIF'), -1);
    assert.equal(out.indexOf('secret'), -1);
    assert.deepEqual([...out.subarray(0, 2)], [0xff, 0xd8]);
    assert.deepEqual([...out.subarray(-2)], [0xff, 0xd9]);
    assert.notEqual(out.indexOf(Buffer.from([0xff, 0xc0])), -1);
    assert.notEqual(out.indexOf(Buffer.from([0xff, 0xda])), -1);
  });
  it('garde les données compressées intactes (FF00, FFD0)', () => {
    assert.notEqual(stripJpeg(jpeg()).indexOf(Buffer.from([0xff, 0x00])), -1);
  });
  it('JPEG progressif : garde les deux balayages', () => {
    const out = stripJpeg(jpeg({ progressive: true }));
    assert.equal(out.toString('latin1').split('\xff\xda').length - 1, 2);
  });
  it('coupe tout ce qui suit EOI', () => {
    assert.equal(stripJpeg(jpeg({ trailer: true })).indexOf('SAMSUNG'), -1);
  });
  it('sans EXIF, le résultat est identique à la sortie avec EXIF', () => {
    assert.deepEqual(stripJpeg(jpeg({ exif: false })), stripJpeg(jpeg()));
  });
  it('refuse ce qui n est pas un JPEG accepté', () => {
    const good = jpeg();
    for (const bad of [
      Buffer.from('<html>'), Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(0),
      good.subarray(0, good.indexOf(Buffer.from([0xff, 0xda]))), // tronqué avant SOS
      good.subarray(0, good.length - 2), // pas d'EOI
      jpeg({ width: 8001 }), jpeg({ height: 0 }),
    ]) assert.equal(stripJpeg(bad), null);
  });
  it('refuse une longueur de segment qui dépasse le fichier', () => {
    const b = Buffer.from(jpeg());
    b.writeUInt16BE(0xffff, 4); // longueur de APP0
    assert.equal(stripJpeg(b), null);
  });
});
```

- [ ] **Step 3: Lancer** `npm run test:docker -- tests/photos.test.js` → FAIL (`stripJpeg` absent).

- [ ] **Step 4: Écrire `stripJpeg(buffer)`**

Parcours (le seul point que la signature ne fixe pas) :
1. `FFD8` en tête, sinon `null`. Sortie = `FFD8`.
2. Hors données compressées : à chaque position, un `FF` (les `FF` de remplissage répétés sont sautés), puis le marqueur `m`. `D9` → fin. `D0`–`D7` ou `01` → marqueur seul, gardé. Sinon, longueur `L` (2 octets) ; `L < 2` ou dépassement du fichier → `null`. `E0`–`EF` et `FE` sont sautés, les autres segments sont copiés. Un `SOFn` (`C0`–`CF` sauf `C4`, `C8`, `CC`) donne `height` (octets 5–6 du segment) et `width` (7–8) : 0 ou plus de 8 000 → `null`.
3. Après un `DA` (SOS) copié : données compressées copiées jusqu'au prochain `FF` qui n'est suivi ni de `00` ni de `D0`–`D7`. On revient alors à l'étape 2 (un JPEG progressif enchaîne plusieurs balayages).
4. Fin : il faut au moins un SOF et un SOS avant `D9`, sinon `null`. Sortie = segments gardés + `FFD9`. Rien de ce qui suit n'est copié. Atteindre la fin du tampon sans `D9` → `null`.

- [ ] **Step 5: Lancer** `npm run test:docker -- tests/photos.test.js` → PASS.

- [ ] **Step 6: Commit**

```bash
git add src/photos.js tests/photos.test.js tests/helpers/photos.js
git ls-files --eol src/photos.js tests/photos.test.js tests/helpers/photos.js   # i/lf partout
git commit -m "feat(photos): strip JPEG metadata"
```

---

### Task 2: Stockage, versions et nettoyage

**Files:**
- Create: `src/migrations/0005-photos.sql`
- Modify: `src/photos.js`
- Modify: `src/recipes.js` (`checkFields`, `insertVersion`, `getRecipe`)
- Modify: `src/contributions.js` (`getOwnRecipe`)
- Modify: `src/moderation.js` (`getVersion`)
- Test: `tests/photos.test.js`, `tests/recipes.test.js`, `tests/contributions.test.js`

**Interfaces:**
- Consumes: `stripJpeg` (Tâche 1).
- Produces :
  - `savePhoto(dataDir: string, jpegBuffer: Buffer) -> Promise<string>` : empreinte hex de 64 caractères ; écrit `<dataDir>/tmp/<randomUUID()>` puis renomme vers `<dataDir>/photos/<hash>.jpg` (crée les deux dossiers). Le tampon reçu est déjà passé par `stripJpeg`.
  - `photoPath(dataDir, file) -> string`.
  - `PHOTO_FILE = /^[0-9a-f]{64}$/`.
  - `sweepPhotos(db, dataDir, { graceMs = 600000, now = Date.now() } = {}) -> Promise<number>` : nombre de fichiers effacés. Dossier absent → 0. Ignore les noms qui ne sont pas `<64 hex>.jpg`.
  - `checkFields` accepte `photo` (défaut `null`) : `null` ou `{ file, credit }` avec `file` conforme à `PHOTO_FILE` et `credit` de 1 à 80 caractères, sinon `invalid('Indiquez l'auteur de la photo, en 80 caractères au plus.')`. Le résultat contient `photo`.
  - `getRecipe`, `getVersion` et `getOwnRecipe().latest` renvoient `photo: { file, credit } | null`.

- [ ] **Step 1: Migration `0005-photos.sql`**

```sql
-- A version's photo: file name in <dataDir>/photos (sha256 of the stripped JPEG) and its author.
ALTER TABLE recipe_versions
  ADD COLUMN photo text CHECK (photo ~ '^[0-9a-f]{64}$'),
  ADD COLUMN photo_credit text CHECK (char_length(photo_credit) BETWEEN 1 AND 80),
  ADD CONSTRAINT recipe_versions_photo_check CHECK ((photo IS NULL) = (photo_credit IS NULL));
```

- [ ] **Step 2: Tests qui échouent**

`tests/recipes.test.js` :
- `checkFields({ ...recipe(), photo: { file: 'a'.repeat(64), credit: 'Léa' } }).photo` vaut `{ file: 'a'.repeat(64), credit: 'Léa' }` ; sans `photo` → `null`.
- refus (`code === 'invalid_recipe'`) pour `{ file: '../x', credit: 'a' }`, `{ file: 'A'.repeat(64), credit: 'a' }`, `{ file: 'a'.repeat(64), credit: '' }`, crédit de 81 caractères.
- `publishVersion` avec une photo, puis `getRecipe(id).photo` → la même photo.

`tests/contributions.test.js` : un brouillon avec photo, soumis en privé → `getOwnRecipe(...).latest.photo` égale la photo.

`tests/photos.test.js` (base de test et dossier `mkdtemp`) :
- `savePhoto(dir, buf)` renvoie `sha256(buf)` en hex, le fichier existe et contient `buf`, et `<dir>/tmp` est vide ensuite.
- `sweepPhotos` : trois fichiers, `a` cité par une version d'une recette visible, `b` cité seulement par le brouillon d'une recette, `c` cité par personne → avec `now = Date.now() + 3600000`, seul `c` est effacé et la fonction renvoie `1`. Avec `now = Date.now()`, rien n'est effacé (délai de 10 minutes).
- même chose après `UPDATE recipes SET removed_at = now()` sur la recette de `a` → `a` est effacé.
- un fichier `notes.txt` dans `photos/` n'est jamais touché ; dossier `photos/` absent → `0`.

- [ ] **Step 3: Lancer** `npm run test:docker` → les nouveaux tests échouent, les 234 autres passent.

- [ ] **Step 4: Implémenter**

`insertVersion` écrit `photo` et `photo_credit` (`f.photo?.file ?? null`, `f.photo?.credit ?? null`). Les trois lectures construisent `photo` à partir de ces deux colonnes. La requête de `sweepPhotos` reçoit les noms trouvés en un seul tableau et renvoie ceux qui sont cités :

```sql
SELECT v.photo AS file FROM recipe_versions v JOIN recipes r ON r.id = v.recipe_id
 WHERE r.removed_at IS NULL AND v.photo = ANY($1)
UNION
SELECT r.draft->'photo'->>'file' FROM recipes r
 WHERE r.removed_at IS NULL AND r.draft->'photo'->>'file' = ANY($1)
```

Un fichier non cité est effacé seulement si `now - mtimeMs > graceMs`. Ce délai protège un envoi en cours, dont le fichier est écrit avant le brouillon.

- [ ] **Step 5: Lancer** `npm run test:docker` → tout passe ; `tests/migrate.test.js` voit le schéma 5.

- [ ] **Step 6: Commit** `feat(photos): store photos and attach them to versions` (vérifier `git ls-files --eol` d'abord).

---

### Task 3: Envoyer une photo depuis le formulaire

**Files:**
- Modify: `src/web.js` (nouvelle fonction `readForm`)
- Modify: `src/routes/contributions.js` (`formPage`, `POST /mes-recettes/edition`, `GET /mes-recettes/edition`)
- Test: `tests/http.test.js`, `tests/contribute-pages.test.js`

**Interfaces:**
- Consumes: `stripJpeg`, `savePhoto`, `sweepPhotos`, `checkFields` avec `photo` (Tâches 1–2) ; `limiter` déjà passé à `contributionRoutes`.
- Produces: `readForm(request, { max }) -> Promise<{ body: URLSearchParams, files: Map<string, Buffer> }>` dans `src/web.js`. Elle accepte `application/x-www-form-urlencoded` (pas de fichier) et `multipart/form-data`. Les mêmes refus que `readBody` s'appliquent : type → 400, taille → 413, NUL dans un champ texte → 400. Un multipart illisible → 400 `bad_request`. Une partie fichier vide (champ laissé vide par le navigateur) n'entre pas dans `files`. Pour le multipart, le corps brut est lu avec la même limite que `readBody`, puis passé à `new Request('http://x', { method: 'POST', headers: { 'content-type': <en-tête reçu> }, body }).formData()`. Lire un fichier avec `Buffer.from(await file.arrayBuffer())`, car `File.bytes()` n'existe pas en Node 22.

- [ ] **Step 1: Tests qui échouent**

`tests/http.test.js` (`readForm` derrière un petit serveur, comme les tests existants de `readBody`) :
- multipart avec `title=Pâtes` et un fichier `photo` de 4 octets → `body.get('title') === 'Pâtes'` et `files.get('photo').length === 4`.
- fichier vide → `files.size === 0`.
- `content-type: multipart/form-data; boundary=x` avec un corps `n'importe quoi` → 400.
- champ texte contenant `\0` → 400 ; corps plus grand que `max` → 413.

`tests/contribute-pages.test.js` (envoi avec `FormData` + `fetch`, en-tête `origin`). La photo vient de `jpeg()`, et `config.dataDir` devient un dossier `mkdtemp` propre à chaque test :
- `GET /mes-recettes/edition` : le `<form>` a `enctype="multipart/form-data"` et contient `name="photo"`, `name="photo_credit"`, `name="atteste_photo"`.
- « Enregistrer le brouillon » avec photo + `photo_credit=Léa` → 303 ; `photos/` contient exactement un fichier, son contenu égale `stripJpeg(jpeg())`, il ne contient pas `GPSLatitude` ; `recipes.draft->'photo'` égale `{ file, credit: 'Léa' }`.
- nouvel enregistrement sans fichier, avec `photo_credit=Léa B.` → même `file`, `credit` mis à jour.
- un champ `photo_file=<empreinte d'une photo d'un autre compte>` est ignoré : le brouillon garde sa propre photo, ou `null` s'il n'en avait pas.
- `retirer_photo=1` → `draft.photo` vaut `null`.
- fichier `<html>` envoyé comme `image/jpeg` → 400, message `La photo doit être une image JPEG de 8 000 pixels de côté au plus.`. Le titre envoyé est quand même dans le brouillon, et `photos/` reste vide.
- « Publier » avec photo, `atteste_texte=1` sans `atteste_photo` → 400 avec `J'ai pris cette photo ou j'ai le droit de la publier` ; avec les deux cases → 303 et la version 1 a `photo` et `photo_credit`.
- fichier de `1024 * 1024 + 1` octets (un `jpeg()` complété dans un segment `COM`) → 400 avec `PHOTO_TOO_BIG`, titre gardé dans le brouillon, `photos/` vide.
- photo sans `photo_credit` puis « Publier » → 400 avec le message de `checkFields`.
- 11e envoi de photo du même compte dans le quart d'heure → 429 (`tooMany`) ; un enregistrement sans fichier n'est pas compté.
- 20 000 lignes `ingredient_name=` vides en multipart → réponse en moins de 3 000 ms.

- [ ] **Step 2: Lancer** `npm run test:docker -- tests/http.test.js tests/contribute-pages.test.js` → FAIL.

- [ ] **Step 3: `readForm` dans `src/web.js`**, puis `POST /mes-recettes/edition` passe de `readBody` à `readForm(request, { max: 256 * 1024 + 8 * 1024 * 1024 })`. `draftFrom(body)` ne change pas.

- [ ] **Step 4: Formulaire et route**

Textes exacts :
- `ATTEST_PHOTO = "J'ai pris cette photo ou j'ai le droit de la publier"` ;
- `PHOTO_INVALID = 'La photo doit être une image JPEG de 8 000 pixels de côté au plus.'` ;
- `PHOTO_TOO_BIG = 'La photo dépasse 1 Mo. Activez JavaScript pour qu'elle soit réduite automatiquement, ou envoyez une image plus petite.'`.

Dans `formPage`, le `<form>` reçoit `enctype="multipart/form-data"`. Après le lien source, ajouter :
- si `draft.photo`, `<img src="/photo?f=<file>" alt="Photo actuelle" class="preview">` et une case `retirer_photo` « Retirer la photo » ;
- `<label>Photo (JPEG) <input type="file" name="photo" accept="image/jpeg"></label>` ;
- `<label>Auteur de la photo <input name="photo_credit" maxlength="80" value="<draft.photo?.credit>"></label>` ;
- après la case du texte, la case `atteste_photo` avec `ATTEST_PHOTO` ;
- `<script src="/static/fdl-photo.js"></script>` en fin de page (le script arrive à la Tâche 4 ; une page sans le fichier reste fonctionnelle).

Dans la route, avant `saveDraft` :
1. Photo précédente = `own.draft?.photo ?? own.latest?.photo ?? null`, lue avec `getOwnRecipe` quand il y a un `id`. Elle ne vient jamais du formulaire.
2. Si `files.get('photo')` existe : on compte d'abord `limiter.hit(\`photo:${accountId}\`, { scope: 'photo', accountId, ip: clientIp(request) })`. S'il est dépassé → `tooMany`. Ensuite, `stripJpeg` ; un fichier de plus de 1 Mio (`1024 * 1024` octets) fait retenir `PHOTO_TOO_BIG` sans appeler `stripJpeg` ; si `stripJpeg` renvoie `null`, on retient `PHOTO_INVALID` et on garde la photo précédente. Sinon, `savePhoto` donne le nouveau `file`.
3. `draft.photo = retirer_photo === '1' ? null : (file ? { file, credit: photo_credit.trim() } : null)`, où `file` est le nouveau ou celui de la photo précédente. Un crédit vide reste vide dans le brouillon : `checkFields` le refusera à la publication.
4. Après `saveDraft` : si un message de photo a été retenu → `again(message)` (400), quelle que soit l'action. Si une photo a été envoyée ou retirée → `await sweepPhotos(pool, config.dataDir)`.
5. « Publier » avec `draft.photo` et `atteste_photo !== '1'` → `again(\`Cochez la case : ${ATTEST_PHOTO}.\`)`.

`GET /mes-recettes/edition` n'a rien à changer : le brouillon ou la dernière version porte déjà `photo`.

- [ ] **Step 5: Lancer** `npm run test:docker` → tout passe.

- [ ] **Step 6: Commit** `feat(photos): upload a photo from the recipe form` (vérifier `git ls-files --eol`).

---

### Task 4: Servir et afficher la photo

**Files:**
- Modify: `src/photos.js` (`canSeePhoto`)
- Create: `src/static/fdl-photo.js`
- Modify: `src/routes/catalogue.js` (`recipeArticle`, `GET /photo`, `GET /static/fdl-photo.js`)
- Modify: `src/routes/moderation.js` (`moderationRoutes(pool, config)`, nettoyage après `remove`)
- Modify: `src/server.js` (passer `config` à `moderationRoutes`, `catalogueRoutes(pool, config)`, nettoyage au démarrage)
- Modify: `src/static/fdl.css`
- Test: `tests/catalogue.test.js`, `tests/moderation.test.js`, `tests/startup.test.js`

**Interfaces:**
- Consumes: `photoPath`, `PHOTO_FILE`, `sweepPhotos` (Tâche 2), `VISIBLE` (`src/recipes.js`).
- Produces: `canSeePhoto(db, file, { accountId, staff }) -> Promise<boolean>`.

- [ ] **Step 1: Tests qui échouent**

`tests/catalogue.test.js` :
- recette publique avec photo → `GET /recette?id=` contient `<img src="/photo?f=<file>"` et `Photo : Léa` ; le crédit `<b>x</b>` est affiché échappé.
- `GET /photo?f=<file>` par un autre membre → 200, `content-type` `image/jpeg`, `x-content-type-options: nosniff`, `cache-control: private, max-age=86400`, corps égal au fichier.
- 404 pour l'autre membre quand la photo n'est citée que par un brouillon, une version privée, une version `pending`, une recette retirée ou une recette d'un compte banni ; 200 pour l'auteur sur le brouillon, la version privée et la version en attente ; 200 pour un modérateur sur la version en attente.
- `f=../../etc/passwd`, `f=` vide, `f=` en majuscules → 404 sans lecture disque ; empreinte citée mais fichier absent du disque → 404.
- `GET /static/fdl-photo.js` → 200, `text/javascript`.

`tests/moderation.test.js` : aperçu `/moderation/version` d'une version avec photo → contient `<img src="/photo?f=`. Décision `remove`, puis `sweepPhotos` appelé avec `now` dans une heure → le fichier n'existe plus. Pour ce cas, la route peut appeler `sweepPhotos(pool, config.dataDir)` avec le délai normal. Le test vérifie l'appel en lançant `sweepPhotos` lui-même avec `now` décalé, après le retrait.

`tests/startup.test.js` : `main()` démarre avec un `FDL_DATA_DIR` sans dossier `photos/` (pas d'erreur).

- [ ] **Step 2: Lancer** → FAIL.

- [ ] **Step 3: Implémenter**

`canSeePhoto` renvoie `false` d'emblée si `file` n'est pas conforme à `PHOTO_FILE`. Il fait ensuite deux requêtes et s'arrête à la première qui trouve :

```sql
-- 1. publique : version publiée d'une recette visible
SELECT 1 ${VISIBLE} AND v.photo = $1 LIMIT 1
-- 2. auteur (brouillon ou n'importe quelle version, recette non retirée) ou staff (n'importe quelle version)
SELECT 1 FROM recipes r WHERE
  (r.removed_at IS NULL AND r.author_id = $2 AND (r.draft->'photo'->>'file' = $1
     OR EXISTS (SELECT 1 FROM recipe_versions w WHERE w.recipe_id = r.id AND w.photo = $1)))
  OR ($3 AND EXISTS (SELECT 1 FROM recipe_versions w WHERE w.recipe_id = r.id AND w.photo = $1))
LIMIT 1
```

`staff` = rôle `moderator` ou `admin`.

`GET /photo` : `f` lu dans la requête, `canSeePhoto`, puis lecture du fichier avec `readFile(photoPath(...))`. `ENOENT` ou refus → page 404 `Photo introuvable` (via `show`). Pas de flux : 1 Mio au plus.

`recipeArticle` : juste après le `<h1>`, si `recipe.photo`, `<figure><img src="/photo?f=${file}" alt="${recipe.title}"><figcaption>Photo : ${credit}</figcaption></figure>`.

`fdl-photo.js` : sur `change` de `input[name=photo]`, faire `createImageBitmap(file)` (qui applique l'orientation EXIF par défaut). Dessiner l'image sur un canvas dont le plus grand côté fait au plus 1 600 px, puis `canvas.toBlob(..., 'image/jpeg', 0.8)`. Remplacer ensuite `input.files` par un `DataTransfer` qui contient le nouveau `File` (`photo.jpg`). Au chargement, le script passe `accept` à `image/*`. En cas d'erreur, il ne fait rien : le fichier d'origine part tel quel. Le servir comme `fdl-print.js`.

CSS : `figure img, img.preview { max-width: 100%; height: auto; }` et `img.preview { max-height: 12rem; }`.

`server.js` : dans `main()`, après `migrate`, lancer `await sweepPhotos(pool, config.dataDir).catch((e) => console.error(\`photos : nettoyage impossible (${e.code ?? 'inconnu'})\`))`.

- [ ] **Step 4: Lancer** `npm run test:docker` → tout passe.

- [ ] **Step 5: Commit** `feat(photos): serve and show recipe photos` (vérifier `git ls-files --eol`).

---

### Task 5: Sauvegarde, documentation, vérification réelle

**Files:**
- Test: `tests/backup.test.js`, `tests/restore.test.js`
- Modify: `docs/CONTRATS.md`, `docs/EXPLOITATION.md`, `docs/ARCHITECTURE.md`, `CAPABILITIES.md`, `README.md`

- [ ] **Step 1: Tests**

`tests/backup.test.js` : avec un fichier `photos/<hash>.jpg` dans le dossier de données, le manifeste contient `files/photos/<hash>.jpg`. `tests/restore.test.js` : après restauration, le fichier est revenu à l'identique. Aucun code ne devrait changer, car `photos/` n'est pas exclu. Si un test échoue, c'est un bogue de la Tâche 2 à corriger là.

- [ ] **Step 2: Documentation**

- `CONTRATS.md` : `GET /photo?f=` (règles d'accès, en-têtes), limites (JPEG, 1 Mio, 8 000 px, compression automatique dans le navigateur, crédit 1–80, 10 envois par quart d'heure), retrait des métadonnées et ses deux effets (orientation sans JavaScript, profils de couleur), nettoyage après 10 minutes. Remplacer la phrase « Photos, commentaires et import dans Manger! viendront… » par « Commentaires et import dans Manger! viendront… ».
- `EXPLOITATION.md` : `/data/photos` fait partie de la sauvegarde. Chaque sauvegarde recopie tout le dossier de données : ne garder que les dernières (par exemple 7) pour que les photos ne multiplient pas l'espace disque. Une photo retirée par la modération est effacée du disque, mais elle reste dans les sauvegardes antérieures.
- `ARCHITECTURE.md` ligne 41, `CAPABILITIES.md` ligne 13, `README.md` : les photos sont construites.

- [ ] **Step 3: Lancer** `npm run test:docker` → tout passe ; noter le total.

- [ ] **Step 4: Vérification dans un vrai navigateur**

Reprendre le montage de `acces` : Playwright emprunté à `C:\Users\Neckr\Documents\bullshark\packages\e2e` via `createRequire`, et `postgres:18` jetable sur `127.0.0.1:55432`. Le script reste dans le dossier scratchpad, hors du dépôt. Une photo de test se fabrique ainsi : un canvas 4000×3000 rempli de bruit (plus de 2 Mio) exporté en JPEG, puis un segment `APP1` `Exif` contenant `GPSLatitude` inséré après `FFD8`. Contrôles :
1. Avec JavaScript : choisir la photo, enregistrer. Le fichier dans `photos/` ne contient ni `Exif` ni `GPSLatitude`, son plus grand côté fait 1 600 px au plus (lire le SOF), et il pèse moins de 1 Mio alors que l'original de test fait plus de 2 Mio (canvas 4000×3000 avec du bruit).
2. Publier (compte de confiance, ou accepter depuis `/moderation`). La page recette affiche l'image, et `naturalWidth > 0`, donc le JPEG nettoyé se décode réellement.
3. Sans JavaScript (`javaScriptEnabled: false`) : la grosse photo est refusée avec `PHOTO_TOO_BIG`, et le titre saisi est conservé. Une photo de moins de 1 Mio (canvas 1200×800) est stockée sans `Exif`, et l'image se décode toujours.
4. Un second compte ouvre l'URL de la photo d'un brouillon → 404.

- [ ] **Step 5: Commit** `docs(photos): document photos` (vérifier `git ls-files --eol`).
