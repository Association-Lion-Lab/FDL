#!/usr/bin/env bash
# Met à jour FDL : sauvegarde, nouvelle image, vérification, retour arrière si échec.
# À lancer depuis le dossier du dépôt (celui de compose.yaml).
set -euo pipefail

ROLLBACK_TAG=codeberg.org/lion_lab/fdl:rollback

if [ -z "$(docker compose ps -q --status running app)" ]; then
  echo "Le conteneur app ne tourne pas : démarrez-le (docker compose up -d) avant de mettre à jour." >&2
  exit 1
fi

# Interroge /ready depuis le conteneur pendant 60 s au plus.
wait_ready() {
  for _ in $(seq 1 30); do
    if docker compose exec -T app node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/ready').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" 2>/dev/null; then
      return 0
    fi
    sleep 2
  done
  return 1
}

echo "Sauvegarde avant mise à jour..."
backup_output=$(docker compose exec -T app npm run backup -- /data/backups)
echo "$backup_output"
backup_path=$(echo "$backup_output" | tail -n 1)

# Mémorise l'image en cours pour pouvoir y revenir.
current_id=$(docker inspect --format '{{.Image}}' "$(docker compose ps -q app)")
docker tag "$current_id" "$ROLLBACK_TAG"

echo "Téléchargement et démarrage de la nouvelle image..."
docker compose pull app
docker compose up -d app

if [ "$(docker inspect --format '{{.Image}}' "$(docker compose ps -q app)")" = "$current_id" ]; then
  echo "Aucune nouvelle image : rien à mettre à jour."
  exit 0
fi

echo "Vérification de /ready (60 s maximum)..."
if wait_ready; then
  echo "Mise à jour réussie."
  exit 0
fi

echo "Échec : la nouvelle version ne répond pas. Retour à l'image précédente..." >&2
FDL_IMAGE=$ROLLBACK_TAG docker compose up -d app
if wait_ready; then
  echo "La version précédente tourne de nouveau. La mise à jour est annulée. Voir : docker compose logs app" >&2
else
  echo "La version précédente ne démarre pas non plus : le schéma de la base est probablement plus récent qu'elle." >&2
  echo "La sauvegarde faite avant la mise à jour est dans le volume : $backup_path" >&2
  echo "Copiez-la d'abord hors du volume (ne lancez pas docker compose down -v) :" >&2
  echo "  mkdir -p sauvegardes && docker cp \"$(docker compose ps -aq app)\":$backup_path ./sauvegardes/" >&2
  echo "Puis suivez docs/EXPLOITATION.md, section « Après un échec de mise à jour »." >&2
fi
exit 1
