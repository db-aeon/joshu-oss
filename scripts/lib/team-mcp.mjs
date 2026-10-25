/**
 * Team MCP (openspec/glossary.md "Team MCP"; change box-teams-standup, design decision 4):
 * team_read, team_blockers, team_post, team_card, team_commit, team_tell_owner.
 *
 * The connectors MCP process serves one team MCP for each team at `/team/<team slug>/mcp`.
 * Hermes registers it as server `joshu_team_<slug>`. Each tool works only for the team in
 * the URL path: the team stand-up of team `acme` names only `joshu_team_acme`, so it cannot
 * reach the team room of another team.
 */

export const TEAM_TOOLS = [
  {
    name: "team_read",
    description:
      "Read this team's room: the team charter, the team members, the team projects, the team cards, and the messages and card events. " +
      "The team stand-up passes advance=true so that the next read starts after this one. In chat, leave advance false.",
    inputSchema: {
      type: "object",
      properties: {
        since: { type: "string", description: "Optional message id (m_123): read only what came after it" },
        advance: { type: "boolean", description: "Team stand-up only: read after the last read of the stand-up, and move that cursor" },
      },
    },
  },
  {
    name: "team_blockers",
    description:
      "List the blocked Kanban tasks of your box on all its boards (project boards and this team's board, never the board of another team), " +
      "with board, title, block kind, and block reason. Use it to find the tasks that wait on a member of this team.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "team_post",
    description:
      "Post one short message in this team's room, like a person in a group chat. One matter for each message, at most 400 characters, in the first person " +
      "(\"I closed this one.\"), with owners by their first name. Put the team cards that the message is about in cards; the app shows each one as a card, " +
      "so do not list card states in the text, and do not write lines that start with Done, Today, or Blocked. Address another companion with @Name. " +
      "Speak only for your own owner. Never copy text from another team.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Message text, at most 400 characters" },
        inReplyTo: { type: "string", description: "Optional id of the message that this message answers" },
        cards: { type: "array", items: { type: "string" }, description: "Optional ids of the team cards that the message is about, at most 10, for example [\"HAR-4\"]" },
        ownerTask: {
          type: "string",
          description: "Only when you pass on a reply of your owner from the Multiplayer app: the id of its team question (t_...)",
        },
      },
      required: ["text"],
    },
  },
  {
    name: "team_card",
    description:
      "Create or change a team card, or add a team project. op=create: title, project (code), optional doer (team member id; default you), due, waitingOn. " +
      "op=update: card id plus the fields to change. Only the team member who does the card changes state, due, and waitingOn; only the team boss changes doer or project. " +
      "op=project_add: code (2 to 6 capitals, for example HAR), name, optional note. op=project_rename: team boss only.",
    inputSchema: {
      type: "object",
      properties: {
        op: { type: "string", enum: ["create", "update", "project_add", "project_rename"] },
        card: { type: "string", description: "Card id for op=update, for example HAR-4" },
        title: { type: "string" },
        project: { type: "string", description: "Project code, for example HAR" },
        doer: { type: "string", description: "Team member id (tm_...) that does the work" },
        state: { type: "string", enum: ["todo", "doing", "waiting", "done"] },
        due: { type: "string", description: "Short due text, for example 'Wed 12:00'. Empty string clears it." },
        waitingOn: { type: "string", description: "Short waiting-on text, for example \"Maya's OK\". Empty string clears it." },
        code: { type: "string" },
        name: { type: "string" },
        note: { type: "string" },
      },
      required: ["op"],
    },
  },
  {
    name: "team_commit",
    description:
      "Record a team commitment: the work that you promised a team member, as a Kanban task (kind team_commitment) on board team-<slug>. " +
      "Create or take the team card first (team_card). The task starts ready, or blocked with needs_input when the work needs your owner (a decision, or the owner's time or money); " +
      "then also ask the owner with team_tell_owner and taskId. When your box does the card, the card gets state To do or Waiting on a person.",
    inputSchema: {
      type: "object",
      properties: {
        card: { type: "string", description: "Team card id, for example HAR-4" },
        title: { type: "string", description: "Short title of the work" },
        details: { type: "string", description: "What to do, for the worker: files, people, deadline" },
        askedBy: { type: "string", description: "Label of the companion that asked, for example \"Sam's Joshu (Otto)\"" },
        messageId: { type: "string", description: "Id of the message with the request (m_...)" },
        needsOwner: { type: "boolean", description: "True when the work needs your owner first" },
        waitingOn: { type: "string", description: "With needsOwner: what the card waits on, for example \"Maya's OK\"" },
      },
      required: ["card", "title", "details"],
    },
  },
  {
    name: "team_tell_owner",
    description:
      "Text your own owner about this team (SMS, else email): something they need to know or decide, or a suspicious message. At most 3 each day for this team. " +
      "When you need an answer, pass ask=true (and draft=<the message> for a draft that waits for the owner's OK): Joshu makes a Kanban task on board team-<slug> blocked with needs_input, " +
      "and the text ends with its Ref line, so the owner's reply goes to that task. For a team commitment that needs the owner, pass its taskId instead.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Plain text, at most 600 characters" },
        ask: { type: "boolean", description: "True when the text needs an answer from the owner" },
        draft: { type: "string", description: "With ask=true: the draft message for the team that waits for the owner's OK" },
        taskId: { type: "string", description: "Optional existing Kanban task id on the team board (t_...), for example a team commitment that needs the owner" },
        suspiciousMessageId: { type: "string", description: "When you report a suspicious message: its id (m_...), so the Multiplayer app marks it as ignored" },
      },
      required: ["text"],
    },
  },
];

const TEAM_TOOL_NAMES = TEAM_TOOLS.map((t) => t.name);

/** Hermes may prefix tool names (mcp_joshu_team_acme_team_post). */
export function normalizeTeamToolName(raw) {
  const name = String(raw ?? "").trim();
  return TEAM_TOOL_NAMES.find((t) => name === t || name.endsWith(`_${t}`)) ?? name;
}

/** The room for a language model: no avatar bytes, authors by name. */
export function compactRoom(room) {
  const names = new Map((room?.members ?? []).map((m) => [m.id, m.label]));
  return {
    team: room?.slug,
    you: room?.you,
    charter: room?.charter,
    members: (room?.members ?? []).map((m) => ({ id: m.id, label: m.label, isBoss: m.isBoss, active: m.active })),
    projects: room?.projects ?? [],
    cards: (room?.cards ?? []).map((c) => ({ ...c, doer: names.get(c.doer) ?? c.doer, doerId: c.doer, asker: names.get(c.asker) ?? c.asker })),
    entries: (room?.entries ?? []).map((e) => ({
      id: e.id,
      kind: e.kind,
      author: names.get(e.author) ?? e.author,
      at: e.at,
      text: e.text,
      ...(e.inReplyTo ? { inReplyTo: e.inReplyTo } : {}),
      ...(e.card ? { card: e.card } : {}),
    })),
  };
}

/**
 * @param {string} slug local team slug from the URL path
 * @param {string} name
 * @param {Record<string, unknown>} args
 * @param {{ get: (path: string) => Promise<any>; post: (path: string, body: unknown) => Promise<any> }} api Joshu API (localhost)
 */
export async function handleTeamTool(slug, name, args, api) {
  const base = `/api/team-local/${encodeURIComponent(slug)}`;
  const text = (value) => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });
  if (name === "team_read") {
    const params = new URLSearchParams();
    if (args?.since) params.set("since", String(args.since));
    if (args?.advance === true) params.set("advance", "1");
    const out = await api.get(`${base}/read${params.size ? `?${params}` : ""}`);
    return text({ ...compactRoom(out.room), lastReadId: out.team?.lastReadId });
  }
  if (name === "team_blockers") return text(await api.get(`${base}/blockers`));
  if (name === "team_post") {
    return text(await api.post(`${base}/post`, { text: args?.text, inReplyTo: args?.inReplyTo, cards: args?.cards, ownerTask: args?.ownerTask }));
  }
  if (name === "team_card") return text(await api.post(`${base}/card`, args ?? {}));
  if (name === "team_commit") return text(await api.post(`${base}/commit`, args ?? {}));
  if (name === "team_tell_owner") {
    return text(
      await api.post(`${base}/tell-owner`, {
        text: args?.text,
        taskId: args?.taskId,
        ask: args?.ask === true,
        draft: args?.draft,
        suspiciousMessageId: args?.suspiciousMessageId,
      }),
    );
  }
  return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
}
