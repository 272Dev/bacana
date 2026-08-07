const dateFormatter = new Intl.DateTimeFormat('pt-BR', {
  timeZone: 'America/Sao_Paulo',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric'
});

export function formatChangeLogDate(value) {
  const date = new Date(value || Date.now());
  return Number.isNaN(date.getTime()) ? dateFormatter.format(new Date()) : dateFormatter.format(date);
}

export function formatChangeLogText(changeLog) {
  const changes = Array.isArray(changeLog?.changes) ? changeLog.changes : [];
  return [
    'NEXUS — CHANGE LOG',
    `Version ${changeLog?.version || 'unknown'}`,
    formatChangeLogDate(changeLog?.publishedAt || changeLog?.published_at),
    '',
    ...changes.map((change) => `• ${change}`)
  ].join('\n');
}
