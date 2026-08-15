import "dotenv/config";
import { prisma } from "@/lib/db";
import { analyzePending } from "@/lib/analysis/run";
import { hasAnthropicKey } from "@/lib/analysis/claude";

/**
 * Analyze pending conversations.
 *
 *   npm run analyze                  analyze everything pending
 *   npm run analyze -- --force       re-analyze already-analyzed calls
 *   npm run analyze -- --limit 5     cap the batch
 *   npm run analyze -- --heuristic   force the fallback even with a key present
 */
function parseArgs(argv: string[]) {
  const args = { force: false, heuristicOnly: false, limit: undefined as number | undefined };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--force") args.force = true;
    else if (arg === "--heuristic" || arg === "--heuristic-only")
      args.heuristicOnly = true;
    else if (arg === "--limit") {
      const value = Number(argv[++i]);
      if (!Number.isFinite(value) || value <= 0) {
        throw new Error(`--limit needs a positive number, got "${argv[i]}"`);
      }
      args.limit = value;
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!hasAnthropicKey() && !args.heuristicOnly) {
    console.log(
      "No ANTHROPIC_API_KEY found — using the deterministic heuristic analyzer.\n" +
        "Results are labelled 'heuristic' in the UI and are pattern matching, not judgment.\n",
    );
  }

  const started = Date.now();
  const summary = await analyzePending(args);
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);

  console.log(`\nAnalyzed in ${elapsed}s`);
  console.table({
    considered: summary.considered,
    analyzed: summary.analyzed,
    skipped: summary.skipped,
    failed: summary.failed,
    analyzer: summary.usedModel ? "claude" : "heuristic",
  });

  if (summary.usedModel) {
    console.log(
      `tokens: ${summary.tokensUsed.toLocaleString()} total, ` +
        `${summary.cacheReadTokens.toLocaleString()} read from cache`,
    );
    if (summary.analyzed > 1 && summary.cacheReadTokens === 0) {
      // The rubric prefix should be cached from the second call onward; zero
      // reads across a batch means something volatile crept into the prefix.
      console.warn(
        "\n⚠ No cache reads across a multi-call batch. The system prompt prefix " +
          "may not be stable — check for per-call content in buildSystemPrompt().",
      );
    }
  }

  if (summary.droppedSlugs.length > 0) {
    const counts = summary.droppedSlugs.reduce<Record<string, number>>((acc, slug) => {
      acc[slug] = (acc[slug] ?? 0) + 1;
      return acc;
    }, {});
    console.log("\nDropped unknown slugs (prompt-tuning signal):");
    for (const [slug, count] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${count}×  ${slug}`);
    }
  }

  if (summary.failed > 0) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
