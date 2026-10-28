# Contrats initiaux

Statut : contrat de départ pour la bêta. Sont implémentés aujourd’hui `GET /health`, `GET /ready`, les routes d’accès (section « Accès ») et les pages du catalogue (section « Catalogue ») et des contributions (section « Contributions ») ; les autres sections fixent les limites à respecter lors des prochaines tranches.

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
| 403 | `elevation_required` | ajout d'une clé d'accès (`/cles/inscription/*`) par un `admin` qui a déjà une clé, sans confirmation récente |
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
| `GET`/`POST /admin/univers` | liste des univers et formulaire d'ajout : `slug` (`a-z`, `0-9`, tirets, 1 à 40) et `label` (1 à 40 caractères) ; un `slug` existant est renommé. Valeur invalide → `400`. Pas de suppression (une version peut y faire référence), pas de reconfirmation |
| `GET /admin/journal` | cent dernières actions d'administration |
| `GET`/`POST /admin/confirmation` | confirmation par code à 6 chiffres ou clé d'accès |

Inviter un `moderator` ou un `admin`, changer un rôle, bannir, débannir et réinitialiser exigent une confirmation de moins de 5 minutes ; sinon la personne est renvoyée vers `/admin/confirmation`. Pour un `admin` qui a déjà une clé d'accès, il en va de même pour ajouter ou supprimer une clé, activer le code à 6 chiffres et régénérer les codes de récupération : les pages renvoient vers `/admin/confirmation?retour=/compte/securite`, les routes JSON répondent `403 elevation_required`. La première clé d'un compte reste ajoutable sans confirmation.

Le journal de sécurité (`logs/securite.log`) et `/admin/journal` consignent aussi la création et la révocation d'une invitation `moderator` ou `admin` (`invitation_created`, `invitation_revoked`), avec le rôle et les 16 premiers caractères de l'empreinte du lien, jamais le lien. `rate_limited` n'est écrit qu'une fois par clé et par fenêtre de 15 minutes, au premier refus. Il reste toujours au moins un administrateur actif : le dernier ne peut être ni rétrogradé ni banni. Le rôle `moderator` n'a accès qu'à `/moderation` (section « Contributions »).

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

La pagination se fait par curseur opaque : 20 recettes par défaut, 50 au maximum. Un curseur invalide produit une erreur `400` de code `bad_cursor`. Les résultats sont triés de la plus récente à la plus ancienne (date de première publication), y compris pour une recherche texte. Aucun brouillon, aucune recette privée et aucune recette d’un compte banni n’y entre. L’API JSON (`/api/v1`) arrivera avec `integration-manger` ; elle reprendra ces règles.

Sémantique des filtres :

- texte : recherche plein texte française sur le titre (poids fort), les noms d’ingrédients et les étiquettes ; insensible à la casse, aux accents et aux pluriels courants. Un texte vide ou fait d’espaces ne filtre pas ;
- durée : durée totale inférieure ou égale à la valeur ;
- régime : « convient à ». `vegan` garde `vegan` ; `vegetarian` garde `vegan` et `vegetarian` ; `pescetarian` garde les trois ; `omnivore` ne filtre pas ;
- univers : égalité stricte avec un univers de la liste fermée gérée par les administrateurs ;
- saisons : au moins une saison commune. Une recette sans saison ne sort jamais d’un filtre de saison.

## Catalogue

Pages HTML réservées à une session complète pendant la bêta :

| Route | Rôle |
| --- | --- |
| `GET /` | vitrine : rangées « De saison », « Récemment ajoutées », « Rapides » (30 min au plus), « Végétariennes », 6 recettes chacune ; une rangée vide n’est pas affichée |
| `GET /recherche` | paramètres `q`, `duree` (`15`, `30`, `60`), `regime` (`vegan`, `vegetarian`, `pescetarian`), `univers` (identifiant), `saison` (répétable : `spring`, `summer`, `autumn`, `winter`), `apres` (curseur) ; une valeur inconnue de `duree`, `regime` ou `saison` est ignorée ; curseur invalide → `400` « Lien de page invalide » |
| `GET /recette?id=<id>` | recette publiée, dernière version ; identifiant invalide, inconnu ou recette non visible → `404` « Recette introuvable » |

Le texte d’une recette est publié sous licence CC BY-SA 4.0 (`text_licence = 'CC-BY-SA-4.0'`, seule valeur acceptée pour l’instant). Un compte supprimé laisse ses recettes publiques signées « Auteur anonyme ». Une nouvelle version ne change pas la date de première publication. Photos, commentaires et import dans Manger! viendront avec les tranches suivantes. La moyenne des notes s'affiche sur la page et les cartes d'une recette (voir « Contributions »).

## Contributions

Pages HTML réservées à une session complète. Aucune n'est publique.

| Route | Rôle |
| --- | --- |
| `GET /mes-recettes` | recettes de l'auteur, leur état et le motif de la dernière décision (c'est ainsi qu'il en est informé : pas d'e-mail) |
| `GET /mes-recettes/edition`, `GET /mes-recettes/edition?id=<id>` | formulaire vide ou rempli avec le brouillon (sinon la dernière version) ; recette d'un autre, inconnue ou retirée → `404` |
| `POST /mes-recettes/edition` | boutons `action` : `lignes` (renvoie la page avec des lignes d'ingrédients et d'étapes en plus, sans JavaScript), `brouillon`, `privee`, `publier`. `publier` exige la case `atteste_texte` (droit de publier le texte sous CC BY-SA 4.0). Brouillon limité à 256 Kio (corps plus gros ou brouillon stocké trop gros → `413`). Recette d'un autre ou retirée → `404`, rien d'écrit. Un envoi invalide renvoie le formulaire en `400` ; le brouillon est enregistré dans tous les cas |
| `GET`/`POST /recette/signaler` | signalement d'une recette visible : `category` (`illegal`, `copyright`, `off_topic`, `spam`, `other`) et `detail` facultatif (1 000 caractères au plus). 10 par 15 minutes et par compte (`429` au-delà). Un second signalement ouvert du même compte sur la même recette donne la même page de remerciement sans nouvelle ligne. Un signalement ne masque jamais la recette |
| `POST /recette/note` | `etoiles` de 1 à 5, une note par compte et par recette (une nouvelle note remplace l'ancienne). Recette non visible → `404` ; sa propre recette → `403` ; note invalide → `400` |
| `GET /moderation`, `GET /moderation/version?id=<id>&version=<n>` | file de modération (rôles `moderator` et `admin`, les autres reçoivent `403`) : versions en attente avec leurs filtres automatiques, signalements ouverts ; aperçu d'une version |
| `POST /moderation/decision` | `kind` : `accept`, `reject` (versions en attente), `remove` (retire la recette, ferme ses signalements), `dismiss` (classe un signalement) ; `motif` obligatoire. Pas de reconfirmation. Version ou recette inconnue → `404` ; motif absent ou hors de 1 à 500 caractères → `400` ; élément déjà décidé → `409` « Déjà traitée » |

Les moyennes des notes sont affichées sur la page recette et sur les cartes ; la rangée « Les mieux notées » de la vitrine ne retient que les recettes qui ont au moins 3 notes.

États d'une recette pour son auteur : brouillon, privée, en attente de modération, publiée, publiée avec une nouvelle version en attente, refusée, retirée. Une version a le statut `private`, `pending`, `published` ou `rejected`. Le catalogue public lit toujours la version publiée ; une recette publiée ne redevient jamais privée, et la version précédente reste publique pendant qu'une nouvelle attend. Une seule version est en attente à la fois : un nouvel envoi (public ou privé) remplace l'ancienne, qui passe à `rejected` avec la décision « Remplacée par une version plus récente. ». Un double envoi ne laisse donc qu'une version en attente.

Confiance progressive : tant que l'auteur a moins de 3 recettes (non retirées) qui ont au moins une version publiée, chaque version publique passe par un modérateur. Ensuite elle est publiée directement, sauf si un filtre automatique la signale. Filtres : `link` (adresse `http://`, `https://` ou `www.` dans le titre, un ingrédient, une étape ou la provenance), `banned_word` (mot du fichier `mots-interdits.txt`, voir [EXPLOITATION.md](EXPLOITATION.md), comparé sans accents ni casse) et `duplicate` (titre identique, sans accents ni casse, à celui d'une recette visible). Une version signalée attend toujours un modérateur.

Chaque décision de modération a un motif de 1 à 500 caractères, écrit dans `moderation_decisions` et visible par l'auteur sur `/mes-recettes`.

Actions ajoutées à `admin_log` (journal d'administration, cible = identifiant de la recette, détail = recette, version et motif) : `recipe_accepted`, `recipe_rejected`, `recipe_removed`, `report_dismissed`. L'écran `/admin/univers` ajoute `universe_saved` (cible = identifiant de l'univers).

## Limites de la bêta à vérifier

Objectifs de travail, pas promesses de production :

- 100 comptes invités au maximum ;
- 5 000 recettes publiées et leur historique de versions ;
- 10 requêtes de lecture simultanées sans erreur ;
- 95 % des lectures de catalogue sous 500 ms sur l’instance de test retenue ;
- restauration complète de la base et des images démontrée avant toute vraie bêta.

Mesure du 28 octobre 2026, en local (PC de développement, PostgreSQL 18 en conteneur), pas sur l’instance de test : 5 000 recettes, 200 recherches par 10 en parallèle (texte, filtres, curseur), 95e centile 30 ms.

Ces seuils devront être mesurés avec des données d’essai et révisés avant de choisir définitivement le stockage ou l’hébergement.
