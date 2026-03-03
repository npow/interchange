/**
 * Model resolution: maps model ID strings to Vercel AI SDK provider instances.
 *
 * Model IDs follow the pattern:
 *   "claude-sonnet-4-6"        → Anthropic
 *   "gpt-4o"                   → OpenAI
 *   "gemini-2.0-flash"         → Google (requires @ai-sdk/google)
 *   "openai/gpt-4o"            → explicit provider prefix (override)
 *
 * Extend resolveModel() to add new providers.
 */
import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import type { LanguageModelV1 } from "ai";

const ANTHROPIC_PREFIXES = ["claude-"];
const OPENAI_PREFIXES = ["gpt-", "o1", "o3", "o4", "text-davinci"];

/**
 * Resolve a model ID string to an AI SDK LanguageModelV1 instance.
 * Throws if the model ID cannot be mapped to a known provider.
 */
export function resolveModel(modelId: string): LanguageModelV1 {
  // Explicit provider prefix: "openai/gpt-4o", "anthropic/claude-sonnet-4-6"
  const slashIdx = modelId.indexOf("/");
  if (slashIdx !== -1) {
    const provider = modelId.slice(0, slashIdx);
    const id = modelId.slice(slashIdx + 1);
    switch (provider) {
      case "anthropic":
        return anthropic(id);
      case "openai":
        return openai(id);
      default:
        throw new Error(`Unknown provider prefix: ${provider}`);
    }
  }

  // Auto-detect by prefix
  for (const prefix of ANTHROPIC_PREFIXES) {
    if (modelId.startsWith(prefix)) return anthropic(modelId);
  }
  for (const prefix of OPENAI_PREFIXES) {
    if (modelId.startsWith(prefix)) return openai(modelId);
  }

  // Default: try OpenAI-compatible
  return openai(modelId);
}
