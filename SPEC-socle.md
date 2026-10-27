# Spécification : `socle`

Statut : brouillon soumis à validation.

## Objectif

Fournir une base locale, testable et récupérable sur laquelle les autres capacités de FDL pourront s’appuyer sans réécrire la configuration, le stockage ou les conventions HTTP.

Cette capacité s’adresse d’abord aux personnes qui développent et exploitent FDL. Elle ne crée encore aucun compte, catalogue, formulaire de contribution ou connexion avec Manger!.

Le socle est terminé lorsqu’une instance de test peut démarrer avec une configuration valide, créer ou ouvrir son stockage, répondre aux contrôles de santé, être sauvegardée puis restaurée sans perte, et refuser proprement une configuration ou un stockage invalide.

## Hypothèses soumises à validation

1. La bêta fonctionne sur une seule instance du service.
2. Node.js 22 ou plus récent reste la plateforme minimale.
3. SQLite est utilisé pour la première bêta, avec réexamen uniquement si les mesures de charge le justifient.
4. Les fichiers persistants sont placés dans un répertoire configurable distinct du code.
5. Aucune donnée réelle ni aucun accès au serveur Ubuntu personnel n’est utilisé pour valider ce module.

## Périmètre

Inclus :

- configuration de démarrage et validation de ses valeurs ;
- conventions HTTP et format stable des erreurs ;
- création, ouverture et versionnement du stockage ;
- sauvegarde cohérente et restauration vérifiée ;
- contrôles de vie et de disponibilité ;
- documentation des commandes et limites mesurées.

Exclus : comptes, invitations, recettes, photos, e-mails, interface web, HTTPS public, Docker, déploiement et modification de Manger!.

## Pile technique

- JavaScript en modules ES ;
- Node.js `>=22` ;
- API standard de Node privilégiées ;
- `node:test` et `node:assert` pour les tests ;
- SQLite proposé comme stockage de bêta ; bibliothèque d’accès à choisir avant l’implémentation du stockage.

Aucune dépendance n’est ajoutée sans besoin démontré et revue préalable.

## Commandes

```powershell
npm start
npm test
node --check src/server.js
```

Les futures commandes de sauvegarde, restauration et migration devront être exposées par des scripts `npm` documentés. Leur nom exact sera fixé dans le plan technique ; cette spécification ne prétend pas qu’elles existent déjà.

## Structure du projet

```text
src/                 serveur et futurs modules applicatifs
tests/               tests unitaires et d’intégration Node
scripts/             futures commandes d’exploitation
docs/                architecture, contrats et exploitation
CAPABILITIES.md       carte approuvée des capacités
SPEC-socle.md         présente spécification
tasks/                futur plan et tâches approuvés
```

Les données d’exécution, sauvegardes, secrets et journaux ne vivent jamais dans le dépôt Git.

## Style de code

Privilégier des fonctions courtes, des valeurs explicites et les API standard. Une fonction valide ses entrées avant tout effet de bord :

```js
export function parsePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT doit être un entier compris entre 1 et 65535.');
  }
  return port;
}
```

Conventions : noms anglais dans le code, messages destinés aux utilisateurs en français, deux espaces, points-virgules et aucune abstraction créée pour un seul appel.

## Contrats du socle

### Configuration

Une configuration invalide arrête le processus avant l’ouverture du port. Les chemins sont résolus explicitement ; un répertoire manquant peut être créé seulement à l’intérieur du répertoire de données configuré. Aucun secret n’est accepté dans une URL ou journalisé.

### Santé

- `GET /health` indique uniquement que le processus HTTP répond.
- Un futur contrôle de disponibilité vérifie séparément que le stockage est ouvrable.
- Aucun contrôle ne révèle chemin local, version détaillée, secret ou donnée personnelle.

### Erreurs

Les erreurs JSON suivent le contrat défini dans `docs/CONTRATS.md`. Une erreur interne reçoit un identifiant de corrélation et un message public générique ; sa trace complète reste hors de la réponse HTTP.

### Stockage et sauvegarde

Le stockage possède un numéro de schéma explicite. Une migration est transactionnelle et testée depuis chaque version réellement publiée. Une sauvegarde contient tous les fichiers nécessaires à la restauration d’une instance, mais aucun fichier temporaire.

La restauration est validée sur un répertoire neuf et isolé. Une archive incomplète, incompatible ou corrompue est refusée sans modifier l’instance cible.

## Stratégie de tests

- tests unitaires pour la configuration, les chemins et les erreurs ;
- tests d’intégration sur une base et un répertoire temporaires par test ;
- test HTTP réel uniquement sur `127.0.0.1` et un port éphémère ;
- test de restauration comparant schéma et contenu avant/après ;
- aucun test ne dépend du réseau, de Codeberg, de Manger! ou du serveur Ubuntu.

Chaque nouveau comportement commence par un test en échec. `npm test` doit réussir sans test ignoré avant chaque commit.

## Limites de bêta à démontrer

Les objectifs initiaux restent ceux de `docs/CONTRATS.md` : 100 comptes, 5 000 recettes publiées, 10 lectures simultanées et 95 % des lectures sous 500 ms sur l’instance de test retenue.

Le socle doit fournir les moyens de mesurer ces limites, sans implémenter artificiellement les capacités métier correspondantes. Un changement de base de données exige d’abord une mesure montrant que SQLite ne satisfait pas le besoin.

## Frontières de travail

### Toujours faire

- valider les entrées avant tout effet de bord ;
- écrire le test avant le comportement ;
- garder les données de test isolées et jetables ;
- documenter toute nouvelle commande d’exploitation ;
- vérifier qu’aucun secret ou fichier persistant n’entre dans Git.

### Demander avant

- ajouter une dépendance ;
- choisir ou changer la bibliothèque SQLite ;
- modifier un contrat HTTP déjà consommé ;
- modifier le schéma après sa première utilisation réelle ;
- publier, déployer ou accéder à une machine distante.

### Ne jamais faire

- accéder au serveur Ubuntu personnel sans autorisation explicite ;
- modifier Manger! pendant le travail sur `socle` ;
- réutiliser les comptes ou données privées d’un foyer ;
- ajouter le scan PDF/photo à FDL ;
- commettre secrets, données réelles, bases ou sauvegardes.

## Critères de réussite

1. Une configuration valide démarre ; chaque valeur invalide testée échoue avant l’écoute réseau.
2. Les contrôles de santé respectent leur contrat et ne divulguent aucune donnée sensible.
3. Une instance neuve obtient le schéma attendu ; une version incompatible est refusée clairement.
4. Une sauvegarde est restaurée sur une instance vierge avec schéma et contenu identiques.
5. Tests, vérification syntaxique et contrôle du diff réussissent sur un environnement local isolé.

## Questions ouvertes

1. Confirmer SQLite pour la bêta.
2. Choisir la bibliothèque SQLite seulement après comparaison de la compatibilité Node.js, de la maintenance et des besoins de sauvegarde.
3. Décider si Docker appartient encore au `socle` ou uniquement à la préparation de la bêta.
4. Fixer le format de sauvegarde après définition des futurs fichiers d’images.
5. Fixer l’identité de l’opérateur avant toute donnée réelle, sans bloquer les tests locaux fictifs.
