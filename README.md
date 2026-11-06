# KreepJ
KreepJ: Free, Open-Source JVM Runtime & API in JavaScript/WebAssembly

KreepJ is a high-performance, lightweight, open-source JVM runtime and API designed to execute Java bytecode, .class binaries, and .jar archives directly within Node.js and browser environments—completely free and structured as a modular developer API instead of a locked-down web page demo.

Features

⚡ WebAssembly Core Integration: Low-overhead memory management and stack execution hooks.
📦 JAR Packer & Runner: Automated ZIP archive extraction, META-INF/MANIFEST.MF entry point discovery, and direct execution.
🔒 Bytecode Verifier: Structural integrity checks, magic header validation (CAFEBABE), and constant pool bounds verification.
🌐 Native JNI Bridge: Bind Java native method declarations directly to high-performance JavaScript functions.
🗑️ GC & Heap Tracker: Object allocation tables and mark-and-sweep garbage collection cycle monitoring.
🧵 Multi-Threading & Synchronization: Thread state management, priority queues, and monitor locks (monitorenter/monitorexit).
🧩 Custom ClassLoaders: Isolated package delegation hierarchies and dynamic runtime bytecode loading (defineClass).
🕹️ Stack-Based Interpreter: Full opcode instruction interpretation and evaluation loop.
🔍 Reflection API: Dynamic method handle resolution, field inspection, and reflective invocation.
🔌 Network & JDBC Pools: Node.js net/http runtime bridges alongside SQL connection pooling.
📊 Web UI Dashboard: Real-time metrics visualization, thread state inspection, and REST API endpoints.
💻 CLI Wrapper: Terminal-based execution (kreepj run, kreepj pack, kreepj dashboard).
Installation

Initialize your project and include kreepj.js:

Bash



npm init -y

Save the runtime code as kreepj.js in your repository root.

Usage Examples

Running a
.jar File via API

JavaScript



import KreepJ from './kreepj.js';async function run() {

const jvm = new KreepJ();

await jvm.init();



// Parses MANIFEST.MF, extracts classes, and executes main()

await jvm.runJar('app.jar', ['arg1', 'arg2']);

}



run();

2. Packing Classes into a .jar

JavaScript



import KreepJ from './kreepj.js';// Packs compiled .class files from ./build into app.jar with com.example.Main as entry point

KreepJ.packJar('./build', 'app.jar', 'com.example.Main');

3. Registering Native JNI Methods

JavaScript



import KreepJ from './kreepj.js';const jvm = new KreepJ();await jvm.init();



jvm.registerNative('com.example.Utils', 'getOS', '()Ljava/lang/String;', () => {

return "Node.js / KreepJ Environment";

});

4. Launching the Web UI Dashboard

JavaScript



import KreepJ from './kreepj.js';const jvm = new KreepJ();await jvm.init();

jvm.startDashboard(3000); // Access at http://localhost:3000

CLI Tool Usage

Create a bin/cli.mjs script:
JavaScript



#!/usr/bin/env nodeimport KreepJ from '../kreepj.js';

KreepJ.executeCli(process.argv);

Register the binary in package.json:
JSON



{

"name": "kreepj",

"version": "1.0.0",

"type": "module",

"bin": {

"kreepj": "./bin/cli.mjs"

}

}

Run commands from your terminal:
Bash



kreepj run app.jar

kreepj pack ./build app.jar com.example.Main

kreepj dashboard 3000

License
Distributed under the MIT License. See LICENSE for details.
