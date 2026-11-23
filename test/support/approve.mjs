// Test setup: approve a project folder the way a user does it with `cortex-trust approve` and a Yes in the
// confirmation dialog, without the command line and without any dialog. The folder is added to the approvals
// list and to the acknowledged list, so the hooks have no "approvals changed without the dialog" warning to
// show. Tests that are about such a change call `approveProject` (approvals list only) themselves.
import { acknowledgeApproval, approveProject } from '../../src/core/trust.mjs';

export function approveAsUser(projectDir, { globalDir, now } = {}) {
  const approved = approveProject(projectDir, { globalDir, ...(now ? { now } : {}) });
  acknowledgeApproval(approved.path, { globalDir });
  return approved;
}
