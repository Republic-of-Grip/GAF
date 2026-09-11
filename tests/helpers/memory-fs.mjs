/** In-memory File System Access directory handle for tests. */

function toBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (typeof data === 'string') return new TextEncoder().encode(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return new TextEncoder().encode(String(data));
}

function ensureDir(node, name) {
  let child = node.children.get(name);
  if (!child) {
    child = { type: 'dir', name, children: new Map() };
    node.children.set(name, child);
  }
  if (child.type !== 'dir') throw new Error(`${name} is not a directory`);
  return child;
}

function wrap(node) {
  if (node.type === 'dir') return new MemoryDirectoryHandle(node);
  return new MemoryFileHandle(node);
}

export class MemoryFileHandle {
  constructor(node) {
    this.kind = 'file';
    this.name = node.name;
    this._node = node;
  }

  async getFile() {
    const bytes = this._node.bytes || new Uint8Array();
    return {
      size: bytes.length,
      text: async () => new TextDecoder().decode(bytes),
      arrayBuffer: async () => bytes.slice().buffer,
    };
  }

  async createWritable() {
    const chunks = [];
    return {
      write: async (data) => {
        chunks.push(toBytes(data));
      },
      close: async () => {
        const total = chunks.reduce((n, c) => n + c.length, 0);
        const out = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          out.set(chunk, offset);
          offset += chunk.length;
        }
        this._node.bytes = out;
      },
      abort: async () => {},
    };
  }
}

export class MemoryDirectoryHandle {
  constructor(node, { permission = 'granted' } = {}) {
    this.kind = 'directory';
    this.name = node.name;
    this._node = node;
    this._permission = permission;
  }

  async queryPermission() {
    return this._permission;
  }

  async requestPermission() {
    this._permission = 'granted';
    return this._permission;
  }

  async getDirectoryHandle(name, { create = false } = {}) {
    let child = this._node.children.get(name);
    if (!child && create) child = ensureDir(this._node, name);
    if (!child || child.type !== 'dir') throw new Error(`Missing directory: ${name}`);
    return wrap(child);
  }

  async getFileHandle(name, { create = false } = {}) {
    let child = this._node.children.get(name);
    if (!child && create) {
      child = { type: 'file', name, bytes: new Uint8Array() };
      this._node.children.set(name, child);
    }
    if (!child || child.type !== 'file') throw new Error(`Missing file: ${name}`);
    return wrap(child);
  }

  async removeEntry(name) {
    this._node.children.delete(name);
  }

  async *entries() {
    for (const [name, child] of this._node.children) {
      yield [name, wrap(child)];
    }
  }
}

export function createMemoryDirectory(files = {}, { name = 'gaf', permission = 'granted' } = {}) {
  const root = { type: 'dir', name, children: new Map() };
  for (const [path, data] of Object.entries(files)) {
    const parts = path.split('/').filter(Boolean);
    const fileName = parts.pop();
    let dir = root;
    for (const part of parts) dir = ensureDir(dir, part);
    dir.children.set(fileName, { type: 'file', name: fileName, bytes: toBytes(data) });
  }
  return new MemoryDirectoryHandle(root, { permission });
}

export async function readMemoryFile(dirHandle, relativePath) {
  const parts = relativePath.split('/').filter(Boolean);
  const fileName = parts.pop();
  let dir = dirHandle;
  for (const part of parts) dir = await dir.getDirectoryHandle(part);
  const file = await (await dir.getFileHandle(fileName)).getFile();
  return file.text();
}
