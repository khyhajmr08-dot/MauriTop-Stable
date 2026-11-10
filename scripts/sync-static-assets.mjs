import { cp, mkdir, access } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const source = path.join(root, "dist");
const target = path.join(root, "public");

await access(path.join(source, "index.html"));
await mkdir(target, { recursive: true });
await cp(source, target, {
  recursive: true,
  force: true,
  filter: (entry) => {
    const relative = path.relative(source, entry);
    return relative !== "server.cjs" && relative !== "server.cjs.map";
  },
});

console.log("Client assets copied to public/ for Vercel static hosting.");
