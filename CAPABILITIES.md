# Carte des capacités FDL

Statut : approuvée le 15 octobre 2026 ; ordre mis à jour le 27 octobre 2026 selon le cahier des charges (`docs/superpowers/specs/2026-10-27-fdl-cahier-des-charges-design.md`, section 11).

| Identifiant | Responsabilité | Dépend de |
| --- | --- | --- |
| `socle` | Contrats, stockage, sauvegarde et configuration | — |
| `acces` | Invitations, comptes, sessions et rôles | `socle` |
| `catalogue` | Recettes publiées, versions, recherche et pagination | `acces` |
| `contributions` | Brouillons, droits, modération, photos et signalements | `catalogue` |
| `integration-manger` | Consultation distante et import d’une copie privée | `catalogue` |

État : `socle` et `acces` sont construits (comptes, sessions, rôles, seconde étape, clés d’accès, administration des comptes, journal de sécurité). `catalogue` est construit (vitrine, recherche, page recette ; sans photos, signalement, notes ni API). Les autres capacités restent à faire.

Ordre de réalisation (cahier des charges, section 11) : `socle` → `acces` (dont 2FA admin) → `catalogue` + site public → `contributions` + modération + administration + notes → commentaires → `integration-manger`.

Le cahier des charges ajoute l’interface web publique, les recettes privées, l’administration et les commentaires ; ils seront rattachés à ces capacités au moment de leur cadrage détaillé.

Le juridique, la sécurité, la confidentialité, l’accessibilité et l’exploitation sont des critères transversaux. Ils ne constituent pas une phase repoussée après le développement.

