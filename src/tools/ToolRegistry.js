class ToolRegistry {
  constructor() { this.tools = new Map(); }
  register(definition) {
    const name = String(definition?.name || '').trim();
    if (!name) throw new Error('Tool name is required.');
    if (this.tools.has(name)) throw new Error(`Tool already registered: ${name}`);
    if (typeof definition.handler !== 'function') throw new Error(`Tool ${name} must have a handler.`);
    this.tools.set(name, { description: '', inputSchema: { type: 'object', properties: {} }, risk: 'read', actionLabel: args => `${name} ${JSON.stringify(args)}`, ...definition, name });
    return this;
  }
  get(name) { return this.tools.get(name); }
  list() { return [...this.tools.values()]; }
  asOpenAITools() {
    return this.list().map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } }));
  }
  async execute(name, args, context = {}) {
    const tool = this.get(name);
    if (!tool) return { ok: false, error: `Unknown tool: ${name}` };
    try {
      validateArguments(tool.inputSchema, args);
      const value = await tool.handler(args || {}, context);
      return value && typeof value === 'object' ? { ok: true, ...value } : { ok: true, value };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}
function validateArguments(schema, args) {
  const value = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  for (const key of schema?.required || []) {
    if (value[key] === undefined || value[key] === null) throw new Error(`Missing required argument: ${key}`);
  }
  for (const [key, definition] of Object.entries(schema?.properties || {})) {
    if (value[key] === undefined) continue;
    if (definition.type === 'string' && typeof value[key] !== 'string') throw new Error(`Argument ${key} must be a string.`);
    if (definition.type === 'boolean' && typeof value[key] !== 'boolean') throw new Error(`Argument ${key} must be a boolean.`);
    if (definition.type === 'number' && typeof value[key] !== 'number') throw new Error(`Argument ${key} must be a number.`);
    if (definition.type === 'array' && !Array.isArray(value[key])) throw new Error(`Argument ${key} must be an array.`);
  }
}
module.exports = { ToolRegistry, validateArguments };
