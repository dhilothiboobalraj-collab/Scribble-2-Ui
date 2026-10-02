import { createOpenAI } from "@ai-sdk/openai";
import { streamText, type ModelMessage } from "ai";

const RUN = "X-Lovable-AIG-Run-ID";

const THEMES: Record<string, string> = {
  minimalist: "Minimalist: generous whitespace, neutral palette, thin borders, elegant sans-serif type.",
  glassmorphism: "Glassmorphism: vivid gradient backdrop, frosted translucent cards (backdrop-blur, white/10 fills), soft glows.",
  neubrutalism: "Neubrutalism: bold flat colors, thick black 3px borders, hard offset shadows, chunky type.",
  corporate: "Corporate: trustworthy blue/slate palette, structured grid, crisp cards, professional tone.",
};

export async function handleGenerate(request: Request) {
  const apiKey = process.env.LOVABLE_API_KEY;
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
  const theme = THEMES[body.theme ?? ""] ?? THEMES.minimalist;

  let runId = request.headers.get(RUN) ?? undefined;
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

  const content: Array<{ type: "text"; text: string } | { type: "image"; image: string }> = [];
  const instr = [
    image
      ? "Convert the attached hand-drawn UI sketch into a real webpage. Detect every element (nav, hero, cards, sidebars, buttons, inputs, text labels) and preserve its layout positions and reading order. Replace X-boxes with real-looking image placeholders from https://picsum.photos with seeds."
      : "Design a complete webpage from the description.",
    prompt.trim() ? `Description / extra instructions: ${prompt}` : "",
    `Visual theme: ${theme}`,
  ].filter(Boolean).join("\n\n");
  content.push({ type: "text", text: instr });
  if (image) content.push({ type: "image", image });

  const result = streamText({
    model: provider.responses("openai/gpt-6-astra"),
    system:
      "You are Scribble2UI, an expert front-end engineer. Output ONLY one complete, standalone, responsive HTML5 document using Tailwind via <script src=\"https://cdn.tailwindcss.com\"></script>. Use semantic HTML, realistic copy, accessible contrast, and mobile-friendly layout. No markdown fences, no explanation.",
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

  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(c) {
      try {
        for await (const part of result.fullStream) {
          if (part.type === "text-delta") c.enqueue(enc.encode(part.text));
          if (part.type === "error") {
            const e = part.error as { statusCode?: number; message?: string };
            c.enqueue(enc.encode(`\n<!--S2U_ERROR:${e?.statusCode === 402 ? "AI credits are used up. Add credits in workspace billing." : e?.statusCode === 429 ? "Too many requests, please wait a moment." : (e?.message ?? "Generation failed.")}-->`));
          }
        }
      } catch (e) {
        if (!request.signal.aborted) c.enqueue(enc.encode(`\n<!--S2U_ERROR:${(e as Error).message}-->`));
      }
      c.close();
    },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache, no-transform" },
  });
}
