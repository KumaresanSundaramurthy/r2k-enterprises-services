import { Injectable, Logger } from "@nestjs/common";
import { CiValidationError } from "../../core/response/ci-response";

// application/config/ai_config.php
export const GEMINI_CONFIG = {
  model: process.env.GEMINI_MODEL || "gemini-3.6-flash",
  maxOutputTokens: 400,
  temperature: 0.25,
  timeoutMs: 20_000,
};

export interface ChatTurn { role: "user" | "model"; text: string }

type GeminiResponse = { error?: { message?: string }; candidates?: { content?: { parts?: { text?: string }[] } }[] };

/**
 * Geminiapi — Google Gemini generateContent. Failures throw a user-safe message (CI3's wording), so the caller
 * answers { Error: true, Message } instead of returning the message as the assistant's reply.
 */
@Injectable()
export class GeminiClient {
  private readonly logger = new Logger(GeminiClient.name);

  async chat(systemPrompt: string, history: ChatTurn[], userMessage: string): Promise<string> {
    const apiKey = process.env.GEMINI_API_KEY ?? "";
    if (!apiKey) throw new CiValidationError("AI assistant is not configured yet. Please set GEMINI_API_KEY in the services environment.");

    const payload = {
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: [...history, { role: "user", text: userMessage }].map((turn) => ({ role: turn.role, parts: [{ text: turn.text }] })),
      generationConfig: { temperature: GEMINI_CONFIG.temperature, maxOutputTokens: GEMINI_CONFIG.maxOutputTokens },
    };

    let response: Response;
    try {
      // Key in a header rather than the URL, so it never appears in request logs
      response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_CONFIG.model)}:generateContent`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(GEMINI_CONFIG.timeoutMs),
      });
    } catch (err) {
      this.logger.warn(`Gemini request failed: ${(err as Error).message}`);
      throw new CiValidationError("Network error connecting to AI service. Please try again.");
    }

    let data: GeminiResponse | null;
    try {
      data = (await response.json()) as GeminiResponse | null;
    } catch {
      data = null;
    }
    if (!data || typeof data !== "object") throw new CiValidationError("AI service returned an unexpected response. Please try again.");

    if (data.error) {
      this.logger.warn(`Gemini error ${response.status}: ${data.error.message ?? ""}`);
      if (response.status === 400) throw new CiValidationError("Request was rejected by AI service. Try rephrasing your question.");
      if (response.status === 429) throw new CiValidationError("AI service rate limit reached. Please wait a moment and try again.");
      throw new CiValidationError(`AI service error: ${data.error.message ?? "Unknown error"}`);
    }

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (text === undefined || text === null) throw new CiValidationError("I couldn't generate a response. Please try rephrasing your question.");
    return text.trim();
  }
}
