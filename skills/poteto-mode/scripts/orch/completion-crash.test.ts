import { test, expect } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Journal } from "../../../../scripts/verify/io.ts";

const cli = join(import.meta.dir, "orch.ts");
const stages = ["claim", "decision", "unit", "ledger", "complete"] as const;

for (const stage of stages) for (const edge of ["before", "after"] as const) {
  test(`real SIGKILL ${edge} ${stage} retains completion and recovers local effects`, async () => {
    const retained = process.env.ORCH_TEST_EVIDENCE_ROOT;
    const root = retained ? join(retained, `${stage}-${edge}`) : await mkdtemp(join(tmpdir(), "orch-crash-"));
    if (retained) { await mkdir(retained, { recursive: true }); await mkdir(root); }
    const store = join(root, "store"), journal = new Journal(root);
    let sequence = 0;
    const command = async (args: string[], hook?: string) => {
      const result = await journal.run(["bun", ...(hook ? ["--preload", hook] : []), cli, "--store", store, "--json", ...args],
        { cwd: root, label: `command-${++sequence}`, timeoutMs: 15_000 });
      const stdout = await readFile(result.stdout, "utf8"), stderr = await readFile(result.stderr, "utf8");
      return { result, stdout, stderr, value: stdout.trim() ? JSON.parse(stdout) : null };
    };
    try {
      await command(["init"]);
      await command(["unit", "add", "u", "--track", "core"]);
      await command(["unit", "set", "u", "--state", "ready", "--pr", "12", "--sha", "head"]);
      await writeFile(join(root, "report.md"), "Real local crash-control report\n");
      const attempt = (await command(["attempt", "begin", "u", "worker", "--request", "dispatch"])).value;
      expect((await command(["attempt", "begin", "u", "worker", "--request", "dispatch"])).value).toEqual(attempt);
      const pushed = (await command(["inbox", "push", "worker", "u", "done", "--attempt", attempt.id, "--request", "completion", "--report", "report.md"])).value;
      const hook = join(root, "fault.ts"), marker = join(root, "fault-marker.json");
      await writeFile(hook, `import {mock} from 'bun:test';import * as original from 'node:fs/promises';const fs={...original};
mock.module('node:fs/promises',()=>({...fs,rename:async(from,to)=>{
let hit=false;const stage=${JSON.stringify(stage)}, edge=${JSON.stringify(edge)};
if(String(to).endsWith('/units.tsv'))hit=stage==='unit';
if(String(to).endsWith('/ledger.tsv'))hit=stage==='ledger';
if(String(to).endsWith('/inbox-state.json')){const data=JSON.parse(await fs.readFile(from,'utf8'));
if(stage==='claim')hit=data.batches.length>0;
if(stage==='decision')hit=data.decisions.some(d=>!d.completed);
if(stage==='complete')hit=data.decisions.some(d=>d.completed);}
const crash=async()=>{await fs.writeFile(${JSON.stringify(marker)},JSON.stringify({pid:process.pid,stage,edge,from,to}));process.kill(process.pid,'SIGKILL');};
if(hit&&edge==='before')await crash();await fs.rename(from,to);if(hit&&edge==='after')await crash();}}));`);
      let batch, killed;
      if (stage === "claim") {
        killed = await command(["inbox", "drain", "--request", "drain"], hook);
        expect((await command(["inbox", "count"])).value).toEqual({ count: 1 });
        batch = (await command(["inbox", "drain", "--request", "drain"])).value;
      } else {
        batch = (await command(["inbox", "drain", "--request", "drain"])).value;
      }
      expect(batch.events).toEqual([pushed]);
      const decisions = [{ event: pushed.id, outcome: { kind: "unit", state: "published", ledger: { pr: 12, sha: "head", verdict: "unit-test-verified", evidence: "report.md" } } }];
      const ack = join(root, "ack.json");
      await writeFile(ack, JSON.stringify(decisions));
      if (stage !== "claim") killed = await command(["inbox", "ack", batch.id, "--file", ack], hook);
      expect(killed!.result.signal).toBe("SIGKILL");
      expect(killed!.stdout).toBe("");
      expect(JSON.parse(await readFile(marker, "utf8")).pid).toBe(killed!.result.pid);
      const cold = (await command(["unit", "get", "u"])).value;
      expect(cold.state).toBe(stage === "claim" || (stage === "decision" && edge === "before") ? "ready" : "published");
      const first = await command(["inbox", "ack", batch.id, "--file", ack]);
      expect(first.result.status).toBe("complete");
      expect((await command(["inbox", "ack", batch.id, "--file", ack])).value).toEqual(first.value);
      expect((await command(["inbox", "count"])).value).toEqual({ count: 0 });
      const ledger = await readFile(join(store, "ledger.tsv"), "utf8");
      expect(ledger.trim().split("\n")).toHaveLength(2);
      await command(["unit", "set", "u", "--state", "restacked", "--sha", "new-head"]);
      expect((await command(["inbox", "ack", batch.id, "--file", ack])).value).toEqual(first.value);
      expect((await command(["unit", "get", "u"])).value).toMatchObject({ state: "restacked", sha: "new-head" });
      expect(await readFile(join(store, "ledger.tsv"), "utf8")).toBe(ledger);
      expect((await command(["inbox", "drain", "--request", "drain"])).value).toEqual(batch);
      const history = (await command(["inbox", "history"])).value;
      expect(history.events).toEqual([pushed]);
      expect(history.decisions).toHaveLength(1);
      expect(history.decisions[0].completed).toBe(true);
      await writeFile(join(root, "result.json"), JSON.stringify({ stage, edge, killed: killed!.result, cold,
        batch, ledgerDataRows: 1, retainedEvent: history.events[0], decision: history.decisions[0], replayPreservedNewHead: true }, null, 2));
    } finally {
      if (!retained) await rm(root, { recursive: true, force: true });
    }
  }, 40_000);
}
