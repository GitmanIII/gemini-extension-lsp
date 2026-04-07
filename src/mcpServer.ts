import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { LspClient } from "./LspClient.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// --- LspServerManager ---
interface UserSettings {
  lsp?: {
    [extension: string]: { command: string; args: string[] };
  };
}

class LspServerManager {
  private activeServers: Map<string, LspClient> = new Map();
  private settings: UserSettings = {};

  constructor() {
    this.loadSettings();
  }

  private loadSettings() {
    const settingsPath = path.join(os.homedir(), ".gemini", "settings.json");
    try {
      if (fs.existsSync(settingsPath)) {
        const content = fs.readFileSync(settingsPath, "utf-8");
        this.settings = JSON.parse(content);
      }
    } catch (err) {
      console.error("Failed to load settings from ~/.gemini/settings.json", err);
    }
  }

  public async getServerForFile(filePath: string): Promise<LspClient> {
    const ext = path.extname(filePath);
    if (this.activeServers.has(ext)) {
      return this.activeServers.get(ext)!;
    }

    const config = this.settings.lsp?.[ext];
    if (!config) {
      throw new Error(
        `No LSP configured for extension '${ext}'. ` +
        `Please configure it in ~/.gemini/settings.json under 'lsp' key. ` +
        `Example: { "lsp": { ".ts": { "command": "typescript-language-server", "args": ["--stdio"] } } }`
      );
    }

    const client = new LspClient(config.command, config.args);
    client.start();
    
    // Initialize the server
    await client.sendRequest("initialize", {
      processId: process.pid,
      rootUri: `file://${process.cwd()}`,
      capabilities: {}
    });
    client.sendNotification("initialized", {});

    this.activeServers.set(ext, client);
    return client;
  }
}

// --- Token Compression Middleware ---
function compressDocumentSymbols(symbols: any[]): string {
  if (!Array.isArray(symbols)) return "No symbols found.";
  
  const formattedSymbols: string[] = [];
  
  function processSymbol(sym: any, indent = "") {
    // kind 12 is Function, 5 is Class, 6 is Method, etc in LSP Spec
    const kindMap: Record<number, string> = {
      1: "File",
      2: "Module",
      3: "Namespace",
      4: "Package",
      5: "Class",
      6: "Method",
      7: "Property",
      8: "Field",
      9: "Constructor",
      10: "Enum",
      11: "Interface",
      12: "Function",
      13: "Variable",
      14: "Constant",
      15: "String",
      16: "Number",
      17: "Boolean",
      18: "Array",
      19: "Object",
      20: "Key",
      21: "Null",
      22: "EnumMember",
      23: "Struct",
      24: "Event",
      25: "Operator",
      26: "TypeParameter"
    };
    
    const kindStr = kindMap[sym.kind] || "Symbol";
    const line = sym.range?.start?.line ?? sym.location?.range?.start?.line ?? "?";
    
    formattedSymbols.push(`${indent}[${kindStr}] ${sym.name} (Line ${line})`);
    
    if (sym.children && Array.isArray(sym.children)) {
      sym.children.forEach((child: any) => processSymbol(child, indent + "  "));
    }
  }

  symbols.forEach(sym => processSymbol(sym));
  return formattedSymbols.join("\n");
}

function compressLocations(locations: any | any[]): string {
  if (!locations) return "No locations found.";
  const locArray = Array.isArray(locations) ? locations : [locations];
  
  if (locArray.length === 0) return "No locations found.";
  
  return locArray.map(loc => {
    const uri = loc.uri?.replace("file://", "") || "unknown file";
    const line = loc.range?.start?.line ?? "?";
    return `${uri} (Line ${line})`;
  }).join("\n");
}

function compressHover(hover: any): string {
  if (!hover || !hover.contents) return "No hover information found.";
  
  let content = "";
  if (typeof hover.contents === "string") {
    content = hover.contents;
  } else if (hover.contents.value) {
    content = hover.contents.value;
  } else if (Array.isArray(hover.contents)) {
    content = hover.contents.map((c: any) => typeof c === "string" ? c : c.value).join("\n");
  }
  
  return content.trim();
}

// --- MCP Server Setup ---
const server = new McpServer({
  name: "gemini-extension-lsp",
  version: "0.1.0"
});

const serverManager = new LspServerManager();

// Helper to open a file before running commands that require the file to be open
async function ensureFileOpen(client: LspClient, filePath: string) {
    const uri = `file://${path.resolve(filePath)}`;
    try {
        const text = fs.readFileSync(filePath, "utf-8");
        client.sendNotification("textDocument/didOpen", {
            textDocument: {
                uri,
                languageId: path.extname(filePath).replace('.', '') || 'text',
                version: 1,
                text
            }
        });
    } catch (e) {
        // Ignore file read errors, might be an external file
    }
    return uri;
}

// Tool 1: getDocumentSymbols
server.tool(
  "getDocumentSymbols",
  "Get a compressed summary of symbols (classes, functions, etc) in a file",
  {
    filePath: z.string().describe("The absolute or relative path to the source file")
  },
  async ({ filePath }) => {
    try {
      const client = await serverManager.getServerForFile(filePath);
      const uri = await ensureFileOpen(client, filePath);
      
      const result = await client.sendRequest("textDocument/documentSymbol", {
        textDocument: { uri }
      });
      
      return {
        content: [{ type: "text", text: compressDocumentSymbols(result) }]
      };
    } catch (err: any) {
      return {
        content: [{ type: "text", text: `Error: ${err.message}` }],
        isError: true
      };
    }
  }
);

// Tool 2: goToDefinition
server.tool(
  "goToDefinition",
  "Find the definition of a symbol at a specific line and character position",
  {
    filePath: z.string().describe("The path to the source file"),
    line: z.number().describe("0-based line number"),
    character: z.number().describe("0-based character position")
  },
  async ({ filePath, line, character }) => {
    try {
      const client = await serverManager.getServerForFile(filePath);
      const uri = await ensureFileOpen(client, filePath);
      
      const result = await client.sendRequest("textDocument/definition", {
        textDocument: { uri },
        position: { line, character }
      });
      
      return {
        content: [{ type: "text", text: compressLocations(result) }]
      };
    } catch (err: any) {
      return {
        content: [{ type: "text", text: `Error: ${err.message}` }],
        isError: true
      };
    }
  }
);

// Tool 3: findReferences
server.tool(
  "findReferences",
  "Find all references to a symbol at a specific line and character position",
  {
    filePath: z.string().describe("The path to the source file"),
    line: z.number().describe("0-based line number"),
    character: z.number().describe("0-based character position"),
    includeDeclaration: z.boolean().default(true).describe("Whether to include the declaration in the results")
  },
  async ({ filePath, line, character, includeDeclaration }) => {
    try {
      const client = await serverManager.getServerForFile(filePath);
      const uri = await ensureFileOpen(client, filePath);
      
      const result = await client.sendRequest("textDocument/references", {
        textDocument: { uri },
        position: { line, character },
        context: { includeDeclaration }
      });
      
      return {
        content: [{ type: "text", text: compressLocations(result) }]
      };
    } catch (err: any) {
      return {
        content: [{ type: "text", text: `Error: ${err.message}` }],
        isError: true
      };
    }
  }
);

// Tool 4: getHoverDocs
server.tool(
  "getHoverDocs",
  "Get hover documentation for a symbol at a specific line and character position",
  {
    filePath: z.string().describe("The path to the source file"),
    line: z.number().describe("0-based line number"),
    character: z.number().describe("0-based character position")
  },
  async ({ filePath, line, character }) => {
    try {
      const client = await serverManager.getServerForFile(filePath);
      const uri = await ensureFileOpen(client, filePath);
      
      const result = await client.sendRequest("textDocument/hover", {
        textDocument: { uri },
        position: { line, character }
      });
      
      return {
        content: [{ type: "text", text: compressHover(result) }]
      };
    } catch (err: any) {
      return {
        content: [{ type: "text", text: `Error: ${err.message}` }],
        isError: true
      };
    }
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Gemini Extension LSP MCP Server started.");
}

main().catch((error) => {
  console.error("Server error:", error);
  process.exit(1);
});
