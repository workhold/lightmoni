/** These failures require new ownership/configuration evidence, not a replay. */
export const recoveryBlocked = (code:string) => /(?:ownership|unowned|unsafe|layout_mismatch|invalid_managed_state|authorization|binding_changed|revision_conflict|invalid_resource_id|legacy_website_evidence_required|invalid_website_cleanup_scope)/i.test(code);
export const recoveryFailureLimit = 5;
