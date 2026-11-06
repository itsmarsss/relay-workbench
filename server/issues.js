import { basename } from 'node:path';
import { runProcess } from './process.js';
import { requireValue, text } from './domain.js';

const fields = [
  'title',
  'body',
  'url',
  'number',
  'author',
  'createdAt',
  'updatedAt',
  'state',
  'labels',
  'assignees',
  'milestone',
];
const markdown = (value) =>
  String(value ?? '')
    .replace(/[\\`*_{}\[\]<>#]/g, '\\$&')
    .replace(/[\r\n]+/g, ' ');
const name = (person) =>
  typeof person === 'string' ? person : person?.login || person?.name || 'Unknown author';
function link(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.href.replaceAll('(', '%28').replaceAll(')', '%29') : '';
  } catch {
    return '';
  }
}
export function issueInvocation(command, ticket) {
  const args = command.args.map((arg) => arg.replaceAll('{ticket}', ticket));
  const github = basename(command.command) === 'gh' && args[0] === 'issue' && args[1] === 'view';
  if (github) {
    const index = args.findIndex((arg) => arg === '--json' || arg.startsWith('--json='));
    const existing =
      index < 0 ? '' : args[index] === '--json' ? args[index + 1] || '' : args[index].slice(7);
    const requested = [...new Set([...existing.split(',').filter(Boolean), ...fields])].join(',');
    if (index < 0) args.push('--json', requested);
    else if (args[index] === '--json') args.splice(index + 1, 1, requested);
    else args[index] = `--json=${requested}`;
  }
  return { command: command.command, args, github };
}
export function issueDescription(issue) {
  const body = text(issue.body ?? issue.description ?? '', 'Issue body', 50000, true);
  const metadata = [];
  if (issue.author) metadata.push(`Filed by: **${markdown(name(issue.author))}**`);
  for (const [label, value] of [
    ['Status', issue.state],
    ['Created', issue.createdAt ?? issue.created_at],
    ['Updated', issue.updatedAt ?? issue.updated_at],
  ])
    if (value) metadata.push(`${label}: ${markdown(value)}`);
  for (const [label, values] of [
    ['Labels', issue.labels],
    ['Assignees', issue.assignees],
  ])
    if (Array.isArray(values) && values.length)
      metadata.push(`${label}: ${values.map((value) => markdown(name(value))).join(', ')}`);
  if (issue.milestone)
    metadata.push(`Milestone: ${markdown(issue.milestone.title ?? issue.milestone)}`);
  const url = link(issue.url);
  if (metadata.length && url) metadata.unshift(`Source: ${url}`);
  const comments = Array.isArray(issue.comments) ? issue.comments : issue.comments?.nodes;
  if (issue.comments?.totalCount !== undefined)
    requireValue(
      Array.isArray(comments) && issue.comments.totalCount <= comments.length,
      'Importer returned an incomplete issue discussion',
      502,
    );
  const parts = [body];
  if (metadata.length)
    parts.push(`## Issue context\n\n${metadata.map((value) => `- ${value}`).join('\n')}`);
  if (Array.isArray(comments)) {
    parts.push(`## Issue discussion (${comments.length} comments)`);
    if (!comments.length) parts.push('No comments at import time.');
    for (const comment of comments) {
      requireValue(
        comment && typeof comment === 'object' && typeof comment.body === 'string',
        'Invalid issue comment returned by importer',
        502,
      );
      const date = comment.createdAt ?? comment.created_at;
      const updated = comment.updatedAt ?? comment.updated_at;
      const url = link(comment.url ?? comment.html_url);
      const attribution = [
        date && markdown(date),
        updated && updated !== date && `edited ${markdown(updated)}`,
        comment.authorAssociation ?? comment.author_association,
      ]
        .filter(Boolean)
        .map(markdown)
        .join(' · ');
      parts.push(
        `### ${markdown(name(comment.author ?? comment.user))}${attribution ? ` · ${attribution}` : ''}\n\n${url ? `${url}\n\n` : ''}${comment.body}`,
      );
    }
  }
  const description = parts.join('\n\n');
  requireValue(
    description.length <= 50000,
    'Full issue context exceeds the 50,000-character task description limit; nothing was truncated',
    413,
  );
  return description;
}
export async function importIssue(command, ticket, cwd, run = runProcess) {
  const invocation = issueInvocation(command, ticket);
  const result = await run(invocation.command, invocation.args, { cwd, timeout: 60000 });
  requireValue(result.code === 0, `Issue import failed: ${result.stderr.slice(-2000)}`, 502);
  let issue;
  try {
    issue = JSON.parse(result.stdout);
  } catch {
    throw new Error('Issue command must return JSON with title and body fields');
  }
  requireValue(
    issue && typeof issue === 'object' && !Array.isArray(issue),
    'Invalid issue returned by importer',
    502,
  );
  if (invocation.github) {
    const url = new URL(issue.url);
    const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/issues\/(\d+)\/?$/);
    requireValue(
      url.protocol === 'https:' && match && !url.username && !url.password && !url.port,
      'GitHub importer returned an invalid issue URL',
      502,
    );
    const [, owner, repository, number] = match;
    const comments = await run(
      invocation.command,
      [
        'api',
        '--hostname',
        url.hostname,
        '--paginate',
        '--slurp',
        `repos/${owner}/${repository}/issues/${number}/comments?per_page=100`,
      ],
      { cwd, timeout: 60000 },
    );
    requireValue(
      comments.code === 0,
      `Issue discussion import failed: ${comments.stderr.slice(-2000)}`,
      502,
    );
    let pages;
    try {
      pages = JSON.parse(comments.stdout);
    } catch {
      throw new Error('Issue discussion command returned invalid JSON');
    }
    requireValue(
      Array.isArray(pages) && pages.every(Array.isArray),
      'Invalid paginated issue discussion',
      502,
    );
    issue.comments = pages.flat();
  }
  return {
    title: text(issue.title, 'Issue title', 240),
    description: issueDescription(issue),
    ticket: typeof issue.url === 'string' ? issue.url : ticket,
    warnings:
      Array.isArray(issue.comments) || Array.isArray(issue.comments?.nodes)
        ? []
        : ['The configured importer did not provide issue comments.'],
  };
}
