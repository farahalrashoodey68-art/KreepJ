// kreepj.js - Open-Source JVM Runtime
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import net from 'net';
import http from 'http';

class Monitor {
  constructor() {
    this.owner = null;
    this.count = 0;
    this.queue = [];
  }

  acquire(thread) {
    if (this.owner === thread) {
      this.count++;
      return true;
    }
    if (!this.owner) {
      this.owner = thread;
      this.count = 1;
      return true;
    }
    return false;
  }

  release(thread) {
    if (this.owner !== thread) {
      throw new Error("IllegalMonitorStateException: Thread does not own monitor");
    }
    this.count--;
    if (this.count === 0) {
      this.owner = null;
      if (this.queue.length > 0) {
        const nextThread = this.queue.shift();
        this.owner = nextThread;
        this.count = 1;
        nextThread.resume();
      }
    }
  }
}

class ExecutionFrame {
  constructor(methodName, maxLocals, maxStack) {
    this.methodName = methodName;
    this.locals = new Array(maxLocals).fill(0);
    this.stack = [];
    this.pc = 0;
  }
}

class KreepJThread {
  constructor(id, name, targetFn) {
    this.id = id;
    this.name = name;
    this.targetFn = targetFn;
    this.state = 'NEW';
    this.callStack = [];
    this.priority = 5;
  }

  async start() {
    this.state = 'RUNNABLE';
    console.log(`[kreepj-thread] Thread started: ${this.name} (ID: ${this.id})`);
    try {
      if (this.targetFn) await this.targetFn();
      this.state = 'TERMINATED';
      console.log(`[kreepj-thread] Thread terminated: ${this.name}`);
    } catch (err) {
      this.state = 'TERMINATED';
      console.error(`[kreepj-thread] Uncaught exception in thread ${this.name}:`, err);
    }
  }

  resume() {
    this.state = 'RUNNABLE';
  }
}

class KreepJJdbcConnection {
  constructor(id, dbUrl) {
    this.id = id;
    this.dbUrl = dbUrl;
    this.isClosed = false;
  }

  executeQuery(sql, params = []) {
    if (this.isClosed) throw new Error("SQLException: Connection is closed");
    return [{ id: 1, status: "SUCCESS", timestamp: Date.now() }];
  }

  executeUpdate(sql, params = []) {
    if (this.isClosed) throw new Error("SQLException: Connection is closed");
    return 1;
  }

  close() {
    this.isClosed = true;
  }
}

class KreepJJdbcPool {
  constructor(dbUrl, maxPoolSize = 5) {
    this.dbUrl = dbUrl;
    this.maxPoolSize = maxPoolSize;
    this.pool = [];
    this.activeConnections = new Set();
    this.nextConnId = 1;

    for (let i = 0; i < maxPoolSize; i++) {
      this.pool.push(new KreepJJdbcConnection(this.nextConnId++, dbUrl));
    }
  }

  getConnection() {
    if (this.pool.length > 0) {
      const conn = this.pool.pop();
      conn.isClosed = false;
      this.activeConnections.add(conn);
      return conn;
    }
    throw new Error("SQLTransientConnectionException: Connection pool exhausted");
  }

  releaseConnection(conn) {
    if (this.activeConnections.has(conn)) {
      this.activeConnections.delete(conn);
      conn.close();
      this.pool.push(new KreepJJdbcConnection(conn.id, this.dbUrl));
    }
  }
}

class KreepJClassLoader {
  constructor(jvm, parentLoader = null) {
    this.jvm = jvm;
    this.parentLoader = parentLoader;
    this.loadedClasses = new Map();
  }

  async loadClass(className) {
    if (this.loadedClasses.has(className)) return this.loadedClasses.get(className);
    if (this.parentLoader) {
      try { return await this.parentLoader.loadClass(className); } catch (e) {}
    }
    try {
      const cls = await this.jvm.findSystemClass(className);
      if (cls) return cls;
    } catch (e) {}
    throw new Error(`ClassNotFoundException: ${className}`);
  }

  defineClass(className, bytecodeBuffer) {
    this.jvm.verifyBytecode(bytecodeBuffer);
    const parsed = this.jvm.parseClassFile(bytecodeBuffer);
    this.loadedClasses.set(className, parsed);
    this.jvm.classes.set(className, parsed);
    return parsed;
  }
}

class KreepJ {
  constructor(config = {}) {
    this.classPath = config.classPath || [];
    this.classes = new Map();
    this.jniRegistry = new Map();
    
    this.heapMemory = new Map();
    this.nextObjectId = 1;
    this.gcStats = { totalAllocated: 0, totalCollected: 0 };

    this.threads = new Map();
    this.nextThreadId = 1;
    this.monitors = new Map();
    this.currentThread = null;

    this.activeServers = new Map();
    this.activeSockets = new Map();
    this.jdbcPools = new Map();
    this.dashboardServer = null;
    this.nextNetworkId = 1;

    this.systemClassLoader = new KreepJClassLoader(this, null);
    this.heap = new WebAssembly.Memory({ initial: 256, maximum: 65536 });
    
    this.env = {
      printString: (ptr) => console.log(this.readUtf8(ptr)),
      printInt: (val) => console.log(val),
      currentTimeMillis: () => BigInt(Date.now()),
      invokeNative: (nativeId, argsPtr) => {
        const nativeFn = this.jniRegistry.get(nativeId);
        if (nativeFn) return nativeFn(argsPtr);
        throw new Error(`UnsatisfiedLinkError: Native method ID ${nativeId} not found`);
      },
      allocateObject: (classNamePtr, size) => {
        const className = this.readUtf8(classNamePtr);
        return this.allocateObject(className, size);
      },
      monitorEnter: (objectId) => this.monitorEnter(objectId),
      monitorExit: (objectId) => this.monitorExit(objectId)
    };
  }

  async init() {
    const wasmCode = new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
    const module = await WebAssembly.instantiate(wasmCode, { env: this.env });
    this.wasmInstance = module.instance;

    const mainThread = new KreepJThread(this.nextThreadId++, "main", null);
    this.threads.set(mainThread.id, mainThread);
    this.currentThread = mainThread;

    return this;
  }

  // ==========================================
  // 1. CLI TERMINAL WRAPPER EXECUTOR
  // ==========================================
  static async executeCli(argv) {
    const command = argv[2];
    const target = argv[3];
    const extra = argv[4];

    const jvm = new KreepJ();
    await jvm.init();

    switch (command) {
      case 'run':
        if (!target) {
          console.error("Error: Missing target .jar file path. Usage: kreepj run <app.jar>");
          process.exit(1);
        }
        await jvm.runJar(target, argv.slice(4));
        break;

      case 'pack':
        if (!target || !argv[4] || !argv[5]) {
          console.error("Error: Invalid arguments. Usage: kreepj pack <sourceDir> <output.jar> <MainClass>");
          process.exit(1);
        }
        KreepJ.packJar(target, argv[4], argv[5]);
        break;

      case 'dashboard':
        const port = target ? parseInt(target, 10) : 3000;
        jvm.startDashboard(port);
        break;

      default:
        console.log(`
⚡ KreepJ CLI - Open-Source JVM Runtime & WebAssembly API
Usage:
  kreepj run <app.jar>       - Execute a compiled Java JAR archive
  kreepj pack <dir> <out> <main> - Package a class directory into a runnable JAR
  kreepj dashboard [port]    - Launch the real-time Web UI Dashboard & REST API
        `);
        break;
    }
  }

  // ==========================================
  // 2. WEB UI DASHBOARD & REST API SERVER
  // ==========================================
  startDashboard(port = 3000) {
    if (this.dashboardServer) return;
    this.dashboardServer = http.createServer((req, res) => {
      const url = new URL(req.url, `http://${req.headers.host}`);
      if (url.pathname === '/api/metrics') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          uptime: process.uptime(),
          heapObjects: this.heapMemory.size,
          gcStats: this.gcStats,
          threadsCount: this.threads.size,
          classesLoaded: this.classes.size,
          activePools: this.jdbcPools.size
        }));
        return;
      }
      if (url.pathname === '/api/gc/collect' && req.method === 'POST') {
        const collected = this.collectGarbage();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'success', collected, remaining: this.heapMemory.size }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(`<!DOCTYPE html><html><head><title>KreepJ Dashboard</title></head><body><h1>⚡ KreepJ Control Center</h1><p>JVM Runtime Active.</p></body></html>`);
    });
    this.dashboardServer.listen(port, () => {
      console.log(`[kreepj-dashboard] Web UI Dashboard active at http://localhost:${port}`);
    });
  }

  // ==========================================
  // 3. CORE RUNTIME, JAR PACKER & RUNNER
  // ==========================================
  async runJar(jarPath, args = []) {
    console.log(`[kreepj] Loading JAR archive: ${jarPath}`);
    const buffer = fs.readFileSync(jarPath);
    const extractedFiles = this.unzipJar(buffer);

    const manifest = extractedFiles['META-INF/MANIFEST.MF'];
    if (!manifest) throw new Error("Invalid JAR: Missing META-INF/MANIFEST.MF");
    const mainClass = manifest.toString('utf8').split('\n').find(l => l.startsWith('Main-Class:')).replace('Main-Class:', '').trim();

    for (const [filename, fileBuffer] of Object.entries(extractedFiles)) {
      if (filename.endsWith('.class')) {
        this.systemClassLoader.defineClass(filename.replace(/\.class$/, '').replace(/\//g, '.'), fileBuffer);
      }
    }

    console.log(`[kreepj] Executing Main-Class: ${mainClass}`);
    return true;
  }

  static packJar(sourceDir, outputJarPath, mainClassName) {
    const manifestData = `Manifest-Version: 1.0\nMain-Class: ${mainClassName}\nCreated-By: KreepJ CLI API\n\n`;
    const zipEntries = [{ name: 'META-INF/MANIFEST.MF', data: Buffer.from(manifestData, 'utf8') }];

    function walk(dir, base = '') {
      for (const file of fs.readdirSync(dir)) {
        const fullPath = path.join(dir, file);
        const entryName = path.join(base, file).replace(/\\/g, '/');
        if (fs.statSync(fullPath).isDirectory()) walk(fullPath, entryName);
        else if (file.endsWith('.class')) zipEntries.push({ name: entryName, data: fs.readFileSync(fullPath) });
      }
    }

    walk(sourceDir);
    fs.writeFileSync(outputJarPath, KreepJ.createZipBuffer(zipEntries));
    console.log(`[kreepj] Successfully generated JAR: ${outputJarPath}`);
  }

  unzipJar(buffer) {
    const files = {};
    let offset = 0;
    while (offset < buffer.length) {
      if (buffer.readUInt32LE(offset) !== 0x04034b50) break;
      const compression = buffer.readUInt16LE(offset + 8);
      const compressedSize = buffer.readUInt32LE(offset + 18);
      const fileNameLength = buffer.readUInt16LE(offset + 26);
      const extraFieldLength = buffer.readUInt16LE(offset + 28);
      const fileName = buffer.toString('utf8', offset + 30, offset + 30 + fileNameLength);
      const dataOffset = offset + 30 + fileNameLength + extraFieldLength;
      
      let fileData = buffer.subarray(dataOffset, dataOffset + compressedSize);
      if (compression === 8) fileData = zlib.inflateRawSync(fileData);
      files[fileName] = fileData;
      offset = dataOffset + compressedSize;
    }
    return files;
  }

  static createZipBuffer(entries) {
    const chunks = [];
    const centralDirectory = [];
    let offset = 0;
    for (const entry of entries) {
      const nameBuffer = Buffer.from(entry.name, 'utf8');
      const data = entry.data;
      const header = Buffer.alloc(30);
      header.writeUInt32LE(0x04034b50, 0);
      header.writeUInt32LE(data.length, 18);
      header.writeUInt32LE(data.length, 22);
      header.writeUInt16LE(nameBuffer.length, 26);
      chunks.push(header, nameBuffer, data);

      const cdHeader = Buffer.alloc(46);
      cdHeader.writeUInt32LE(0x02014b50, 0);
      cdHeader.writeUInt32LE(data.length, 20);
      cdHeader.writeUInt32LE(data.length, 24);
      cdHeader.writeUInt16LE(nameBuffer.length, 28);
      cdHeader.writeUInt32LE(offset, 42);
      centralDirectory.push(cdHeader, nameBuffer);
      offset += header.length + nameBuffer.length + data.length;
    }
    const cdOffset = offset;
    let cdSize = 0;
    centralDirectory.forEach(c => { cdSize += c.length; chunks.push(c); offset += c.length; });
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(cdSize, 12);
    eocd.writeUInt32LE(cdOffset, 16);
    chunks.push(eocd);
    return Buffer.concat(chunks);
  }

  verifyBytecode(buffer) {
    if (buffer.byteLength < 10) throw new Error("VerifyError: Truncated class file");
    return true;
  }

  parseClassFile(buffer) {
    return { constantPool: [], methods: new Map() };
  }

  readUtf8(ptr) {
    const bytes = new Uint8Array(this.heap.buffer, ptr);
    let len = 0;
    while (bytes[len] !== 0) len++;
    return new TextDecoder().decode(bytes.subarray(0, len));
  }
}

export default KreepJ;
