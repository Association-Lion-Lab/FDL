# Architecture initiale

Statut : cadrage de la première bêta, à confirmer tranche par tranche.

## Frontières

FDL est un service autonome. Il possède ses propres comptes, invitations, recettes publiées et décisions de modération. Il ne lit pas les comptes, recettes privées, calendriers, goûts, allergies, placards ou courses d’un foyer Manger!.

L’intégration future fonctionne uniquement dans ce sens : le serveur Manger! effectue une requête HTTPS sortante vers FDL, montre un aperçu, puis enregistre une copie privée. FDL ne se connecte jamais au serveur privé du foyer. Une panne ou un retrait de FDL ne doit pas casser les copies déjà importées.

Le futur service de scan PDF/photo est un autre projet. Aucun OCR, PDF, scan de livre ou collecte automatique de sites n’entre dans FDL.

## Forme du service

Le socle utilise un seul processus Node.js et les API standard de Node. Aucune dépendance, base de données ou interface web n’est ajoutée tant qu’une capacité ne l’exige pas.

Modules prévus :

1. **Accès** — invitations, comptes, sessions, rôles et révocation.
2. **Catalogue** — recettes publiées, versions, recherche et pagination.
3. **Contributions** — brouillons appartenant à leur auteur et soumissions volontaires.
4. **Modération** — examen, signalements, publication, retrait et historique.
5. **Connexion Manger!** — lecture autorisée et import d’une version identifiée, sans synchronisation.

Chaque contrôle d’accès devra être appliqué côté serveur. Les brouillons ne devront jamais être exposés par le catalogue, même avec leur identifiant direct.

## État actuel

Le serveur expose uniquement `GET /health`. Il ne charge aucune donnée et ne révèle ni configuration, ni version, ni information personnelle. Le port est validé avant l’écoute ; une valeur hors de `1..65535` arrête le démarrage.

Le stockage, les comptes, les photos, HTTPS, Docker et l’hébergement restent hors de cette première tranche. SQLite reste une option de bêta, pas une décision déjà implémentée.
