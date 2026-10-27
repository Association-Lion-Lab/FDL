# Carte des capacités FDL

Statut : approuvée le 15 octobre 2026.

| Identifiant | Responsabilité | Dépend de |
| --- | --- | --- |
| `socle` | Contrats, stockage, sauvegarde et configuration | — |
| `acces` | Invitations, comptes, sessions et rôles | `socle` |
| `catalogue` | Recettes publiées, versions, recherche et pagination | `acces` |
| `contributions` | Brouillons, droits, modération, photos et signalements | `catalogue` |
| `integration-manger` | Consultation distante et import d’une copie privée | `catalogue` |

Ordre de réalisation : `socle` → `acces` → `catalogue` → `contributions` → `integration-manger`.

Le juridique, la sécurité, la confidentialité, l’accessibilité et l’exploitation sont des critères transversaux. Ils ne constituent pas une phase repoussée après le développement.

