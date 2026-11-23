import path from 'node:path';
import { isProjectEnabled, loadConfig } from '../core/config.mjs';
import { createHcClient, sanitizeSingleLineTrigger } from './hc.mjs';
import { ackMessage, drainInbox, enqueueMessage, peekInbox } from './inbox.mjs';
import { isValidTerminalId, listSavedSessions, readSavedSession, validateTerminalId } from '../revive/tracker.mjs';
import { isSubagentCaller } from '../mcp/tools.mjs';

function normalizePathKey(p) {
  if (typeof p !== 'string' || !p.trim()) return '';
  return path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
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

/**
 * Create the 3 Herdr relay MCP tools: relay_tabs, relay_send, relay_inbox.
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
  const projectPathKey = normalizePathKey(resolvedProjectDir);

  const isCurrentProjectEnabled = () => {
    if (typeof projectEnabled === 'boolean') return projectEnabled;
    const cfg = store?.config || loadConfig({ projectDir: resolvedProjectDir, globalDir });
    return isProjectEnabled(resolvedProjectDir, cfg);
  };

  const relayTabsTool = {
    name: 'relay_tabs',
    description: 'List live Herdr terminals combined with saved revive sessions and project memory session mapping.',
    inputSchema: {
      type: 'object',
      properties: {
        only_same_project: { type: 'boolean', default: false },
      },
    },
    async handler(args) {
      const currentTerminalId = getCurrentTerminalId();
      const savedList = listSavedSessions({ globalDir, legacyHome });
      const savedById = new Map(savedList.map((s) => [s.terminalId, s]));
      const projectSessions = resolveProjectSessions(store, isCurrentProjectEnabled());

      const lsRes = hc.listTerminals();
      const tabs = [];

      if (lsRes.ok) {
        for (const t of lsRes.terminals) {
          const tid = t.terminalId;
          const saved = tid ? savedById.get(tid) || null : null;
          const tabCwd = t.cwd || saved?.cwd || '';
          const sameProject = Boolean(tabCwd) && normalizePathKey(tabCwd) === projectPathKey;

          if (args.only_same_project && !sameProject) continue;

          let pendingInboxCount = 0;
          if (tid && isValidTerminalId(tid)) {
            try {
              pendingInboxCount = peekInbox(tabCwd || resolvedProjectDir, tid).count;
            } catch {
              pendingInboxCount = 0;
            }
          }

          tabs.push({
            terminalId: tid,
            isCurrent: Boolean(currentTerminalId) && tid === currentTerminalId,
            live: t.live,
            state: t.state,
            idle: t.idle,
            busy: t.busy,
            agent: t.agentName || saved?.agent || '',
            isBareShell: t.isBareShell,
            where: t.where,
            cwd: tabCwd,
            sameProject,
            pendingInboxCount,
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
          sameProject: Boolean(s.cwd) && normalizePathKey(s.cwd) === projectPathKey,
          updatedAt: s.updatedAt || '',
          source: s.source || 'cortex',
        })),
        projectSessions,
      };
    },
  };

  const relaySendTool = {
    name: 'relay_send',
    description: 'Send a message (with optional context_docs IDs) to another Herdr terminal via atomic file inbox, optionally sending a short single-line wake trigger via hc send.',
    writeProtected: true,
    inputSchema: {
      type: 'object',
      required: ['to_terminal_id', 'message'],
      properties: {
        to_terminal_id: { type: 'string', description: 'Target Herdr HC_TERMINAL_ID' },
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
          description: 'Wake policy via hc send: auto (only when target is live & idle), always, or never',
        },
        from_terminal_id: { type: 'string', description: 'Optional sender terminal ID override' },
      },
    },
    async handler(args) {
      if (!isCurrentProjectEnabled()) {
        return {
          isError: true,
          errorCode: 'PROJECT_EXCLUDED',
          data: {
            error: 'PROJECT_EXCLUDED',
            project_dir: resolvedProjectDir,
            message: `Project "${resolvedProjectDir}" is excluded by herdr-cortex configuration; relay_send is disabled.`,
          },
        };
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

      // Resolve target terminal's project directory from hc get -> saved revive session -> current projectDir
      const getRes = hc.getTerminal(toTerminalId);
      const savedTarget = readSavedSession(toTerminalId, { globalDir, legacyHome });
      const rawTargetDir =
        (getRes?.ok && getRes.status?.cwd ? getRes.status.cwd : '')
        || (savedTarget?.cwd ? savedTarget.cwd : '')
        || resolvedProjectDir;
      const targetProjectDir = path.resolve(rawTargetDir);

      // Never write inbox files or create .memory/ inside an excluded target project
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

      const enqueued = enqueueMessage(targetProjectDir, toTerminalId, {
        from_terminal_id: fromTerminalId,
        message,
        context_docs: contextDocs,
      });

      const trigger = buildWakeTrigger({
        messageId: enqueued.id,
        fromTerminalId,
        contextDocs,
      });

      let woke = false;
      let wakeReason = 'wake_disabled';
      let wakeError = null;
      let triggerSent = null;

      if (wake === 'always') {
        const sendRes = hc.sendTrigger(toTerminalId, trigger);
        if (sendRes.ok) {
          woke = true;
          wakeReason = 'sent_always';
          triggerSent = sendRes.sent;
        } else {
          wakeReason = 'hc_send_failed';
          wakeError = sendRes.error;
        }
      } else if (wake === 'auto') {
        if (!getRes.ok) {
          wakeReason = 'hc_unavailable';
          wakeError = getRes.error;
        } else if (!getRes.status.live) {
          wakeReason = 'target_not_live';
        } else if (getRes.status.isBareShell === true) {
          wakeReason = 'target_is_bare_shell';
        } else if (getRes.status.blocked) {
          wakeReason = 'target_blocked';
        } else if (getRes.status.error) {
          wakeReason = 'target_error';
        } else if (getRes.status.busy || !getRes.status.idle) {
          wakeReason = 'target_busy';
        } else {
          const sendRes = hc.sendTrigger(toTerminalId, trigger, { ifIdle: true });
          if (sendRes.ok) {
            woke = true;
            wakeReason = 'sent_auto_idle';
            triggerSent = sendRes.sent;
          } else {
            wakeReason = 'hc_send_failed';
            wakeError = sendRes.error;
          }
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
    description: 'Inspect (peek) or acknowledge (ack) incoming Herdr relay messages for the current HC_TERMINAL_ID.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['peek', 'ack'], default: 'peek' },
        message_id: { type: 'string', description: 'Message ID to acknowledge (or "all" to acknowledge all pending messages) when action="ack"' },
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

      const terminalId = validateTerminalId(rawTerminalId);

      if (action === 'peek') {
        return peekInbox(resolvedProjectDir, terminalId);
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
        if (msgId === 'all') {
          const drained = drainInbox(resolvedProjectDir, terminalId);
          const ackRes = drained.ack();
          return {
            acked: ackRes.acked > 0,
            ackedCount: ackRes.acked,
            terminalId,
            messageIds: drained.messages.map((m) => m.id),
            notices: drained.notices,
          };
        }
        return ackMessage(resolvedProjectDir, terminalId, msgId);
      }

      return {
        isError: true,
        data: { error: 'INVALID_ACTION', message: `Invalid action "${action}": expected "peek" or "ack"` },
      };
    },
  };

  return [relayTabsTool, relaySendTool, relayInboxTool];
}
