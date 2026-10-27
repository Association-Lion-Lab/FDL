# Faim de Lion (FDL)

Une base communautaire pour partager, découvrir et importer des recettes dans Manger!. Bêta sur invitation.

## État

Le projet démarre par un socle fermé et minimal. Il fournit actuellement un serveur HTTP sans dépendance externe et un contrôle de santé. Aucun compte, catalogue, stockage, envoi d’e-mail ou déploiement n’est encore disponible.

FDL reste indépendant de Manger! et du futur service de scan PDF/photo. Manger! doit continuer à fonctionner sans FDL. Seules les contributions volontairement soumises à FDL y seront conservées.

## Lancer localement

Prérequis : Node.js 22 ou plus récent.

```powershell
npm run test:docker
npm start
```

Les tests tournent dans Docker (PostgreSQL 18 et `pg_dump` 18 inclus) : rien à installer d’autre que Docker. Lancé hors du conteneur, `npm test` n’a pas de base à sa disposition.

Le serveur écoute par défaut sur `http://127.0.0.1:3000`. Le contrôle de santé est disponible sur `GET /health`.

## Documentation

- [Carte des capacités](CAPABILITIES.md)
- [Spécification du socle](SPEC-socle.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Contrats initiaux](docs/CONTRATS.md)

La licence du code et celle des contributions restent deux décisions distinctes à prendre avant toute publication réelle.
