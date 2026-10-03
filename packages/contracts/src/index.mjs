import { readFileSync } from 'node:fs';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const schemas = ['v1.json', 'worker.v1.json', 'model.v1.json'].map((name) =>
  JSON.parse(readFileSync(new URL('../schema/' + name, import.meta.url), 'utf8')));
const ajv = new Ajv2020({ strict: true, strictRequired: false, strictTypes: false, allErrors: true });
addFormats(ajv);
const validators = new Map();
for (const schema of schemas) {
  ajv.addSchema(schema);
  for (const [name, definition] of Object.entries(schema.$defs)) {
    if (definition.type !== 'object' && name !== 'ModelEvent') continue;
    if (validators.has(name)) throw new Error('Duplicate contract name');
    validators.set(name, ajv.compile({ $ref: `${schema.$id}#/$defs/${name}` }));
  }
}

// JSON Schema cannot compare required_criteria with an arbitrary result list.
// Keep the corresponding Rust check and shared regression fixtures in sync.
export function manifestErrors(value) {
  const results = new Map();
  for (const record of value.verification) {
    if (results.has(record.criterion_id)) return ['DUPLICATE_VERIFICATION_CRITERION'];
    results.set(record.criterion_id, record.result);
  }
  const unmet = value.required_criteria.filter((id) => results.get(id) !== 'pass').sort();
  const declared = [...value.unmet_required_criteria].sort();
  if (JSON.stringify(unmet) !== JSON.stringify(declared)) return ['UNMET_CRITERIA_MISMATCH'];
  if (value.status === 'complete' && (unmet.length > 0 || value.unresolved_effects.length > 0)) return ['UNVERIFIED_COMPLETE'];
  if (value.status === 'partial' && unmet.length === 0 && value.unresolved_effects.length === 0) return ['PARTIAL_WITHOUT_UNMET_CONDITION'];
  return [];
}

export function validateContract(name, value) {
  const validate = validators.get(name);
  if (!validate) return { valid: false, errors: ['UNKNOWN_CONTRACT'] };
  if (!validate(value)) {
    // Deliberately exclude instance values (potentially credentials/documents).
    return { valid: false, errors: validate.errors.map((e) => `${e.instancePath || '/'}:${e.keyword}`) };
  }
  const errors = name === 'ArtifactManifest' ? manifestErrors(value) : [];
  return { valid: errors.length === 0, errors };
}

export function parseContract(name, value) {
  const result = validateContract(name, value);
  if (!result.valid) throw new TypeError(`Invalid ${name}: ${result.errors.join(', ')}`);
  return structuredClone(value);
}
