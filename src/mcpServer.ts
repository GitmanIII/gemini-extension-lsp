import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { LspClient } from "./LspClient.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { exec } from "node:child_process";
import { promisify } from "node:util";

const execAsync = promisify(exec);

// --- LspServerManager ---
interface UserSettings {
  lsp?: {
    [extension: string]: { command: string; args: string[] };
  };
}

class LspServerManager {
  private activeServers: Map<string, LspClient> = new Map();
  private initializingServers: Map<string, Promise<LspClient>> = new Map();
  private settings: UserSettings = {};
  public diagnosticsCache: Map<string, any[]> = new Map();
  public openedFiles: Set<string> = new Set();

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

    if (this.initializingServers.has(ext)) {
      return this.initializingServers.get(ext)!;
    }

    const initPromise = this._initializeServer(ext);
    this.initializingServers.set(ext, initPromise);

    try {
      const client = await initPromise;
      this.activeServers.set(ext, client);
      return client;
    } finally {
      this.initializingServers.delete(ext);
    }
  }

  private async _initializeServer(ext: string): Promise<LspClient> {
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
    
    client.on("notification", (message) => {
      if (message.method === "textDocument/publishDiagnostics") {
        this.diagnosticsCache.set(message.params.uri, message.params.diagnostics);
      }
    });
    
    // Initialize the server with proper capabilities for refactoring
    await client.sendRequest("initialize", {
      processId: process.pid,
      rootUri: `file://${process.cwd()}`,
      capabilities: {
        workspace: {
          workspaceEdit: {
            documentChanges: true,
            resourceOperations: ["create", "rename", "delete"]
          }
        },
        textDocument: {
          rename: {
            prepareSupport: true
          },
          codeAction: {
            codeActionLiteralSupport: {
              codeActionKind: {
                valueSet: ["quickfix", "refactor", "source"]
              }
            }
          }
        }
      }
    });
    client.sendNotification("initialized", {});

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

function compressWorkspaceSymbols(symbols: any[]): string {
  if (!symbols || symbols.length === 0) return "No symbols found.";
  
  const kindMap: Record<number, string> = {
    1: "File", 2: "Module", 3: "Namespace", 4: "Package", 5: "Class", 
    6: "Method", 7: "Property", 8: "Field", 9: "Constructor", 10: "Enum", 
    11: "Interface", 12: "Function", 13: "Variable", 14: "Constant", 
    15: "String", 16: "Number", 17: "Boolean", 18: "Array", 19: "Object", 
    20: "Key", 21: "Null", 22: "EnumMember", 23: "Struct", 24: "Event", 
    25: "Operator", 26: "TypeParameter"
  };

  return symbols.map(sym => {
    const kindStr = kindMap[sym.kind] || "Symbol";
    const loc = sym.location;
    const uri = loc?.uri?.replace("file://", "") || "unknown file";
    const line = loc?.range?.start?.line ?? "?";
    const container = sym.containerName ? ` (in ${sym.containerName})` : "";
    return `[${kindStr}] ${sym.name}${container} - ${uri} (Line ${line})`;
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

function compressCodeActions(actions: any[]): string {
  if (!actions || actions.length === 0) return "No code actions available.";
  
  return actions.map((action, i) => {
    const title = action.title || "Untitled Action";
    const kind = action.kind ? ` [${action.kind}]` : "";
    return `${i + 1}. ${title}${kind}`;
  }).join("\n");
}

function applyLspEdits(text: string, edits: any[]): string {
  const lineOffsets: number[] = [0];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '\n') lineOffsets.push(i + 1);
  }

  function getOffset(pos: { line: number, character: number }): number {
    const lineOffset = lineOffsets[pos.line] ?? text.length;
    return Math.min(lineOffset + pos.character, text.length);
  }

  // Sort edits in reverse order (bottom-up)
  const sortedEdits = [...edits].sort((a, b) => {
    const offsetA = getOffset(a.range.start);
    const offsetB = getOffset(b.range.start);
    return offsetB - offsetA;
  });

  let result = text;
  for (const edit of sortedEdits) {
    const start = getOffset(edit.range.start);
    const end = getOffset(edit.range.end);
    result = result.slice(0, start) + edit.newText + result.slice(end);
  }
  return result;
}

function uriToPath(uri: string): string {
  let p = uri.replace(/^file:\/\//, "");
  // On Windows, the URI might be file:///C:/path, so p is /C:/path
  if (os.platform() === 'win32' && p.startsWith('/')) {
    p = p.substring(1);
  }
  return decodeURIComponent(p);
}

async function applyWorkspaceEdit(edit: any) {
  if (!edit) return "No changes suggested by the server.";

  let report = "Applied changes:\n";

  // Handle changes (Map of URI to TextEdit[])
  if (edit.changes) {
    for (const [uri, edits] of Object.entries(edit.changes)) {
      const fullPath = uriToPath(uri);
      const text = fs.readFileSync(fullPath, "utf-8");
      const newText = applyLspEdits(text, edits as any[]);
      fs.writeFileSync(fullPath, newText, "utf-8");
      
      const client = await serverManager.getServerForFile(fullPath);
      client.sendNotification("textDocument/didSave", { textDocument: { uri } });
      
      report += `- Updated ${fullPath}\n`;
    }
  }

  // Handle documentChanges (Array of TextDocumentEdit | CreateFile | RenameFile | DeleteFile)
  if (edit.documentChanges) {
    for (const change of edit.documentChanges) {
      if (change.textDocument) {
        const uri = change.textDocument.uri;
        const fullPath = uriToPath(uri);
        const text = fs.readFileSync(fullPath, "utf-8");
        const newText = applyLspEdits(text, change.edits);
        fs.writeFileSync(fullPath, newText, "utf-8");
        
        const client = await serverManager.getServerForFile(fullPath);
        client.sendNotification("textDocument/didSave", { textDocument: { uri } });
        
        report += `- Updated ${fullPath}\n`;
      }
    }
  }

  return report;
}

// --- MCP Server Setup ---
const server = new McpServer({
  name: "gemini-extension-lsp",
  version: "0.1.0"
});

const serverManager = new LspServerManager();

async function forceIndexWorkspace(client: LspClient, extension: string) {
    try {
        console.error(`[Indexer] Performing smart workspace scan for *${extension}...`);
        const { stdout } = await execAsync(`find . -maxdepth 4 -name "*${extension}" -not -path "*/node_modules/*" -not -path "*/build/*" -not -path "*/.git/*"`);
        const files = stdout.split('\n').filter(f => f.trim() !== '');

        for (const file of files) {
            await ensureFileOpen(client, file);
        }
        console.error(`[Indexer] Successfully indexed ${files.length} files.`);
    } catch (e: any) {
        console.error(`[Indexer] Scan failed: ${e.message}`);
    }
}

// Tool: renameSymbol
server.tool(
  "renameSymbol",
  "Rename a symbol across the workspace safely using the Language Server",
  {
    filePath: z.string().describe("The path to the source file"),
    line: z.number().describe("0-based line number"),
    character: z.number().describe("0-based character position"),
    newName: z.string().describe("The new name for the symbol")
  },
  async ({ filePath, line, character, newName }) => {
    try {
      console.error(`[Rename] Renaming symbol in ${filePath} at ${line}:${character} to ${newName}`);
      const client = await serverManager.getServerForFile(filePath);

      // Zero-Config Hack: Ensure all relevant files are open so the LSP indexes the WHOLE project
      const ext = path.extname(filePath);
      await forceIndexWorkspace(client, ext);

      const uri = await ensureFileOpen(client, filePath);

      const result = await client.sendRequest("textDocument/rename", {        textDocument: { uri },
        position: { line, character },
        newName
      });
      
      console.error(`[Rename] LSP Result: ${JSON.stringify(result)}`);
      
      const report = await applyWorkspaceEdit(result);
      
      return {
        content: [{ type: "text", text: report }]
      };
    } catch (err: any) {
      console.error(`[Rename] Error: ${err.message}`);
      return {
        content: [{ type: "text", text: `Error: ${err.message}` }],
        isError: true
      };
    }
  }
);

const extensionToLanguageId: Record<string, string> = {
  '.ts': 'typescript',
  '.js': 'javascript',
  '.tsx': 'typescriptreact',
  '.jsx': 'javascriptreact',
  '.py': 'python',
  '.go': 'go',
  '.rs': 'rust',
  '.c': 'c',
  '.cpp': 'cpp',
  '.h': 'c',
  '.hpp': 'cpp',
  '.json': 'json',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.md': 'markdown',
  '.html': 'html',
  '.css': 'css',
  '.sh': 'shellscript'
};

function getLanguageId(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return extensionToLanguageId[ext] || ext.replace('.', '') || 'text';
}

// Helper to open a file before running commands that require the file to be open
async function ensureFileOpen(client: LspClient, filePath: string) {
    const uri = `file://${path.resolve(filePath)}`;
    if (serverManager.openedFiles.has(uri)) return uri;

    try {
        const text = fs.readFileSync(filePath, "utf-8");
        client.sendNotification("textDocument/didOpen", {
            textDocument: {
                uri,
                languageId: getLanguageId(filePath),
                version: 1,
                text
            }
        });
        serverManager.openedFiles.add(uri);
    } catch (e) {
        // Ignore file read errors, might be an external file
    }
    return uri;
}

// Tool: getWorkspaceSymbols
server.tool(
  "getWorkspaceSymbols",
  "Find a symbol (class, function, etc) by name across the entire project",
  {
    query: z.string().describe("The name of the symbol to search for"),
    extension: z.string().describe("The file extension to search within (e.g. '.ts', '.go')")
  },
  async ({ query, extension }) => {
    try {
      const dummyPath = path.join(process.cwd(), `index${extension}`);
      const client = await serverManager.getServerForFile(dummyPath);
      
      let result = await client.sendRequest("workspace/symbol", {
        query
      });
      
      // SMART FALLBACK: If LSP returns nothing, it might be a config issue (like tsconfig.json)
      // We will perform a manual search and "force" the LSP to see those files.
      if (!result || (Array.isArray(result) && result.length === 0)) {
        console.error(`[Discovery] LSP returned no results for "${query}". Attempting Smart Fallback...`);
        
        // 1. Find potential files using a simple filesystem scan
        const { stdout } = await execAsync(`find . -maxdepth 4 -name "*${extension}" -not -path "*/node_modules/*" -not -path "*/build/*" -not -path "*/.git/*"`);
        const matches = stdout.split('\n').filter(f => f.trim() !== '');
        const potentialFiles: string[] = [];
        
        // Limit to first 20 matches to avoid overwhelming the server
        for (const file of matches.slice(0, 20)) {
           try {
             const content = fs.readFileSync(file, 'utf-8');
             if (content.includes(query)) {
               potentialFiles.push(file);
             }
           } catch (e) {}
        }

        if (potentialFiles.length > 0) {
          console.error(`[Discovery] Found ${potentialFiles.length} potential files via fallback. Forcing LSP indexing...`);
          // 2. Force the LSP to open these files so it indexes them
          for (const file of potentialFiles) {
            await ensureFileOpen(client, file);
          }
          
          // 3. Try the LSP request again now that files are "open"
          result = await client.sendRequest("workspace/symbol", { query });
        }
      }
      
      return {
        content: [{ type: "text", text: compressWorkspaceSymbols(result) }]
      };
    } catch (err: any) {
      return {
        content: [{ type: "text", text: `Error: ${err.message}` }],
        isError: true
      };
    }
  }
);

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
      
      // Zero-Config Hack: Ensure all relevant files are open so the LSP indexes the WHOLE project
      const ext = path.extname(filePath);
      await forceIndexWorkspace(client, ext);
      
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

// Tool: getCodeActions
server.tool(
  "getCodeActions",
  "Get available code actions (quick fixes, refactorings) for a file region",
  {
    filePath: z.string().describe("The path to the source file"),
    startLine: z.number().describe("0-based start line number"),
    startCharacter: z.number().describe("0-based start character position"),
    endLine: z.number().describe("0-based end line number"),
    endCharacter: z.number().describe("0-based end character position")
  },
  async ({ filePath, startLine, startCharacter, endLine, endCharacter }) => {
    try {
      const client = await serverManager.getServerForFile(filePath);
      const uri = await ensureFileOpen(client, filePath);
      
      const diagnostics = serverManager.diagnosticsCache.get(uri) || [];
      
      const result = await client.sendRequest("textDocument/codeAction", {
        textDocument: { uri },
        range: {
          start: { line: startLine, character: startCharacter },
          end: { line: endLine, character: endCharacter }
        },
        context: { diagnostics }
      });
      
      // Store the full action objects in a temporary cache for applyCodeAction
      (client as any)._lastCodeActions = result;

      return {
        content: [{ type: "text", text: compressCodeActions(result) }]
      };
    } catch (err: any) {
      return {
        content: [{ type: "text", text: `Error: ${err.message}` }],
        isError: true
      };
    }
  }
);

// Tool: applyCodeAction
server.tool(
  "applyCodeAction",
  "Apply a specific code action by its index (1-based, from getCodeActions)",
  {
    filePath: z.string().describe("The path to the source file"),
    index: z.number().describe("1-based index of the action to apply")
  },
  async ({ filePath, index }) => {
    try {
      const client = await serverManager.getServerForFile(filePath);
      const actions = (client as any)._lastCodeActions;
      
      if (!actions || index < 1 || index > actions.length) {
        throw new Error("Invalid action index or no actions cached. Run getCodeActions first.");
      }
      
      const action = actions[index - 1];
      let report = `Applying: ${action.title}\n`;
      
      if (action.edit) {
        report += await applyWorkspaceEdit(action.edit);
      } else if (action.command) {
        const result = await client.sendRequest("workspace/executeCommand", {
          command: action.command.command,
          arguments: action.command.arguments
        });
        
        // After a command that might change the disk, notify the server
        const uri = `file://${path.resolve(filePath)}`;
        client.sendNotification("textDocument/didSave", { textDocument: { uri } });
        
        report += `Command executed: ${action.command.command}`;
      }
      
      return {
        content: [{ type: "text", text: report }]
      };
    } catch (err: any) {
      return {
        content: [{ type: "text", text: `Error: ${err.message}` }],
        isError: true
      };
    }
  }
);

// Tool: goToImplementation
server.tool(
  "goToImplementation",
  "Find the actual implementation(s) of a symbol (e.g., interface method to concrete class method)",
  {
    filePath: z.string().describe("The path to the source file"),
    line: z.number().describe("0-based line number"),
    character: z.number().describe("0-based character position")
  },
  async ({ filePath, line, character }) => {
    try {
      const client = await serverManager.getServerForFile(filePath);
      const uri = await ensureFileOpen(client, filePath);
      
      const result = await client.sendRequest("textDocument/implementation", {
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

// Tool: format_and_fix
server.tool(
  "format_and_fix",
  "The ultimate auto-formatter and linter. Works on almost any language. ALWAYS use this tool after modifying a file to ensure perfect syntax, spacing, and imports.",
  {
    filePath: z.string().describe("The path to the source file to format")
  },
  async ({ filePath }) => {
    try {
      const ext = path.extname(filePath);
      const webExtensions = ['.js', '.ts', '.jsx', '.tsx', '.json', '.css', '.graphql'];

      // ROUTE 1: The Biome Fast-Path (JS/TS/Web)
      if (webExtensions.includes(ext)) {
        const { stdout } = await execAsync(`npx @biomejs/biome check --write "${filePath}"`);
        return { content: [{ type: "text", text: `[Biome] File formatted and linted instantly.\n${stdout}` }] };
      }

      // ROUTE 2: The Ruff Fast-Path (Python)
      if (ext === '.py') {
        // Ruff formats the code, then applies safe linting fixes (like organizing imports)
        await execAsync(`ruff format "${filePath}"`);
        await execAsync(`ruff check --fix "${filePath}"`);
        return { content: [{ type: "text", text: "[Ruff] Python file formatted and linted instantly." }] };
      }

      // ROUTE 3: The Gofmt Fast-Path (Go)
      if (ext === '.go') {
        await execAsync(`gofmt -w "${filePath}"`);
        return { content: [{ type: "text", text: "[Gofmt] Go file formatted instantly." }] };
      }

      // ROUTE 4: The Rustfmt Fast-Path (Rust)
      if (ext === '.rs') {
        await execAsync(`rustfmt "${filePath}"`);
        return { content: [{ type: "text", text: "[Rustfmt] Rust file formatted instantly." }] };
      }

      // ROUTE 5: The Native LSP Fallback (C++, Java, PHP, etc.)
      const client = await serverManager.getServerForFile(filePath);
      const uri = await ensureFileOpen(client, filePath);
      const text = fs.readFileSync(filePath, "utf-8");
      
      const edits = await client.sendRequest("textDocument/formatting", { 
        textDocument: { uri }, 
        options: { tabSize: 4, insertSpaces: true } 
      });

      if (!edits || (Array.isArray(edits) && edits.length === 0)) {
        return { content: [{ type: "text", text: `[LSP] No formatting changes needed for ${ext}.` }] };
      }

      const newText = applyLspEdits(text, edits);
      fs.writeFileSync(filePath, newText, "utf-8");
      
      // Force update the LSP cache
      client.sendNotification("textDocument/didChange", { 
        textDocument: { uri, version: Date.now() }, 
        contentChanges: [{ text: newText }] 
      });

      client.sendNotification("textDocument/didSave", { textDocument: { uri } });

      return { content: [{ type: "text", text: `[LSP] File successfully formatted by the native ${ext} Language Server.` }] };

    } catch (err: any) {
      return {
        content: [{ type: "text", text: `Formatting partially failed or found unfixable errors:\n${err.message}` }],
        isError: false // Return false so the AI reads the warnings instead of panicking
      };
    }
  }
);

// Tool 7: get_diagnostics
server.tool(
  "get_diagnostics",
  "Get workspace diagnostics (syntax errors, warnings, type errors) for a file",
  {
    filePath: z.string().describe("The path to the source file")
  },
  async ({ filePath }) => {
    try {
      const ext = path.extname(filePath);

      // FAST PATH 1: Ruff (Python)
      if (ext === '.py') {
        try {
          const { stdout } = await execAsync(`ruff check "${filePath}"`);
          return { content: [{ type: "text", text: stdout || "No issues found. The file is clean!" }] };
        } catch (err: any) {
          // Ruff exits with non-zero if issues found
          return { content: [{ type: "text", text: err.stdout || err.message }] };
        }
      }

      // FAST PATH 2: Go Vet (Go)
      if (ext === '.go') {
        try {
          const { stderr } = await execAsync(`go vet "${filePath}"`);
          return { content: [{ type: "text", text: stderr || "No issues found. The file is clean!" }] };
        } catch (err: any) {
          return { content: [{ type: "text", text: err.stderr || err.message }] };
        }
      }

      const client = await serverManager.getServerForFile(filePath);
      const uri = await ensureFileOpen(client, filePath);

      // Fix race condition: Read latest from disk and clear cache
      const text = fs.readFileSync(filePath, "utf-8");
      serverManager.diagnosticsCache.delete(uri);

      // Force LSP to update
      client.sendNotification("textDocument/didChange", {
        textDocument: { uri, version: Date.now() },
        contentChanges: [{ text }]
      });

      // Polling loop to wait for diagnostics (4 seconds)
      let diagnostics = null;
      for (let i = 0; i < 40; i++) {
        if (serverManager.diagnosticsCache.has(uri)) {
          diagnostics = serverManager.diagnosticsCache.get(uri);
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      if (!diagnostics || diagnostics.length === 0) {
        return {
          content: [{ type: "text", text: "No issues found. The file is clean!" }]
        };
      }

      const severityMap: Record<number, string> = {
        1: "Error",
        2: "Warning",
        3: "Info",
        4: "Hint"
      };

      const formatted = diagnostics.map((d: any) => {
        const severity = severityMap[d.severity] || "Issue";
        const line = d.range?.start?.line ?? "?";
        return `[${severity} - Line ${line}] ${d.message}`;
      }).join("\n");

      return {
        content: [{ type: "text", text: formatted }]
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
