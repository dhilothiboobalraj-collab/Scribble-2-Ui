import { createFileRoute } from "@tanstack/react-router";
import { handleGenerate } from "@/lib/generate.server";

export const Route = createFileRoute("/api/generate")({
  server: { handlers: { POST: ({ request }) => handleGenerate(request) } },
});
