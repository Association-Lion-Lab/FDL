# Cahier des charges : Faim de Lion (FDL)

Statut : validé le 27 octobre 2026.
Ce document complète `CAPABILITIES.md` et `docs/ARCHITECTURE.md`. Là où il les contredit (base de données, Docker, interface web), c'est lui qui fait foi.

Légende : **[décidé]** = choix du porteur de projet ; **[choix Claude]** = choix par défaut proposé pendant le cadrage, à contester ; **[ouvert]** = reste à décider.

## 1. Intention

FDL est une base de recettes communautaire, ouverte à tous, portée par l'association LION LAB. C'est l'équivalent d'un Marmiton, sans publicité intrusive, sans bandeau de cookies imposé, sans abonnement, et en sachant où vont les données.

Origine : l'expérience de Jow, une appli de qualité mais bridée par un modèle freemium et opaque sur l'usage des données. FDL est la réponse libre et gratuite.

FDL est aussi un bonus pour Manger!, l'application de cuisine du foyer : Manger! peut y puiser des recettes de la communauté. Mais FDL vit seul : un visiteur sans Manger! doit y trouver tout son intérêt.

## 2. Objectifs, non-objectifs, anti-objectifs

Objectifs :

- un site public où l'on cherche, découvre et lit des recettes sans compte ;
- des contributions de la communauté, modérées sans épuiser les modérateurs ;
- une connexion directe avec Manger! ;
- un service gratuit et open-source ; l'adhésion à l'asso peut apporter des fonctions en plus pour financer l'association **[décidé]** ;
- une administration complète et très protégée contre le piratage **[décidé]**.

Non-objectifs :

- scan de PDF ou photo, OCR, collecte automatique de sites (autre projet) ;
- application mobile dédiée ;
- toute modification de Manger! en dehors de la brique d'intégration.

Anti-objectifs (échec même si « ça marche ») **[décidé]** :

- publicité, quelle qu'en soit la forme ;
- revente ou partage commercial des données ;
- compte obligatoire pour lire une recette ;
- freemium déguisé : aucune recette publique n'est cachée derrière l'adhésion **[choix Claude]** ;
- traceurs tiers (statistiques externes, réseaux sociaux, polices ou scripts chargés depuis un tiers) **[choix Claude, conséquence directe du « sans bandeau cookies »]**.

## 3. Phases

1. **Bêta sur invitation** **[décidé]** : proches, collègues, amis, membres de l'asso. L'inscription n'est possible qu'avec une invitation ; la lecture peut rester restreinte aux invités pendant la bêta **[choix Claude : site entier fermé aux non-invités pendant la bêta, pour ne rien exposer d'inachevé]**.
2. **Ouverture au public** **[décidé]** : après environ 3 à 4 mois de tests, quand tout est testé. Critères proposés **[choix Claude]** :
   - aucun bug bloquant ouvert ;
   - sauvegarde puis restauration complète réussies sur une machine vierge ;
   - parcours complet (inscription, publication, modération, signalement, import Manger!, mise à jour, retrait) validé par au moins 3 testeurs ;
   - mentions légales, FAQ, politique de confidentialité et conditions d'utilisation publiées ;
   - objectifs de charge de `docs/CONTRATS.md` mesurés.

## 4. Le site public

Page d'accueil en **vitrine** **[décidé]** : barre de recherche dans l'en-tête, puis des rangées de cartes (de saison, récemment ajoutées, rapides, végétariennes...). Les rangées exactes sont laissées au constructeur.

Recherche et filtres : texte, durée, régime, univers, saisons (déjà prévus dans `CONTRATS.md`). La recherche texte tolère pluriels et accents (« poireau » trouve « Poireaux »).

Page recette : photo avec son auteur, titre, auteur, durée, portions, régime, saisons, ingrédients, étapes, licence, version et date. Boutons : « Importer dans Manger! », « Imprimer », « Signaler ».

## 5. Comptes et rôles

- Lire : sans compte **[décidé]**.
- Publier, signaler en étant identifié, relier Manger! : compte requis **[décidé]**.
- Rôles : membre, adhérent, modérateur, administrateur. Le rôle adhérent existe dès le départ, mais ses droits sont **[ouvert]** (modèle d'adhésion à réfléchir). Le code doit permettre d'ajouter ces droits sans refonte.
- Suppression d'un compte **[décidé]** : ses recettes publiques restent, signées « Auteur anonyme » ; ses brouillons, recettes privées et données personnelles sont supprimés. Les copies Manger! ne sont pas touchées. Les conditions d'utilisation l'annoncent avant toute publication.
- Le signalement est possible sans compte **[choix Claude : le DSA impose un mécanisme de signalement accessible à tous]**.

## 6. Recettes

Trois états de visibilité :

- **Brouillon** : en cours d'écriture, visible par son seul auteur.
- **Privée** **[décidé]** : terminée, visible uniquement par son auteur sur FDL et importable dans son Manger!. Jamais publique, donc jamais modérée.
- **Publique** : soumise à la modération puis visible de tous.

Le contenu d'une recette suit le contrat de `docs/CONTRATS.md` (champs, limites compatibles Manger!, versions). Le formulaire est structuré (ingrédients, étapes, durée, portions, régime) : c'est le premier filtre contre les contenus hors sujet.

Lors d'une publication, le contributeur atteste être l'auteur du texte et, séparément, de la photo (ou en avoir les droits) **[choix Claude]**.

## 6 bis. Notes et commentaires

Réservés aux utilisateurs connectés **[décidé]**.

- **Notes** : de 1 à 5 étoiles, une note par personne et par recette, modifiable. La page recette et les cartes affichent la moyenne et le nombre de notes. On ne note pas sa propre recette. La vitrine peut proposer une rangée « les mieux notées » **[choix Claude]**.
- **Commentaires** **[décidé : à prévoir]** : texte simple, sans lien cliquable ni image. Chaque commentaire a un bouton « Signaler ». Son auteur peut le modifier ou le supprimer. Les commentaires suivent la même confiance progressive que les recettes, et un bannissement masque aussi les commentaires du compte **[choix Claude]**.
- Ni les notes ni les commentaires ne sont transmis à Manger!.
- Ordre de réalisation : les notes avec la brique `contributions`, puis les commentaires dans une tranche séparée juste après **[choix Claude : les commentaires ajoutent de la modération, on les livre une fois la modération des recettes rodée]**.

## 7. Modération

Objectif : rester gérable même avec beaucoup de contributeurs **[décidé]**.

1. **Formulaire structuré** : une recette doit ressembler à une recette.
2. **Filtres automatiques simples** : liens externes dans le texte, mots interdits, doublons. Une recette filtrée part en vérification humaine, elle n'est pas rejetée en silence.
3. **Confiance progressive** **[décidé]** : les premières recettes d'un nouveau compte sont validées par un modérateur ; ensuite le compte publie directement. Seuil par défaut : 3 recettes acceptées **[choix Claude]**.
4. **Bouton « Signaler »** sur chaque recette **[décidé]** : la recette part en file de modération.
5. **Bannissement** **[décidé]** : bloquer un compte masque toutes ses recettes. Les données sont conservées le temps imposé à un hébergeur (durée à confirmer juridiquement, piste : 1 an), puis supprimées.
6. **IA** : hors périmètre de la première version. Si elle arrive, elle aide le modérateur sans décider seule, et le modèle est auto-hébergé **[choix Claude, cohérent avec la promesse sur les données]**.

Chaque décision de modération est motivée et l'auteur en est informé (exigence DSA).

## 8. Connexion avec Manger!

Principe inchangé de `ARCHITECTURE.md` : c'est toujours le serveur Manger! qui appelle FDL, jamais l'inverse.

Deux façons de récupérer une recette **[décidé]** :

- **Compte FDL relié dans Manger!** : la personne parcourt toute la base FDL depuis Manger! (recherche, filtres) et ajoute des recettes, y compris ses recettes privées.
- **Sans compte FDL** : import d'une recette précise, via le bouton « Importer dans Manger! » du site ou en collant le lien de la recette dans Manger!. Le mécanisme technique exact est laissé au constructeur.

Vie de la copie importée :

- la recette est **copiée** dans Manger! et reste utilisable si FDL est indisponible ;
- Manger! vérifie régulièrement l'existence d'une nouvelle version et **propose** la mise à jour ; le foyer accepte ou ignore **[décidé : mise à jour dynamique ; choix Claude : proposée, pas imposée]** ;
- si le foyer modifie sa copie, elle ne reçoit plus de mises à jour **[choix Claude]** ;
- si la recette est **retirée par la modération**, la copie **disparaît** de Manger! **[décidé]**, y compris une copie modifiée **[choix Claude, sinon contournement trivial]**, et le foyer en est prévenu par un message ;
- cette règle est expliquée dans les mentions légales et la FAQ **[décidé]**.

Cela implique d'ajouter à Manger! l'identifiant FDL, la version source et l'état « modifiée » de chaque copie importée. La brique `integration-manger` touche donc deux dépôts : FDL (API) et Manger! (import, vérification, suppression).

Manger! est un logiciel libre auto-hébergé : **chaque foyer installe son propre serveur** **[décidé]**. FDL dialogue donc avec un grand nombre d'instances inconnues. Relier un compte passe par un parcours d'autorisation du type « Se connecter avec FDL » (OAuth 2.0 avec PKCE ou équivalent), révocable depuis le compte FDL ; jamais de mot de passe FDL saisi dans Manger!. L'API applique des limites de débit par instance reliée et par adresse **[choix Claude]**.

## 9. Administration

Intégrée au site, sous `/admin`, pas d'application séparée ni de VPN **[décidé]**.

Fonctions : file de modération, signalements, comptes (rôles, bannissement), invitations de bêta, journal des actions, état du service et des sauvegardes.

Sécurité **[décidé : « 2FA blindée » ; détail : choix Claude]** :

- double authentification obligatoire pour modérateurs et administrateurs ;
- clé d'accès (passkey / WebAuthn) en méthode principale, code TOTP en secours, codes de récupération à usage unique ;
- sessions admin courtes et nouvelle authentification avant une action sensible (bannir, supprimer, changer un rôle) ;
- limitation des tentatives de connexion ;
- alerte e-mail à chaque nouvelle connexion admin ;
- journal des actions admin non modifiable depuis l'interface.

## 10. Contraintes techniques

- Node.js 22 ou plus, modules ES, API standard privilégiées (inchangé).
- **PostgreSQL** **[décidé : pas SQLite ; choix de PostgreSQL proposé par Claude]** : recherche plein texte en français (configuration `french` + `unaccent`), écritures concurrentes, sauvegarde par `pg_dump`. Le client Node (`pg` ou `postgres`) est la première dépendance du projet ; le choix entre les deux est laissé au constructeur.
- Serveur **Ubuntu** (ou Ubuntu Pro) **[décidé]**.
- **Docker Compose** : un conteneur FDL, un conteneur PostgreSQL **[choix Claude]**.
- **Mise à jour facile** **[décidé]** : une commande qui sauvegarde la base, récupère la nouvelle version, applique les migrations et redémarre ; retour à la sauvegarde si la migration échoue.
- Seuls les cookies strictement nécessaires (session) sont utilisés, donc pas de bandeau de consentement.
- E-mails nécessaires : invitations, alertes admin, notifications de modération. Le fournisseur d'envoi est **[ouvert]**.

## 11. Impact sur le cadrage existant

- `SPEC-socle.md` : remplacer SQLite par PostgreSQL ; Docker entre dans le périmètre.
- `CAPABILITIES.md` : ajouter l'interface web publique, les recettes privées et l'administration. Ordre proposé **[choix Claude]** : `socle` → `acces` (dont 2FA admin) → `catalogue` + site public → `contributions` + modération + admin + notes → commentaires → `integration-manger`.

## 12. Questions ouvertes

1. Ce qu'apporte l'adhésion.
2. Licence du code et licence des recettes publiées (piste : CC BY-SA pour les contenus).
3. Sort d'une copie Manger! quand l'**auteur** supprime lui-même sa recette.
4. Qui sont les modérateurs.
5. Nom de domaine (piste : sous-domaine de lionlab.fr) et machine d'hébergement précise.
6. Fournisseur d'envoi d'e-mails.

## 13. Précisions issues de la relecture [choix Claude]

- **États vus par Manger!** : l'API distingue explicitement « retirée par la modération » (y compris par bannissement de l'auteur, qui vaut retrait de ses recettes), « masquée temporairement » (signalement en cours d'examen) et « introuvable ». Seul le retrait définitif supprime les copies Manger!. Un masquage temporaire, un 404 ou une panne de FDL ne suppriment rien. Un retrait annulé ensuite ne restaure pas les copies ; le foyer peut réimporter.
- **Modification d'une recette publique** : elle crée une nouvelle version, soumise aux mêmes règles que la première publication (validée par un modérateur tant que le compte n'a pas gagné la confiance, directe ensuite). La version précédente reste publique tant que la nouvelle attend. Une recette publiée ne peut pas redevenir privée ; seule la suppression est possible (voir question ouverte 3).
- **Dépendances** : le client PostgreSQL, une bibliothèque WebAuthn reconnue (par exemple `@simplewebauthn/server`), une bibliothèque TOTP et un client d'envoi d'e-mails sont acceptés sur le principe ; on n'écrit pas de cryptographie à la main. Chaque bibliothèque est nommée dans le plan, qui sert de validation. Toute autre dépendance suit la règle « demander avant » de `SPEC-socle.md`.
- **Pendant la bêta**, tout est réservé aux invités, y compris la lecture, l'import dans Manger! sans compte et le signalement. Ces routes s'ouvrent à tous avec le public.
- **Photos** : stockées sur disque dans le répertoire de données, incluses dans la sauvegarde et la restauration. Elles ne sont pas copiées dans Manger! en première version (Manger! n'a pas de champ photo).
- **Déploiement** : images de conteneur publiées sur le registre Codeberg de LION_LAB ; la commande de mise à jour récupère l'image. Caddy est ajouté au Compose pour le HTTPS (obligatoire pour les clés d'accès), désactivable si le serveur a déjà un proxy.
- **Saisons** : liste fixe (printemps, été, automne, hiver), plusieurs possibles. **Univers** : liste fermée gérée par les administrateurs, valeurs initiales à reprendre de Manger! si le concept y existe.

## 14. Laissé au constructeur

Rangées exactes de la vitrine, mécanisme technique d'import sans compte, fréquence de vérification des mises à jour, client PostgreSQL, structure interne du code, apparence visuelle.
