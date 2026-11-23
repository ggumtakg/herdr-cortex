/**
 * FIT_STEPS progressive non-truncating overview compression.
 * Preserves P0 baselines (highest priority), open sessions/branches, active todos,
 * recent active decisions/baselines, and global preferences without mid-sentence truncation.
 */
export const FIT_STEPS = Object.freeze([
  {
    name: 'full',
    maxP0Baselines: 10,
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
    maxP0Baselines: 10,
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
    maxP0Baselines: 8,
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
    maxP0Baselines: 8,
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
    maxP0Baselines: 6,
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
    maxP0Baselines: 5,
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
  if (step.compactLines) {
    return `- [${w.id}] (${w.type}) ${oneLine(w.title)}`;
  }
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
  const p0Baselines = overviewData?.p0Baselines || [];
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

  // Highest priority: active P0 baselines
  const secP0 = renderSection(
    '## P0 Baselines',
    p0Baselines,
    step.maxP0Baselines ?? 8,
    (d) => formatDecisionLine(d, step),
  );
  if (secP0.lines.length > 0) blocks.push(secP0.lines);

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

  let secWork = renderSection(
    '## Recent Worklogs & Knowledge',
    recentWork,
    step.maxRecentWork,
    (w) => formatWorkLine(w, step),
  );
  if (secWork.lines.length > 0) blocks.push(secWork.lines);

  const hasAnyItems =
    p0Baselines.length > 0
    || sessions.length > 0
    || todos.length > 0
    || decisions.length > 0
    || globalPreferences.length > 0
    || recentWork.length > 0;

  // If ONLY recentWork exists and current step set maxRecentWork=0, render recentWork fallback instead of empty message
  if (blocks.length === 1 && recentWork.length > 0) {
    const fallbackMax = Math.max(1, step.maxDecisions || 2);
    secWork = renderSection(
      '## Recent Worklogs & Knowledge',
      recentWork,
      fallbackMax,
      (w) => formatWorkLine(w, step),
    );
    if (secWork.lines.length > 0) blocks.push(secWork.lines);
  } else if (!hasAnyItems && blocks.length === 1) {
    blocks.push(['(No active memory documents recorded yet.)']);
  }

  const text = blocks.map((b) => b.join('\n')).join('\n\n');
  return {
    text,
    omittedCounts: {
      p0Baselines: secP0.omitted,
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
 * Never skips shorter subsequent lines in a section just because line 0 was oversized.
 */
function fitByDroppingWholeLines(overviewData, budget) {
  const sections = [
    {
      heading: '## P0 Baselines',
      lines: (overviewData?.p0Baselines || []).map((d) => `- [${d.id}] (baseline) ${oneLine(d.title)}`),
    },
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
    {
      heading: '## Recent Work',
      lines: (overviewData?.recentWork || []).map((w) => `- [${w.id}] (${w.type}) ${oneLine(w.title)}`),
    },
  ].filter((s) => s.lines.length > 0);

  const outLines = ['# Cortex Memory Overview'];
  let currentLen = outLines[0].length;
  if (currentLen > budget) return '';

  for (const sec of sections) {
    let sectionAdded = false;
    for (const candidate of sec.lines) {
      const needed = sectionAdded
        ? 1 + candidate.length
        : 2 + sec.heading.length + 1 + candidate.length;
      if (currentLen + needed <= budget) {
        if (!sectionAdded) {
          outLines.push('', sec.heading);
          currentLen += 2 + sec.heading.length;
          sectionAdded = true;
        }
        outLines.push(candidate);
        currentLen += 1 + candidate.length;
      }
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
  const rawBudget = budget ?? 9000;
  const parsed = Number(rawBudget);
  const safeBudget = Number.isFinite(parsed) ? Math.max(0, parsed) : 9000;

  if (safeBudget === 0) {
    return {
      text: '',
      step: 'empty',
      charCount: 0,
      budget: 0,
      omittedCounts: null,
    };
  }

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
