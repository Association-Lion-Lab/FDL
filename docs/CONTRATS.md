# Contrats initiaux

Statut : contrat de départ pour la bêta. Sont implémentés aujourd’hui `GET /health`, `GET /ready` et les routes d’accès (section « Accès ») ; les autres sections fixent les limites à respecter lors des prochaines tranches.

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

Une erreur interne produit un statut `500` avec le code `internal_error` et un champ supplémentaire `requestId` (UUID) qui permet de retrouver la trace complète dans le journal du serveur :

```json
{
  "error": {
    "code": "internal_error",
    "message": "Erreur interne. Réessayez plus tard.",
    "requestId": "3f2b8c1e-5a47-4d0e-9b6a-1c2d3e4f5a6b"
  }
}
```

### `GET /health`

Réponse `200` :

```json
{ "status": "ok" }
```

Ce contrôle confirme uniquement que le processus HTTP répond. Il ne prétend pas valider le stockage d’images (qui n’existe pas encore) ni la validité d’un déploiement. La base est vérifiée par `/ready`.

### `GET /ready`

Réponse `200` quand la base est jointe et que son schéma est à la version attendue par l’application :

```json
{ "status": "ok" }
```

Sinon (schéma absent ou différent, base injoignable, erreur de connexion), réponse `503` sans aucun détail technique (ni nom de base, ni hôte, ni message du pilote) :

```json
{
  "error": {
    "code": "not_ready",
    "message": "Service momentanément indisponible."
  }
}
```

### Codes d'erreur communs

Ces erreurs JSON valent pour toute route (forme ci-dessus) :

| Statut | `code` | Cas |
| --- | --- | --- |
| 400 | `bad_request` | type de contenu autre que formulaire ou JSON, ou JSON invalide |
| 400 | `passkey_failed` | étape de clé d'accès refusée (session, défi, signature ou nom invalide) |
| 403 | `bad_origin` | `POST` dont l'en-tête `Origin` est absent ou différent de `FDL_ORIGIN` |
| 413 | `payload_too_large` | corps de plus de 16 Kio |
| 429 | `too_many` | trop d'essais sur les routes JSON de clé d'accès (10 par 15 minutes) |

Les pages HTML répondent à la même limite d'essais par une page « Trop de tentatives » (statut 429).

## Accès

Ces routes servent des pages HTML en français, sauf mention JSON. Le seul cookie est `fdl_session` (`HttpOnly; Secure; SameSite=Lax; Path=/`). Sans session complète, toute route hors liste publique renvoie vers `/connexion` (ou `/connexion/verification` si la seconde étape manque). Un `moderator` ou `admin` sans clé d'accès n'atteint que `/compte/securite` et `/cles/*` : tout le reste renvoie vers `/compte/securite?obligatoire=1`.

Publiques : `GET`/`POST /connexion`, `GET`/`POST /connexion/verification`, `GET`/`POST /inscription?code=…`, `GET`/`POST /reinitialisation?code=…`, `POST /deconnexion`, `POST /cles/connexion/options` et `/cles/connexion/verification` (JSON, session à moitié ouverte), et `/static/*`. Un lien expiré, utilisé ou révoqué répond `410` « Lien expiré ». Au-delà de 10 essais par quart d'heure (par adresse IP, et par e-mail pour `/connexion`), `429`.

Réservées à une session complète :

| Route | Rôle |
| --- | --- |
| `GET /` | accueil provisoire |
| `GET /compte/securite` | état du code à 6 chiffres, des clés et des codes de récupération |
| `POST /compte/securite/totp`, `POST /compte/securite/totp/confirmation` | activer le code à 6 chiffres (secret et QR code, puis confirmation) |
| `POST /compte/securite/recuperation` | nouveaux codes de récupération, affichés une seule fois |
| `POST /compte/securite/cles/suppression` | supprimer une clé ; refusé pour la dernière clé d'un `moderator` ou `admin` |
| `POST /compte/securite/mot-de-passe` | changer le mot de passe ; les autres sessions du compte sont fermées |
| `POST /cles/inscription/options`, `POST /cles/inscription/verification` | ajouter une clé d'accès (JSON) |
| `POST /cles/confirmation/options`, `POST /cles/confirmation/verification` | confirmer son identité par clé d'accès (JSON) |

Réservées au rôle `admin` (les autres reçoivent `403` « Accès refusé ») :

| Route | Rôle |
| --- | --- |
| `GET /admin` | menu |
| `GET`/`POST /admin/invitations`, `POST /admin/invitations/revoquer` | créer (lien montré une seule fois) ou révoquer une invitation |
| `GET /admin/comptes` | liste des comptes |
| `POST /admin/comptes/role`, `/bannir`, `/debannir` | changer le rôle, bannir (ferme ses sessions), débannir |
| `POST /admin/comptes/reinitialiser` | lien de réinitialisation, montré une seule fois |
| `GET /admin/journal` | cent dernières actions d'administration |
| `GET`/`POST /admin/confirmation` | confirmation par code à 6 chiffres ou clé d'accès |

Inviter un `moderator` ou un `admin`, changer un rôle, bannir, débannir et réinitialiser exigent une confirmation de moins de 5 minutes ; sinon la personne est renvoyée vers `/admin/confirmation`. Il reste toujours au moins un administrateur actif : le dernier ne peut être ni rétrogradé ni banni. Le rôle `moderator` n'a pas encore d'écran.

Une réinitialisation (`/reinitialisation`) change le mot de passe et supprime les sessions, le code à 6 chiffres, les clés d'accès et les codes de récupération du compte.

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
