import path from 'node:path';
import { isProjectEnabled, loadConfig, projectPathKey } from '../core/config.mjs';
import { createHcClient, parseTerminalAddress, sanitizeSingleLineTrigger } from './hc.mjs';
import {
  INBOX_DELIVERED_RETENTION_MS,
  ackMessage,
  countInboxMessages,
  deleteHeldMessages,
  describeRetention,
  drainInbox,
  enqueueMessage,
  peekInbox,
} from './inbox.mjs';
import { isValidTerminalId, listSavedSessions, readSavedSession, validateTerminalId } from '../revive/tracker.mjs';
import { isSubagentCaller } from '../mcp/tools.mjs';

// How long an explicit relay_inbox(action="ack") waits for a hook that is delivering the same terminal's
// messages at that moment (hooks themselves never wait for the lock).
const ACK_LOCK_WAIT_MS = 500;

// Why a wake trigger is never typed into a tab, whatever the wake policy: keyed by `activity`.
const NEVER_WAKE_REASONS = Object.freeze({
  not_live: 'target_not_live',
  shell: 'target_is_bare_shell',
  error: 'target_error',
});

/**
 * `wakeReason` of a wake trigger that `hc send` refused, keyed by the code the hc client reports (see
 * `HC_TARGET_ERROR_CODES` in hc.mjs). These describe the target tab, not a failure of hc; every other
 * failure is `hc_send_failed`.
 */
export const SEND_REFUSED_WAKE_REASONS = Object.freeze({
  HC_TARGET_BLOCKED: 'target_blocked', // the tab waits on a dialog (typing would answer it)
  HC_STATUS_MISMATCH: 'target_status_changed', // `--if idle` no longer matched: the status changed after it was read
  HC_TARGET_FINISHED: 'target_not_live', // the terminal ended
  HC_TARGET_NOT_FOUND: 'target_not_live', // there is no such terminal (any more)
});

// "24 hours": how long a message a hook injected is kept, in the words the tool descriptions use.
const RETENTION_TEXT = describeRetention(INBOX_DELIVERED_RETENTION_MS);

// Comparison key of a folder: its real path (junctions and symlinks resolved, lower-cased on Windows),
// so a tab that reached the same folder through a junction is the same project.
function pathKey(p) {
  if (typeof p !== 'string' || !p.trim()) return '';
  try {
    return projectPathKey(p.trim());
  } catch {
    return '';
  }
}

function resolveProjectSessions(store, projectEnabled) {
  if (!projectEnabled || !store || typeof store.getOverview !== 'function') return [];
  try {
    const ov = store.getOverview({ includeGlobal: false });
    return Array.isArray(ov?.sessions) ? ov.sessions : [];
  } catch {
    return [];
  }
}

function buildWakeTrigger({ messageId, fromTerminalId, contextDocs }) {
  const from = fromTerminalId || 'peer';
  const docsHint = Array.isArray(contextDocs) && contextDocs.length > 0
    ? ` (${contextDocs.length} doc${contextDocs.length === 1 ? '' : 's'})`
    : '';
  return sanitizeSingleLineTrigger(
    `[relay] Message ${messageId} from ${from}${docsHint} — check hook context or run relay_inbox(action="peek") if not shown`,
  );
}

function remoteTerminalError(toolName, rawAddress, machine) {
  return {
    isError: true,
    errorCode: 'REMOTE_TERMINAL_UNSUPPORTED',
    data: {
      error: 'REMOTE_TERMINAL_UNSUPPORTED',
      tool: toolName,
      terminal_id: rawAddress,
      machine,
      message: `Terminal "${rawAddress}" is on another machine ("${machine}"). Relay works only between tabs on the `
        + 'same machine: the inbox is a local file on this machine and is not read by tabs elsewhere.',
    },
  };
}

/**
 * Create the 3 Herdr relay MCP tools: relay_tabs, relay_send, relay_inbox.
 * All three refuse to work (`PROJECT_EXCLUDED`) when the session's current project is excluded by the
 * herdr-cortex configuration. The inbox lives in the global store (`<globalDir>/state/inbox/<terminalId>/`),
 * so nothing is created inside any project folder and project approval is not involved.
 */
export function createRelayTools({
  projectDir = process.cwd(),
  globalDir,
  legacyHome,
  hcClient = null,
  store = null,
  projectEnabled = null,
  getCurrentTerminalId = () => (process.env.HC_TERMINAL_ID || '').trim(),
} = {}) {
  const hc = hcClient || createHcClient();
  const resolvedProjectDir = path.resolve(projectDir);
  const currentProjectKey = pathKey(resolvedProjectDir);

  const isCurrentProjectEnabled = () => {
    if (typeof projectEnabled === 'boolean') return projectEnabled;
    const cfg = store?.config || loadConfig({ projectDir: resolvedProjectDir, globalDir });
    return isProjectEnabled(resolvedProjectDir, cfg);
  };

  const projectExcludedError = (toolName) => ({
    isError: true,
    errorCode: 'PROJECT_EXCLUDED',
    data: {
      error: 'PROJECT_EXCLUDED',
      tool: toolName,
      project_dir: resolvedProjectDir,
      message: `Project "${resolvedProjectDir}" is excluded by herdr-cortex configuration; ${toolName} is disabled.`,
    },
  });

  const isSameProject = (cwd) => Boolean(cwd) && Boolean(currentProjectKey) && pathKey(cwd) === currentProjectKey;

  const relayTabsTool = {
    name: 'relay_tabs',
    description: 'List live Herdr terminals combined with saved revive sessions and project memory session mapping. '
      + 'activity is idle | working | done | blocked | error | unknown | shell | not_live (the status words of hc; blockedKind says why a blocked tab waits: permission, question or auth); '
      + 'tabs on another machine are listed with remote: true and cannot receive relay messages. '
      + `pendingInboxCount = messages waiting to be injected, heldInboxCount = messages already injected and kept for ${RETENTION_TEXT}.`,
    inputSchema: {
      type: 'object',
      properties: {
        only_same_project: { type: 'boolean', default: false },
      },
    },
    async handler(args) {
      if (!isCurrentProjectEnabled()) {
        return projectExcludedError('relay_tabs');
      }

      const currentTerminalId = getCurrentTerminalId();
      const savedList = listSavedSessions({ globalDir, legacyHome });
      const savedById = new Map(savedList.map((s) => [s.terminalId, s]));
      const projectSessions = resolveProjectSessions(store, true);

      const lsRes = hc.listTerminals();
      const tabs = [];

      if (lsRes.ok) {
        for (const t of lsRes.terminals) {
          const tid = t.terminalId;
          // A tab on another machine ("pc2/t3") is shown, but it has no inbox here and its folder is a
          // path on that machine, so it is never "the same project" and never relay-capable.
          const remote = Boolean(t.remote);
          const relayCapable = !remote && isValidTerminalId(tid);
          const saved = relayCapable ? savedById.get(tid) || null : null;
          const tabCwd = t.cwd || saved?.cwd || '';
          const sameProject = !remote && isSameProject(tabCwd);

          if (args.only_same_project && !sameProject) continue;

          // pending: waiting to be injected; held: already injected by a hook and kept for a while
          let pendingInboxCount = 0;
          let heldInboxCount = 0;
          if (relayCapable) {
            try {
              const counts = countInboxMessages(tid, { globalDir });
              pendingInboxCount = counts.pending;
              heldInboxCount = counts.held;
            } catch {
              pendingInboxCount = 0;
              heldInboxCount = 0;
            }
          }

          // Why a blocked tab waits (hc: permission, question or auth). `hc ls` prints only the status word,
          // so a blocked tab of this machine is asked for once more with `hc get`; null when hc does not say.
          let blockedKind = t.blocked && t.blockedKind ? t.blockedKind : null;
          if (t.blocked && !blockedKind && relayCapable) {
            try {
              const got = hc.getTerminal(tid);
              if (got.ok && got.status?.blocked && got.status.blockedKind) blockedKind = got.status.blockedKind;
            } catch {
              blockedKind = null;
            }
          }

          tabs.push({
            terminalId: tid,
            isCurrent: Boolean(currentTerminalId) && tid === currentTerminalId,
            remote,
            ...(remote ? { machine: t.machine } : {}),
            relayCapable,
            live: t.live,
            state: t.state,
            activity: t.activity,
            idle: t.idle,
            busy: t.busy,
            done: Boolean(t.done),
            blockedKind,
            statusUnknown: Boolean(t.unknown),
            agent: t.agentName || saved?.agent || '',
            isBareShell: t.isBareShell,
            where: t.where,
            cwd: tabCwd,
            sameProject,
            pendingInboxCount,
            heldInboxCount,
            savedSession: saved
              ? {
                  agent: saved.agent,
                  sessionId: saved.sessionId,
                  previousSessionId: saved.previousSessionId || null,
                  updatedAt: saved.updatedAt || '',
                  source: saved.source || 'cortex',
                }
              : null,
          });
        }
      }

      return {
        currentTerminalId: currentTerminalId || null,
        projectDir: resolvedProjectDir,
        hcAvailable: lsRes.ok,
        ...(lsRes.ok ? {} : { hcError: lsRes.error, hcErrorCode: lsRes.code }),
        tabs,
        savedSessions: savedList.map((s) => ({
          terminalId: s.terminalId,
          agent: s.agent,
          sessionId: s.sessionId,
          previousSessionId: s.previousSessionId || null,
          cwd: s.cwd || '',
          sameProject: isSameProject(s.cwd),
          updatedAt: s.updatedAt || '',
          source: s.source || 'cortex',
        })),
        projectSessions,
      };
    },
  };

  const relaySendTool = {
    name: 'relay_send',
    description: 'Send a message (with optional context_docs IDs) to another Herdr terminal on this machine via atomic file inbox, optionally sending a short single-line wake trigger via hc send.',
    writeProtected: true,
    inputSchema: {
      type: 'object',
      required: ['to_terminal_id', 'message'],
      properties: {
        to_terminal_id: { type: 'string', description: 'Target Herdr HC_TERMINAL_ID (a tab on this machine)' },
        message: { type: 'string', description: 'Full message body (stored safely in file inbox)' },
        context_docs: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional cortex memory document IDs for recipient reference',
        },
        wake: {
          type: 'string',
          enum: ['auto', 'always', 'never'],
          default: 'auto',
          description: 'Wake policy via hc send: auto (only when the target agent is idle or done), always (also while it is working; never into a bare shell, a tab that is not live, or one in an error state), or never',
        },
        from_terminal_id: { type: 'string', description: 'Optional sender terminal ID override' },
      },
    },
    async handler(args) {
      if (!isCurrentProjectEnabled()) {
        return projectExcludedError('relay_send');
      }

      const targetAddress = parseTerminalAddress(args.to_terminal_id);
      if (targetAddress.remote) {
        return remoteTerminalError('relay_send', String(args.to_terminal_id).trim(), targetAddress.machine);
      }

      const toTerminalId = validateTerminalId(args.to_terminal_id);
      const message = typeof args.message === 'string' ? args.message : '';
      if (!message.trim()) {
        return {
          isError: true,
          data: { error: 'EMPTY_MESSAGE', message: 'relay_send requires a non-empty "message"' },
        };
      }

      const wake = args.wake || 'auto';
      if (!['auto', 'always', 'never'].includes(wake)) {
        return {
          isError: true,
          data: { error: 'INVALID_WAKE', message: `Invalid wake "${wake}": expected auto, always, or never` },
        };
      }

      const fromTerminalId = typeof args.from_terminal_id === 'string' && args.from_terminal_id.trim()
        ? validateTerminalId(args.from_terminal_id)
        : getCurrentTerminalId();

      const contextDocs = Array.isArray(args.context_docs)
        ? [...new Set(args.context_docs.map((d) => String(d).trim()).filter(Boolean))]
        : [];

      // The target tab's project (hc get -> saved revive session -> current project) decides one thing only:
      // a tab working in an excluded project gets no relay messages. Nothing is written into that folder.
      const getRes = hc.getTerminal(toTerminalId);
      const savedTarget = readSavedSession(toTerminalId, { globalDir, legacyHome });
      const rawTargetDir =
        (getRes?.ok && getRes.status?.cwd ? getRes.status.cwd : '')
        || (savedTarget?.cwd ? savedTarget.cwd : '')
        || resolvedProjectDir;
      const targetProjectDir = path.resolve(rawTargetDir);

      const targetConfig = loadConfig({ projectDir: targetProjectDir, globalDir });
      if (!isProjectEnabled(targetProjectDir, targetConfig)) {
        return {
          isError: true,
          errorCode: 'TARGET_PROJECT_EXCLUDED',
          data: {
            error: 'TARGET_PROJECT_EXCLUDED',
            to_terminal_id: toTerminalId,
            target_project_dir: targetProjectDir,
            message: `Target project "${targetProjectDir}" is excluded by herdr-cortex configuration.`,
          },
        };
      }

      const enqueued = enqueueMessage(
        toTerminalId,
        {
          from_terminal_id: fromTerminalId,
          message,
          context_docs: contextDocs,
        },
        { globalDir },
      );

      const trigger = buildWakeTrigger({
        messageId: enqueued.id,
        fromTerminalId,
        contextDocs,
      });

      let woke = false;
      let wakeReason = 'wake_disabled';
      let wakeError = null;
      let triggerSent = null;

      const sendTrigger = (options, sentReason) => {
        const sendRes = hc.sendTrigger(toTerminalId, trigger, options);
        if (sendRes.ok) {
          woke = true;
          wakeReason = sentReason;
          triggerSent = sendRes.sent;
        } else {
          // hc refuses to type into a tab that is waiting on a dialog (typing would answer the dialog), whose
          // status no longer is what `--if` asked for, or that has ended: that is the tab's state, not a
          // failure of hc.
          wakeReason = SEND_REFUSED_WAKE_REASONS[sendRes.code] || 'hc_send_failed';
          wakeError = sendRes.error;
        }
      };

      if (wake !== 'never') {
        const target = getRes.ok ? getRes.status : null;
        if (!target) {
          // Without the tab's state nothing can rule out a bare shell: do not type.
          wakeReason = 'hc_unavailable';
          wakeError = getRes.error;
        } else if (NEVER_WAKE_REASONS[target.activity]) {
          wakeReason = NEVER_WAKE_REASONS[target.activity];
        } else if (wake === 'always') {
          // Also while the agent is working: the trigger is queued behind its current turn.
          sendTrigger({}, 'sent_always');
        } else if (target.blocked) {
          wakeReason = 'target_blocked';
        } else if (target.busy) {
          wakeReason = 'target_busy';
        } else if (target.idle) {
          // `--if idle`: hc types only if the status still is exactly "idle" when the text goes in.
          sendTrigger({ ifIdle: true }, 'sent_auto_idle');
        } else if (target.done) {
          // "done": the agent finished and waits. `--if` knows only "idle" and "working" and matches the
          // word exactly, so this send carries no condition (hc itself still refuses a blocked tab).
          sendTrigger({}, 'sent_auto_done');
        } else {
          // The status could not be interpreted: unknown is neither busy nor idle.
          wakeReason = 'target_status_unknown';
        }
      }

      return {
        queued: true,
        messageId: enqueued.id,
        to_terminal_id: toTerminalId,
        from_terminal_id: fromTerminalId || null,
        target_project_dir: targetProjectDir,
        context_docs: contextDocs,
        wakeRequested: wake,
        woke,
        wakeReason,
        ...(triggerSent ? { triggerSent } : {}),
        ...(wakeError ? { wakeError } : {}),
      };
    },
  };

  const relayInboxTool = {
    name: 'relay_inbox',
    description: 'Inspect (peek: full message bodies, announced/delivered flags) or acknowledge (ack) incoming Herdr relay messages for the current HC_TERMINAL_ID. '
      + `A message a hook injected is kept for ${RETENTION_TEXT} as delivered; it is listed only with include_delivered=true.`,
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['peek', 'ack'], default: 'peek' },
        message_id: { type: 'string', description: 'Message ID to acknowledge (a pending or a delivered message), or "all" to acknowledge all pending messages, when action="ack"' },
        include_delivered: {
          type: 'boolean',
          default: false,
          description: 'peek: also list the messages a hook already injected and that are still kept (delivered: true). ack with message_id="all": also delete those.',
        },
        terminal_id: { type: 'string', description: 'Optional terminal ID override (defaults to HC_TERMINAL_ID)' },
      },
    },
    async handler(args, meta = {}) {
      const action = args.action || 'peek';
      if (action === 'ack' && isSubagentCaller(args, meta)) {
        return {
          isError: true,
          errorCode: 'SUBAGENT_WRITE_DENIED',
          data: {
            error: 'SUBAGENT_WRITE_DENIED',
            tool: 'relay_inbox',
            message: 'Subagents cannot acknowledge/delete relay inbox messages; use action="peek" only.',
          },
        };
      }
      if (!isCurrentProjectEnabled()) {
        return projectExcludedError('relay_inbox');
      }

      const rawTerminalId = typeof args.terminal_id === 'string' && args.terminal_id.trim()
        ? args.terminal_id.trim()
        : getCurrentTerminalId();

      if (!rawTerminalId) {
        return {
          isError: true,
          data: {
            error: 'MISSING_TERMINAL_ID',
            message: 'HC_TERMINAL_ID is not set and no terminal_id was provided.',
          },
        };
      }

      const address = parseTerminalAddress(rawTerminalId);
      if (address.remote) {
        return remoteTerminalError('relay_inbox', rawTerminalId, address.machine);
      }
      const terminalId = validateTerminalId(rawTerminalId);
      // `projectDir` only lets the inbox move what this (approved, enabled) project still keeps in the old
      // per-project location; the messages themselves are in the global store.
      const inboxOptions = { globalDir, projectDir: resolvedProjectDir };

      const includeDelivered = args.include_delivered === true;

      if (action === 'peek') {
        return peekInbox(terminalId, { ...inboxOptions, includeDelivered });
      }

      if (action === 'ack') {
        const msgId = typeof args.message_id === 'string' ? args.message_id.trim() : '';
        if (!msgId) {
          return {
            isError: true,
            data: {
              error: 'MISSING_MESSAGE_ID',
              message: 'relay_inbox(action="ack") requires "message_id" (or "all").',
            },
          };
        }
        const busyMessage = 'Another process is delivering this terminal\'s messages right now; nothing was acknowledged. Call again.';
        if (msgId === 'all') {
          const drained = drainInbox(terminalId, { ...inboxOptions, lockWaitMs: ACK_LOCK_WAIT_MS });
          const ackRes = drained.ack();
          // Delivered messages are deleted only on request; without it they stay until their retention ends.
          const heldIds = includeDelivered && !drained.busy ? deleteHeldMessages(terminalId, { globalDir }) : [];
          return {
            acked: ackRes.acked + heldIds.length > 0,
            ackedCount: ackRes.acked + heldIds.length,
            terminalId,
            messageIds: [...drained.messages.map((m) => m.id), ...heldIds],
            ...(includeDelivered ? { deliveredAckedCount: heldIds.length } : {}),
            notices: drained.notices,
            ...(drained.busy ? { busy: true, message: busyMessage } : {}),
          };
        }
        const ackRes = ackMessage(terminalId, msgId, { ...inboxOptions, lockWaitMs: ACK_LOCK_WAIT_MS });
        return ackRes.busy ? { ...ackRes, message: busyMessage } : ackRes;
      }

      return {
        isError: true,
        data: { error: 'INVALID_ACTION', message: `Invalid action "${action}": expected "peek" or "ack"` },
      };
    },
  };

  return [relayTabsTool, relaySendTool, relayInboxTool];
}
