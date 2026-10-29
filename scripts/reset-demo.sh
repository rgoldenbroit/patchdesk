#!/bin/bash
# Resets the demo: removes PatchDesk worktrees, closes its open PRs, deletes its branches.
set -e
PORTAL=~/dev/active/hvmc-patient-portal
rm -rf ~/dev/active/patchdesk/worktrees
cd "$PORTAL"
git worktree prune
for n in $(gh pr list --state open --json number,headRefName --jq '.[] | select(.headRefName | startswith("patchdesk/")) | .number'); do
  gh pr close "$n" --delete-branch
done
for b in $(git branch --list 'patchdesk/*' --format='%(refname:short)'); do git branch -D "$b"; done
git switch main
echo "Demo reset: no PatchDesk PRs, branches or worktrees."
