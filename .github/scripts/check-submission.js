'use strict';
// Unprivileged half of the submission check. Runs with a read-only token and
// performs every network probe of contributor-supplied URLs through safe-fetch.
// It never writes to GitHub: it returns {add, remove, comments} for the
// privileged report job, which applies them after allowlisting.

const fs = require('node:fs');
const { guardedRequest } = require('./safe-fetch.js');

const MAX_PROBES = 25;
const CLIP = 300;
const clip = (s) => (String(s).length > CLIP ? `${String(s).slice(0, CLIP)}…` : String(s));

module.exports = async function checkSubmission({ github, context }) {
  const { owner, repo } = context.repo;
  const issue_number = context.payload.pull_request.number;

  const readme = fs.readFileSync('README.md', 'utf8');
  const existingEndpoints = new Set(
    [...readme.matchAll(/`(https:\/\/[^`\s]+)`/g)].map(m => m[1].replace(/\/+$/, '').toLowerCase())
  );

  const { data: files } = await github.rest.pulls.listFiles({
    owner, repo, pull_number: issue_number, per_page: 100,
  });

  const addedLines = files
    .filter(f => f.filename === 'README.md' && f.patch)
    .flatMap(f => f.patch.split('\n'))
    .filter(l => l.startsWith('+') && !l.startsWith('+++'))
    .map(l => l.slice(1));

  // Reassemble multi-line entries from the diff
  const HEAD = /^-\s*\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)\s+`(https?:\/\/[^`\s]+)`\s*$/;
  const BADGE = /^\s+\[!\[[^\]]*\]\(https:\/\/glama\.ai\/mcp\/connectors\/([^/)\s]+\/[^/)\s]+)\/badges\/score\.svg\)\]\(([^)\s]+)\)\s*$/;
  const MARKS = /^\s+([🔓🔑🔐][\s\S]*?)\s+-\s+(\S.*)$/u;

  const entries = [];
  for (const line of addedLines) {
    const h = line.match(HEAD);
    if (h) { entries.push({ name: h[1], home: h[2], endpoint: h[3], badge: null, marks: null, desc: null }); continue; }
    const cur = entries[entries.length - 1];
    if (!cur) continue;
    const b = line.match(BADGE);
    if (b) { cur.badge = b[1]; continue; }
    const m = line.match(MARKS);
    if (m) { cur.marks = m[1].trim(); cur.desc = m[2].trim(); }
  }

  // Only look at entries whose endpoint is not already listed
  const fresh = entries.filter(e => !existingEndpoints.has(e.endpoint.replace(/\/+$/, '').toLowerCase()));
  const duplicates = entries.filter(e => existingEndpoints.has(e.endpoint.replace(/\/+$/, '').toLowerCase()));

  const AUTH = ['🔓', '🔑', '🔐'];

  const formatProblems = [];
  for (const e of fresh) {
    if (!e.marks || !e.desc) {
      formatProblems.push(`\`${clip(e.name)}\` – missing the marker/description line (\`  🔐 - What it does.\`)`);
      continue;
    }
    if (!AUTH.some(a => e.marks.includes(a))) {
      formatProblems.push(`\`${clip(e.name)}\` – needs an auth marker (🔓 none, 🔑 API key, or 🔐 OAuth)`);
    }
    const unknown = [...e.marks].filter(ch =>
      /\p{Extended_Pictographic}/u.test(ch) &&
      !AUTH.some(k => k.includes(ch))
    );
    if (unknown.length) {
      formatProblems.push(`\`${clip(e.name)}\` – unrecognized marker(s): ${unknown.join(' ')}`);
    }
    if (!/\.$/.test(e.desc)) {
      formatProblems.push(`\`${clip(e.name)}\` – description should end with a period`);
    }
  }

  // Probe each endpoint with a real MCP initialize handshake.
  // No credentials are sent; only the response shape is inspected.
  // Endpoints are contributor-controlled, so every request goes through the
  // SSRF guard in safe-fetch.js (https/443, DNS names only, public addresses
  // only, validated connect address, re-validated redirects).
  const initBody = JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: {
      protocolVersion: '2025-06-18', capabilities: {},
      clientInfo: { name: 'awesome-remote-mcp-servers-ci', version: '1.0.0' },
    },
  });

  async function probe(url) {
    try {
      const res = await guardedRequest(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json, text/event-stream',
          'MCP-Protocol-Version': '2025-06-18',
          'User-Agent': 'awesome-remote-mcp-servers-ci/1.0',
        },
        body: initBody,
        timeoutMs: 20000,
      });
      if (res.status === 401 || res.status === 403) {
        const wa = String(res.headers['www-authenticate'] || '');
        return { ok: true, auth: /resource_metadata|Bearer/i.test(wa) ? '🔐' : '🔑', status: res.status };
      }
      const text = res.text.slice(0, 20000);
      const payload = text.includes('data:')
        ? text.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('')
        : text;
      let json = null;
      try { json = JSON.parse(payload); } catch {}
      if (json && json.result) return { ok: true, auth: '🔓', status: res.status };
      return { ok: false, status: res.status, why: `no initialize result (HTTP ${res.status})` };
    } catch (err) {
      return { ok: false, why: String(err.message || err).slice(0, 120) };
    }
  }

  const SLUG = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
  async function connectorExists(slug) {
    if (!SLUG.test(slug) || slug.split('/').includes('..')) return false;
    try {
      const res = await guardedRequest(`https://glama.ai/mcp/connectors/${slug}`, {
        method: 'GET',
        headers: { 'User-Agent': 'awesome-remote-mcp-servers-ci/1.0' },
        allowHosts: ['glama.ai'],
        maxBytes: 1024,
        timeoutMs: 20000,
      });
      return res.status === 200;
    } catch { return false; }
  }

  const unreachable = [];
  const authMismatch = [];
  const badBadges = [];

  for (const [i, e] of fresh.entries()) {
    if (i >= MAX_PROBES) {
      unreachable.push(`\`${clip(e.endpoint)}\` – not probed: more than ${MAX_PROBES} new entries in one PR`);
      continue;
    }
    const r = await probe(e.endpoint);
    if (!r.ok) {
      unreachable.push(`\`${clip(e.endpoint)}\` – ${r.why}`);
    } else if (e.marks && !e.marks.includes(r.auth)) {
      authMismatch.push(`\`${clip(e.endpoint)}\` – responded with ${r.auth}, entry says ${clip(e.marks)}`);
    }
    if (e.badge && !(await connectorExists(e.badge))) {
      badBadges.push(`\`${clip(e.badge)}\` – no such connector on Glama`);
    }
  }

  const hasConnector = fresh.length > 0 && fresh.every(e => e.badge);
  const endpointOk = unreachable.length === 0;
  const formatOk = formatProblems.length === 0 && badBadges.length === 0;

  const add = [], remove = [];
  (endpointOk ? add : remove).push('endpoint-ok');
  (endpointOk ? remove : add).push('endpoint-unreachable');
  (hasConnector ? add : remove).push('has-connector');
  (hasConnector ? remove : add).push('missing-connector');
  (formatOk ? remove : add).push('invalid-format');
  (duplicates.length ? add : remove).push('duplicate');

  const comments = [];
  const say = (id, body) => comments.push({ id, body });

  if (unreachable.length) {
    say('endpoint-check', `We could not complete an MCP \`initialize\` handshake against:

${unreachable.map(u => `- ${u}`).join('\n')}

Only servers that answer a handshake are listed. If the endpoint needs an account, it should still return \`401\` with a \`WWW-Authenticate\` header — a timeout or \`404\` means the URL is wrong.`);
  }

  if (authMismatch.length) {
    say('auth-check', `The auth marker does not match what the endpoint returned:

${authMismatch.map(u => `- ${u}`).join('\n')}

Please correct the marker: 🔓 none, 🔑 API key, 🔐 OAuth.`);
  }

  if (formatProblems.length) {
    say('format-check', `Please fix the entry format:

${formatProblems.map(u => `- ${u}`).join('\n')}

Expected shape:

\`\`\`markdown
- [Name](https://homepage.example) \\\`https://mcp.example.com/mcp\\\`
  [![Name MCP connector](https://glama.ai/mcp/connectors/com.example/name/badges/score.svg)](https://glama.ai/mcp/connectors/com.example/name)
  🔐 - One sentence describing what the tools do.
\`\`\`

See [CONTRIBUTING.md](../blob/main/CONTRIBUTING.md).`);
  }

  if (badBadges.length) {
    say('badge-check', `These connector badges do not resolve:

${badBadges.map(u => `- ${u}`).join('\n')}

The slug is the reverse-DNS identifier from your connector's URL on [glama.ai/mcp/connectors](https://glama.ai/mcp/connectors), e.g. \`io.tseha/tseha\`.`);
  }

  if (!hasConnector && fresh.length > 0) {
    say('connector-check', `Your entry is missing its [Glama connector](https://glama.ai/mcp/connectors) badge. Every entry needs one — it shows tool definition quality and endpoint health, so readers can tell a maintained server from an abandoned one.

List your server at [glama.ai/mcp/connectors](https://glama.ai/mcp/connectors) if it is not there yet, then add the badge as the second line of your entry:

\`\`\`markdown
[![NAME MCP connector](https://glama.ai/mcp/connectors/NAMESPACE/NAME/badges/score.svg)](https://glama.ai/mcp/connectors/NAMESPACE/NAME)
\`\`\`

PRs without a badge are not merged. Questions welcome here or on [Discord](https://glama.ai/mcp/discord).`);
  }

  if (duplicates.length) {
    say('duplicate-check', `These endpoints are already listed:

${duplicates.map(e => `- \`${clip(e.endpoint)}\``).join('\n')}

Please remove the duplicate entries.`);
  }

  return { add, remove, comments };
};
