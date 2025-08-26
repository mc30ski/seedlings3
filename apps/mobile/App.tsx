import React, { useState } from "react";
import { Linking } from "react-native";
import {
  Provider as PaperProvider,
  MD3LightTheme,
  Button,
  Text,
} from "react-native-paper";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { tokens } from "@repo/tokens";

const API_BASE =
  process.env.EXPO_PUBLIC_API_BASE_URL || "http://localhost:8080";

export default function App() {
  const [loading, setLoading] = useState(false);

  const callApi = async () => {
    try {
      setLoading(true);
      const res = await fetch(`${API_BASE}/hello`, { cache: "no-store" });
      const data = await res.json();
      alert(JSON.stringify(data));
    } finally {
      setLoading(false);
    }
  };

  const theme = {
    ...MD3LightTheme,
    roundness: 16,
    colors: {
      ...MD3LightTheme.colors,
      primary: tokens.colors.brand[600],
      primaryContainer: tokens.colors.brand[100],
    },
  };

  return (
    <SafeAreaProvider>
      <PaperProvider theme={theme}>
        <SafeAreaView style={{ flex: 1, backgroundColor: "#fff" }}>
          <Text
            style={{
              fontSize: 22,
              fontWeight: "700",
              marginTop: 24,
              marginHorizontal: 16,
            }}
          >
            Hello World (Mobile)
          </Text>
          <Text
            style={{ color: "#4b5563", marginTop: 8, marginHorizontal: 16 }}
          >
            Matches the web’s primary actions.
          </Text>
          <SafeAreaView
            style={{
              flexDirection: "row",
              gap: 12,
              marginTop: 24,
              marginHorizontal: 16,
              maxWidth: 640,
              alignSelf: "center",
            }}
          >
            <Button mode="contained" onPress={callApi} loading={loading}>
              {loading ? "Calling…" : "Call API"}
            </Button>
            <Button
              mode="outlined"
              onPress={() =>
                Linking.openURL("https://seedlings3-web.vercel.app")
              }
            >
              Open Site
            </Button>
          </SafeAreaView>
        </SafeAreaView>
      </PaperProvider>
    </SafeAreaProvider>
  );
}
