import { execFileSync, spawn } from "child_process";
import { mkdtempSync } from "fs";
import { createServer, IncomingMessage, Server } from "http";
import { AddressInfo } from "net";
import { tmpdir } from "os";
import { join } from "path";

export interface TestRemote {
  url: string;
  token: string;
  /** Requests rejected for a missing/wrong token. */
  unauthorized: number;
  close(): Promise<void>;
}

const readBody = (req: IncomingMessage) =>
  new Promise<Buffer>((res, rej) => {
    const c: Buffer[] = [];
    req.on("data", (d) => c.push(d));
    req.on("end", () => res(Buffer.concat(c)));
    req.on("error", rej);
  });

/** Smart-HTTP git server over `git http-backend`, requiring `Authorization: Basic x-access-token:<token>`. */
export async function startRemote(token = "test-token"): Promise<TestRemote> {
  const root = mkdtempSync(join(tmpdir(), "git-http-"));
  const repo = join(root, "repo.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", repo]);
  execFileSync("git", ["config", "http.receivepack", "true"], { cwd: repo });
  const expected = "Basic " + Buffer.from(`x-access-token:${token}`).toString("base64");

  const remote: TestRemote = { url: "", token, unauthorized: 0, close: async () => {} };
  const server: Server = createServer(async (req, res) => {
    if (req.headers.authorization !== expected) {
      remote.unauthorized++;
      res.writeHead(401, { "WWW-Authenticate": 'Basic realm="git"' }).end();
      return;
    }
    const body = await readBody(req);
    const u = new URL(req.url!, "http://x");
    const cgi = spawn("git", ["http-backend"], {
      env: {
        PATH: process.env.PATH,
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: "1",
        REQUEST_METHOD: req.method,
        PATH_INFO: u.pathname,
        QUERY_STRING: u.search.slice(1),
        CONTENT_TYPE: req.headers["content-type"] ?? "",
        CONTENT_LENGTH: String(body.length),
        HTTP_CONTENT_ENCODING: (req.headers["content-encoding"] as string) ?? "",
        REMOTE_USER: "test",
        REMOTE_ADDR: "127.0.0.1",
      },
    });
    const out: Buffer[] = [];
    cgi.stdout.on("data", (d) => out.push(d));
    cgi.stdin.on("error", () => {});
    cgi.stdin.end(body);
    cgi.on("close", () => {
      const raw = Buffer.concat(out);
      const sep = raw.indexOf("\r\n\r\n");
      const head = raw.subarray(0, sep).toString().split("\r\n");
      const headers: Record<string, string> = {};
      let status = 200;
      for (const line of head) {
        const i = line.indexOf(":");
        const k = line.slice(0, i), v = line.slice(i + 1).trim();
        if (k.toLowerCase() === "status") status = parseInt(v, 10);
        else headers[k] = v;
      }
      res.writeHead(status, headers).end(raw.subarray(sep + 4));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  remote.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/repo.git`;
  remote.close = () => new Promise((r) => server.close(() => r()));
  return remote;
}
