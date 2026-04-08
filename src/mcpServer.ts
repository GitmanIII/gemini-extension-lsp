import { exec } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { LspClient } from "./LspClient.js";

const execAsync = promisify(exec);

// --- LspServerManager ---
interface UserSettings {
	lsp?: {
		[extension: string]: { command: string; args: string[] };
	};
}

class LspServerManager {
	private activeServers: Map<string, { client: LspClient; lastUsed: number }> =
		new Map();
	private settings: UserSettings = {};
	public diagnosticsCache: Map<string, unknown[]> = new Map();
	private diagnosticWaiters: Map<string, (diagnostics: unknown[]) => void> =
		new Map();

	constructor() {
		this.loadSettings();
		setInterval(() => this.stopIdleServers(), 60000);
	}

	private loadSettings() {
		const settingsPath = path.join(os.homedir(), ".gemini", "settings.json");
		try {
			if (fs.existsSync(settingsPath)) {
				const content = fs.readFileSync(settingsPath, "utf-8");
				this.settings = JSON.parse(content);
			}
		} catch (err) {
			console.error(
				"Failed to load settings from ~/.gemini/settings.json",
				err,
			);
		}
	}

	public async getServerForFile(filePath: string): Promise<LspClient> {
		const ext = path.extname(filePath);
		if (this.activeServers.has(ext)) {
			const server = this.activeServers.get(ext)!;
			server.lastUsed = Date.now();
			return server.client;
		}

		const config = this.settings.lsp?.[ext];
		if (!config) {
			throw new Error(
				`No LSP configured for extension '${ext}'. ` +
					`Please configure it in ~/.gemini/settings.json under 'lsp' key.`,
			);
		}

		const client = new LspClient(config.command, config.args);
		client.start();

		client.on("notification", (message) => {
			if (message.method === "textDocument/publishDiagnostics") {
				const uri = message.params.uri;
				const diags = message.params.diagnostics;
				this.diagnosticsCache.set(uri, diags);

				const waiter = this.diagnosticWaiters.get(uri);
				if (waiter) {
					waiter(diags);
					this.diagnosticWaiters.delete(uri);
				}
			}
		});

		await client.sendRequest("initialize", {
			processId: process.pid,
			rootUri: `file://${process.cwd()}`,
			capabilities: {},
		});
		client.sendNotification("initialized", {});

		this.activeServers.set(ext, { client, lastUsed: Date.now() });
		return client;
	}

	public waitForDiagnostics(uri: string): Promise<unknown[]> {
		return new Promise((resolve) => {
			this.diagnosticWaiters.set(uri, resolve);
			// Timeout after 3 seconds if no diagnostics received
			setTimeout(() => {
				if (this.diagnosticWaiters.has(uri)) {
					this.diagnosticWaiters.delete(uri);
					resolve(this.diagnosticsCache.get(uri) || []);
				}
			}, 3000);
		});
	}

	private stopIdleServers() {
		const now = Date.now();
		for (const [ext, server] of this.activeServers.entries()) {
			if (now - server.lastUsed > 300000) {
				// 5 minutes
				server.client.stop();
				this.activeServers.delete(ext);
			}
		}
	}
}

// --- Token Compression Middleware ---
function compressDocumentSymbols(symbols: unknown[]): string {
	if (!Array.isArray(symbols)) return "No symbols found.";

	const formattedSymbols: string[] = [];

	function processSymbol(sym: any, indent = "") {
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
			26: "TypeParameter",
		};

		const kindStr = kindMap[sym.kind as number] || "Symbol";
		const line =
			sym.range?.start?.line ?? sym.location?.range?.start?.line ?? "?";

		formattedSymbols.push(`${indent}[${kindStr}] ${sym.name} (Line ${line})`);

		if (sym.children && Array.isArray(sym.children)) {
			for (const child of sym.children) {
				processSymbol(child, `${indent}  `);
			}
		}
	}

	for (const sym of symbols) {
		processSymbol(sym);
	}
	return formattedSymbols.join("\n");
}

function compressLocations(locations: unknown | unknown[]): string {
	if (!locations) return "No locations found.";
	const locArray = Array.isArray(locations) ? locations : [locations];

	if (locArray.length === 0) return "No locations found.";

	return locArray
		.map((loc) => {
			const uri = loc.uri?.replace("file://", "") || "unknown file";
			const line = loc.range?.start?.line ?? "?";
			return `${uri} (Line ${line})`;
		})
		.join("\n");
}

function compressHover(hover: unknown): string {
	if (!hover || !hover.contents) return "No hover information found.";

	let content = "";
	if (typeof hover.contents === "string") {
		content = hover.contents;
	} else if (hover.contents.value) {
		content = hover.contents.value;
	} else if (Array.isArray(hover.contents)) {
		content = hover.contents
			.map((c: unknown) => (typeof c === "string" ? c : c.value))
			.join("\n");
	}

	return content.trim();
}

function applyLspEdits(text: string, edits: unknown[]): string {
	const lineOffsets: number[] = [0];
	for (let i = 0; i < text.length; i++) {
		if (text[i] === "\n") lineOffsets.push(i + 1);
	}

	function getOffset(pos: { line: number; character: number }): number {
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

// --- MCP Server Setup ---
const server = new McpServer({
	name: "gemini-extension-lsp",
	version: "0.1.0",
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
				languageId: path.extname(filePath).replace(".", "") || "text",
				version: 1,
				text,
			},
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
		filePath: z
			.string()
			.describe("The absolute or relative path to the source file"),
	},
	async ({ filePath }) => {
		try {
			const client = await serverManager.getServerForFile(filePath);
			const uri = await ensureFileOpen(client, filePath);

			const result = await client.sendRequest("textDocument/documentSymbol", {
				textDocument: { uri },
			});

			return {
				content: [
					{ type: "text", text: compressDocumentSymbols(result as unknown[]) },
				],
			};
		} catch (err: unknown) {
			return {
				content: [{ type: "text", text: `Error: ${(err as Error).message}` }],
				isError: true,
			};
		}
	},
);

// Tool 2: goToDefinition
server.tool(
	"goToDefinition",
	"Find the definition of a symbol at a specific line and character position",
	{
		filePath: z.string().describe("The path to the source file"),
		line: z.number().describe("0-based line number"),
		character: z.number().describe("0-based character position"),
	},
	async ({ filePath, line, character }) => {
		try {
			const client = await serverManager.getServerForFile(filePath);
			const uri = await ensureFileOpen(client, filePath);

			const result = await client.sendRequest("textDocument/definition", {
				textDocument: { uri },
				position: { line, character },
			});

			return {
				content: [{ type: "text", text: compressLocations(result) }],
			};
		} catch (err: unknown) {
			return {
				content: [{ type: "text", text: `Error: ${err.message}` }],
				isError: true,
			};
		}
	},
);

// Tool 3: findReferences
server.tool(
	"findReferences",
	"Find all references to a symbol at a specific line and character position",
	{
		filePath: z.string().describe("The path to the source file"),
		line: z.number().describe("0-based line number"),
		character: z.number().describe("0-based character position"),
		includeDeclaration: z
			.boolean()
			.default(true)
			.describe("Whether to include the declaration in the results"),
	},
	async ({ filePath, line, character, includeDeclaration }) => {
		try {
			const client = await serverManager.getServerForFile(filePath);
			const uri = await ensureFileOpen(client, filePath);

			const result = await client.sendRequest("textDocument/references", {
				textDocument: { uri },
				position: { line, character },
				context: { includeDeclaration },
			});

			return {
				content: [{ type: "text", text: compressLocations(result) }],
			};
		} catch (err: unknown) {
			return {
				content: [{ type: "text", text: `Error: ${err.message}` }],
				isError: true,
			};
		}
	},
);

// Tool 4: getHoverDocs
server.tool(
	"getHoverDocs",
	"Get hover documentation for a symbol at a specific line and character position",
	{
		filePath: z.string().describe("The path to the source file"),
		line: z.number().describe("0-based line number"),
		character: z.number().describe("0-based character position"),
	},
	async ({ filePath, line, character }) => {
		try {
			const client = await serverManager.getServerForFile(filePath);
			const uri = await ensureFileOpen(client, filePath);

			const result = await client.sendRequest("textDocument/hover", {
				textDocument: { uri },
				position: { line, character },
			});

			return {
				content: [{ type: "text", text: compressHover(result) }],
			};
		} catch (err: unknown) {
			return {
				content: [{ type: "text", text: `Error: ${err.message}` }],
				isError: true,
			};
		}
	},
);

// Tool: format_and_fix
server.tool(
	"format_and_fix",
	"The ultimate auto-formatter and linter. Works on almost any language. ALWAYS use this tool after modifying a file to ensure perfect syntax, spacing, and imports.",
	{
		filePath: z.string().describe("The path to the source file to format"),
	},
	async ({ filePath }) => {
		try {
			const ext = path.extname(filePath);
			const webExtensions = [
				".js",
				".ts",
				".jsx",
				".tsx",
				".json",
				".css",
				".graphql",
			];

			// Helper to check for command
			const commandExists = async (cmd: string) => {
				try {
					await execAsync(`which ${cmd}`);
					return true;
				} catch {
					return false;
				}
			};

			// ROUTE 1: The Biome Fast-Path (JS/TS/Web)
			if (webExtensions.includes(ext) && (await commandExists("biome"))) {
				const { stdout } = await execAsync(`biome check --write "${filePath}"`);
				return {
					content: [
						{
							type: "text",
							text: `[Biome] File formatted and linted instantly.\n${stdout}`,
						},
					],
				};
			}

			// ROUTE 2: The Ruff Fast-Path (Python)
			if (ext === ".py" && (await commandExists("ruff"))) {
				await execAsync(`ruff format "${filePath}"`);
				await execAsync(`ruff check --fix "${filePath}"`);
				return {
					content: [
						{
							type: "text",
							text: "[Ruff] Python file formatted and linted instantly.",
						},
					],
				};
			}

			// ROUTE 3: The Native LSP Fallback (C++, Go, Rust, PHP, etc.)
			const client = await serverManager.getServerForFile(filePath);
			const uri = await ensureFileOpen(client, filePath);
			const text = fs.readFileSync(filePath, "utf-8");

			const edits = await client.sendRequest("textDocument/formatting", {
				textDocument: { uri },
				options: { tabSize: 4, insertSpaces: true },
			});

			if (!edits || (Array.isArray(edits) && edits.length === 0)) {
				return {
					content: [
						{
							type: "text",
							text: `[LSP] No formatting changes needed for ${ext}.`,
						},
					],
				};
			}

			const newText = applyLspEdits(text, edits);
			fs.writeFileSync(filePath, newText, "utf-8");

			// Force update the LSP cache
			client.sendNotification("textDocument/didChange", {
				textDocument: { uri, version: Date.now() },
				contentChanges: [{ text: newText }],
			});

			return {
				content: [
					{
						type: "text",
						text: `[LSP] File successfully formatted by the native ${ext} Language Server.`,
					},
				],
			};
		} catch (err: unknown) {
			return {
				content: [
					{
						type: "text",
						text: `Formatting failed. Ensure Biome/Ruff are installed or LSP is configured correctly.\nError: ${err.message}`,
					},
				],
				isError: true,
			};
		}
	},
);

// Tool 7: get_diagnostics
server.tool(
	"get_diagnostics",
	"Get workspace diagnostics (syntax errors, warnings, type errors) for a file",
	{
		filePath: z.string().describe("The path to the source file"),
	},
	async ({ filePath }) => {
		try {
			const client = await serverManager.getServerForFile(filePath);
			const uri = await ensureFileOpen(client, filePath);

			// Force LSP to update
			const text = fs.readFileSync(filePath, "utf-8");
			client.sendNotification("textDocument/didChange", {
				textDocument: { uri, version: Date.now() },
				contentChanges: [{ text }],
			});

			const diagnostics = await serverManager.waitForDiagnostics(uri);

			if (!diagnostics || diagnostics.length === 0) {
				return {
					content: [
						{ type: "text", text: "No issues found. The file is clean!" },
					],
				};
			}

			const severityMap: Record<number, string> = {
				1: "Error",
				2: "Warning",
				3: "Info",
				4: "Hint",
			};

			const formatted = diagnostics
				.map((d: unknown) => {
					const severity = severityMap[d.severity] || "Issue";
					const line = d.range?.start?.line ?? "?";
					return `[${severity} - Line ${line}] ${d.message}`;
				})
				.join("\n");

			return {
				content: [{ type: "text", text: formatted }],
			};
		} catch (err: unknown) {
			return {
				content: [{ type: "text", text: `Error: ${err.message}` }],
				isError: true,
			};
		}
	},
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
