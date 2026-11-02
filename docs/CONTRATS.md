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
| 401 | `unauthorized` | chemin `/api/` sans session complète valide |
| 403 | `forbidden` | chemin `/api/` : `moderator` ou `admin` sans clé d'accès |
| 403 | `bad_origin` | `POST` dont l'en-tête `Origin` est absent ou différent de `FDL_ORIGIN` |
| 403 | `elevation_required` | ajout d'une clé d'accès (`/cles/inscription/*`) par un `admin` qui a déjà une clé, sans confirmation récente |
| 413 | `payload_too_large` | corps de plus de 16 Kio |
| 429 | `too_many` | trop d'essais sur les routes JSON de clé d'accès (10 par 15 minutes) |

Les pages HTML répondent à la même limite d'essais par une page « Trop de tentatives » (statut 429).

## Accès

Ces routes servent des pages HTML en français, sauf mention JSON. Le seul cookie est `fdl_session` (`HttpOnly; Secure; SameSite=Lax; Path=/`). Sans session complète, toute route hors liste publique renvoie vers `/connexion` (ou `/connexion/verification` si la seconde étape manque). Un `moderator` ou `admin` sans clé d'accès n'atteint que `/compte/securite` et `/cles/*` : tout le reste renvoie vers `/compte/securite?obligatoire=1`. Les chemins `/api/` ne redirigent jamais : `401` JSON `unauthorized` sans session valide, `403` JSON `forbidden` pour le personnel sans clé d'accès.

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

La pagination se fait par curseur opaque : 20 recettes par défaut, 50 au maximum. Un curseur invalide produit une erreur `400` de code `bad_cursor`. Les résultats sont triés de la plus récente à la plus ancienne (date de première publication), y compris pour une recherche texte. Aucun brouillon, aucune recette privée et aucune recette d’un compte banni n’y entre. L’API JSON de Manger! reprend ces règles : voir « API Manger! (`/api/v1`) ».

Sémantique des filtres :

- texte : recherche plein texte française sur le titre (poids fort), les noms d’ingrédients et les étiquettes ; insensible à la casse, aux accents et aux pluriels courants. Un texte vide ou fait d’espaces ne filtre pas ;
- durée : durée totale inférieure ou égale à la valeur ;
- régime : « convient à ». `vegan` garde `vegan` ; `vegetarian` garde `vegan` et `vegetarian` ; `pescetarian` garde les trois ; `omnivore` ne filtre pas ;
- univers : égalité stricte avec un univers de la liste fermée gérée par les administrateurs ;
- saisons : au moins une saison commune. Une recette sans saison ne sort jamais d’un filtre de saison.

## API Manger! (`/api/v1`)

Lecture seule, en JSON, appelée par les serveurs Manger! (partie A de `integration-manger` ; l'import et la vérification côté Manger! viennent ensuite). Session complète exigée pendant la bêta : sans elle, `401` de code `unauthorized` (jamais de redirection) ; un `moderator` ou `admin` sans clé d'accès reçoit `403` de code `forbidden`. Toutes les réponses portent `cache-control: no-store` (elles dépendent du compte).

| Route | Réponse |
| --- | --- |
| `GET /api/v1/recettes` | mêmes paramètres que `/recherche` (`q`, `duree`, `regime`, `univers`, `saison`, `apres`), plus `limite` (1 à 50, 20 par défaut ; une valeur invalide vaut la valeur par défaut). `200 { items: [{ id, title, minutes, diet, author }], next }` ; curseur invalide → `400` `bad_cursor` |
| `GET /api/v1/recette?id=<id>` | `200` projection de la version publiée (ou, pour son auteur, de sa version privée) ; identifiant invalide, inconnu ou recette privée d'un autre → `404` « Recette introuvable. » ; recette retirée → `410` `removed` « Recette retirée par la modération. » |
| `GET /api/v1/etat?ids=1,2,3` | 1 à 100 identifiants distincts, séparés par des virgules. `200 { "1": { "state": "published", "version": 3 }, "2": { "state": "removed" } }`, clés = identifiants fournis ; liste vide, élément invalide ou hors limites, doublon ou plus de 100 → `400` `bad_request` |
| `GET /api/v1/mes-recettes` | `200 { items: [{ id, title, state, version }] }` : recettes du compte dont l'état API est `published` (y compris avec une nouvelle version en attente) ou `private` (y compris si une soumission publique attend ou a été refusée) ; ni brouillon, ni recette retirée |

États : `published` (version publiée), `private` (version privée du demandeur), `removed` (retirée par la modération, y compris par bannissement de l'auteur), `not_found` (inconnue, ou privée d'un autre). `hidden` (masquage temporaire) est réservé : il n'est jamais renvoyé aujourd'hui. Seul `removed` supprime une copie Manger! ; `not_found`, une panne ou `hidden` ne suppriment rien.

Projection d'une recette : `id`, `version`, `visibility` (`public` ou `private`), `title`, `minutes`, `servings`, `diet`, `tags`, `seasons`, `ingredients`, `steps`, `provenance`, `sourceUrl`, `licence`, `author` (nul pour un auteur anonyme), `publishedAt` (nul si privée) et `url` (page de la recette sur FDL). Ni photo, ni note, ni commentaire.

Un état inconnu de Manger! vaut « garder la copie ». Décisions du porteur (2026-11-02) : la tranche `integration-manger` est découpée en 3 plans (A : cette API ; B : liaison de compte par OAuth 2.0 avec PKCE ; C : côté Manger!, import, vérification des versions, suppression) ; pendant la bêta l'API exige une identité (session en A, jeton en B) et l'import sans compte s'ouvrira avec le public ; quand l'auteur supprime lui-même sa recette (ou que la suppression de son compte supprime ses recettes privées), les copies restent (`not_found`).

## Catalogue

Pages HTML réservées à une session complète pendant la bêta :

| Route | Rôle |
| --- | --- |
| `GET /` | vitrine : rangées « De saison », « Récemment ajoutées », « Rapides » (30 min au plus), « Végétariennes », 6 recettes chacune ; une rangée vide n’est pas affichée |
| `GET /recherche` | paramètres `q`, `duree` (`15`, `30`, `60`), `regime` (`vegan`, `vegetarian`, `pescetarian`), `univers` (identifiant), `saison` (répétable : `spring`, `summer`, `autumn`, `winter`), `apres` (curseur) ; une valeur inconnue de `duree`, `regime` ou `saison` est ignorée ; curseur invalide → `400` « Lien de page invalide » |
| `GET /recette?id=<id>` | recette publiée, dernière version ; identifiant invalide, inconnu ou recette non visible → `404` « Recette introuvable » |

Le texte d’une recette est publié sous licence CC BY-SA 4.0 (`text_licence = 'CC-BY-SA-4.0'`, seule valeur acceptée pour l’instant). Un compte supprimé laisse ses recettes publiques signées « Auteur anonyme ». Une nouvelle version ne change pas la date de première publication. Les commentaires sont décrits dans « Contributions » ; l'import dans Manger! viendra avec une tranche suivante. La moyenne des notes s'affiche sur la page et les cartes d'une recette (voir « Contributions »).

## Contributions

Pages HTML réservées à une session complète. Aucune n'est publique.

| Route | Rôle |
| --- | --- |
| `GET /mes-recettes` | recettes de l'auteur, leur état et le motif de la dernière décision (c'est ainsi qu'il en est informé : pas d'e-mail) |
| `GET /mes-recettes/edition`, `GET /mes-recettes/edition?id=<id>` | formulaire vide ou rempli avec le brouillon (sinon la dernière version) ; recette d'un autre, inconnue ou retirée → `404` |
| `POST /mes-recettes/edition` | boutons `action` : `lignes` (renvoie la page avec des lignes d'ingrédients et d'étapes en plus, sans JavaScript), `brouillon`, `privee`, `publier`. `publier` exige la case `atteste_texte` (droit de publier le texte sous CC BY-SA 4.0). Le corps de la requête peut atteindre 256 Kio + 8 Mio (photo comprise, au-delà → `413`) ; le brouillon stocké reste limité à 256 Kio (trop gros → `413`). Recette d'un autre ou retirée → `404`, rien d'écrit. Un envoi invalide renvoie le formulaire en `400` ; le brouillon est enregistré dans tous les cas |
| `GET`/`POST /recette/signaler` | signalement d'une recette visible : `category` (`illegal`, `copyright`, `off_topic`, `spam`, `other`) et `detail` facultatif (1 000 caractères au plus). 10 par 15 minutes et par compte (`429` au-delà). Un second signalement ouvert du même compte sur la même recette donne la même page de remerciement sans nouvelle ligne. Un signalement ne masque jamais la recette |
| `POST /recette/note` | `etoiles` de 1 à 5, une note par compte et par recette (une nouvelle note remplace l'ancienne). Recette non visible → `404` ; sa propre recette → `403` ; note invalide → `400` |
| `POST /recette/commentaire` | `id` (recette visible) et `texte` (1 à 1 000 caractères). Publié aussitôt si l'auteur est de confiance et qu'aucun filtre ne se déclenche, sinon en attente. 10 envois ou modifications par 15 minutes et par compte (`429` au-delà). Recette non visible → `404` ; texte invalide → `400` |
| `GET /recette/commentaire/modifier?id=<id>`, `POST /recette/commentaire/modifier` (`id` dans le corps du formulaire) | l'auteur modifie son commentaire (sauf retiré). La modification efface le motif et recalcule l'état (confiance et filtres). Commentaire d'un autre, retiré, inconnu ou recette plus visible → `404` |
| `POST /recette/commentaire/supprimer` | l'auteur supprime son commentaire (définitif, ses signalements disparaissent avec lui) ; le commentaire d'un autre → `404` |
| `GET`/`POST /recette/signaler?id=<id>&commentaire=<id>` | même signalement, appliqué à un commentaire publié d'un auteur non banni ; mêmes catégories, limites et page de remerciement que pour une recette |
| `GET /moderation`, `GET /moderation/version?id=<id>&version=<n>` | file de modération (rôles `moderator` et `admin`, les autres reçoivent `403`) : versions en attente avec leurs filtres automatiques, signalements de recettes ouverts, commentaires en attente (texte, filtres, lien vers la recette), signalements de commentaires ouverts ; aperçu d'une version |
| `POST /moderation/decision` | `kind` : `accept`, `reject` (versions en attente), `remove` (retire la recette, ferme ses signalements, y compris ceux de ses commentaires), `dismiss` (classe un signalement, de recette ou de commentaire) ; `comment_accept`, `comment_reject` (commentaires en attente), `comment_remove` (retire un commentaire publié, ferme ses signalements), avec les champs `commentaire` et `vu` (date de dernière écriture du commentaire, portée par le formulaire de la file ; un commentaire modifié depuis le chargement de la file est refusé). `comment_reject` ferme aussi les signalements ouverts du commentaire. `motif` obligatoire. Pas de reconfirmation. Version, recette ou commentaire inconnu (ou `commentaire` ou `vu` absent ou invalide) → `404` ; motif absent ou hors de 1 à 500 caractères → `400` ; élément déjà décidé ou commentaire modifié depuis → `409` « Déjà traitée » |

Les moyennes des notes sont affichées sur la page recette et sur les cartes ; la rangée « Les mieux notées » de la vitrine ne retient que les recettes qui ont au moins 3 notes.

États d'une recette pour son auteur : brouillon, privée, en attente de modération, publiée, publiée avec une nouvelle version en attente, refusée, retirée. Une version a le statut `private`, `pending`, `published` ou `rejected`. Le catalogue public lit toujours la version publiée ; une recette publiée ne redevient jamais privée, et la version précédente reste publique pendant qu'une nouvelle attend. Une seule version est en attente à la fois : un nouvel envoi (public ou privé) remplace l'ancienne, qui passe à `rejected` avec la décision « Remplacée par une version plus récente. ». Un double envoi ne laisse donc qu'une version en attente.

Confiance progressive : tant que l'auteur a moins de 3 recettes (non retirées) qui ont au moins une version publiée, chaque version publique passe par un modérateur. Ensuite elle est publiée directement, sauf si un filtre automatique la signale. Filtres : `link` (adresse `http://`, `https://` ou `www.` dans le titre, un ingrédient, une étape ou la provenance), `banned_word` (mot du fichier `mots-interdits.txt`, voir [EXPLOITATION.md](EXPLOITATION.md), comparé sans accents ni casse) et `duplicate` (titre identique, sans accents ni casse, à celui d'une recette visible). Une version signalée attend toujours un modérateur.

Chaque décision de modération a un motif de 1 à 500 caractères, écrit dans `moderation_decisions` et visible par l'auteur sur `/mes-recettes`. Un modérateur peut décider sur sa propre recette. Les notes d'un compte banni restent comptées dans les moyennes (décisions du porteur, 2026-11-02).

Commentaires : un compte de confiance (3 commentaires publiés, ou de confiance pour les recettes) publie directement, sauf si un filtre se déclenche ; les autres attendent un modérateur. Les filtres sont ceux des recettes (`link`, `banned_word`, mêmes règles), appliqués au texte, sans `duplicate`. Un commentaire a le statut `pending`, `published`, `rejected` ou `removed`. L'auteur voit les siens dans tous les états sur la page recette (« En attente de modération », « Publié », « Refusé. Motif : … », « Retiré. Motif : … ») ; les autres lecteurs ne voient que les commentaires publiés d'auteurs non bannis. Un commentaire est décidé une seule fois : `accept` et `reject` exigent `pending`, `remove` exige `published`. Un modérateur peut décider sur son propre commentaire ou sur ceux de sa recette. Un commentaire ne figure jamais dans la projection transmise à Manger! : il n'est jamais transmis. Les décisions écrivent `moderation_decisions` (avec `comment_id`, sans clé étrangère : la décision survit à la suppression du commentaire).

Actions ajoutées à `admin_log` (journal d'administration, cible = identifiant de la recette, détail = recette, version, commentaire pour le classement d'un signalement de commentaire, et motif) : `recipe_accepted`, `recipe_rejected`, `recipe_removed`, `report_dismissed`. Pour un commentaire, la cible est l'identifiant du commentaire et le détail la recette, le commentaire et le motif : `comment_accepted`, `comment_rejected`, `comment_removed`. L'écran `/admin/univers` ajoute `universe_saved` (cible = identifiant de l'univers).

## Photos

Une photo par recette, envoyée dans le formulaire `/mes-recettes/edition` (multipart). Le texte du brouillon est enregistré dans tous les cas.

Limites côté serveur : JPEG uniquement, 1 Mio au plus (`1024*1024` octets), 8 000 px au plus par côté. Une photo plus grosse est refusée avec « La photo dépasse 1 Mo. Activez JavaScript pour qu'elle soit réduite automatiquement, ou envoyez une image plus petite. » (code `PHOTO_TOO_BIG`). Le script facultatif `/static/fdl-photo.js` convertit dans le navigateur n'importe quelle image en JPEG de 1 600 px au plus sur le plus grand côté, qualité 0,8, abaissée jusqu'à 0,4 si l'image dépasse 1 Mo, orientation appliquée. 10 envois de photo par compte et par 15 minutes. Le corps de la requête est limité à environ 8 Mio : au-delà, la réponse est une page HTML `413` « Photo trop lourde » qui indique que le texte n'a pas été enregistré. Une photo retirée par la modération moins de 10 minutes après son envoi reste sur le disque (sans être servie aux membres) jusqu'au prochain nettoyage (démarrage, prochain envoi de photo, prochain retrait).

Le serveur ne garde que les segments JPEG d'une liste autorisée : SOF0 à SOF2, DHT, DQT, DRI, SOS et RST. Les segments APP0 à APP15 et COM sont retirés (EXIF, dont position GPS et orientation, XMP, profil ICC, Adobe). Tout autre marqueur fait refuser le fichier, et rien après EOI n'est conservé. Deux effets : sans JavaScript, une photo de téléphone peut s'afficher tournée ; les profils de couleur disparaissent (décalage de couleur rare).

Le fichier est stocké dans `<dossier de données>/photos/<sha256 en hexadécimal>.jpg`, écrit par `tmp/` puis renommé. `photo_credit` : 1 à 80 caractères, obligatoire dès qu'il y a une photo. La publication exige une seconde case, « J'ai pris cette photo ou j'ai le droit de la publier ». Changer la photo crée une nouvelle version à la publication suivante.

| Route | Rôle |
| --- | --- |
| `GET /photo?f=<64 hex>` | session complète exigée (bêta fermée). Visible par tous pour la version publiée d'une recette visible ; par l'auteur pour ses brouillons et les versions d'une recette non retirée ; par la modération pour toute version. Sinon `404`. En-têtes : `content-type: image/jpeg`, `x-content-type-options: nosniff`, `cache-control: private, max-age=86400` |

La page recette et l'aperçu de modération affichent la photo avec « Photo : <crédit> ».

Nettoyage : un fichier cité par aucun brouillon ni aucune version d'une recette non retirée est supprimé quand il a plus de 10 minutes. Il s'exécute au démarrage, après chaque envoi ou retrait de photo et après chaque retrait par la modération.

## Limites de la bêta à vérifier

Objectifs de travail, pas promesses de production :

- 100 comptes invités au maximum ;
- 5 000 recettes publiées et leur historique de versions ;
- 10 requêtes de lecture simultanées sans erreur ;
- 95 % des lectures de catalogue sous 500 ms sur l’instance de test retenue ;
- restauration complète de la base et des images démontrée avant toute vraie bêta.

Mesure du 28 octobre 2026, en local (PC de développement, PostgreSQL 18 en conteneur), pas sur l’instance de test : 5 000 recettes, 200 recherches par 10 en parallèle (texte, filtres, curseur), 95e centile 30 ms.

Ces seuils devront être mesurés avec des données d’essai et révisés avant de choisir définitivement le stockage ou l’hébergement.
