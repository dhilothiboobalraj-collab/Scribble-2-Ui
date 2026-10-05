import { createOpenAI } from "@ai-sdk/openai";
import { streamText, type ModelMessage } from "ai";
import samples from "@/data/samples.json";

const RUN = "X-Lovable-AIG-Run-ID";

const THEMES: Record<string, string> = {
  minimalist: "Minimalist: generous whitespace, neutral palette, thin borders, elegant sans-serif type.",
  glassmorphism: "Glassmorphism: vivid gradient backdrop, frosted translucent cards (backdrop-blur, white/10 fills), soft glows.",
  neubrutalism: "Neubrutalism: bold flat colors, thick black 3px borders, hard offset shadows, chunky type.",
  corporate: "Corporate: trustworthy blue/slate palette, structured grid, crisp cards, professional tone.",
};

export async function handleGenerate(request: Request) {
  const apiKey = process.env["LOVABLE_API_KEY"];
  if (!apiKey) return new Response("AI is not configured.", { status: 500 });
  let body: { prompt?: string; image?: string; theme?: string };
  try {
    body = await request.json();
  } catch {
    return new Response("Invalid request.", { status: 400 });
  }
  const prompt = (body.prompt ?? "").slice(0, 4000);
  const image = typeof body.image === "string" && body.image.startsWith("data:image/") ? body.image : undefined;
  if (!prompt.trim() && !image) return new Response("Add a sketch or a description.", { status: 400 });
  const theme = THEMES[body.theme ?? ""] ?? THEMES["minimalist"];

  // Retrieve the closest training examples from the dataset (sketch+caption pairs and shop prompts).
  const refs = retrieve(prompt);
  const content: Part[] = [];
  const exampleText = [
    "REFERENCE DATASET EXAMPLES (learn how sketch annotations map to page structure; do not copy them verbatim):",
    ...refs.sketches.map((s) => `- Sketch #${s.id} (${s.store}): ${s.caption}`),
    ...refs.prompts.map((p) => `- Shop brief #${p.id}: ${p.prompt}`),
  ].join("\n");
  content.push({ type: "text", text: exampleText });
  const top = refs.sketches[0];
  if (top) {
    try {
      const r = await fetch(new URL(`/sketches/sketch_${top.id}.png`, request.url));
      if (r.ok) {
        const b64 = Buffer.from(await r.arrayBuffer()).toString("base64");
        content.push({ type: "text", text: `Example sketch #${top.id} image paired with its caption above:` });
        content.push({ type: "image", image: `data:image/png;base64,${b64}` });
      }
    } catch {
      /* example image is optional */
    }
  }
  const instr = [
    image
      ? "NOW THE USER'S INPUT. Convert the attached hand-drawn UI sketch into a real webpage. Detect every element (nav, hero, cards, sidebars, buttons, inputs, text labels) and preserve its layout positions and reading order. Replace X-boxes with real-looking image placeholders from https://picsum.photos with seeds."
      : "NOW THE USER'S INPUT. Design a complete webpage from the description.",
    prompt.trim() ? `Description / extra instructions: ${prompt}` : "",
    `Visual theme: ${theme}`,
  ].filter(Boolean).join("\n\n");
  content.push({ type: "text", text: instr });
  if (image) content.push({ type: "image", image });

  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(c) {
      try {
        for await (const t of streamGemini({
          system:
            "You are Scribble2UI, an expert front-end engineer. Output ONLY one complete, standalone, responsive HTML5 document using Tailwind via <script src=\"https://cdn.tailwindcss.com\"></script>. Use semantic HTML, realistic copy, accessible contrast, and mobile-friendly layout. No markdown fences, no explanation.",
          parts: content,
          signal: request.signal,
        }))
          c.enqueue(enc.encode(t));
      } catch (e) {
        if (!request.signal.aborted) c.enqueue(enc.encode(`\n<!--S2U_ERROR:${friendlyGeminiError(e).message}-->`));
      }
      c.close();
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-S2U-Refs": [...refs.sketches.map((s) => `sketch#${s.id}`), ...refs.prompts.map((p) => `brief#${p.id}`)].join(","),
    },
  });
}

const STOP = new Set("a an the and or for with of to in on at by is it be as make keep use using that this from into your clear simple".split(" "));
const tokens = (s: string) => s.toLowerCase().match(/[a-z]{3,}/g)?.filter((w) => !STOP.has(w)) ?? [];

function retrieve(query: string) {
  const q = new Set(tokens(query));
  const score = (t: string) => {
    if (!q.size) return Math.random();
    let n = 0;
    for (const w of tokens(t)) if (q.has(w)) n++;
    return n;
  };
  const sketches = samples.sketches
    .map((s) => ({ s, v: score(`${s.store} ${s.caption}`) }))
    .sort((a, b) => b.v - a.v)
    .slice(0, 3)
    .map((x) => x.s);
  const prompts = samples.prompts
    .map((p) => ({ p, v: score(p.prompt) }))
    .sort((a, b) => b.v - a.v)
    .slice(0, 3)
    .map((x) => x.p);
  return { sketches, prompts };
}
