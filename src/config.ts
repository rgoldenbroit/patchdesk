import type { ModelSelection } from "@cursor/sdk";

/** Model that decides whether each vulnerable package is actually reachable. */
export const TRIAGE_MODEL: ModelSelection = { id: "composer-2.5" };

/** Model that will edit the repo once a person has approved a fix. */
export const FIX_MODEL: ModelSelection = { id: "composer-2.5" };

/** How many times the fix agent may try before PatchDesk gives up on that package. */
export const MAX_FIX_ATTEMPTS = 2;
