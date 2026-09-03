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

app.get("/api-docs", (_req, res) => {
  res.json({
    title: "Mike API Documentation",
    version: "1.0.0",
    endpoints: [
      { path: "/health", method: "GET", purpose: "Health check endpoint returning { ok: true }" },
      { path: "/chat", method: "GET/POST/PATCH/DELETE", purpose: "Manage chats and run inference" },
      { path: "/projects", method: "GET/POST/PATCH/DELETE", purpose: "Manage projects" },
      { path: "/projects/:projectId/chat", method: "GET/POST", purpose: "Project-specific chat" },
      { path: "/projects/:projectId/documents", method: "POST", purpose: "Upload document to project" },
      { path: "/single-documents", method: "GET/POST/PATCH/DELETE", purpose: "Manage documents" },
      { path: "/single-documents/:documentId/versions", method: "GET/POST", purpose: "Manage document versions" },
      { path: "/tabular-review", method: "GET/POST/PATCH/DELETE", purpose: "Manage tabular reviews" },
      { path: "/tabular-review/:reviewId/generate", method: "POST", purpose: "Run tabular generation" },
      { path: "/tabular-review/:reviewId/chat", method: "POST", purpose: "Chat about tabular review" },
      { path: "/workflows", method: "GET/POST/PATCH/DELETE", purpose: "Manage workflows" },
      { path: "/user", method: "GET/PATCH", purpose: "Manage user profile" },
      { path: "/user/api-keys", method: "GET/PUT", purpose: "Manage API keys" },
      { path: "/users", method: "GET/PATCH", purpose: "Alias for /user" },
      { path: "/download", method: "GET", purpose: "Download documents" },
      { path: "/api-docs", method: "GET", purpose: "API Documentation" },
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
});
