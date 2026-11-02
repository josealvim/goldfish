import {
  buildConflictPrompt,
  parseConflictVerdict,
  type ConflictVerdict,
  type ConflictVerifier,
} from "../core/conflicts.ts";
import {
  buildVerificationPrompt,
  parseVerificationVerdict,
  type VerificationPacket,
  type VerificationVerdict,
  type Verifier,
} from "../core/verification.ts";
import type { PluginContext } from "./runtime.ts";

interface ModelRef {
  providerID: string;
  id: string;
  variant?: string;
}

function parseModelRef(value: string | undefined): ModelRef | undefined {
  if (!value || value === "session" || value === "default") return undefined;
  const separator = value.indexOf("/");
  if (separator <= 0 || separator === value.length - 1) return undefined;
  const providerID = value.slice(0, separator);
  const target = value.slice(separator + 1);
  const variantAt = target.indexOf("#");
  const id = variantAt === -1 ? target : target.slice(0, variantAt);
  const variant = variantAt === -1 ? undefined : target.slice(variantAt + 1);
  if (!id) return undefined;
  return { providerID, id, ...(variant ? { variant } : {}) };
}

export class ModelVerifier implements Verifier {
  constructor(
    private readonly ctx: PluginContext,
    private readonly model?: string,
    private readonly maxChars = 40_000,
  ) {}

  async verify(packet: VerificationPacket): Promise<VerificationVerdict> {
    try {
      const prompt = buildVerificationPrompt(packet).slice(0, this.maxChars);
      const model = parseModelRef(this.model);
      const result = await this.ctx.generate.text({
        prompt,
        ...(model ? { model } : {}),
      });
      return parseVerificationVerdict(result.text);
    } catch (error) {
      return {
        verdict: "insufficient",
        suggestedAction: "needs_human",
        reason: `Verifier error: ${error instanceof Error ? error.message : String(error)}`,
        evidence: [],
        premises: [],
        conflicts: [],
        cacheable: false,
      };
    }
  }
}

export class ModelConflictVerifier implements ConflictVerifier {
  constructor(
    private readonly ctx: PluginContext,
    private readonly model?: string,
    private readonly maxChars = 44_000,
  ) {}

  async find(
    target: VerificationPacket,
    candidates: VerificationPacket[],
  ): Promise<ConflictVerdict> {
    try {
      const prompt = buildConflictPrompt(target, candidates).slice(0, this.maxChars);
      const model = parseModelRef(this.model);
      const result = await this.ctx.generate.text({
        prompt,
        ...(model ? { model } : {}),
      });
      return parseConflictVerdict(
        result.text,
        new Set(candidates.map((candidate) => candidate.node.id)),
      );
    } catch (error) {
      return {
        findings: [],
        cacheable: false,
        error: `Conflict verifier error: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
}
