// A local HTTP server standing in for the parts of the GitLab REST API the
// tool uses. It keeps merge request state in memory and records every
// request, so a test can assert exactly what was sent.

import { createServer } from "node:http";
import { randomBytes } from "node:crypto";

export const MOCK_TOKEN = "glpat-mock-reviewer-token-0123456789";

export const POSITION_ERROR = {
  message: "400 Bad request - Note {:line_code=>[\"can't be blank\", \"must be a valid line code\"]}",
};

// options:
//   token           the token the server accepts in PRIVATE-TOKEN
//   user            what GET /user returns
//   mr              what GET /projects/:id/merge_requests/:iid returns
//   rejectPosition  (position) => true to answer a positioned thread
//                   with a 400, as GitLab does for a line outside the diff
//   fail            (method, path) => status to answer with instead, or
//                   { status, body } to choose the error body too
//   redirect        (method, path) => a URL to answer with a 302 to
export async function startMockGitLab({
  token = MOCK_TOKEN,
  user = { id: 7, username: "reviewer-bot" },
  mr = {},
  rejectPosition = () => false,
  fail = () => null,
  redirect = () => null,
} = {}) {
  const state = { requests: [], discussions: [], notes: [], awards: [], user, mr, rejectPosition, fail, redirect };
  const nextId = () => randomBytes(20).toString("hex");

  const server = createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (d) => { raw += d; });
    req.on("end", () => {
      const url = new URL(req.url, "http://mock");
      const record = { method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, raw, body: null };
      try { record.body = raw ? JSON.parse(raw) : null; } catch { record.body = raw; }
      state.requests.push(record);
      const send = (status, data, headers = {}) => {
        res.writeHead(status, { "Content-Type": "application/json", ...headers });
        res.end(data === undefined ? "" : JSON.stringify(data));
      };
      const to = state.redirect(req.method, url.pathname);
      if (to) return send(302, { message: "302 Found" }, { Location: to });
      if (req.headers["private-token"] !== token) return send(401, { message: "401 Unauthorized" });
      const forced = state.fail(req.method, url.pathname);
      if (forced && typeof forced === "object") return send(forced.status, forced.body);
      if (forced) return send(forced, { message: `${forced} forced by the test` });

      const p = url.pathname;
      const mrMatch = /^\/api\/v4\/projects\/([^/]+)\/merge_requests\/(\d+)(\/.*)?$/.exec(p);
      if (req.method === "GET" && p === "/api/v4/user") return send(200, state.user);
      if (!mrMatch) return send(404, { message: "404 Not Found" });
      const rest = mrMatch[3] ?? "";
      const body = record.body ?? {};

      if (req.method === "GET" && rest === "") return send(200, state.mr);
      if (req.method === "GET" && rest === "/discussions") {
        const perPage = Number(url.searchParams.get("per_page") ?? 20);
        const page = Number(url.searchParams.get("page") ?? 1);
        const slice = state.discussions.slice((page - 1) * perPage, page * perPage);
        const more = page * perPage < state.discussions.length;
        return send(200, slice, { "x-next-page": more ? String(page + 1) : "" });
      }
      if (req.method === "POST" && rest === "/discussions") {
        if (body.position && state.rejectPosition(body.position)) return send(400, POSITION_ERROR);
        const discussion = {
          id: nextId(),
          individual_note: false,
          notes: [{ id: state.requests.length, body: body.body, author: state.user, resolvable: true, resolved: false, position: body.position ?? null }],
        };
        state.discussions.push(discussion);
        return send(201, discussion);
      }
      const d = /^\/discussions\/([0-9a-f]+)(\/notes)?$/.exec(rest);
      if (d) {
        const discussion = state.discussions.find((x) => x.id === d[1]);
        if (!discussion) return send(404, { message: "404 Discussion Not Found" });
        if (req.method === "POST" && d[2]) {
          const note = { id: state.requests.length, body: body.body, author: state.user, resolvable: true, resolved: discussion.notes[0].resolved };
          discussion.notes.push(note);
          return send(201, note);
        }
        if (req.method === "PUT" && !d[2]) {
          for (const n of discussion.notes) n.resolved = body.resolved === true;
          return send(200, discussion);
        }
      }
      if (req.method === "POST" && rest === "/notes") {
        const note = { id: state.requests.length, body: body.body, author: state.user, system: false };
        state.notes.push(note);
        return send(201, note);
      }
      if (req.method === "POST" && rest === "/award_emoji") {
        state.awards.push(body.name);
        return send(201, { id: state.awards.length, name: body.name });
      }
      return send(404, { message: "404 Not Found" });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    state,
    // Method and path of every request, for "exactly these requests".
    calls: () => state.requests.map((r) => `${r.method} ${r.path.replace(/^\/api\/v4\/projects\/[^/]+\/merge_requests\/\d+/, "MR")}`),
    // Marks every thread resolved, as a person clicking "Resolve" would.
    resolveAll() {
      for (const d of state.discussions) for (const n of d.notes) n.resolved = true;
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
