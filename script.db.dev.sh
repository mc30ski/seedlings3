set -a
source apps/api/.env
set +a
echo Using Database: $DATABASE_URL
read -p "DB Migration Name: " migration_name
npm -w apps/api run prisma:migrate:dev -- --name $migration_name
npm -w apps/api run prisma:generate
