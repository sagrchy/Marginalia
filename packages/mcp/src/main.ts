import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { openDb, resolveDataDir } from "@marginalia/db";
import { createMcpServer } from "./server";

// stdout carries the MCP protocol; log only to stderr.
const dataDir = resolveDataDir();
const db = openDb(dataDir);
const server = createMcpServer(db);
await server.connect(new StdioServerTransport());
console.error(`marginalia mcp: serving ${dataDir}`);
