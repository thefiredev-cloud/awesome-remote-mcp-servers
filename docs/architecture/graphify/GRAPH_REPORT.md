# Graph Report - awesome-remote-mcp-servers  (2026-10-21)

## Corpus Check
- 6 files · ~26,562 words
- Verdict: corpus is large enough that graph structure adds value.
- Unclassified: 2 file(s) not represented in the graph (top: (none) 2)

## Summary
- 92 nodes · 107 edges · 7 communities (6 shown, 1 thin omitted)
- Extraction: 96% EXTRACTED · 4% INFERRED · 0% AMBIGUOUS · INFERRED: 4 edges (avg confidence: 0.85)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- Servers
- safe-fetch.js
- safe-fetch.test.js
- Contributing to Awesome Remote MCP Servers
- check-submission.js
- Awesome Remote MCP Servers [![Awesome](https://awesome.re/badge.svg)](https://awesome.re)

## God Nodes (most connected - your core abstractions)
1. `Servers` - 42 edges
2. `guardedRequest()` - 8 edges
3. `Awesome Remote MCP Servers [![Awesome](https://awesome.re/badge.svg)](https://awesome.re)` - 8 edges
4. `isPublicAddress()` - 5 edges
5. `makeGuardedLookup()` - 5 edges
6. `Contributing to Awesome Remote MCP Servers` - 5 edges
7. `isPublicIPv4()` - 4 edges
8. `isPublicIPv6()` - 4 edges
9. `v4ToInt()` - 3 edges
10. `parseIPv6()` - 3 edges

## Surprising Connections (you probably didn't know these)
- `probe()` --calls--> `guardedRequest()`  [EXTRACTED]
  .github/scripts/check-submission.js → .github/scripts/safe-fetch.js
- `connectorExists()` --calls--> `guardedRequest()`  [EXTRACTED]
  .github/scripts/check-submission.js → .github/scripts/safe-fetch.js
- `lookupOf()` --calls--> `makeGuardedLookup()`  [EXTRACTED]
  .github/scripts/safe-fetch.test.js → .github/scripts/safe-fetch.js

## Import Cycles
- None detected.

## Communities (7 total, 1 thin omitted)

### Community 0 - "Servers"
Cohesion: 0.05
Nodes (42): 🔗 <a name="aggregators"></a>Aggregators, 🤝 <a name="agreements--coordination"></a>Agreements & Coordination, 🌾 <a name="agriculture"></a>Agriculture, 🎨 <a name="art--design"></a>Art & Design, 🌐 <a name="browser-automation"></a>Browser Automation, ☁️ <a name="cloud-platforms"></a>Cloud Platforms, 💬 <a name="communication"></a>Communication, 📝 <a name="content-management"></a>Content Management (+34 more)

### Community 1 - "safe-fetch.js"
Cohesion: 0.21
Nodes (10): BLOCKED_SUFFIXES, BLOCKED_V4, dns, https, isPublicAddress(), isPublicIPv4(), isPublicIPv6(), net (+2 more)

### Community 2 - "safe-fetch.test.js"
Cohesion: 0.22
Nodes (6): checkUrl(), makeGuardedLookup(), assert, { isPublicAddress, checkUrl, makeGuardedLookup, guardedRequest }, lookupOf(), test

### Community 3 - "Contributing to Awesome Remote MCP Servers"
Cohesion: 0.22
Nodes (7): Contributing to Awesome Remote MCP Servers, Entry format, Glama connector badge, How to contribute, Markers, Ordering, What belongs here

### Community 4 - "check-submission.js"
Cohesion: 0.28
Nodes (6): connectorExists(), fs, { guardedRequest }, probe(), guardedRequest(), once()

### Community 5 - "Awesome Remote MCP Servers [![Awesome](https://awesome.re/badge.svg)](https://awesome.re)"
Cohesion: 0.29
Nodes (7): Awesome Remote MCP Servers [![Awesome](https://awesome.re/badge.svg)](https://awesome.re), Community, Contributing, How to connect, Legend, Related, What is a remote MCP server?

## Knowledge Gaps
- **1 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `Servers` connect `Servers` to `Awesome Remote MCP Servers [![Awesome](https://awesome.re/badge.svg)](https://awesome.re)`?**
  _High betweenness centrality (0.360) - this node is a cross-community bridge._
- **Should `Servers` be split into smaller, more focused modules?**
  _Cohesion score 0.047619047619047616 - nodes in this community are weakly interconnected._
- **Why does `Awesome Remote MCP Servers [![Awesome](https://awesome.re/badge.svg)](https://awesome.re)` connect `Awesome Remote MCP Servers [![Awesome](https://awesome.re/badge.svg)](https://awesome.re)` to `Servers`, `Contributing to Awesome Remote MCP Servers`?**
  _High betweenness centrality (0.171) - this node is a cross-community bridge._