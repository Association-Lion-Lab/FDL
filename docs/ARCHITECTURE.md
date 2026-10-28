# Architecture initiale

Statut : cadrage de la première bêta, à confirmer tranche par tranche.

## Frontières

FDL est un service autonome. Il possède ses propres comptes, invitations, recettes publiées et décisions de modération. Il ne lit pas les comptes, recettes privées, calendriers, goûts, allergies, placards ou courses d’un foyer Manger!.

L’intégration future fonctionne uniquement dans ce sens : le serveur Manger! effectue une requête HTTPS sortante vers FDL, montre un aperçu, puis enregistre une copie privée. FDL ne se connecte jamais au serveur privé du foyer. Une panne ou un retrait de FDL ne doit pas casser les copies déjà importées.

Le futur service de scan PDF/photo est un autre projet. Aucun OCR, PDF, scan de livre ou collecte automatique de sites n’entre dans FDL.

## Forme du service

Le socle utilise un seul processus Node.js et les API standard de Node. Il utilise PostgreSQL et le client `pg` ; toute autre dépendance n’est ajoutée que lorsqu’une capacité l’exige.

Modules prévus :

1. **Accès** — invitations, comptes, sessions, rôles et révocation.
2. **Catalogue** — recettes publiées, versions, recherche et pagination.
3. **Contributions** — brouillons appartenant à leur auteur et soumissions volontaires.
4. **Modération** — examen, signalements, publication, retrait et historique.
5. **Connexion Manger!** — lecture autorisée et import d’une version identifiée, sans synchronisation.

Chaque contrôle d’accès devra être appliqué côté serveur. Les brouillons ne devront jamais être exposés par le catalogue, même avec leur identifiant direct.

## État actuel

Le socle et `acces` sont construits. Le serveur est un seul processus Node.js, avec PostgreSQL 18 comme stockage (client `pg`).

- **Routes** : `GET /health` indique que le processus répond ; `GET /ready` répond 200 seulement si la base répond avec le schéma attendu, sinon 503. Aucune ne révèle configuration, version, chemin ou information personnelle. Les erreurs JSON suivent `docs/CONTRATS.md`.
- **Configuration** : validée avant l’écoute (`FDL_DATA_DIR` absolu et existant, `PORT` entre 1 et 65535, `PGHOST`, `PGDATABASE`, `PGUSER` obligatoires). Une valeur invalide arrête le démarrage ; aucun secret n’est journalisé.
- **Migrations** : fichiers SQL numérotés dans `src/migrations/`, appliqués au démarrage dans une seule transaction. Une base plus récente que l’application est refusée.
- **Sauvegarde et restauration** : `npm run backup` produit un dossier (dump PostgreSQL, fichiers de données, manifeste avec sommes SHA-256) ; `npm run restore` le rejoue sur une base et un dossier vierges.
- **Déploiement** : Docker Compose avec `db`, `app` et `caddy` (HTTPS) ; `scripts/update.sh` sauvegarde, met à jour l’image et revient à l’image précédente si `/ready` ne répond pas. Voir `docs/EXPLOITATION.md`.

- **Accès** (`acces`, construit) : invitations et réinitialisations par lien à usage unique (seul le hachage du jeton est stocké), mots de passe `scrypt`, sessions en base (cookie `fdl_session`, 30 jours pour un membre, 12 heures pour un `moderator` ou `admin`), code à 6 chiffres (TOTP, secret chiffré en `aes-256-gcm` avec `FDL_SECRET_KEY`), clés d'accès (WebAuthn) et codes de récupération. Un `moderator` ou `admin` doit avoir une clé d'accès ; les actions d'administration exigent une confirmation de moins de 5 minutes. Les limites d'essais sont en mémoire, par processus. Dépendances ajoutées : `@simplewebauthn/server`, `@simplewebauthn/browser`, `otpauth`, `uqr`. Routes dans `docs/CONTRATS.md`.
- **Journaux** : le journal d'administration est en base (table `admin_log`, page `/admin/journal`). Le journal de sécurité est le fichier `logs/securite.log` du dossier de données, une ligne JSON par événement, exclu des sauvegardes. Voir `docs/EXPLOITATION.md`.
- **Protection** : tout `POST` dont `Origin` diffère de `FDL_ORIGIN` est refusé (`bad_origin`) ; les corps sont limités à 16 Kio.

Catalogue, photos et interface publique ne sont pas encore construits.
