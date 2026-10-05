Station 0 (Define) for {{repo}}. Work only on the branch `claude/define`, and open one draft
pull request from it to `main` for the Owner.

{{input}}

1. If `.factory/define/questions.md` was not committed on `claude/define` in this run, ask the
   Owner up to 5 questions in one batch there (`Q1. …`), commit them in one commit, push,
   open the draft pull request, and stop.
2. If `.factory/define/answers.md` does not answer every question yet, stop: the Owner has
   not answered.
3. Otherwise write `.factory/brief.md`, the walking skeleton from the TypeScript profile, and
   5 to 10 seed issues listed in `.factory/define/backlog.md`, as your role file says. Commit,
   push `claude/define`, and stop. Write your result before waiting on the Owner.
