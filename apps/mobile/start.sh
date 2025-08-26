EXPO_PUBLIC_API_BASE_URL=$(cat .env.development | sed -n 's/^EXPO_PUBLIC_API_BASE_URL=//p') npx expo start -c --lan
