import Anthropic from "@anthropic-ai/sdk";
import { ProviderError } from "../lib/errors";
import { toStructuredOutputSchema } from "./json-schema";
import type { LlmProvider, StructuredRequest } from "./types";

/**
 * Anthropic (Claude) adapter using JSON structured outputs (`output_config.format`).
 * The response is validated again with Zod before use.
 * STATUS: implemented, NOT verified against the live API in this repository (no key).
 */
export class AnthropicLlmProvider implements LlmProvider {
  readonly name = "anthropic";
  readonly isMock = false;
  private readonly client: Anthropic;

  constructor(
    apiKey: string,
    readonly model: string,
    client?: Anthropic,
  ) {
    this.client = client ?? new Anthropic({ apiKey, maxRetries: 2, timeout: 10 * 60_000 });
  }

  async generateStructured<T>(req: StructuredRequest<T>) {
    let response: Anthropic.Message;
    try {
      response = await this.client.messages.create({
        model: this.model,
        max_tokens: req.maxOutputTokens,
        system: req.system,
        messages: [{ role: "user", content: req.user }],
        output_config: {
          format: { type: "json_schema", schema: toStructuredOutputSchema(req.schema) },
        },
      });
    } catch (err) {
      if (err instanceof Anthropic.APIError) {
        const status = err.status ?? 0;
        const retryable =
          status === 0 || status === 408 || status === 409 || status === 429 || status >= 500;
        throw new ProviderError("generation_failed", `LLM HTTP ${status}`, retryable, status);
      }
      throw new ProviderError("generation_failed", "LLM request failed", true);
    }

    if (response.stop_reason === "refusal") {
      throw new ProviderError("generation_failed", "LLM refused the request", false);
    }
    if (response.stop_reason === "max_tokens") {
      throw new ProviderError(
        "generation_invalid_output",
        "LLM output truncated (max_tokens)",
        false,
      );
    }
    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      throw new ProviderError("generation_invalid_output", "LLM returned no text block", true);
    }
    let json: unknown;
    try {
      json = JSON.parse(textBlock.text);
    } catch {
      throw new ProviderError("generation_invalid_output", "LLM returned invalid JSON", true);
    }
    const parsed = req.schema.safeParse(json);
    if (!parsed.success) {
      throw new ProviderError(
        "generation_invalid_output",
        "LLM output failed schema validation",
        true,
      );
    }
    return {
      data: parsed.data,
      usage: {
        inputTokens: response.usage.input_tokens,
        outputTokens: response.usage.output_tokens,
      },
    };
  }
}
