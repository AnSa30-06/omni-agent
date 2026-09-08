// Prefixed random ids, matching the `rtn_` convention already used by routines.
//
// A prefix costs three characters and buys the ability to tell, from a log line
// or an error message alone, what kind of thing an id refers to.
import crypto from "node:crypto";

/** @param {string} prefix e.g. "dec" */
export function id(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString("hex")}`;
}

export const accountId = () => id("acc");
export const decisionId = () => id("dec");
export const situationId = () => id("sit");
export const signalId = () => id("sig");
export const runId = () => id("run");
export const actionId = () => id("act");
export const eventId = () => id("evt");
export const hypothesisId = () => id("hyp");
export const callId = () => id("llm");
export const workspaceId = () => id("ws");
