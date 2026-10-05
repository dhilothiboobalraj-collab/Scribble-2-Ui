// Server-only Google Gemini client (raw fetch, works on any serverless host).
export const GEMINI_MODEL = "gemini-2.5-flash";

export type Part = { type: "text"; text: string } | { type: "image"; image: string };

export class GeminiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function friendlyGeminiError(e: unknown): { status: number; message: string } {
  if (e instanceof GeminiError) {
    if (e.status === 400) return { status: 400, message: `Gemini rejected the request: ${e.message}` };
    if (e.status === 401 || e.status === 403)
      return { status: e.status, message: "The Gemini API key is invalid or lacks access. Check GEMINI_API_KEY." };
    if (e.status === 429) return { status: 429, message: "Gemini rate limit or quota reached — please wait and try again." };
    if (e.status >= 500) return { status: 502, message: "Gemini is temporarily unavailable. Please try again." };
    return { status: e.status, message: e.message };
  }
  return { status: 500, message: (e as Error)?.message || "AI request failed." };
}

function toGeminiParts(parts: Part[]) {
  return parts.map((p) => {
    if (p.type === "text") return { text: p.text };
    const m = p.image.match(/^data:([^;]+);base64,(.*)$/);
    if (!m) throw new GeminiError(400, "Invalid image data.");
    return { inline_data: { mime_type: m[1], data: m[2] } };
  });
}

/** Streams text chunks from Gemini via SSE. */
export async function* streamGemini(opts: {
  system: string;
  parts: Part[];
  signal?: AbortSignal;
  json?: boolean;
}): AsyncGenerator<string> {
  const apiKey = process.env["GEMINI_API_KEY"];
  if (!apiKey) throw new GeminiError(500, "GEMINI_API_KEY is not configured on the server.");

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:streamGenerateContent?alt=sse`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      signal: opts.signal ?? null,
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: opts.system }] },
        contents: [{ role: "user", parts: toGeminiParts(opts.parts) }],
        generationConfig: opts.json ? { responseMimeType: "application/json" } : {},
      }),
    },
  );
  if (!res.ok || !res.body) {
    let msg = res.statusText;
    try {
      msg = ((await res.json()) as { error?: { message?: string } }).error?.message ?? msg;
    } catch {
      /* keep statusText */
    }
    throw new GeminiError(res.status, msg);
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line.startsWith("data:")) continue;
      const evt = JSON.parse(line.slice(5)) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> }; finishReason?: string }>;
        promptFeedback?: { blockReason?: string };
        error?: { code?: number; message?: string };
      };
      if (evt.error) throw new GeminiError(evt.error.code ?? 500, evt.error.message ?? "Gemini error");
      if (evt.promptFeedback?.blockReason)
        throw new GeminiError(400, `Request blocked by Gemini safety filters (${evt.promptFeedback.blockReason}).`);
      const c = evt.candidates?.[0];
      for (const p of c?.content?.parts ?? []) if (p.text) yield p.text;
      if (c?.finishReason === "SAFETY") throw new GeminiError(400, "Response blocked by Gemini safety filters.");
    }
  }
}
