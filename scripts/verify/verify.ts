import { lstatSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { availableParallelism, arch, platform, release, totalmem } from "node:os";
import { classify, sha256, source, type Registry } from "./core.ts";
import { freshRoot, Journal, save } from "./io.ts";
import { recipes, type Feature, type Observation, type Route } from "./recipes.ts";

export interface Options {
  repository: string;
  output: string;
  base: string;
  head: string;
  workingTree: boolean;
  features: Feature[];
  routes: Route[];
  classifyOnly?: boolean;
}

export function artifactManifest(root: string): { path: string; sha256: string; bytes: number }[] {
  const artifacts: ReturnType<typeof artifactManifest> = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory).sort()) {
      const path = join(directory, entry), name = relative(root, path);
      if (name === "receipt.json") continue;
      const stat = lstatSync(path);
      if (stat.isDirectory()) visit(path);
      else if (stat.isFile()) artifacts.push({ path: name, sha256: sha256(readFileSync(path)), bytes: stat.size });
      else throw new Error(`Evidence must be regular files, not links: ${name}`);
    }
  };
  visit(root);
  return artifacts;
}

export async function verify(options: Options, signal?: AbortSignal): Promise<{ path: string; status: string }> {
  if (new Set(options.features).size !== options.features.length || new Set(options.routes).size !== options.routes.length) throw new Error("Duplicate features/routes would repeat work; use a new attempt explicitly");
  const root = freshRoot(options.output, options.repository);
  const journal = new Journal(root, signal);
  const path = join(root, "receipt.json");
  const started = Date.now();
  const receipt: {
    schema: 1; status: string; phase: string; startedAt: string; completedAt?: string; elapsedMs?: number;
    requested: Options; source?: Awaited<ReturnType<typeof source>>; selection?: ReturnType<typeof classify>;
    environment: { node: string; platform: string; release: string; arch: string; availableParallelism: number; totalMemoryBytes: number };
    phases: { phase: string; at: string }[];
    observations: { feature: Feature; elapsedMs: number; observation: Observation }[];
    artifacts?: ReturnType<typeof artifactManifest>; error?: string;
  } = { schema: 1, status: "running", phase: "resolve", startedAt: new Date(started).toISOString(), requested: options, observations: [], phases: [],
    environment: { node: process.version, platform: platform(), release: release(), arch: arch(), availableParallelism: availableParallelism(), totalMemoryBytes: totalmem() } };
  const phase = (value: string): void => { receipt.phase = value; receipt.phases.push({ phase: value, at: new Date().toISOString() }); save(path, receipt); };
  phase("resolve");
  try {
    receipt.source = await source(journal, options.repository, options.base, options.head, options.workingTree);
    const registry: Registry = JSON.parse(readFileSync(join(options.repository, "scripts/verify/registry.json"), "utf8"));
    receipt.selection = classify(receipt.source.changed, registry);
    phase("classified");
    if (!options.classifyOnly) {
      if (!receipt.selection.noRuntime && options.features.length === 0) throw new Error("Runtime changes require explicit --feature selections; inspect the classified areas");
      if (receipt.selection.areas.includes("verification") && !options.features.includes("verifier-contracts")) throw new Error("Verifier changes require verifier-contracts in the selection");
      for (const feature of options.features) {
        const recipe = recipes[feature];
        const directory = join(root, feature);
        mkdirSync(directory, { mode: 0o700 });
        const context = { repository: options.repository, directory, journal, routes: options.routes };
        const featureStarted = Date.now();
        save(join(directory, "method.json"), { feature, description: recipe.description, live: recipe.live, routes: options.routes });
        phase(`${feature}:prepare`);
        await recipe.prepare(context);
        phase(`${feature}:exercise`);
        const result = await recipe.exercise(context);
        save(join(directory, "result.json"), result);
        phase(`${feature}:assert`);
        const observation = recipe.assert(result, context);
        if (!observation.assertions.length) throw new Error(`Empty assertions: ${feature}`);
        receipt.observations.push({ feature, elapsedMs: Date.now() - featureStarted, observation });
        save(path, receipt);
      }
    }
    phase("revalidate-source");
    const after = await source(journal, options.repository, options.base, options.head, options.workingTree);
    if (after.head !== receipt.source.head || after.base !== receipt.source.base || after.digest !== receipt.source.digest) throw new Error("Source changed during verification; proof cannot be assigned to the original candidate");
    receipt.status = options.classifyOnly ? "classified" : "complete";
  } catch (error) {
    receipt.status = signal?.aborted ? "cancelled" : "failed";
    receipt.error = error instanceof Error ? error.message : String(error);
  } finally {
    try { receipt.artifacts = artifactManifest(root); }
    catch (error) { receipt.status = "failed"; receipt.error = `${receipt.error ?? ""}\nArtifact manifest: ${String(error)}`.trim(); }
    receipt.completedAt = new Date().toISOString();
    receipt.elapsedMs = Date.now() - started;
    save(path, receipt);
  }
  return { path, status: receipt.status };
}
