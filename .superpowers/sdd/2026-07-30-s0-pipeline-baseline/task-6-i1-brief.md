### Task 6 I-1 binding remediation: prove bootstrap/close/disposal order

Start only after the exact plan commit containing this brief receives fresh Luna advisory
and independent Sol binding PASS. That exact commit is `TASK6_I1_PLAN_SHA`.

Read the complete Task 6 I-1 remediation section and global stop conditions in
`docs/superpowers/plans/2026-07-30-s0-pipeline-baseline.md`, plus the original Task 6
plan/brief/report, Task 6.5 plan/report, and first joint Sol binding failure.

Files:
- Modify: `test/test-database-isolation.test.ts`
- Modify: `test/eval-database-isolation.test.ts`
- Create:
  `.superpowers/sdd/2026-07-30-s0-pipeline-baseline/task-6-binding-fix-report.md`

You are not alone in the repository. Preserve all other work and untracked review
artifacts. Do not modify production wrapper/application code, H3, configuration, packages,
Make, workflow, scripts, migrations, or protected data/settings.

Required exact success trace:

~~~text
plan
provision
set:DATABASE_URL
bootstrap:migrate:test
bootstrap:closeDb
spawn
child:0
dispose
~~~

Required exact bootstrap-failure trace:

~~~text
plan
provision
set:DATABASE_URL
bootstrap:migrate:test:fail
bootstrap:closeDb
dispose
~~~

Add test-only injected observations proving separate migrate/close ordering, owned URL
assignment, child completion before disposal, no spawn after bootstrap/close failure, and
fixed cleanup precedence when close and branded disposal both reject.

Add one real generated-target case using the real provision/dispose capabilities with an
injected bootstrap failure. Prove the exact target is present before the failure path and
absent afterward, no child spawned, and the primary bootstrap error remains when cleanup
succeeds. Never touch or busy the source template.

Run the complete joint gate list from the plan, read-only residue/source activity checks,
role posture, exact implementation/protected scope proofs, and process cleanup checks.
Write the dedicated fix report and commit exact message
`test: prove owned bootstrap cleanup order`. Stop instead of expanding scope on any plan
conflict, production change need, real target leak, source-template touch, non-fixed
cleanup precedence, provider egress, protected change, failed gate, or residue.
