import { createOpenAI } from "@ai-sdk/openai";
import { streamText, type ModelMessage } from "ai";
import samples from "@/data/samples.json";

const RUN = "X-Lovable-AIG-Run-ID";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

export async function handleMatch(request: Request) {
  const apiKey = process.env["LOVABLE_API_KEY"];
  if (!apiKey) return json({ error: "AI is not configured on the server." }, 500);

  let body: { prompt?: unknown; image?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid request body." }, 400);
  }
  const prompt = typeof body.prompt === "string" ? body.prompt.slice(0, 4000) : "";
  const image =
    typeof body.image === "string" && /^data:image\/(png|jpe?g|webp|gif);base64,/.test(body.image)
      ? body.image
      : undefined;
  if (typeof body.image === "string" && !image) return json({ error: "Unsupported image format." }, 400);
  if (image && image.length > 11_000_000) return json({ error: "Image is too large (max 8 MB)." }, 413);
  if (!prompt.trim() && !image) return json({ error: "Upload a sketch or enter a description." }, 400);

  let runId: string | undefined;
  const runFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const h = new Headers(init?.headers);
    if (runId && !h.has(RUN)) h.set(RUN, runId);
    const r = await fetch(input, { ...init, headers: h });
    runId ??= r.headers.get(RUN) ?? undefined;
    return r;
  };
  const provider = createOpenAI({
    baseURL: "https://ai.gateway.lovable.dev/v1",
    apiKey,
    headers: { "Lovable-API-Key": apiKey, "X-Lovable-AIG-SDK": "vercel-ai-sdk" },
    fetch: runFetch,
  });

  const catalog = samples.sketches.map((s) => `S${s.id} | ${s.store} | ${s.caption}`).join("\n");
  const content: Array<{ type: "text"; text: string } | { type: "image"; image: string }> = [
    {
      type: "text",
      text: `CATALOG of ${samples.sketches.length} hand-drawn webpage sketches (id | store | caption describing layout):\n${catalog}\n\nUSER INPUT:\n${prompt.trim() ? `Description: ${prompt}` : "(no description)"}${image ? "\nA sketch/screenshot is attached below. Analyze its layout (header, sidebar, hero, grid columns, banners, labels) and store type." : ""}\n\nPick the 3 catalog entries that match the input most closely, best first. Weigh layout structure AND store/business type. Reply with ONLY JSON: {"analysis":"one sentence describing what you see/understand in the input","matches":[{"id":"S001","confidence":0-100,"reason":"short reason"}]}`,
    },
  ];
  if (image) content.push({ type: "image", image });

  try {
    const result = streamText({
      model: provider.responses("openai/gpt-6-astra"),
      system: "You are a precise UI-layout matching engine. Output strict JSON only.",
      messages: [{ role: "user", content } as ModelMessage],
      abortSignal: request.signal,
      maxRetries: 0,
      providerOptions: {
        openai: {
          forceReasoning: true,
          reasoningEffort: "low",
          reasoningSummary: "auto",
          store: false,
          include: ["reasoning.encrypted_content"],
        },
      },
    });
    let text = "";
    for await (const part of result.fullStream) {
      if (part.type === "text-delta") text += part.text;
      if (part.type === "error") throw part.error;
    }
    const raw = text.match(/\{[\s\S]*\}/)?.[0];
    if (!raw) return json({ error: "The AI did not return a match. Please try again." }, 502);
    const parsed = JSON.parse(raw) as {
      analysis?: string;
      matches?: Array<{ id?: string; confidence?: number; reason?: string }>;
    };
    const matches = (parsed.matches ?? [])
      .map((m) => {
        const id = String(m.id ?? "").replace(/^S/i, "").padStart(3, "0");
        const s = samples.sketches.find((x) => x.id === id);
        if (!s) return null;
        return {
          id: s.id,
          store: s.store,
          caption: s.caption,
          image: `/sketches/sketch_${s.id}.png`,
          confidence: Math.max(0, Math.min(100, Math.round(Number(m.confidence) || 0))),
          reason: String(m.reason ?? "").slice(0, 300),
        };
      })
      .filter(Boolean)
      .slice(0, 3);
    if (!matches.length) return json({ error: "No valid match found in the dataset." }, 502);
    return json({ analysis: String(parsed.analysis ?? ""), matches });
  } catch (e) {
    if (request.signal.aborted) return json({ error: "Cancelled." }, 499);
    const err = e as { statusCode?: number; message?: string };
    const status = err?.statusCode;
    if (status === 402) return json({ error: "AI credits are used up. Add credits in workspace billing." }, 402);
    if (status === 429) return json({ error: "Too many requests — please wait a moment and try again." }, 429);
    if (status === 403) return json({ error: err.message ?? "AI access denied." }, 403);
    if (e instanceof SyntaxError) return json({ error: "The AI returned an unreadable answer. Please try again." }, 502);
    console.error(e);
    return json({ error: "Matching failed. Please try again." }, 500);
  }
}
