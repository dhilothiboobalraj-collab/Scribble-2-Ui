import { createFileRoute } from "@tanstack/react-router";
import { handleMatch } from "@/lib/match.server";

export const Route = createFileRoute("/api/match")({
  server: { handlers: { POST: ({ request }) => handleMatch(request) } },
});
