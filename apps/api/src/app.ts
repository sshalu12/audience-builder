import cors from "cors";
import express, { type NextFunction, type Request, type Response } from "express";
import { config } from "./config.js";
import { adminRouter } from "./routes/admin.routes.js";
import { authRouter } from "./routes/auth.routes.js";
import { conversationRouter } from "./routes/conversation.routes.js";
import { taxonomyRouter } from "./routes/taxonomy.routes.js";
import { HttpError } from "./utils/httpError.js";

export const app = express();

app.use(
  cors({
    origin: config.corsOrigin === "*" ? true : config.corsOrigin,
    credentials: true,
  })
);
app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "audience-builder-api" });
});

app.use("/api/auth", authRouter);
app.use("/api/conversations", conversationRouter);
app.use("/api/taxonomy", taxonomyRouter);
app.use("/api/admin", adminRouter);

app.use((_req, _res, next) => {
  next(new HttpError(404, "Route not found"));
});

app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
  const status = error instanceof HttpError ? error.status : 500;
  const message = status === 500 ? "Unexpected server error" : error.message;

  if (status === 500) {
    console.error(error);
  }

  res.status(status).json({ error: message });
});
