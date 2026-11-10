# Essai FDL + Manger! en local (10 novembre 2026)

Premier essai des deux applications **ensemble**, avec un vrai FDL (pas le faux FDL des tests de Manger!). Fait par Claude côté FDL ; Manger! n'a pas été modifié (il est développé par Codex). Ce document sert de point de reprise.

Versions testées :

- FDL : branche `development` à `19c30fc` (plus ce document et `scripts/essai-manger.js`).
- Manger! : `origin/development` à `1cff75b` (intégration `3491e9f`), exporté par `git archive` dans un dossier temporaire, sans toucher au clone de Manger!.

## Résultat

Tout le parcours prévu fonctionne, sans erreur. Aucun bug trouvé côté FDL ni côté Manger!.

| Étape | Ce qui a été fait | Résultat |
| --- | --- | --- |
| Liaison | Manger! (admin) → « Relier un compte FDL » → page de consentement FDL → « Autoriser » | Retour sur Manger!. Jeton côté FDL (`oauth_tokens`, client `http://127.0.0.1:3001`), liaison côté Manger! (`household.fdl_link`) |
| Recherche | « Chercher sur FDL » : `poireaux` | 4 résultats avec durée |
| Import | « Importer » sur une recette de démo, puis via « Mes recettes FDL » sur une recette du compte relié | Copies suivies dans `household.fdl_copies` (origine, id FDL, version, licence, lien) |
| Nouvelle version | Version 2 publiée dans FDL, Manger! redémarré | Vue par la vérification environ 1 min après le démarrage (`available_version = 2`), panneau « 1 nouvelle version sur FDL », « Mettre à jour » applique la version 2 |
| Retrait par la modération | Recette inutilisée et recette planifiée dans un repas retirées dans FDL | Inutilisée : supprimée. Planifiée : neutralisée (« Recette retirée de FDL », aucun ingrédient), le repas garde son titre. Avis « 2 retraits par la modération FDL » avec « J'ai compris » |
| Révocation côté FDL | « Retirer l'accès » dans Sécurité du compte FDL, puis recherche dans Manger! | Message « La liaison FDL a été retirée. Relie à nouveau le compte depuis Compte. », liaison effacée côté Manger! |

FDL et Manger! tournaient sur deux origines différentes (`http://localhost:3000` et `http://127.0.0.1:3001`), donc le retour OAuth était réellement intersite.

## Remarques pour Codex (côté Manger!)

Aucune n'est bloquante. À trancher par le porteur avant de coder.

1. **« Mes recettes FDL » n'affiche pas la durée**, alors que la recherche l'affiche. C'est conforme au contrat : `GET /api/v1/mes-recettes` renvoie seulement `id`, `title`, `state` et `version`. Si l'affichage doit être identique, il faut d'abord ajouter `minutes` côté FDL (contrat et code), puis l'afficher côté Manger!.
2. **Message affiché deux fois** : « Recette importée dans le foyer. » et « Recette mise à jour. » apparaissent dans deux zones `role="status"`. Un lecteur d'écran peut donc l'annoncer deux fois. À vérifier.
3. **Titre du repas** : après « Mettre à jour », le repas planifié a pris le nouveau titre de la recette. Après un retrait, il garde l'ancien titre (comportement voulu par le plan). Confirmer que la mise à jour du titre est voulue.
4. **Vérification seulement au démarrage puis toutes les 24 h** : pour l'essai, il a fallu redémarrer Manger! pour voir une nouvelle version ou un retrait. C'est le comportement prévu ; un bouton « Vérifier maintenant » n'existe pas.
5. Le serveur Manger! écoute sur `0.0.0.0` (toutes les interfaces), donc aussi sur le réseau local pendant un essai sur un poste. Connu, à garder en tête.

## Pas testé

- « Délier » depuis Manger!, « Ignorer » une version, le panneau de confirmation de « Mettre à jour » (la boîte `confirm()` a été acceptée par script).
- Copie modifiée localement puis mise à jour (avertissement de perte des changements).
- Sauvegarde et restauration du foyer (format v2 avec suivi des copies).
- HTTPS, Docker, serveur Ubuntu, Safari et iPhone, plusieurs foyers.
- Une recette supprimée par son **auteur** : FDL n'a pas encore cette fonction (les copies doivent rester, état `not_found`).

## Rejouer l'essai

Prérequis : Docker Desktop, Node.js 24, le dépôt FDL et une copie de Manger! `development`. Remplacer `<...>` par vos chemins. Les mots de passe sont générés, jamais réutilisés.

### 1. Base PostgreSQL commune

```bash
docker run -d --name fdl-local -e POSTGRES_PASSWORD=fdl_local -p 127.0.0.1:55432:5432 -v fdl-local-pg:/var/lib/postgresql postgres:18
```

FDL utilise la base `postgres`, Manger! une base `manger` dans le même conteneur.

### 2. FDL (port 3000)

`.env.local` à la racine de FDL (ignoré par git) :

```
PGHOST=127.0.0.1
PGPORT=55432
PGUSER=postgres
PGPASSWORD=fdl_local
PGDATABASE=postgres
PORT=3000
FDL_ORIGIN=http://localhost:3000
FDL_DATA_DIR=<dossier absolu existant>
FDL_SECRET_KEY=<64 caractères hexadécimaux aléatoires>
```

```bash
node --env-file=.env.local scripts/seed-demo.js 40
node --env-file=.env.local scripts/invite.js member
node --env-file=.env.local src/server.js
```

Ouvrir le lien d'invitation affiché et créer le compte qui sera relié.

### 3. Manger! (port 3001), sans toucher à son dépôt

```bash
git -C <clone manger> archive origin/development | tar -x -C <dossier vide>
cd <dossier vide> && npm ci --ignore-scripts
```

Rôles et base, comme `docker/postgres-init.sh` (deux mots de passe hexadécimaux de 64 caractères, différents, écrits chacun dans un fichier) :

```sql
CREATE ROLE manger_migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '<mot de passe migration>';
CREATE ROLE manger_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '<mot de passe application>';
CREATE DATABASE manger OWNER manger_migrator TEMPLATE template0;
REVOKE ALL ON DATABASE manger FROM PUBLIC;
GRANT CONNECT ON DATABASE manger TO manger_app;
\connect manger
REVOKE ALL ON SCHEMA public FROM PUBLIC,manger_app;
```

(à passer avec `docker exec -i fdl-local psql -U postgres -v ON_ERROR_STOP=1`).

Fichier d'environnement de Manger! :

```
MANGER_STORAGE=postgres
MANGER_POSTGRES_CANDIDATE=1
MANGER_PORT=3001
MANGER_DATA_DIR=<dossier absolu>
MANGER_FDL_URL=http://localhost:3000
MANGER_PG_HOST=127.0.0.1
MANGER_PG_PORT=55432
MANGER_PG_DATABASE=manger
MANGER_PG_USER=manger_app
MANGER_PG_PASSWORD_FILE=<fichier du mot de passe application>
MANGER_PG_MIGRATION_USER=manger_migrator
MANGER_PG_MIGRATION_PASSWORD_FILE=<fichier du mot de passe migration>
MANGER_PG_TLS=disable-local
```

```bash
node --env-file=<fichier> postgres-schema.js --apply
node --env-file=<fichier> accounts.js create-admin testeur
node --env-file=<fichier> server.js
```

Ouvrir Manger! sur `http://127.0.0.1:3001` (et non `localhost`, pour que le retour OAuth soit intersite), se connecter avec l'admin affiché.

### 4. Scénario

1. Manger! : Compte → « Relier un compte FDL » → FDL : « Autoriser ».
2. Manger! : Recettes → « Recettes de Faim de Lion » : chercher, importer une recette de démo.
3. FDL : `node --env-file=.env.local scripts/essai-manger.js creer <id du compte relié>` crée et publie « Dahl de lentilles » pour ce compte. Manger! : « Mes recettes FDL » → l'importer, puis planifier un repas avec.
4. FDL : `node --env-file=.env.local scripts/essai-manger.js version <id recette> <id compte>`. Redémarrer Manger!, attendre 1 min : « 1 nouvelle version sur FDL » → « Mettre à jour ».
5. FDL : `scripts/essai-manger.js retirer <id recette> <id compte>` pour la recette planifiée et pour la recette de démo. Redémarrer Manger!, attendre 1 min : avis de retrait, recette planifiée neutralisée, l'autre supprimée.
6. FDL : Sécurité du compte → « Retirer l'accès ». Manger! : une recherche affiche que la liaison a été retirée.

Contrôles en base : `household.fdl_link`, `household.fdl_copies`, `household.fdl_notices`, `household.recipes`, `household.meals` (base `manger`) et `oauth_tokens` (base `postgres`).

`scripts/essai-manger.js` appelle directement les fonctions de FDL (brouillon, soumission, décision de modération), sans HTTP ni clé d'accès : le compte joue aussi le modérateur. Il refuse `NODE_ENV=production`.

## Suite

- Côté Manger! (Codex) : trancher les remarques 1 à 3, puis tester ce qui est dans « Pas testé ».
- Côté FDL (Claude) : remarque 1 retenue par le porteur et faite le 10 novembre : `/api/v1/mes-recettes` renvoie `minutes` (contrat et test). Remarques 2 et 3 retenues côté Manger! (une seule zone d'annonce ; titre du repas inchangé).
- Les deux : refaire cet essai sur le vrai serveur, en HTTPS, quand le domaine et l'hébergement seront choisis.
