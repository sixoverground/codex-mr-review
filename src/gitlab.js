// A small GitLab REST client over fetch, for one merge request.
//
// Endpoints (GitLab REST API v4):
//   GET  /user                                               https://docs.gitlab.com/api/users/
//   GET  /projects/:id/merge_requests/:iid                   https://docs.gitlab.com/api/merge_requests/
//   GET  /projects/:id/merge_requests/:iid/discussions       https://docs.gitlab.com/api/discussions/
//   POST /projects/:id/merge_requests/:iid/discussions       (same page)
//   POST /projects/:id/merge_requests/:iid/discussions/:did/notes
//   PUT  /projects/:id/merge_requests/:iid/discussions/:did  (resolved)
//   POST /projects/:id/merge_requests/:iid/notes             https://docs.gitlab.com/api/notes/
//   POST /projects/:id/merge_requests/:iid/award_emoji       https://docs.gitlab.com/api/emoji_reactions/
//
// The token goes only in the PRIVATE-TOKEN header. It is never put in a
// URL, a body or an error message, and every body this client sends passes
// through the redactor first. Redirects are never followed: fetch would
// resend the header to wherever the redirect points, so any 3xx is an
// error naming only the status and the target's origin.

export const REQUEST_TIMEOUT_MS = 30_000;
const PER_PAGE = 100;
const MAX_PAGES = 100;
const ERROR_TEXT_LIMIT = 300;

// " to <origin>" for a redirect's Location, never its path or query, which
// could carry anything.
function redirectOrigin(res, url) {
  const location = res.headers.get("location");
  if (!location) return "";
  try {
    return ` to ${new URL(location, url).origin}`;
  } catch {
    return " to an unparseable location";
  }
}

export class GitLabError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

// baseUrl: the instance, such as https://gitlab.com (no /api/v4).
// project: a numeric id or a "group/project" path.
export function createClient({ baseUrl, token, project, mr, redact = (s) => s, fetchImpl = fetch }) {
  const root = `${baseUrl.replace(/\/+$/, "")}/api/v4`;
  const mrPath = `/projects/${encodeURIComponent(String(project))}/merge_requests/${encodeURIComponent(String(mr))}`;

  async function request(method, path, { body, query } = {}) {
    const url = new URL(root + path);
    for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, String(v));
    const headers = { "PRIVATE-TOKEN": token, Accept: "application/json" };
    let payload;
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = redact(JSON.stringify(body));
    }
    let res;
    try {
      res = await fetchImpl(url, {
        method,
        headers,
        body: payload,
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      throw new GitLabError(`${method} ${path} failed: ${err.message}`, null);
    }
    if (res.status >= 300 && res.status < 400 || res.type === "opaqueredirect") {
      await res.body?.cancel();
      throw new GitLabError(`${method} ${path} was redirected (${res.status || "3xx"})${redirectOrigin(res, url)}; redirects are not followed`, res.status);
    }
    const text = await res.text();
    if (!res.ok) {
      const detail = redact(text.slice(0, ERROR_TEXT_LIMIT)).replace(/\s+/g, " ").trim();
      throw new GitLabError(`${method} ${path} returned ${res.status}${detail ? `: ${detail}` : ""}`, res.status);
    }
    let data = null;
    if (text !== "") {
      try {
        data = JSON.parse(text);
      } catch {
        throw new GitLabError(`${method} ${path} returned a body that is not JSON`, res.status);
      }
    }
    return { data, headers: res.headers };
  }

  async function paginate(path) {
    const all = [];
    let page = "1";
    for (let i = 0; i < MAX_PAGES && page; i++) {
      const { data, headers } = await request("GET", path, { query: { per_page: PER_PAGE, page } });
      if (!Array.isArray(data)) throw new GitLabError(`GET ${path} did not return a list`, null);
      all.push(...data);
      page = headers.get("x-next-page") || "";
    }
    if (page) throw new GitLabError(`GET ${path} has more than ${MAX_PAGES} pages`, null);
    return all;
  }

  return {
    async currentUser() {
      return (await request("GET", "/user")).data;
    },
    async getMergeRequest() {
      return (await request("GET", mrPath)).data;
    },
    async listDiscussions() {
      return paginate(`${mrPath}/discussions`);
    },
    // position is optional; without it the thread is a general one.
    async createDiscussion(body, position) {
      return (await request("POST", `${mrPath}/discussions`, { body: position ? { body, position } : { body } })).data;
    },
    async replyToDiscussion(discussionId, body) {
      return (await request("POST", `${mrPath}/discussions/${encodeURIComponent(discussionId)}/notes`, { body: { body } })).data;
    },
    async setDiscussionResolved(discussionId, resolved) {
      return (await request("PUT", `${mrPath}/discussions/${encodeURIComponent(discussionId)}`, { body: { resolved } })).data;
    },
    async createNote(body) {
      return (await request("POST", `${mrPath}/notes`, { body: { body } })).data;
    },
    async awardEmoji(name) {
      return (await request("POST", `${mrPath}/award_emoji`, { body: { name } })).data;
    },
  };
}
