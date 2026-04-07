import { spawn, ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';

export interface LspMessage {
  jsonrpc: string;
  id?: number | string;
  method?: string;
  params?: any;
  result?: any;
  error?: any;
}

export class LspClient extends EventEmitter {
  private process: ChildProcess | null = null;
  private buffer: Buffer = Buffer.alloc(0);
  private nextId = 1;
  private pendingRequests: Map<number | string, { resolve: (val: any) => void; reject: (err: any) => void }> = new Map();

  constructor(private command: string, private args: string[]) {
    super();
  }

  public start() {
    this.process = spawn(this.command, this.args, {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    this.process.stdout?.on('data', (data: Buffer) => this.handleData(data));
    this.process.stderr?.on('data', (data: Buffer) => {
      console.error(`[LSP Error] ${data.toString()}`);
    });

    this.process.on('close', (code) => {
      this.emit('close', code);
    });
  }

  public stop() {
    this.process?.kill();
    this.process = null;
  }

  private handleData(data: Buffer) {
    this.buffer = Buffer.concat([this.buffer, data]);

    while (true) {
      const match = this.buffer.toString('ascii').match(/Content-Length: (\d+)\r\n\r\n/);
      if (!match) break;

      const contentLength = parseInt(match[1], 10);
      const headerLength = match[0].length;
      const totalLength = headerLength + contentLength;

      if (this.buffer.length < totalLength) break;

      const messageBuffer = this.buffer.subarray(headerLength, totalLength);
      this.buffer = this.buffer.subarray(totalLength);

      try {
        const message: LspMessage = JSON.parse(messageBuffer.toString('utf8'));
        this.handleMessage(message);
      } catch (err) {
        console.error('Failed to parse LSP message:', err);
      }
    }
  }

  private handleMessage(message: LspMessage) {
    if (message.id !== undefined && this.pendingRequests.has(message.id)) {
      const { resolve, reject } = this.pendingRequests.get(message.id)!;
      this.pendingRequests.delete(message.id);
      
      if (message.error) {
        reject(message.error);
      } else {
        resolve(message.result);
      }
    } else if (message.method) {
      // It's a notification or request from the server
      this.emit('notification', message);
    }
  }

  public sendRequest(method: string, params: any): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.process || !this.process.stdin) {
        return reject(new Error('LSP process not running'));
      }

      const id = this.nextId++;
      this.pendingRequests.set(id, { resolve, reject });

      const request: LspMessage = {
        jsonrpc: '2.0',
        id,
        method,
        params,
      };

      this.sendMessage(request);
    });
  }

  public sendNotification(method: string, params: any) {
    if (!this.process || !this.process.stdin) return;

    const notification: LspMessage = {
      jsonrpc: '2.0',
      method,
      params,
    };

    this.sendMessage(notification);
  }

  private sendMessage(message: LspMessage) {
    const json = JSON.stringify(message);
    const payload = `Content-Length: ${Buffer.byteLength(json, 'utf8')}\r\n\r\n${json}`;
    this.process!.stdin!.write(payload);
  }
}
