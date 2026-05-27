import dotenv from "dotenv";

dotenv.config();

export const config = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: Number(process.env.PORT ?? 4000),
  corsOrigin: process.env.CORS_ORIGIN ?? "http://localhost:5173",
  jwtSecret: process.env.JWT_SECRET ?? "dev-secret-change-me",
  openaiApiKey: process.env.GROQ_API_KEY ?? "",
  openaiModel: process.env.GROQ_MODEL ?? "llama-3.3-70b-versatile",
};
