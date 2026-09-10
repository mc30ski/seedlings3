/** Build the REAL assessment prompt from a dev forecast and send it. */
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync } from "fs";
import { prisma } from "./src/db/prisma";

const env = readFileSync("./.env", "utf8");
const k = env.split("\n").find((l) => l.trim().startsWith("ANTHROPIC_API_KEY="))!;
const apiKey = k.slice(k.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "");

(async () => {
  // Re-run the route's own pipeline via its exported internals.
  const mod: any = await import("./src/routes/forecast");
  const fc = await prisma.forecast.findFirstOrThrow({ where: { name: "Summer" } });
  console.log(`forecast: ${fc.name} ${fc.windowFrom}..${fc.windowTo}`);

  // The prompt builder is module-private, so rebuild the same inputs and
  // call the model with a prompt of comparable size to prove/disprove
  // truncation. We reuse the service layer the route uses.
  const svc: any = await import("./src/services/forecast");
  const { baseline, backtest } = await svc.buildBaselineWithBacktest(fc.windowFrom, fc.windowTo);
  console.log(`baseline: ${baseline.jobs.length} jobs, ${baseline.workers?.length ?? "?"} workers`);

  const anthropic = new Anthropic({ apiKey });
  // Same max_tokens as the route.
  const bigPrompt = readFileSync("./src/routes/forecast.ts", "utf8");
  const prompt = `Here is a large context block:\n\n${bigPrompt.slice(0, 12000)}\n\nRespond with ONLY a JSON object: {"verdict":"strong","headline":"x","summary":"y","strengths":["a"],"concerns":["b"],"fairness":"c","recommendations":[{"action":"d","why":"e"}],"questionsToResolve":["f"]}`;
  const r = await anthropic.messages.create({
    model: "claude-sonnet-5",
    max_tokens: 4000,
    messages: [{ role: "user", content: prompt }],
  });
  const text = r.content.filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
  console.log(`stop_reason=${(r as any).stop_reason} output_tokens=${(r as any).usage.output_tokens} textLen=${text.length}`);
  console.log(`indexOf({)=${text.indexOf("{")} lastIndexOf(})=${text.lastIndexOf("}")}`);
  console.log("first 160:", JSON.stringify(text.slice(0, 160)));
  await prisma.$disconnect();
})().catch(async (e) => { console.error("ERROR:", e.message); await prisma.$disconnect(); });
