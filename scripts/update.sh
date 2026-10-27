#!/usr/bin/env bash
# Met à jour FDL : sauvegarde, nouvelle image, vérification, retour arrière si échec.
# À lancer depuis le dossier du dépôt (celui de compose.yaml).
set -euo pipefail

ROLLBACK_TAG=codeberg.org/lion_lab/fdl:rollback

echo "Sauvegarde avant mise à jour..."
docker compose exec -T app npm run backup -- /data/backups

# Mémorise l'image en cours pour pouvoir y revenir.
current_id=$(docker inspect --format '{{.Image}}' "$(docker compose ps -q app)")
docker tag "$current_id" "$ROLLBACK_TAG"

echo "Téléchargement et démarrage de la nouvelle image..."
docker compose pull app
docker compose up -d app

echo "Vérification de /ready (60 s maximum)..."
for _ in $(seq 1 30); do
  if docker compose exec -T app node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/ready').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" 2>/dev/null; then
    echo "Mise à jour réussie."
    exit 0
  fi
  sleep 2
done

echo "Échec : la nouvelle version ne répond pas. Retour à l'image précédente..." >&2
FDL_IMAGE=$ROLLBACK_TAG docker compose up -d app
echo "Mise à jour annulée. La base n'a pas été modifiée (les migrations sont atomiques). Voir : docker compose logs app" >&2
exit 1
