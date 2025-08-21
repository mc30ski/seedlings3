async function getApiHello() {
  const base = process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:8080';
  try { const res = await fetch(`${base}/hello`, { cache: 'no-store' }); if (!res.ok) throw new Error('failed'); const data = await res.json(); return data.message as string; } catch { return 'Unable to reach API'; }
}
export default async function Page() {
  const apiMsg = await getApiHello();
  return (
    <main className="flex items-center justify-center h-screen">
      <div className="rounded-xl border bg-white p-8 shadow-sm text-center space-y-4">
        <h1 className="text-3xl font-semibold">Hello World (Web)</h1>
        <p className="text-gray-600">API says: <span className="font-mono">{apiMsg}</span></p>
        <p className="text-xs text-gray-400">Edit <code>apps/web/app/page.tsx</code></p>
      </div>
    </main>
  );
}
