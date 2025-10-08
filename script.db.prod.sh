echo "Make sure you have updated .env for DATABASE_URL to point to 'production' branch"
read -p "[RETURN] to continue" nothing
npm -w apps/api run prisma:generate
npm -w apps/api run prisma:migrate:deploy