import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createConnection, type Socket } from "node:net";
import type { Duplex } from "node:stream";

/** Node's standard WebSocket handles framing. A single-use loopback bridge supplies
 * its connection to the CLI's Unix socket, without an npm runtime dependency. */
export async function localSocket(path: string): Promise<{ socket: WebSocket; dispose(): void }> {
  const token = `/${randomUUID()}`;
  let upstream: Socket | undefined;
  let downstream: Duplex | undefined;
  const bridge = createServer((_request, response) => { response.writeHead(404); response.end(); });
  const dispose = (): void => { bridge.close(); upstream?.destroy(); downstream?.destroy(); };
  bridge.on("upgrade", (request, stream, head) => {
    if (request.url !== token || upstream) { stream.destroy(); return; }
    downstream = stream;
    bridge.close(); // Exactly one authenticated local connection, never a reusable listener.
    upstream = createConnection(path);
    upstream.on("error", () => stream.destroy());
    stream.on("error", () => upstream?.destroy());
    upstream.on("connect", () => {
      const headers = request.rawHeaders.reduce<string[]>((lines, value, index, all) => index % 2 ? lines : [...lines, `${value}: ${all[index + 1]}`], []);
      upstream!.write(`GET / HTTP/1.1\r\n${headers.join("\r\n")}\r\n\r\n`);
      if (head.length) upstream!.write(head);
      upstream!.pipe(stream).pipe(upstream!);
    });
  });
  await new Promise<void>((done, reject) => {
    bridge.once("error", reject);
    bridge.listen(0, "127.0.0.1", done);
  });
  const address = bridge.address();
  if (address === null || typeof address === "string") { dispose(); throw new Error("No local bridge address"); }
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}${token}`);
  try {
    await new Promise<void>((done, reject) => {
      const timer = setTimeout(() => reject(new Error("Local Codex WebSocket handshake timed out")), 10_000);
      socket.addEventListener("open", () => { clearTimeout(timer); done(); }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Cannot connect to the local Codex socket")); }, { once: true });
    });
    return { socket, dispose };
  } catch (error) { dispose(); throw error; }
}
