import React, { useEffect, useState } from "react";
import { View } from "react-native";
import { Button, Card, Text, ActivityIndicator } from "react-native-paper";
import { apiGet, apiPost } from "../lib/api";

type Equipment = {
  id: string;
  shortDesc: string;
  longDesc: string;
  status: string;
};

export default function AvailableScreen() {
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState<Equipment[]>([]);

  async function refresh() {
    setLoading(true);
    try {
      setItems(await apiGet("/api/v1/equipment/available"));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    refresh();
  }, []);

  async function claim(id: string) {
    await apiPost(`/api/v1/equipment/${id}/claim`);
    refresh();
  }

  if (loading) return <ActivityIndicator style={{ marginTop: 24 }} />;

  return (
    <View style={{ padding: 16 }}>
      {items.map((e) => (
        <Card key={e.id} style={{ marginBottom: 12 }}>
          <Card.Title title={e.shortDesc} subtitle={e.longDesc} />
          <Card.Actions>
            <Button onPress={() => claim(e.id)}>Claim</Button>
          </Card.Actions>
        </Card>
      ))}
      {items.length === 0 && <Text>No equipment available.</Text>}
    </View>
  );
}
