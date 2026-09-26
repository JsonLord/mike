// @ts-nocheck
import "dotenv/config";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { chatRouter } from "./routes/chat";
import { projectsRouter } from "./routes/projects";
import { projectChatRouter } from "./routes/projectChat";
import { documentsRouter } from "./routes/documents";
import { tabularRouter } from "./routes/tabular";
import { workflowsRouter } from "./routes/workflows";
import { userRouter } from "./routes/user";
import { configRouter } from "./routes/config";
import { warmOfficialDecisionIndex } from "./lib/officialDecisions";
import { probeLegalSources } from "./lib/sourceHealth";
import { downloadsRouter } from "./routes/downloads";

const app = express();
const PORT = process.env.PORT ?? 3001;
const isProduction = process.env.NODE_ENV === "production";

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function minutes(value: number): number {
  return value * 60 * 1000;
}

function hours(value: number): number {
  return minutes(value * 60);
}

function makeLimiter(options: {
  windowMs: number;
  max: number;
  message?: string;
}) {
  return rateLimit({
    windowMs: options.windowMs,
    max: options.max,
    standardHeaders: true,
    legacyHeaders: false,
    skip: (req) => req.method === "OPTIONS",
    message: {
      detail:
        options.message ?? "Too many requests. Please try again later.",
    },
  });
}

const generalLimiter = makeLimiter({
  windowMs: minutes(envInt("RATE_LIMIT_GENERAL_WINDOW_MINUTES", 15)),
  max: envInt("RATE_LIMIT_GENERAL_MAX", 300),
});

const chatLimiter = makeLimiter({
  windowMs: minutes(envInt("RATE_LIMIT_CHAT_WINDOW_MINUTES", 15)),
  max: envInt("RATE_LIMIT_CHAT_MAX", 30),
  message: "Too many chat requests. Please try again later.",
});

const chatCreateLimiter = makeLimiter({
  windowMs: minutes(envInt("RATE_LIMIT_CHAT_CREATE_WINDOW_MINUTES", 15)),
  max: envInt("RATE_LIMIT_CHAT_CREATE_MAX", 60),
});

const uploadLimiter = makeLimiter({
  windowMs: hours(envInt("RATE_LIMIT_UPLOAD_WINDOW_HOURS", 1)),
  max: envInt("RATE_LIMIT_UPLOAD_MAX", 50),
  message: "Too many upload requests. Please try again later.",
});

app.disable("x-powered-by");
app.set("trust proxy", envInt("TRUST_PROXY_HOPS", 1));

app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    hsts: isProduction
      ? {
          maxAge: 15552000,
          includeSubDomains: true,
        }
      : false,
    referrerPolicy: { policy: "no-referrer" },
  }),
);

app.use(
  cors({
    origin: process.env.FRONTEND_URL ? process.env.FRONTEND_URL.split(",") : true,
    credentials: true,
  }),
);

app.use(generalLimiter);

app.use(express.json({ limit: "50mb" }));

app.post("/chat", chatLimiter);
app.post("/projects/:projectId/chat", chatLimiter);
app.post("/tabular-review/:reviewId/chat", chatLimiter);
app.post("/tabular-review/:reviewId/generate", chatLimiter);
app.post("/chat/create", chatCreateLimiter);
app.post("/chat/:chatId/generate-title", chatCreateLimiter);
app.post("/single-documents", uploadLimiter);
app.post("/single-documents/:documentId/versions", uploadLimiter);
app.post("/projects/:projectId/documents", uploadLimiter);

app.use("/chat", chatRouter);
app.use("/projects", projectsRouter);
app.use("/projects/:projectId/chat", projectChatRouter);
app.use("/single-documents", documentsRouter);
app.use("/tabular-review", tabularRouter);
app.use("/workflows", workflowsRouter);
app.use("/config", configRouter);
app.use("/user", userRouter);
app.use("/users", userRouter);
app.use("/download", downloadsRouter);

app.get("/health", (_req, res) => res.json({ ok: true }));

// Kept in step with the routers mounted above. On the Hugging Face Space every
// path below is served under the `/api` prefix (nginx strips it before it
// reaches this process); `/health` and `/api-docs` are also served unprefixed.
app.get("/api-docs", (_req, res) => {
  res.json({
    title: "Mike API Documentation",
    version: "1.1.0",
    base_url: "/api",
    auth: "none — every request runs as the single built-in local user",
    endpoints: [
      { path: "/health", method: "GET", purpose: "Health check endpoint returning { ok: true }" },
      { path: "/config", method: "GET", purpose: "Enabled providers and the model ids accepted by `model`" },
      {
        path: "/chat",
        method: "POST",
        purpose: "Run a chat turn with the research tools; streams Server-Sent Events",
        request: {
          messages: "[{ role: 'user' | 'assistant', content: string }] (required, non-empty)",
          chat_id: "string (optional) — continue an existing chat",
          project_id: "string (optional) — give the model the project's documents",
          model: "string (optional) — one of GET /config models[].id",
        },
        response:
          "text/event-stream of `data: {json}` lines ending with `data: [DONE]`. " +
          "Event types include chat_id, content_delta (answer text), reasoning_delta, " +
          "tool_call_start, citations, doc_* and error.",
      },
      { path: "/chat", method: "GET", purpose: "List chats (?limit=1..100)" },
      { path: "/chat/create", method: "POST", purpose: "Create an empty chat, optionally in a project" },
      { path: "/chat/:chatId", method: "GET/PATCH/DELETE", purpose: "Read (with messages), rename or delete a chat" },
      { path: "/chat/:chatId/generate-title", method: "POST", purpose: "Generate a chat title" },
      { path: "/projects", method: "GET/POST", purpose: "List or create projects" },
      { path: "/projects/:projectId", method: "GET/PATCH/DELETE", purpose: "Read, update or delete a project" },
      { path: "/projects/:projectId/documents", method: "GET/POST", purpose: "List or upload (multipart `file`) project documents" },
      { path: "/projects/:projectId/chats", method: "GET", purpose: "List a project's chats" },
      { path: "/projects/:projectId/chat", method: "POST", purpose: "Project chat; same body and stream as POST /chat" },
      { path: "/single-documents", method: "GET/POST", purpose: "List or upload (multipart `file`: pdf, docx, doc) standalone documents" },
      { path: "/single-documents/:documentId", method: "DELETE", purpose: "Delete a document" },
      { path: "/single-documents/:documentId/versions", method: "GET/POST", purpose: "List or upload document versions" },
      { path: "/tabular-review", method: "GET/POST", purpose: "List or create tabular reviews" },
      { path: "/tabular-review/:reviewId", method: "GET/PATCH/DELETE", purpose: "Read, update or delete a tabular review" },
      { path: "/tabular-review/:reviewId/generate", method: "POST", purpose: "Run tabular generation (streams)" },
      { path: "/tabular-review/:reviewId/chat", method: "POST", purpose: "Chat about a tabular review (streams)" },
      { path: "/workflows", method: "GET/POST", purpose: "List or create workflows" },
      { path: "/workflows/:workflowId", method: "GET/PUT/PATCH/DELETE", purpose: "Read, update or delete a workflow" },
      { path: "/user/profile", method: "GET/PATCH", purpose: "Read or update the user profile and API-key status" },
      { path: "/user/api-keys", method: "GET", purpose: "Which provider keys are configured" },
      { path: "/user/api-keys/:provider", method: "PUT", purpose: "Store a provider API key" },
      { path: "/download/:token", method: "GET", purpose: "Download a generated file" },
      { path: "/api-docs", method: "GET", purpose: "This document" },
    ],
  });
});

// A rejected promise escaping a route handler would otherwise terminate the
// process, and nothing restarts it inside the container — one failed request
// would take the whole deployment down with 502s. Log and stay up instead.
process.on("unhandledRejection", (reason) => {
  console.error("[unhandledRejection]", reason);
});

process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err);
});

app.listen(PORT, () => {
  console.log(`Mike backend running on port ${PORT}`);
  // Build the federal-courts index in the background so the first lookup in a
  // chat does not pay for the ~23 MB download. Failures are logged, not fatal:
  // the tools rebuild on demand and report their own unavailability.
  warmOfficialDecisionIndex();
  // Log which research sources this deployment can actually reach.
  void probeLegalSources().catch(() => {});
});
