// Historical baseline harness for commit 730c61d. Its imports intentionally
// target the pre-fix API. Current regression coverage lives in src/discovery,
// src/registry, src/supervisor/runtime-regression.test.ts and src/adapters.
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { openStore } from '../../src/store/store.ts';
import { Supervisor } from '../../src/supervisor/supervisor.ts';
import { executeAdapter } from '../../src/adapters/executor.ts';
import { validateSpec, submitSpec, getDiscovered, canonicalSpecJson, canaryDiscovered, detectDiscovered } from '../../src/discovery/discovery.ts';
import { selectTarget, listModels, detectApps } from '../../src/registry/registry.ts';
import { catalogOf, clearCatalogCache } from '../../src/registry/catalog.ts';
import type { AdapterSpec, ExecResult } from '../../src/adapters/types.ts';
import type { Target } from '../../src/registry/registry.ts';

const root = mkdtempSync('/tmp/baton-release-review-');
process.env.XDG_CACHE_HOME = join(root, 'cache');
const emit = (test: string, result: unknown) => console.log(JSON.stringify({ test, result }));
const dbFor = (name: string) => openStore(join(root, `${name}.db`));
const specFor = (app = 'review-fake', overrides: Partial<AdapterSpec> = {}): AdapterSpec => ({
  app, adapterVersion: 1, binary: process.execPath,
  models: [{ model: 'review-model', slug: 'review-model' }],
  invoke: { argv: ['{slug}'], promptVia: 'stdin', extract: { kind: 'text' } },
  resume: { argv: ['resume', '{sessionRef}', '{slug}'] },
  sessionRef: { kind: 'text' },
  autonomyFlags: { readonly: [], edits: [], full: [] },
  defaultAutonomy: 'full', admissionFailurePatterns: [], ...overrides,
});
const targetFor = (spec: AdapterSpec): Target => ({ spec, instance: 'default', slug: 'review-model', binaryPath: spec.binary, targetFingerprint: `${spec.app}:default/review-model@a${spec.adapterVersion}` });
const answer = (extra: Partial<ExecResult> = {}): ExecResult => ({ ok: true, started: true, output: 'answer', sessionRef: 'same-session', rawTail: '', exitCode: 0, timedOut: false, durationMs: 1, ...extra });

// A completed parent and grandchild refer to the same callee session.
{
  const db = dbFor('lineage');
  const target = targetFor(specFor());
  const pending: Array<() => void> = [];
  const sup = new Supervisor({ db, env: {}, hostCwd: root,
    resolver: { resolve: () => target, pinned: () => target },
    exec: async (req) => {
      if (req.prompt.startsWith('hold')) await new Promise<void>(resolve => pending.push(resolve));
      return answer();
    },
  });
  const first = await sup.startRun({ model: 'review-model', prompt: 'first' }); await first.settled;
  const second = await sup.resumeRun({ runId: first.view.runId, prompt: 'second' }); await second.settled;
  const grandchild = await sup.resumeRun({ runId: second.view.runId, prompt: 'hold grandchild' });
  const sibling = await sup.resumeRun({ runId: first.view.runId, prompt: 'hold ancestor resume' });
  emit('concurrent resumes through different ancestors', { processesAdmitted: pending.length, statuses: [sup.getRun(grandchild.view.runId)?.status, sup.getRun(sibling.view.runId)?.status] });
  pending.forEach(resolve => resolve()); await Promise.all([grandchild.settled, sibling.settled]); db.close();
}

// Failover changes app/slug/instance but leaves the first adapter's options.
{
  const db = dbFor('failover');
  const a = targetFor(specFor('review-a', { admissionFailurePatterns: ['not logged in'] }));
  const b = targetFor(specFor('review-b', { adapterVersion: 2 }));
  const sup = new Supervisor({ db, env: {}, hostCwd: root,
    resolver: { resolve: (_model, opts) => opts.exclude?.length ? b : a, pinned: () => b },
    exec: async req => req.spec.app === a.spec.app ? answer({ ok: false, output: undefined, exitCode: 1, rawTail: 'not logged in', error: 'not logged in' }) : answer(),
  });
  const first = await sup.startRun({ model: 'review-model', prompt: 'first' }); await first.settled;
  let resume = 'accepted'; try { const next = await sup.resumeRun({ runId: first.view.runId, prompt: 'next' }); await next.settled; } catch (err) { resume = String(err); }
  emit('resume after failover', { answeredBy: sup.getRun(first.view.runId)?.app, resume }); db.close();
}

// User asks to extend timeout and move from review to implementation.
{
  const db = dbFor('resume-options'); const target = targetFor(specFor());
  const observed: unknown[] = [];
  const sup = new Supervisor({ db, env: {}, hostCwd: root, resolver: { resolve: () => target, pinned: () => target }, exec: async req => { observed.push({ autonomy: req.autonomy, timeoutMs: req.timeoutMs }); return answer(); } });
  const first = await sup.startRun({ model: 'review-model', prompt: 'review', options: { autonomy: 'readonly', timeoutMs: 50 } }); await first.settled;
  const second = await sup.resumeRun({ runId: first.view.runId, prompt: 'implement', options: { autonomy: 'full', timeoutMs: 5000 } }); await second.settled;
  emit('explicit resume option changes', observed); db.close();
}

// A readonly-only adapter should work under a full ceiling.
{
  const db = dbFor('ceiling');
  const spec = specFor('review-readonly', { autonomyFlags: { readonly: [] }, defaultAutonomy: 'readonly' });
  const submitted = submitSpec(db, spec); if (!submitted.ok) throw new Error(submitted.errors.join(';'));
  db.query("UPDATE discovered_adapters SET status = 'active' WHERE app = ?").run(spec.app);
  let selected = 'accepted'; try { selectTarget(db, 'review-model', { autonomy: 'readonly' }); } catch (err) { selected = String(err); }
  emit('readonly adapter under full ceiling', selected);
  submitSpec(db, spec);
  emit('identical adapter registration', getDiscovered(db, spec.app)?.status); db.close();
}

// Declarative JSON arguments are rejected although spawn does not use a shell.
{
  const spec = specFor('review-json', { invoke: { argv: ['--settings', '{"mode":"normal"}', '{slug}'], promptVia: 'stdin', extract: { kind: 'text' } } });
  emit('literal JSON argv', validateSpec(spec));
}

// Readonly model enumeration uses the inherited account, not a named instance.
{
  const db = dbFor('catalog');
  const binary = join(root, 'fake-catalog');
  writeFileSync(binary, `#!${process.execPath}\nif (process.argv.includes('--version')) console.log('1'); else console.log(process.env.REVIEW_ACCOUNT === 'paid' ? 'paid-model' : 'default-model');\n`); chmodSync(binary, 0o755);
  const spec = specFor('review-catalog', { binary, models: [{ model: 'fallback', slug: 'fallback' }], identityEnv: 'REVIEW_ACCOUNT', listModels: { argv: ['models'], extract: { kind: 'lines' } } });
  db.query("INSERT INTO discovered_adapters (app,spec,status,submitted_at) VALUES (?,?,'active',?)").run(spec.app, canonicalSpecJson(spec), new Date().toISOString());
  db.query('INSERT INTO instances (app,name,env,created_at) VALUES (?,?,?,?)').run(spec.app, 'paid', JSON.stringify({ REVIEW_ACCOUNT: 'paid' }), new Date().toISOString());
  db.query('INSERT INTO pools (app,members,created_at) VALUES (?,?,?)').run(spec.app, JSON.stringify(['paid']), new Date().toISOString());
  clearCatalogCache();
  const originalPath = process.env.PATH; process.env.PATH = root;
  try {
    emit('named instance catalog', listModels(db).filter(row => row.app === spec.app).map(row => ({ model: row.model, instance: row.instance })));
    let selected = 'accepted'; try { selectTarget(db, 'paid-model', { instance: 'paid' }); } catch (err) { selected = String(err); }
    emit('named instance only model', selected);
  } finally { process.env.PATH = originalPath; db.close(); }
}

// An error before a long JSONL diagnostic tail is forgotten.
{
  const code = `console.log(JSON.stringify({type:'error',error:'upstream failed'}));console.log('x'.repeat(1000500));console.log(JSON.stringify({type:'text',part:{text:'partial answer'}}));`;
  const spec = specFor('review-stream', { invoke: { argv: ['-e', code], promptVia: 'stdin', extract: { kind: 'jsonl', errorWhen: { path: 'type', equals: 'error' }, where: { path: 'type', equals: 'text' }, path: 'part.text', take: 'last' } }, sessionRef: undefined });
  const result = await executeAdapter({ spec, slug: 'review-model', prompt: 'x', cwd: root, env: {}, autonomy: 'full' });
  emit('error event evicted from output buffer', { ok: result.ok, output: result.output, error: result.error });
}

// Retention only runs at open, not as a long-running server records runs.
{
  const db = openStore(join(root, 'retention.db'), 2); const target = targetFor(specFor());
  const sup = new Supervisor({ db, env: {}, hostCwd: root, resolver: { resolve: () => target }, exec: async () => answer() });
  for (let i = 0; i < 5; i++) { const run = await sup.startRun({ model: 'review-model', prompt: `${i}` }); await run.settled; }
  emit('long-lived retention with cap 2', db.query('SELECT count(*) AS count FROM runs').get()); db.close();
}
// Canary execution bypasses the configured per-app ceiling.
{
  const db = dbFor('canary');
  const spec = specFor('review-canary', { autonomyFlags: { full: [] } });
  submitSpec(db, spec);
  db.query("UPDATE discovered_adapters SET status='approved' WHERE app=?").run(spec.app);
  db.query('INSERT INTO settings (key,value) VALUES (?,?)').run(`max_autonomy:${spec.app}`, 'readonly');
  let actual: string | undefined;
  await canaryDiscovered(db, spec.app, async req => { actual = req.autonomy; return answer({ output: 'BATON_CANARY' }); }, { probeVersion: () => '1' });
  emit('canary ignores configured ceiling', { ceiling: 'readonly', actual });
  detectApps({ db, probeVersion: false });
  const before = getDiscovered(db, spec.app)?.status;
  detectDiscovered(db, { probeVersion: () => '2' });
  emit('only explicit detection invalidates upgraded adapter', { before, after: getDiscovered(db, spec.app)?.status }); db.close();
}

// Failure to record a finished result is swallowed and never repaired by its live owner.
{
  const db = dbFor('commit'); const target = targetFor(specFor());
  const sup = new Supervisor({ db, env: {}, hostCwd: root, resolver: { resolve: () => target }, exec: async () => answer() });
  db.exec("CREATE TRIGGER reject_result BEFORE UPDATE OF output ON attempts BEGIN SELECT RAISE(ABORT, 'simulated storage failure'); END");
  const run = await sup.startRun({ model: 'review-model', prompt: 'first' }); await run.settled;
  const before = sup.getRun(run.view.runId)?.status; sup.recoverOrphans();
  emit('settlement write failure', { promiseResolved: true, beforeRecovery: before, afterRecovery: sup.getRun(run.view.runId)?.status }); db.close();
}

// Catalog probes block timers in the MCP process.
{
  const binary = join(root, 'slow-catalog');
  writeFileSync(binary, `#!${process.execPath}\nBun.sleepSync(200);console.log('slow-model');\n`); chmodSync(binary, 0o755);
  const spec = specFor('review-slow', { binary, listModels: { argv: ['models'], extract: { kind: 'lines' } } });
  const start = Date.now(); let timerAt: number | undefined;
  const fired = new Promise<void>(resolve => setTimeout(() => { timerAt = Date.now() - start; resolve(); }, 10));
  catalogOf(spec, binary); await fired;
  emit('catalog blocks event loop', { scheduledTimerMs: 10, observedTimerMs: timerAt });
}
emit('fixture directory', root);
