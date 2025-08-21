import React, { useEffect, useState } from 'react';
import { SafeAreaView, Text, View } from 'react-native';
import { StatusBar } from 'expo-status-bar';
export default function App() {
  const [apiMsg, setApiMsg] = useState('Loading...');
  useEffect(() => {
    const base = process.env.EXPO_PUBLIC_API_BASE_URL || 'http://localhost:8080';
    fetch(`${base}/hello`).then(async r => { if (!r.ok) throw new Error('fail'); const j = await r.json(); setApiMsg(j.message); }).catch(() => setApiMsg('Unable to reach API'));
  }, []);
  return (
    <SafeAreaView style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
      <View style={{ padding: 24, borderRadius: 16, backgroundColor: 'white', elevation: 3 }}>
        <Text style={{ fontSize: 24, fontWeight: '600', textAlign: 'center' }}>Hello World (Mobile)</Text>
        <Text style={{ marginTop: 8, color: '#555', textAlign: 'center' }}>API says: {apiMsg}</Text>
        <Text style={{ marginTop: 8, fontSize: 12, color: '#999', textAlign: 'center' }}>Edit apps/mobile/App.tsx</Text>
      </View>
      <StatusBar style="auto" />
    </SafeAreaView>
  );
}
