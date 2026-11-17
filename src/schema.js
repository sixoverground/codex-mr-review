// A small JSON Schema validator for the subset schema/ uses, so the tool
// keeps no runtime dependencies.
//
// Supported keywords: type (a name or a list of names), enum, const,
// pattern, minLength, minimum, required, properties, additionalProperties
// (false only), items (a single schema). Anything else in a schema is an
// error, so the subset cannot silently grow past what is checked.

const SUPPORTED = new Set([
  "$schema", "$id", "title", "description",
  "type", "enum", "const", "pattern", "minLength", "minimum",
  "required", "properties", "additionalProperties", "items",
]);

function typeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number";
  return typeof value;
}

function matchesType(value, type) {
  const actual = typeOf(value);
  return actual === type || (type === "number" && actual === "integer");
}

// Returns a list of error strings, each prefixed with a JSON pointer. An
// empty list means the value is valid.
export function validate(schema, value, pointer = "") {
  const errors = [];
  const at = pointer || "/";
  for (const key of Object.keys(schema)) {
    if (!SUPPORTED.has(key)) throw new Error(`schema keyword "${key}" at ${at} is not supported`);
  }
  if (schema.additionalProperties !== undefined && schema.additionalProperties !== false) {
    throw new Error(`only additionalProperties: false is supported (at ${at})`);
  }

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => matchesType(value, t))) {
      errors.push(`${at}: expected ${types.join(" or ")}, got ${typeOf(value)}`);
      return errors;
    }
  }
  if (schema.enum !== undefined && !schema.enum.includes(value)) {
    errors.push(`${at}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`);
  }
  if (schema.const !== undefined && value !== schema.const) {
    errors.push(`${at}: expected ${JSON.stringify(schema.const)}`);
  }
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${at}: shorter than ${schema.minLength}`);
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern, "u").test(value)) {
      errors.push(`${at}: does not match ${schema.pattern}`);
    }
  }
  if (typeof value === "number" && schema.minimum !== undefined && value < schema.minimum) {
    errors.push(`${at}: less than ${schema.minimum}`);
  }
  if (typeOf(value) === "object") {
    for (const name of schema.required ?? []) {
      if (!Object.hasOwn(value, name)) errors.push(`${at}: missing required property "${name}"`);
    }
    const props = schema.properties ?? {};
    for (const [name, child] of Object.entries(value)) {
      if (Object.hasOwn(props, name)) {
        errors.push(...validate(props[name], child, `${pointer}/${name}`));
      } else if (schema.additionalProperties === false) {
        errors.push(`${at}: unexpected property "${name}"`);
      }
    }
  }
  if (Array.isArray(value) && schema.items !== undefined) {
    value.forEach((item, i) => errors.push(...validate(schema.items, item, `${pointer}/${i}`)));
  }
  return errors;
}
