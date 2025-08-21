import "dotenv/config";

export default {
  expo: {
    name: "SeedlingsMobile",
    slug: "seedlings-mobile",
    scheme: "seddlings",
    version: "1.0.0",
    orientation: "portrait",
    sdkVersion: "51.0.0",
    platforms: ["ios", "android"],
    updates: { enabled: false },
    ios: { supportsTablet: true },
    android: {
      adaptiveIcon: {
        foregroundImage: "./assets/adaptive-icon.png",
        backgroundColor: "#ffffff",
      },
    },
    web: { bundler: "metro" },
    icon: "./assets/icon.png",
    extra: {
      EXPO_PUBLIC_API_BASE_URL: process.env.EXPO_PUBLIC_API_BASE_URL,
    },
  },
};
