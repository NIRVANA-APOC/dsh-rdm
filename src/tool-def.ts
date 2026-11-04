/**
 * Local, dependency-free replacement for `@deepseek-ai/dsh-tools`' `defineTool`.
 *
 * Why this exists: a DSH plugin installed from a local directory is linked into
 * the profile and its ESM imports resolve from the plugin's real path, not from
 * the Harness installation. Importing `@deepseek-ai/dsh-tools` at runtime would
 * therefore require the Harness package to be importable from the plugin
 * directory (it is not). The two things `defineTool` does for this plugin are:
 *
 *  1. compile the author-facing schema DSL into the raw JSON Schema subset the
 *     tool registry stores and the runtime enforces for canonical values;
 *  2. validate model arguments against that compiled parameter schema before
 *     `execute` runs.
 *
 * This module reproduces exactly that contract for the schema subset used by
 * `tools.ts` (string/number/integer/boolean/null/array/object/json, `enum`,
 * `oneOf`, `required` on properties, and the annotation keys). The registry's
 * own output-schema validation (`validateJsonSchemaValue(tool.output.schema, …)`)
 * still runs on every canonical value — only argument validation lives here.
 *
 * Kept deliberately small and strict: an unsupported author key throws at
 * definition time, so a schema typo fails the plugin load loudly instead of
 * producing a silently unvalidated tool.
 *
 * @module dsh-rdm/tool-def
 */

/** Author-facing schema node (the DSL used in `tools.ts`). */
export interface AuthorSchemaNode {
  type?: 'string' | 'number' | 'integer' | 'boolean' | 'null' | 'array' | 'object' | 'json'
  oneOf?: readonly AuthorSchemaNode[]
  properties?: Record<string, AuthorSchemaNode>
  additionalProperties?: boolean
  items?: AuthorSchemaNode
  enum?: readonly (string | number | boolean | null)[]
  const?: string | number | boolean | null
  /** Property-level requiredness; rejected on roots/items/oneOf branches. */
  required?: boolean
  description?: string
  title?: string
  default?: unknown
  examples?: readonly unknown[]
}

/** Raw JSON Schema node emitted for the registry. */
export type JsonSchemaNode = Record<string, unknown>

/** Execution context passed to a tool body (same fields the plugin uses). */
export interface ToolRunContext {
  readonly signal: AbortSignal
  readonly [key: string]: unknown
}

/** Registry-ready definition (structural subset of ToolDefinition). */
export interface ToolDefinition<Args = unknown, Value = unknown> {
  name: string
  description: string
  parameters: JsonSchemaNode
  output: {
    schema: JsonSchemaNode
    render(args: Args, value: Value): Array<{ type: 'text'; text: string }>
  }
  execute(args: Args, exec: ToolRunContext): Promise<Value>
  timeoutMs?: number
}

/** Options accepted by {@link defineTool}. */
export interface DefineToolOptions<Args, Value> {
  name: string
  description: string
  parameters: Record<string, AuthorSchemaNode>
  output: {
    schema: AuthorSchemaNode
    render(args: Args, value: Value): Array<{ type: 'text'; text: string }>
  }
  execute(args: Args, exec: ToolRunContext): Promise<Value>
  timeoutMs?: number
}

const ANNOTATION_KEYS = ['description', 'title', 'default', 'examples'] as const

function annotations(source: AuthorSchemaNode, target: JsonSchemaNode): void {
  for (const key of ANNOTATION_KEYS) {
    if (Object.hasOwn(source, key)) target[key] = source[key]
  }
}

function authorError(path: string, message: string): never {
  throw new Error(`defineTool schema error at ${path}: ${message}`)
}

function assertAllowedKeys(input: AuthorSchemaNode, path: string, allowed: readonly string[]): void {
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) authorError(path, `"${key}" is not supported by the value schema DSL`)
  }
}

/**
 * Compile one author node to the raw JSON Schema subset.
 *
 * @param input - author node.
 * @param path - diagnostic path.
 * @param allowRequired - whether the property-level `required` flag is legal here.
 */
function compileNode(input: AuthorSchemaNode, path: string, allowRequired: boolean): JsonSchemaNode {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    authorError(path, 'must be a value schema object')
  }
  const baseKeys = [...ANNOTATION_KEYS, ...(allowRequired ? ['required'] : [])]
  if (Object.hasOwn(input, 'required') && input.required !== true) {
    authorError(path, 'required must be true when present')
  }
  if (Object.hasOwn(input, 'oneOf')) {
    assertAllowedKeys(input, path, [...baseKeys, 'oneOf', 'type'])
    if (Object.hasOwn(input, 'type')) authorError(path, 'cannot declare both type and oneOf')
    if (!Array.isArray(input.oneOf) || input.oneOf.length < 2) {
      authorError(path, 'oneOf must be an array of at least two value schemas')
    }
    const node: JsonSchemaNode = { oneOf: input.oneOf.map((branch, index) => compileNode(branch, `${path}.oneOf[${index}]`, false)) }
    annotations(input, node)
    return node
  }
  const node: JsonSchemaNode = {}
  annotations(input, node)
  switch (input.type) {
    case 'json':
      assertAllowedKeys(input, path, [...baseKeys, 'type'])
      return node
    case 'object': {
      assertAllowedKeys(input, path, [...baseKeys, 'type', 'properties', 'additionalProperties'])
      if (typeof input.additionalProperties !== 'boolean') {
        authorError(path, 'object nodes need an explicit boolean additionalProperties')
      }
      node.type = 'object'
      node.additionalProperties = input.additionalProperties
      if (input.properties !== undefined) {
        const compiled = compilePropertyMap(input.properties, `${path}.properties`)
        node.properties = compiled.properties
        if (compiled.required.length > 0) node.required = compiled.required
      }
      return node
    }
    case 'array': {
      assertAllowedKeys(input, path, [...baseKeys, 'type', 'items'])
      node.type = 'array'
      if (input.items !== undefined) node.items = compileNode(input.items, `${path}.items`, false)
      return node
    }
    case 'string':
    case 'number':
    case 'integer':
    case 'boolean':
    case 'null': {
      assertAllowedKeys(input, path, [...baseKeys, 'type', 'enum', 'const'])
      node.type = input.type
      if (input.enum !== undefined) {
        if (!Array.isArray(input.enum) || input.enum.length === 0) authorError(path, 'enum must be a non-empty array')
        node.enum = [...input.enum]
      }
      if (Object.hasOwn(input, 'const')) node.const = input.const
      return node
    }
    default:
      authorError(path, 'type must be string/number/integer/boolean/null/array/object/json, or use oneOf')
  }
}

/**
 * Compile one property map into its plain `properties` record plus the list of
 * required property names (the parent object node owns both).
 */
function compilePropertyMap(
  input: Record<string, AuthorSchemaNode>,
  path: string,
): { properties: Record<string, JsonSchemaNode>; required: string[] } {
  const properties: Record<string, JsonSchemaNode> = {}
  const required: string[] = []
  for (const [key, spec] of Object.entries(input)) {
    if (spec === null || typeof spec !== 'object' || Array.isArray(spec)) {
      authorError(`${path}.${key}`, 'must be a value schema object')
    }
    if (spec.required === true) required.push(key)
    properties[key] = compileNode(spec, `${path}.${key}`, true)
  }
  return { properties, required }
}

/**
 * Compile the implicit parameter map into an object-rooted schema. The root
 * intentionally has no `additionalProperties`: the Harness parameter root is
 * open, so unknown arguments are ignored rather than rejected.
 */
function compileParameters(input: Record<string, AuthorSchemaNode>, path: string): JsonSchemaNode {
  const compiled = compilePropertyMap(input, path)
  const node: JsonSchemaNode = { type: 'object', properties: compiled.properties }
  if (compiled.required.length > 0) node.required = compiled.required
  return node
}

// ── Argument validation ─────────────────────────────────────────────────────

function describe(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

function validate(value: unknown, schema: JsonSchemaNode, path: string, violations: string[]): void {
  const oneOf = schema.oneOf
  if (Array.isArray(oneOf)) {
    let matches = 0
    for (const branch of oneOf) {
      const branchViolations: string[] = []
      validate(value, branch as JsonSchemaNode, path, branchViolations)
      if (branchViolations.length === 0) matches += 1
    }
    if (matches !== 1) violations.push(`${path} must match exactly one allowed shape (matched ${matches})`)
    return
  }
  const type = schema.type
  if (typeof type !== 'string') return // annotation-only ("json") node accepts any JSON value
  switch (type) {
    case 'string':
      if (typeof value !== 'string') violations.push(`${path} must be a string`)
      break
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) violations.push(`${path} must be a finite number`)
      break
    case 'integer':
      if (typeof value !== 'number' || !Number.isInteger(value)) violations.push(`${path} must be an integer`)
      break
    case 'boolean':
      if (typeof value !== 'boolean') violations.push(`${path} must be a boolean`)
      break
    case 'null':
      if (value !== null) violations.push(`${path} must be null`)
      break
    case 'array': {
      if (!Array.isArray(value)) {
        violations.push(`${path} must be an array`)
        break
      }
      const items = schema.items as JsonSchemaNode | undefined
      if (items !== undefined) {
        value.forEach((entry, index) => validate(entry, items, `${path}[${index}]`, violations))
      }
      break
    }
    case 'object': {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        violations.push(`${path} must be an object`)
        break
      }
      const record = value as Record<string, unknown>
      const properties = (schema.properties ?? {}) as Record<string, JsonSchemaNode>
      const required = (schema.required ?? []) as string[]
      for (const key of required) {
        if (record[key] === undefined) violations.push(`${path}.${key} is required`)
      }
      for (const [key, childSchema] of Object.entries(properties)) {
        if (record[key] !== undefined) validate(record[key], childSchema, `${path}.${key}`, violations)
      }
      if (schema.additionalProperties === false) {
        for (const key of Object.keys(record)) {
          if (!Object.hasOwn(properties, key)) violations.push(`${path}.${key} is not allowed`)
        }
      }
      break
    }
    default:
      break
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((entry) => Object.is(entry, value))) {
    violations.push(`${path} must be one of ${JSON.stringify(schema.enum)} (got ${JSON.stringify(value)})`)
  }
  if (Object.hasOwn(schema, 'const') && !Object.is(schema.const, value)) {
    violations.push(`${path} must equal ${JSON.stringify(schema.const)}`)
  }
}

/** Validate model arguments against a compiled parameter schema. */
export function validateArgs(parameters: JsonSchemaNode, args: unknown): string[] {
  const violations: string[] = []
  validate(args, parameters, 'arguments', violations)
  return violations
}

/**
 * Build one registry-ready tool definition from the author-facing DSL and
 * validate model arguments before delegating to `execute`.
 */
export function defineTool<Args, Value>(options: DefineToolOptions<Args, Value>): ToolDefinition<Args, Value> {
  const parameters = compileParameters(options.parameters, 'parameters')
  const outputSchema = compileNode(options.output.schema, 'output.schema', false)
  const definition: ToolDefinition<Args, Value> = {
    name: options.name,
    description: options.description,
    parameters,
    output: {
      schema: outputSchema,
      render: (args, value) => options.output.render(args, value),
    },
    execute: async (args, exec) => {
      const violations = validateArgs(parameters, args)
      if (violations.length > 0) throw new Error(`invalid arguments: ${violations.join('; ')}`)
      return options.execute(args, exec)
    },
  }
  if (options.timeoutMs !== undefined) definition.timeoutMs = options.timeoutMs
  return definition
}
