# Contrats initiaux

Statut : contrat de départ pour la bêta. Seul `GET /health` est implémenté aujourd’hui ; les autres sections fixent les limites à respecter lors des prochaines tranches.

## HTTP

Les futures routes métier seront versionnées sous `/api/v1`. Les réponses utilisent JSON en UTF-8.

Une erreur suit cette forme :

```json
{
  "error": {
    "code": "not_found",
    "message": "Ressource introuvable."
  }
}
```

`code` est stable et destiné au programme appelant. `message` est destiné à la personne qui utilise l’interface. Une réponse ne doit contenir ni secret, ni trace technique, ni donnée d’un autre compte.

### `GET /health`

Réponse `200` :

```json
{ "status": "ok" }
```

Ce contrôle confirme uniquement que le processus HTTP répond. Il ne prétend pas valider une base, un stockage d’images ou un déploiement qui n’existent pas encore.

## Recette communautaire

Une version publiée possède au minimum :

- `id` stable et `version` entière positive ;
- `title`, `minutes`, `servings`, `diet` et `tags` ;
- une liste ordonnée d’`ingredients` et de `steps` ;
- un auteur affiché, une provenance et les droits applicables au texte ;
- des dates de soumission et de publication.

Les droits et la provenance de la photo sont séparés de ceux du texte. Les saisons sont des étiquettes facultatives et multiples ; une liste absente ou vide signifie « non renseigné », jamais « toute l’année ».

## Projection compatible avec Manger!

La copie importée devra respecter la validation locale actuelle de Manger! :

| Champ | Limite actuelle de Manger! |
| --- | --- |
| `title` | texte non vide, 120 caractères maximum |
| `minutes` | entier de 1 à 1 440 |
| `servings` | entier de 1 à 100 |
| `diet` | `vegan`, `vegetarian`, `pescetarian` ou `omnivore` |
| `tags` | 20 maximum, 40 caractères maximum par valeur |
| `ingredients` | 1 à 100 éléments |
| ingrédient | `name` ≤ 80, `unit` ≤ 24, `amount` positif ≤ 1 000 000, `preparation` parmi `raw`, `cooked`, `unknown` |
| `steps` | 1 à 50 éléments |
| étape | `kind` parmi `prep`, `cook`, `rest`, `serve` ; `instruction` ≤ 2 000 ; `minutes` nul ou entier de 0 à 1 440 |
| `sourceUrl` | URL HTTP(S) sans identifiants, 2 000 caractères maximum |

FDL peut conserver des métadonnées communautaires supplémentaires, mais l’import doit produire explicitement cette projection puis laisser Manger! la revalider. La provenance FDL, l’identifiant source et la version source seront ajoutés au schéma de Manger! seulement pendant la tranche d’intégration ; ils ne sont pas supposés exister aujourd’hui.

## Pagination et recherche

Le futur catalogue utilisera une pagination par curseur opaque. La limite par défaut sera de 20 recettes et la limite maximale de 50. Un curseur invalide devra produire une erreur `400` stable. Aucun brouillon ou contenu retiré ne devra entrer dans les résultats.

Les filtres prévus sont le texte, la durée, le régime, l’univers et les saisons déclarées. Leur sémantique exacte sera testée avant l’ouverture de ces routes.

## Limites de la bêta à vérifier

Objectifs de travail, pas promesses de production :

- 100 comptes invités au maximum ;
- 5 000 recettes publiées et leur historique de versions ;
- 10 requêtes de lecture simultanées sans erreur ;
- 95 % des lectures de catalogue sous 500 ms sur l’instance de test retenue ;
- restauration complète de la base et des images démontrée avant toute vraie bêta.

Ces seuils devront être mesurés avec des données d’essai et révisés avant de choisir définitivement le stockage ou l’hébergement.
