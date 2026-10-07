import { existsSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { FEATURES, ROUTES, recipes, type Feature, type Route } from "./recipes.ts";
import { verify } from "./verify.ts";

const help = `pstack-vic repository verifier (Node 24)

  npm run verify -- doctor
  npm run verify -- classify --base <commit> --output <new-absolute-directory>
  npm run verify -- run --base <commit> --output <new-absolute-directory>
    --feature <name> [--feature <name>...] [--route <name>...]
    [--head HEAD] [--working-tree]

Features: ${FEATURES.join(", ")}
Routes: ${Object.keys(ROUTES).join(", ")}

Default proof requires a clean checked-out commit. --working-tree labels a
development proof with a content digest. Named checks are explicit; this is
not a claim of all-feature coverage or a replacement for Shipping/review.
Live recipes use authenticated CLIs and incur model usage. No automatic retries,
publication or timeout. Retain the host's persistent exec/background handle.
SIGINT/SIGTERM cancel only this verifier's owned process groups.
`;

const { values, positionals } = parseArgs({ allowPositionals: true, strict: true, options: {
  base: { type: "string" }, head: { type: "string", default: "HEAD" }, output: { type: "string" },
  candidate: { type: "string" }, feature: { type: "string", multiple: true }, route: { type: "string", multiple: true },
  "working-tree": { type: "boolean", default: false }, help: { type: "boolean", short: "h" },
} });
const repository = resolve(values.candidate ?? resolve(import.meta.dirname, "../.."));

try {
  if (values.help || !positionals.length) process.stdout.write(help);
  else if (positionals.length !== 1) throw new Error("Expected one subcommand");
  else if (positionals[0] === "doctor") {
    if (Number(process.versions.node.split(".")[0]) < 24) throw new Error("Node 24 or newer required");
    for (const path of ["package.json", "scripts/verify/registry.json", "skills/poteto-mode/scripts/runner/pstack-runner"]) if (!existsSync(resolve(repository, path))) throw new Error(`Candidate missing ${path}`);
    process.stdout.write(JSON.stringify({ node: process.version, candidate: repository, version: JSON.parse(readFileSync(resolve(repository, "package.json"), "utf8")).version,
      features: Object.fromEntries(FEATURES.map((name) => [name, { description: recipes[name].description, live: recipes[name].live }])), routes: ROUTES }, null, 2) + "\n");
  } else if (["run", "classify"].includes(positionals[0])) {
    if (realpathSync(repository) !== realpathSync(resolve(import.meta.dirname, "../.."))) throw new Error("Run the verifier from the candidate checkout; --candidate is only for doctor inspection");
    if (!values.base || !values.output) throw new Error("--base and --output are required");
    const features = (values.feature ?? []).map((value): Feature => {
      const feature = FEATURES.find((name) => name === value);
      if (!feature) throw new Error(`Unknown feature: ${value}`);
      return feature;
    });
    const routes = (values.route ?? []).map((value): Route => {
      const route = Object.keys(ROUTES).find((name): name is Route => name === value);
      if (!route) throw new Error(`Unknown route: ${value}`);
      return route;
    });
    if (features.some((name) => recipes[name].live) && !routes.length) throw new Error("Live recipes require explicit --route selections");
    const controller = new AbortController();
    const interrupt = () => controller.abort();
    process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
    try {
      const result = await verify({ repository, base: values.base, head: values.head, output: values.output,
        workingTree: values["working-tree"], features, routes, classifyOnly: positionals[0] === "classify" }, controller.signal);
      process.stdout.write(JSON.stringify(result) + "\n");
      if (result.status !== "complete" && result.status !== "classified") process.exitCode = 1;
    } finally { process.off("SIGINT", interrupt); process.off("SIGTERM", interrupt); }
  } else throw new Error(`Unknown subcommand: ${positionals[0]}`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
