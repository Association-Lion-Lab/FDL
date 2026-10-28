# Faim de Lion (FDL)

Une base communautaire pour partager, découvrir et importer des recettes dans Manger!. Bêta sur invitation.

## État

Le projet démarre par un socle fermé et minimal. Il fournit actuellement un serveur HTTP avec PostgreSQL (migrations au démarrage), des contrôles `/health` et `/ready`, la sauvegarde et la restauration, et un déploiement Docker Compose avec HTTPS et mise à jour par script. L’accès est construit : invitations, comptes, sessions, seconde étape (code à 6 chiffres, clés d’accès, codes de récupération) et pages d’administration des comptes. Le catalogue est lisible (vitrine, recherche, page recette). Les invités écrivent et soumettent des recettes, les modérateurs les valident, et chacun peut signaler et noter ; en revanche aucun stockage d’images, aucun commentaire ni envoi d’e-mail n’est encore disponible : les liens d’invitation et de réinitialisation se transmettent à la main.

FDL reste indépendant de Manger! et du futur service de scan PDF/photo. Manger! doit continuer à fonctionner sans FDL. Seules les contributions volontairement soumises à FDL y seront conservées.

## Lancer localement

Prérequis : Node.js 22 ou plus récent.

```powershell
npm run test:docker
```

Les tests tournent dans Docker (PostgreSQL 18 et `pg_dump` 18 inclus) : rien à installer d’autre que Docker. Lancé hors du conteneur, `npm test` n’a pas de base à sa disposition. Pour faire tourner le service (configuration, `docker compose`), voir [docs/EXPLOITATION.md](docs/EXPLOITATION.md) ; `npm start` seul échoue sans `FDL_DATA_DIR` et `PG*`.

Pour essayer le catalogue en développement, `npm run seed:demo -- <nombre>` (30 par défaut) crée trois univers et des recettes de démonstration dans la base `PGDATABASE`. Il refuse de tourner avec `NODE_ENV=production`.

Le serveur écoute par défaut sur `http://127.0.0.1:3000`. `GET /health` indique que le processus tourne, `GET /ready` que la base est joignable et à jour. Au démarrage, FDL applique les migrations ; si la configuration est invalide ou la base injoignable, il affiche une ligne d’erreur et s’arrête avec le code 1.

## Configuration

Tout se règle par variables d’environnement.

| Variable | Rôle | Défaut |
| --- | --- | --- |
| `FDL_DATA_DIR` | Dossier absolu et existant des données d’exécution | obligatoire |
| `HOST` | Adresse d’écoute | `127.0.0.1` |
| `PORT` | Port d’écoute (1 à 65535) | `3000` |
| `FDL_PG_BIN_DIR` | Dossier des binaires PostgreSQL (`pg_dump`) | vide |
| `PGHOST`, `PGDATABASE`, `PGUSER` | Serveur, base et utilisateur PostgreSQL | obligatoires |
| `PGPORT` | Port PostgreSQL | `5432` |
| `PGPASSWORD` | Mot de passe PostgreSQL | selon le serveur |
| `FDL_ORIGIN` | Adresse publique sans chemin, par exemple `https://fdl.example.org` | obligatoire |
| `FDL_SECRET_KEY` | 64 caractères hexadécimaux (32 octets) ; chiffre les secrets du code à 6 chiffres | obligatoire |

Le mot de passe et la clé ne sont jamais affichés ni journalisés. Perdre `FDL_SECRET_KEY` rend illisibles les secrets du code à 6 chiffres (voir [docs/EXPLOITATION.md](docs/EXPLOITATION.md)).

## Sauvegarde

`npm run backup -- <dossier de sortie>` crée un dossier `fdl-backup-<date>` contenant `database.dump` (`pg_dump` au format custom), `files/` (copie de `FDL_DATA_DIR`, sans `tmp/`, `backups/` ni `logs/`) et `manifest.json` (version du schéma, date, somme SHA-256 de chaque fichier). Le manifeste est écrit en dernier : sans lui, la sauvegarde est incomplète. La base sauvegardée est `PGDATABASE` ; la commande affiche le chemin créé, ou une ligne d’erreur et le code 1.

## Restauration

`npm run restore -- <dossier de sauvegarde>` restaure une sauvegarde dans la base `PGDATABASE` et dans `FDL_DATA_DIR`. Avant toute modification, la commande vérifie dans l’ordre : le manifeste (`backup_invalid`), les sommes SHA-256 et l’absence de fichier manquant ou en trop (`backup_corrupted`), la version du schéma (`schema_incompatible`), puis que la base cible et le dossier de données sont vides, hors `tmp/`, `backups/` et `logs/` (`target_not_empty`). Elle ne remplace jamais de données existantes : restaurez vers une base vierge et un dossier vierge. La base est restaurée en une seule transaction (`pg_restore --single-transaction`) : en cas d’échec, elle reste intacte et les fichiers ne sont pas copiés. Si la copie des fichiers échoue après la restauration de la base, le message l’indique et la base reste restaurée. En cas d’erreur, une ligne en français est affichée et le code de sortie est 1.

## Documentation

- [Carte des capacités](CAPABILITIES.md)
- [Spécification du socle](SPEC-socle.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Contrats initiaux](docs/CONTRATS.md)
- [Exploitation](docs/EXPLOITATION.md)

La licence du code et celle des contributions restent deux décisions distinctes à prendre avant toute publication réelle.
