import OpenAI from "openai";
import type { z } from "zod";

const apiKey = process.env.GROQ_API_KEY;

const model =
  process.env.GROQ_MODEL || "llama-3.3-70b-versatile";

const client = apiKey
  ? new OpenAI({
      apiKey,
      baseURL: "https://api.groq.com/openai/v1",
    })
  : null;

type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

type GenerateJsonInput<T> = {
  label?: string;
  schema?: z.ZodType<T>;
  fallback?: T;
  messages?: ChatMessage[];
};

function extractJson(text: string) {
  return text
    .replace(/```json/g, "")
    .replace(/```/g, "")
    .trim();
}

export async function generateJson<T>(
  input: GenerateJsonInput<T>
): Promise<T | null> {
  if (!client) {
    console.log("No Groq API key found. Using fallback mode.");
    return input.fallback ?? null;
  }

  if (!input.messages?.length) {
    return input.fallback ?? null;
  }

  try {
    console.log(`Using Groq model: ${model}`);

    const completion =
      await client.chat.completions.create({
        model,
        temperature: 0.2,
        response_format: {
          type: "json_object",
        },
        messages: input.messages,
      });

    const content =
      completion.choices[0]?.message?.content;

    if (!content) {
      return input.fallback ?? null;
    }

    const parsed = JSON.parse(
      extractJson(content)
    ) as T;

    if (input.schema) {
      const result =
        input.schema.safeParse(parsed);

      if (!result.success) {
        console.warn(
          "Schema validation failed, using fallback",
          result.error.issues
        );
        
        return input.fallback ?? null;
      }

      return result.data;
    }

    return parsed;
  } catch (error) {
    console.error("Groq error:", error);
    return input.fallback ?? null;
  }
}

export const generateStructuredJson =
  generateJson;