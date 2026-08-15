import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { AnalysisSchema, type AnalysisResult } from "./schema";
import {
  buildSystemPrompt,
  buildUserPrompt,
  type CallContext,
  type TranscriptForPrompt,
} from "./prompt";
import type {
  CrmFieldMapping,
  RubricDimension,
  Theme,
} from "@/generated/prisma/client";

export const DEFAULT_MODEL = "claude-opus-5";

export interface AnalyzerConfig {
  dimensions: RubricDimension[];
  themes: Theme[];
  mappings: CrmFieldMapping[];
  model?: string;
  apiKey?: string;
}

export interface AnalysisOutcome {
  result: AnalysisResult;
  tokensUsed: number;
  cacheReadTokens: number;
  model: string;
}

export class AnalysisError extends Error {
  constructor(
    message: string,
    readonly conversationId?: string,
  ) {
    super(message);
    this.name = "AnalysisError";
  }
}

/**
 * Claude-backed conversation analysis.
 *
 * The system prompt is built once per analyzer instance and marked cacheable.
 * It holds only the rubric, taxonomy, and field catalog — nothing per-call —
 * so the prefix is byte-identical across a whole backfill and every request
 * after the first reads cache instead of paying full price for it again.
 */
export class ClaudeAnalyzer {
  private readonly client: Anthropic;
  private readonly systemPrompt: string;
  readonly model: string;

  constructor(private readonly config: AnalyzerConfig) {
    const apiKey = config.apiKey ?? process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new AnalysisError(
        "ANTHROPIC_API_KEY is not set. Use the heuristic analyzer instead.",
      );
    }
    this.client = new Anthropic({ apiKey });
    this.model = config.model ?? process.env.ANALYSIS_MODEL ?? DEFAULT_MODEL;
    this.systemPrompt = buildSystemPrompt(
      config.dimensions,
      config.themes,
      config.mappings,
    );
  }

  /** The exact cached prefix, exposed so tests can assert it carries no volatile content. */
  getSystemPrompt(): string {
    return this.systemPrompt;
  }

  async analyze(
    context: CallContext,
    transcript: TranscriptForPrompt[],
    conversationId?: string,
  ): Promise<AnalysisOutcome> {
    if (transcript.length === 0) {
      throw new AnalysisError("Refusing to analyze an empty transcript", conversationId);
    }

    const message = await this.client.messages.parse({
      model: this.model,
      max_tokens: 8_000,
      system: [
        {
          type: "text",
          text: this.systemPrompt,
          // Stable across every call in a run; this is the whole point.
          cache_control: { type: "ephemeral" },
        },
      ],
      output_config: { format: zodOutputFormat(AnalysisSchema) },
      messages: [
        { role: "user", content: buildUserPrompt(context, transcript) },
      ],
    });

    // A refusal returns HTTP 200 with no usable content, so check before reading.
    if (message.stop_reason === "refusal") {
      throw new AnalysisError(
        `Model declined to analyze this conversation${
          message.stop_details?.category
            ? ` (${message.stop_details.category})`
            : ""
        }.`,
        conversationId,
      );
    }
    if (message.stop_reason === "max_tokens") {
      throw new AnalysisError(
        "Analysis hit max_tokens; the structured output is incomplete.",
        conversationId,
      );
    }

    const parsed = message.parsed_output;
    if (!parsed) {
      throw new AnalysisError(
        "Model returned no parseable structured output.",
        conversationId,
      );
    }

    return {
      result: parsed,
      tokensUsed:
        (message.usage.input_tokens ?? 0) + (message.usage.output_tokens ?? 0),
      cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
      model: this.model,
    };
  }
}

export function hasAnthropicKey(env = process.env): boolean {
  return Boolean(env.ANTHROPIC_API_KEY);
}
