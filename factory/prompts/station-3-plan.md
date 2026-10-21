Station 3 (Plan) for {{repo}}, work item #{{issue}}, tier {{tier}}.

Feature folder: {{feature}}/ on the branch `{{branch}}`, which is checked out.

Work only in that folder. Commit and push nothing: when you stop, the factory commits your
output. Your hand-off files are `{{feature}}/plan.md` and `{{feature}}/tasks.md`; write your
result there before you end your session or wait on the Owner. Do the steps below in order.

{{commands}}

## Step 4: fix the analysis findings

If the previous step left questions open, end your session.

Fix the findings of step 3 within your own files: `plan.md`, `research.md`, `data-model.md`,
`quickstart.md`, `contracts/` and `tasks.md` in the feature folder. Never change `spec.md`. A
finding you cannot fix there goes at the top of `plan.md` for the Owner. Then end your session
with one short message: the files written, and the findings fixed and left.
