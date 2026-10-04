import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useRef, useState } from "react";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Scribble2UI — Sketch or describe, get a webpage" },
      { name: "description", content: "Upload a hand-drawn UI sketch or type a description and get a responsive, themed HTML page instantly." },
      { property: "og:title", content: "Scribble2UI — Sketch to webpage" },
      { property: "og:description", content: "Hand-drawn mockups and text prompts become editable, themed web pages." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary_large_image" },
    ],
  }),
  component: Index,
});

const THEMES = ["minimalist", "glassmorphism", "neubrutalism", "corporate"] as const;


function cleanHtml(raw: string) {
  let s = raw.replace(/<!--S2U_ERROR:[\s\S]*?-->/g, "").replace(/^```(?:html)?\s*/i, "").replace(/```\s*$/, "");
  const i = s.search(/<!doctype|<html/i);
  if (i > 0) s = s.slice(i);
  return s;
}

type MatchResult = {
  analysis: string;
  matches: Array<{ id: string; store: string; caption: string; image: string; confidence: number; reason: string }>;
};

function Index() {
  const [match, setMatch] = useState<MatchResult | null>(null);
  const [matchErr, setMatchErr] = useState("");
  const [matching, setMatching] = useState(false);

  async function findMatch() {
    setMatchErr("");
    setMatch(null);
    if (!image && !prompt.trim()) return setMatchErr("Upload a sketch or enter a description first.");
    setMatching(true);
    try {
      const res = await fetch("/api/match", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image, prompt }),
      });
      const data = await res.json().catch(() => ({ error: `Server error (${res.status}).` }));
      if (!res.ok) throw new Error(data.error ?? "Matching failed.");
      setMatch(data as MatchResult);
    } catch (e) {
      setMatchErr((e as Error).message || "Matching failed.");
    } finally {
      setMatching(false);
    }
  }
  const [image, setImage] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [theme, setTheme] = useState<(typeof THEMES)[number]>("minimalist");
  const [raw, setRaw] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [tab, setTab] = useState<"preview" | "code">("preview");
  const [refs, setRefs] = useState("");
  const abort = useRef<AbortController | null>(null);
  const html = useMemo(() => cleanHtml(raw), [raw]);

  async function onFile(f?: File) {
    if (!f) return;
    if (!f.type.startsWith("image/")) return setError("Please choose an image file.");
    if (f.size > 8_000_000) return setError("Image must be under 8 MB.");
    const r = new FileReader();
    r.onload = () => setImage(r.result as string);
    r.readAsDataURL(f);
  }

  async function generate() {
    setError("");
    if (!image && !prompt.trim()) return setError("Add a sketch, a description, or both.");
    setBusy(true);
    setRaw("");
    setTab("preview");
    const ac = new AbortController();
    abort.current = ac;
    try {
      const res = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ image, prompt, theme }),
        signal: ac.signal,
      });
      if (!res.ok || !res.body) throw new Error(await res.text());
      setRefs((res.headers.get("X-S2U-Refs") ?? "").split(",").join(", "));
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let acc = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        acc += dec.decode(value, { stream: true });
        setRaw(acc);
      }
      const m = acc.match(/<!--S2U_ERROR:([\s\S]*?)-->/);
      if (m) setError(m[1] ?? "Generation failed.");
    } catch (e) {
      if (!ac.signal.aborted) setError((e as Error).message || "Generation failed.");
    } finally {
      setBusy(false);
    }
  }

  function download() {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([html], { type: "text/html" }));
    a.download = `scribble2ui-${theme}.html`;
    a.click();
  }

  return (
    <div className="paper min-h-screen font-sans text-foreground">
      <header className="flex items-center justify-between border-b-2 border-border px-6 py-4">
        <h1 className="font-display text-4xl">
          Scribble<span className="text-primary">2</span>UI
        </h1>
        <p className="hidden text-sm text-muted-foreground md:block">Sketch it. Describe it. Ship it.</p>
      </header>

      <main className="grid gap-6 p-6 lg:grid-cols-[400px_1fr]">
        <section className="space-y-5">
          <div className="sketch-box p-4">
            <h2 className="font-display text-2xl">1. Sketch</h2>
            <label className="mt-2 flex min-h-40 cursor-pointer items-center justify-center border-2 border-dashed border-border bg-muted p-2 text-center text-sm text-muted-foreground"
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => { e.preventDefault(); onFile(e.dataTransfer.files[0]); }}>
              {image ? <img src={image} alt="Your sketch" className="max-h-56 object-contain" /> : "Drop or click to upload a sketch / screenshot (optional)"}
              <input type="file" accept="image/*" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
            </label>
            {image && <button className="mt-2 text-xs underline" onClick={() => setImage(null)}>Remove sketch</button>}
          </div>

          <div className="sketch-box p-4">
            <h2 className="font-display text-2xl">2. Describe</h2>
            <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={5}
              placeholder="e.g. An artisan bakery shop with warm cream tones and pickup time slots…"
              className="mt-2 w-full border-2 border-input bg-background p-2 text-sm outline-none focus:border-ring" />
          </div>

          <div className="sketch-box p-4">
            <h2 className="font-display text-2xl">3. Theme</h2>
            <div className="mt-2 grid grid-cols-2 gap-2">
              {THEMES.map((t) => (
                <button key={t} onClick={() => setTheme(t)}
                  className={`border-2 border-border px-2 py-2 text-sm capitalize ${theme === t ? "bg-accent shadow-[var(--shadow-sketch)]" : "bg-background"}`}>
                  {t}
                </button>
              ))}
            </div>
          </div>

          <button onClick={findMatch} disabled={matching}
            className="w-full border-2 border-border bg-accent py-3 font-bold text-accent-foreground shadow-[var(--shadow-sketch)] transition active:translate-x-1 active:translate-y-1 active:shadow-none disabled:opacity-60">
            {matching ? "Matching…" : "Find exact match"}
          </button>
          <div className="flex gap-2">
            <button onClick={generate} disabled={busy}
              className="flex-1 border-2 border-border bg-primary py-3 font-bold text-primary-foreground shadow-[var(--shadow-sketch)] transition active:translate-x-1 active:translate-y-1 active:shadow-none disabled:opacity-60">
              {busy ? "Generating…" : "Generate webpage"}
            </button>
            {busy && <button onClick={() => abort.current?.abort()} className="border-2 border-border bg-background px-4">Stop</button>}
          </div>
          {error && <p className="border-2 border-destructive bg-card p-2 text-sm text-destructive">{error}</p>}
        </section>

        <section className="sketch-box flex min-h-[600px] flex-col">
          <div className="flex items-center gap-2 border-b-2 border-border p-2">
            {(["preview", "code"] as const).map((t) => (
              <button key={t} onClick={() => setTab(t)} className={`px-3 py-1 text-sm capitalize ${tab === t ? "bg-accent" : ""}`}>{t}</button>
            ))}
            <div className="flex-1" />
            {html && !busy && (
              <>
                <button onClick={() => navigator.clipboard.writeText(html)} className="border-2 border-border px-3 py-1 text-sm">Copy</button>
                <button onClick={download} className="border-2 border-border bg-primary px-3 py-1 text-sm text-primary-foreground">Download HTML</button>
              </>
            )}
          </div>
          {!raw && !busy ? (
            <div className="flex flex-1 items-center justify-center p-8 text-center font-display text-3xl text-muted-foreground">
              Your generated page appears here ✎
            </div>
          ) : tab === "preview" ? (
            <iframe title="Generated page" sandbox="allow-scripts" srcDoc={busy ? html + "</body></html>" : html} className="w-full flex-1 bg-card" />
          ) : (
            <pre className="flex-1 overflow-auto bg-foreground p-4 font-mono text-xs text-background">{html || "Waiting for output…"}</pre>
          )}
        </section>
      </main>

      {refs && (
        <p className="px-6 pb-4 text-xs text-muted-foreground">
          Guided by closest dataset examples: {refs}
        </p>
      )}

      {(match || matchErr || matching) && (
        <section className="px-6 pb-10">
          <div className="sketch-box p-4">
            <h2 className="font-display text-3xl">Exact Match</h2>
            {matching && <p className="mt-2 text-sm text-muted-foreground">AI is analyzing your input…</p>}
            {matchErr && <p className="mt-2 border-2 border-destructive p-2 text-sm text-destructive">{matchErr}</p>}
            {match && (
              <>
                <p className="mt-2 text-sm">{match.analysis}</p>
                <div className="mt-4 grid gap-4 md:grid-cols-3">
                  {match.matches.map((m, i) => (
                    <div key={m.id} className={`border-2 border-border bg-background p-2 ${i === 0 ? "shadow-[var(--shadow-sketch)]" : ""}`}>
                      <img src={m.image} alt={m.caption} className="aspect-[3/4] w-full object-cover object-top" />
                      <div className="mt-2 flex items-center justify-between text-sm">
                        <span className="font-bold capitalize">{i === 0 ? "Best match · " : ""}#{m.id} {m.store}</span>
                        <span className="bg-accent px-2 font-mono">{m.confidence}%</span>
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">{m.reason}</p>
                    </div>
                  ))}
                </div>
              </>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
