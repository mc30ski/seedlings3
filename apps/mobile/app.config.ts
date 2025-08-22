import "dotenv/config";

const API_BASE =
  process.env.EXPO_PUBLIC_API_BASE_URL ??
  "https://seedlings3-jbki6dumwq-ue.a.run.app";
const EAS_PROJECT_ID = "aea6c4d7-a97e-4ab4-9341-2e02d6a7d8c5";

export default {
  expo: {
    name: "seedlings3-mobile",
    slug: "seedlings3-mobile",
    owner: "mc30ski",
    scheme: "seddlings",
    version: "1.0.0",
    orientation: "portrait",
    sdkVersion: "51.0.0",
    platforms: ["ios", "android"],
    updates: {
      url: `https://u.expo.dev/${EAS_PROJECT_ID}`,
    },
    ios: {
      supportsTablet: true,
      bundleIdentifier: "com.seedlings.seedlings3",
      infoPlist: {
        ITSAppUsesNonExemptEncryption: false,
      },
    },
    android: {
      package: "com.seedlings.seedlings3",
      adaptiveIcon: {
        foregroundImage: "./assets/adaptive-icon.png",
        backgroundColor: "#ffffff",
      },
    },
    web: { bundler: "metro" },
    icon: "./assets/icon.png",
    extra: {
      EXPO_PUBLIC_API_BASE_URL: API_BASE,
      eas: { projectId: EAS_PROJECT_ID },
    },
  },
};
