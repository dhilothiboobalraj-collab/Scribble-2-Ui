import samples from "@/data/samples.json";
import { streamGemini, friendlyGeminiError, type Part } from "./gemini.server";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

export async function handleMatch(request: Request) {
  if (!process.env["GEMINI_API_KEY"]) return json({ error: "GEMINI_API_KEY is not configured on the server." }, 500);

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

  const catalog = samples.sketches.map((s) => `S${s.id} | ${s.store} | ${s.caption}`).join("\n");
  const content: Part[] = [
    {
      type: "text",
      text: `CATALOG of ${samples.sketches.length} hand-drawn webpage sketches (id | store | caption describing layout):\n${catalog}\n\nUSER INPUT:\n${prompt.trim() ? `Description: ${prompt}` : "(no description)"}${image ? "\nA sketch/screenshot is attached below. Analyze its layout (header, sidebar, hero, grid columns, banners, labels) and store type." : ""}\n\nPick the 3 catalog entries that match the input most closely, best first. Weigh layout structure AND store/business type. Reply with ONLY JSON: {"analysis":"one sentence describing what you see/understand in the input","matches":[{"id":"S001","confidence":0-100,"reason":"short reason"}]}`,
    },
  ];
  if (image) content.push({ type: "image", image });

  try {
    let text = "";
    for await (const t of streamGemini({
      system: "You are a precise UI-layout matching engine. Output strict JSON only.",
      parts: content,
      signal: request.signal,
      json: true,
    }))
      text += t;
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
    if (e instanceof SyntaxError) return json({ error: "The AI returned an unreadable answer. Please try again." }, 502);
    console.error(e);
    const f = friendlyGeminiError(e);
    return json({ error: f.message }, f.status);
  }
}
