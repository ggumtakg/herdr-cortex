/**
 * FIT_STEPS progressive non-truncating overview compression.
 * Preserves open sessions/branches, active todos, recent active decisions/baselines,
 * and global preferences without mid-sentence truncation.
 */
export const FIT_STEPS = Object.freeze([
  {
    name: 'full',
    maxSessions: 12,
    maxTodos: 20,
    maxDecisions: 18,
    maxGlobal: 15,
    maxRecentWork: 10,
    includeSummary: true,
    includeTags: true,
    compactLines: false,
  },
  {
    name: 'standard',
    maxSessions: 10,
    maxTodos: 15,
    maxDecisions: 12,
    maxGlobal: 10,
    maxRecentWork: 5,
    includeSummary: true,
    includeTags: false,
    compactLines: false,
  },
  {
    name: 'focused',
    maxSessions: 8,
    maxTodos: 12,
    maxDecisions: 8,
    maxGlobal: 8,
    maxRecentWork: 0,
    includeSummary: true,
    includeTags: false,
    compactLines: false,
  },
  {
    name: 'compact',
    maxSessions: 8,
    maxTodos: 10,
    maxDecisions: 6,
    maxGlobal: 6,
    maxRecentWork: 0,
    includeSummary: false,
    includeTags: false,
    compactLines: true,
  },
  {
    name: 'minimal',
    maxSessions: 5,
    maxTodos: 6,
    maxDecisions: 4,
    maxGlobal: 4,
    maxRecentWork: 0,
    includeSummary: false,
    includeTags: false,
    compactLines: true,
  },
  {
    name: 'essential',
    maxSessions: 3,
    maxTodos: 3,
    maxDecisions: 2,
    maxGlobal: 2,
    maxRecentWork: 0,
    includeSummary: false,
    includeTags: false,
    compactLines: true,
  },
]);

function oneLine(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function formatSessionLine(s) {
  const branches = Array.isArray(s.branches) && s.branches.length > 0
    ? ` [${s.branches.join(', ')}]`
    : '';
  return `- ${s.session}${branches} (${s.docCount || 0} docs)`;
}

function formatTodoLine(t, step) {
  const due = t.due ? ` (due:${t.due})` : '';
  const loc = t.session ? ` [${t.session}${t.branch ? `/${t.branch}` : ''}]` : '';
  if (step.compactLines) {
    return `- [${t.id}] ${oneLine(t.title)}${due}`;
  }
  const summary = step.includeSummary && t.summary ? ` — ${oneLine(t.summary)}` : '';
  return `- [${t.id}] ${oneLine(t.title)}${due}${loc}${summary}`;
}

function formatDecisionLine(d, step) {
  const kind = d.type === 'baseline' ? 'baseline' : 'decision';
  const loc = d.session ? ` [${d.session}${d.branch ? `/${d.branch}` : ''}]` : '';
  if (step.compactLines) {
    return `- [${d.id}] (${kind}) ${oneLine(d.title)}`;
  }
  const summary = step.includeSummary && d.summary ? ` — ${oneLine(d.summary)}` : '';
  const tags = step.includeTags && Array.isArray(d.tags) && d.tags.length > 0
    ? ` #${d.tags.join(' #')}`
    : '';
  return `- [${d.id}] (${kind}) ${oneLine(d.title)}${loc}${summary}${tags}`;
}

function formatGlobalLine(g, step) {
  const cat = g.category === 'preferences' ? 'pref' : 'global';
  if (step.compactLines) {
    return `- [${g.id}] (${cat}) ${oneLine(g.title)}`;
  }
  const summary = step.includeSummary && g.summary ? ` — ${oneLine(g.summary)}` : '';
  return `- [${g.id}] (${cat}) ${oneLine(g.title)}${summary}`;
}

function formatWorkLine(w, step) {
  const summary = step.includeSummary && w.summary ? ` — ${oneLine(w.summary)}` : '';
  return `- [${w.id}] (${w.type}) ${oneLine(w.title)}${summary}`;
}

function renderSection(heading, items, maxCount, formatter) {
  if (!Array.isArray(items) || items.length === 0 || maxCount <= 0) {
    return { lines: [], omitted: Array.isArray(items) ? items.length : 0 };
  }
  const taken = items.slice(0, maxCount);
  const omitted = Math.max(0, items.length - taken.length);
  const lines = [heading, ...taken.map(formatter)];
  if (omitted > 0) {
    lines.push(`- (+${omitted} more via memory_search)`);
  }
  return { lines, omitted };
}

function renderOverviewAtStep(overviewData, step) {
  const sessions = overviewData?.sessions || [];
  const todos = overviewData?.todos || [];
  const decisions = overviewData?.decisions || [];
  const recentWork = overviewData?.recentWork || [];
  const globalPreferences = overviewData?.globalPreferences || [];

  const blocks = [];
  const header = overviewData?.sessionFilter
    ? `# Cortex Memory Overview (session: ${overviewData.sessionFilter})`
    : '# Cortex Memory Overview';
  blocks.push([header]);

  const secSessions = renderSection(
    '## Active Sessions & Branches',
    sessions,
    step.maxSessions,
    (s) => formatSessionLine(s),
  );
  if (secSessions.lines.length > 0) blocks.push(secSessions.lines);

  const secTodos = renderSection(
    '## Active Todos',
    todos,
    step.maxTodos,
    (t) => formatTodoLine(t, step),
  );
  if (secTodos.lines.length > 0) blocks.push(secTodos.lines);

  const secDecisions = renderSection(
    '## Recent Active Decisions & Baselines',
    decisions,
    step.maxDecisions,
    (d) => formatDecisionLine(d, step),
  );
  if (secDecisions.lines.length > 0) blocks.push(secDecisions.lines);

  const secGlobal = renderSection(
    '## Global Preferences & Knowledge',
    globalPreferences,
    step.maxGlobal,
    (g) => formatGlobalLine(g, step),
  );
  if (secGlobal.lines.length > 0) blocks.push(secGlobal.lines);

  const secWork = renderSection(
    '## Recent Worklogs & Knowledge',
    recentWork,
    step.maxRecentWork,
    (w) => formatWorkLine(w, step),
  );
  if (secWork.lines.length > 0) blocks.push(secWork.lines);

  if (blocks.length === 1) {
    blocks.push(['(No active memory documents recorded yet.)']);
  }

  const text = blocks.map((b) => b.join('\n')).join('\n\n');
  return {
    text,
    omittedCounts: {
      sessions: secSessions.omitted,
      todos: secTodos.omitted,
      decisions: secDecisions.omitted,
      globalPreferences: secGlobal.omitted,
      recentWork: secWork.omitted,
    },
  };
}

/**
 * Drop whole lower-priority lines cleanly if even the 'essential' step exceeds a tiny budget.
 */
function fitByDroppingWholeLines(overviewData, budget) {
  const sections = [
    {
      heading: '## Sessions',
      lines: (overviewData?.sessions || []).map((s) => formatSessionLine(s)),
    },
    {
      heading: '## Todos',
      lines: (overviewData?.todos || []).map((t) => `- [${t.id}] ${oneLine(t.title)}`),
    },
    {
      heading: '## Decisions',
      lines: (overviewData?.decisions || []).map((d) => `- [${d.id}] ${oneLine(d.title)}`),
    },
    {
      heading: '## Global',
      lines: (overviewData?.globalPreferences || []).map((g) => `- [${g.id}] ${oneLine(g.title)}`),
    },
  ].filter((s) => s.lines.length > 0);

  const outLines = ['# Cortex Memory Overview'];
  let currentLen = outLines[0].length;

  for (const sec of sections) {
    const firstLine = sec.lines[0];
    const sectionHeaderCost = 2 + sec.heading.length + 1 + firstLine.length;
    if (currentLen + sectionHeaderCost > budget) continue;

    outLines.push('', sec.heading, firstLine);
    currentLen += sectionHeaderCost;

    for (let i = 1; i < sec.lines.length; i++) {
      const candidate = sec.lines[i];
      if (currentLen + 1 + candidate.length > budget) break;
      outLines.push(candidate);
      currentLen += 1 + candidate.length;
    }
  }

  const text = outLines.join('\n');
  return text.length <= budget ? text : '';
}

/**
 * Fit memory overview data into the target character budget using FIT_STEPS
 * without mid-sentence truncation.
 */
export function fitOverviewToBudget(overviewData, budget = 9000) {
  const safeBudget = Math.max(64, Number(budget) || 9000);

  for (const step of FIT_STEPS) {
    const rendered = renderOverviewAtStep(overviewData, step);
    if (rendered.text.length <= safeBudget) {
      return {
        text: rendered.text,
        step: step.name,
        charCount: rendered.text.length,
        budget: safeBudget,
        omittedCounts: rendered.omittedCounts,
      };
    }
  }

  const minimalText = fitByDroppingWholeLines(overviewData, safeBudget);
  return {
    text: minimalText,
    step: 'line-budgeted',
    charCount: minimalText.length,
    budget: safeBudget,
    omittedCounts: null,
  };
}
