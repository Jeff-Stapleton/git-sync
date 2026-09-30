/** Turn raw git/network failures into something a person can act on. Never includes the token. */
export function friendlyError(e: unknown, token = ""): string {
  const raw = e instanceof Error ? e.message : String(e);
  const statusCode = (e as { data?: { statusCode?: number } } | undefined)?.data?.statusCode;
  const text = `${statusCode ?? ""} ${raw}`;

  let msg: string;
  if (/\b(401|403)\b|Authentication failed|could not read Username|Invalid username or password|Permission to .* denied/i.test(text)) {
    msg = "Authentication failed. Check the access token and that it can read and write this repository.";
  } else if (/\b404\b|Repository not found|does not appear to be a git repository/i.test(text)) {
    msg = "Repository not found. Check the origin URL (a private repo also reports this for a bad token).";
  } else if (/exceeds GitHub's file size limit|GH001|file size limit|too large/i.test(text)) {
    msg = "The host rejected the push because a file is too large (GitHub's limit is 100 MB).";
  } else if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ECONNRESET|EAI_AGAIN|Could not resolve host|Failed to fetch|Network|Unable to connect|net::ERR/i.test(text)) {
    msg = "Can't reach the git host. Are you offline?";
  } else {
    msg = raw.trim().slice(0, 300);
  }
  return redact(msg, token);
}

export function redact(text: string, token: string): string {
  return token.length >= 4 ? text.split(token).join("***") : text;
}
