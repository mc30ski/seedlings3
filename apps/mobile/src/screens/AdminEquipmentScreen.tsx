import React, { useEffect, useState } from "react";
import { View } from "react-native";
import { Button, Card, TextInput, Text, Chip } from "react-native-paper";
import { apiDelete, apiGet, apiPost } from "../lib/api";

// implement apiDelete in your lib similarly to web

type Equipment = {
  id: string;
  shortDesc: string;
  longDesc: string;
  status: string;
};

export default function AdminEquipmentScreen() {
  const [items, setItems] = useState<Equipment[]>([]);
  const [shortDesc, setShort] = useState("");
  const [longDesc, setLong] = useState("");

  async function refresh() {
    setItems(await apiGet("/api/equipment"));
  }
  useEffect(() => {
    refresh();
  }, []);

  async function create() {
    await apiPost("/api/equipment", { shortDesc, longDesc });
    setShort("");
    setLong("");
    refresh();
  }
  async function retire(id: string) {
    await apiPost(`/api/equipment/${id}/retire`);
    refresh();
  }
  async function release(id: string) {
    await apiPost(`/api/equipment/${id}/release`);
    refresh();
  }
  async function del(id: string) {
    await apiDelete(`/api/equipment/${id}`);
    refresh();
  }

  return (
    <View style={{ padding: 16 }}>
      <TextInput
        label="Short"
        value={shortDesc}
        onChangeText={setShort}
        style={{ marginBottom: 8 }}
      />
      <TextInput
        label="Long"
        value={longDesc}
        onChangeText={setLong}
        style={{ marginBottom: 8 }}
      />
      <Button mode="contained" onPress={create} style={{ marginBottom: 16 }}>
        Add
      </Button>

      {items.map((e) => (
        <Card key={e.id} style={{ marginBottom: 12 }}>
          <Card.Title
            title={`${e.shortDesc}`}
            subtitle={e.longDesc}
            right={() => <Chip>{e.status}</Chip>}
          />
          <Card.Actions>
            <Button onPress={() => release(e.id)}>Release</Button>
            <Button onPress={() => retire(e.id)}>Retire</Button>
            <Button onPress={() => del(e.id)}>Delete</Button>
          </Card.Actions>
        </Card>
      ))}
    </View>
  );
}
