# Architecture initiale

Statut : cadrage de la première bêta, à confirmer tranche par tranche.

## Frontières

FDL est un service autonome. Il possède ses propres comptes, invitations, recettes publiées et décisions de modération. Il ne lit pas les comptes, recettes privées, calendriers, goûts, allergies, placards ou courses d’un foyer Manger!.

L’intégration future fonctionne uniquement dans ce sens : le serveur Manger! effectue une requête HTTPS sortante vers FDL, montre un aperçu, puis enregistre une copie privée. FDL ne se connecte jamais au serveur privé du foyer. Une panne ou un retrait de FDL ne doit pas casser les copies déjà importées.

Le futur service de scan PDF/photo est un autre projet. Aucun OCR, PDF, scan de livre ou collecte automatique de sites n’entre dans FDL.

## Forme du service

Le socle utilise un seul processus Node.js et les API standard de Node. Il utilise PostgreSQL et le client `pg` ; toute autre dépendance, comme l’interface web, n’est ajoutée que lorsqu’une capacité l’exige.

Modules prévus :

1. **Accès** — invitations, comptes, sessions, rôles et révocation.
2. **Catalogue** — recettes publiées, versions, recherche et pagination.
3. **Contributions** — brouillons appartenant à leur auteur et soumissions volontaires.
4. **Modération** — examen, signalements, publication, retrait et historique.
5. **Connexion Manger!** — lecture autorisée et import d’une version identifiée, sans synchronisation.

Chaque contrôle d’accès devra être appliqué côté serveur. Les brouillons ne devront jamais être exposés par le catalogue, même avec leur identifiant direct.

## État actuel

Le socle est construit. Le serveur est un seul processus Node.js, avec PostgreSQL 18 comme stockage (client `pg`, seule dépendance).

- **Routes** : `GET /health` indique que le processus répond ; `GET /ready` répond 200 seulement si la base répond avec le schéma attendu, sinon 503. Aucune ne révèle configuration, version, chemin ou information personnelle. Les erreurs JSON suivent `docs/CONTRATS.md`.
- **Configuration** : validée avant l’écoute (`FDL_DATA_DIR` absolu et existant, `PORT` entre 1 et 65535, `PGHOST`, `PGDATABASE`, `PGUSER` obligatoires). Une valeur invalide arrête le démarrage ; aucun secret n’est journalisé.
- **Migrations** : fichiers SQL numérotés dans `src/migrations/`, appliqués au démarrage dans une seule transaction. Une base plus récente que l’application est refusée.
- **Sauvegarde et restauration** : `npm run backup` produit un dossier (dump PostgreSQL, fichiers de données, manifeste avec sommes SHA-256) ; `npm run restore` le rejoue sur une base et un dossier vierges.
- **Déploiement** : Docker Compose avec `db`, `app` et `caddy` (HTTPS) ; `scripts/update.sh` sauvegarde, met à jour l’image et revient à l’image précédente si `/ready` ne répond pas. Voir `docs/EXPLOITATION.md`.

Comptes, catalogue, photos et interface web ne sont pas encore construits.
